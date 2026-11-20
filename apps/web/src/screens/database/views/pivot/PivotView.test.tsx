import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewAggregate } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../../data/types';
import { VIEW_DEFINITIONS } from '../registry';
import { SUMMARY_REFRESH } from '../summary/store';
import {
  DONE,
  Harness,
  OPEN,
  closeAll,
  mount,
  summaryFixture,
  type SummaryIds,
} from '../summary/test-support';
import { PivotSettings, PivotView } from './index';

const sessions: DatabaseSession[] = [];
const delay = SUMMARY_REFRESH.delayMs;
beforeEach(() => {
  SUMMARY_REFRESH.delayMs = 20;
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
  SUMMARY_REFRESH.delayMs = delay;
});

async function open(options: Parameters<typeof summaryFixture>[1] = {}) {
  const setup = await summaryFixture('pivot', options);
  sessions.push(setup.session);
  const onExpand = vi.fn();
  mount(
    <Harness
      session={setup.session}
      viewId={setup.ids.viewId}
      View={PivotView}
      Settings={PivotSettings}
      onExpand={onExpand}
    />,
  );
  return { ...setup, onExpand };
}

/** Status down the side, months across the top, and a count and a sum in every cell. */
const byMonth = (ids: SummaryIds) => ({
  pivot: {
    rows: [{ fieldId: ids.status }],
    column: { fieldId: ids.due, dateBucket: 'month' },
    values: [
      { fn: 'count', fieldId: null },
      { fn: 'sum', fieldId: ids.number },
    ],
  },
});

const table = () => screen.getByRole('table', { name: 'Grid' });
/** The first answer can take a while in a full, busy test run. */
const FIRST_LOAD = { timeout: 10_000 };
const texts = (row: HTMLElement) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent);
const rows = () => within(table()).getAllByRole('row').map(texts);

describe('the pivot view', () => {
  it('shows rows, columns, values, and totals, with blank cells where no records fall', async () => {
    await open({ config: byMonth });
    await screen.findByRole('table', { name: 'Grid' }, FIRST_LOAD);
    expect(rows()).toEqual([
      ['Status', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', 'Total'],
      [
        'Records',
        'Sum of Number',
        'Records',
        'Sum of Number',
        'Records',
        'Sum of Number',
        'Records',
        'Sum of Number',
        'Records',
        'Sum of Number',
      ],
      ['Open', '1', '0', '', '', '1', '2', '', '', '2', '2'],
      ['Done', '', '', '1', '1', '', '', '1', '3', '2', '4'],
      ['Total', '1', '0', '1', '1', '1', '2', '1', '3', '4', '6'],
    ]);
    const header = within(table()).getAllByRole('columnheader');
    expect(header[0]!.getAttribute('rowspan')).toBe('2');
    expect(header[1]!.getAttribute('colspan')).toBe('2');
    // Blank cells have nothing behind them, so only filled ones open a list.
    const openRow = within(table()).getAllByRole('row')[2]!;
    expect(
      within(openRow)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['1', '0', '1', '2', '2', '2']);
  });

  it('lists the records behind a cell, a row’s total, and the grand total, and opens one', async () => {
    const setup = await open({ config: byMonth });
    await screen.findByRole('table', { name: 'Grid' }, FIRST_LOAD);
    const [, , openRow] = within(table()).getAllByRole('row');
    await userEvent.click(within(openRow!).getAllByRole('button')[2]!);
    const cell = await screen.findByRole('region', { name: 'Open, 2026-03-01' });
    await waitFor(() =>
      expect(
        within(cell)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Record 3']),
    );
    expect(setup.requests().at(-1)!.options.body).toMatchObject({
      records: { row: [OPEN], column: '2026-03-01' },
    });
    expect(within(cell).getAllByText('Number')).toHaveLength(1);
    await userEvent.click(within(cell).getByRole('link', { name: 'Record 3' }));
    expect(setup.onExpand).toHaveBeenCalledWith(setup.fixture.recordId(2));
    const footer = within(table()).getAllByRole('row').at(-1)!;
    await userEvent.click(within(footer).getAllByRole('button').at(-2)!);
    const everything = await screen.findByRole('region', { name: 'Every record' });
    await waitFor(() => expect(within(everything).getByText('4 records')).toBeDefined());
    expect(setup.requests().at(-1)!.options.body).toMatchObject({ records: { row: [] } });
    expect(setup.requests().at(-1)!.options.body).not.toHaveProperty('records.column');
  });

  it('folds outer groups away, and downloads the pivot as it shows', async () => {
    const setup = await open({
      config: (ids) => ({
        pivot: { rows: [{ fieldId: ids.status }, { fieldId: ids.due, dateBucket: 'quarter' }] },
      }),
    });
    await screen.findByRole('table', { name: 'Grid' }, FIRST_LOAD);
    expect(rows()).toEqual([
      ['Status / Due', 'Records'],
      ['Open', '2'],
      ['2026-01-01', '2'],
      ['Done', '2'],
      ['2026-01-01', '1'],
      ['2026-04-01', '1'],
      ['Total', '4'],
    ]);
    const toggle = screen.getByRole('button', { name: 'Open' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('aria-expanded')).toBe('false');
    expect(rows().map((row) => row[0])).toEqual([
      'Status / Due',
      'Open',
      'Done',
      '2026-01-01',
      '2026-04-01',
      'Total',
    ]);

    const files: Blob[] = [];
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      files.push(blob as Blob);
      return 'blob:pivot';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Download table as CSV' }));
    expect(names).toEqual(['Table - Grid.csv']);
    expect(await files[0]!.text()).toBe(
      '\uFEFFStatus,Due,Records\r\nOpen,,2\r\nDone,,2\r\n,2026-01-01,1\r\n,2026-04-01,1\r\nTotal,,4\r\n',
    );
    expect(setup.requests()).toHaveLength(1);
  });

  it('saves its settings from the settings bar and shows the new numbers', async () => {
    const setup = await open({ config: (ids) => ({ pivot: { rows: [{ fieldId: ids.status }] } }) });
    await screen.findByRole('table', { name: 'Grid' }, FIRST_LOAD);
    expect(rows()).toEqual([
      ['Status', 'Records'],
      ['Open', '2'],
      ['Done', '2'],
      ['Total', '4'],
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Due/ }));
    await waitFor(() =>
      expect(setup.commands().at(-1)).toMatchObject({
        kind: 'view.update',
        config: { pivot: { column: { fieldId: setup.ids.due, dateBucket: 'month' } } },
      }),
    );
    await waitFor(() =>
      expect(rows()[0]).toEqual(['Status', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', 'Total']),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Values' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a value' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Value 2/ })).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /Value 2/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Sum' }));
    await waitFor(() =>
      expect(setup.commands().at(-1)).toMatchObject({
        config: {
          pivot: {
            values: [
              { fn: 'count', fieldId: null },
              { fn: 'sum', fieldId: setup.ids.number },
            ],
          },
        },
      }),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(rows()[1]).toContain('Sum of Number'));
    await userEvent.click(screen.getByRole('button', { name: 'Options' }));
    await userEvent.click(await screen.findByRole('switch', { name: 'Total for each row' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(rows()[0]).toEqual(['Status', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']),
    );
    expect(rows().at(-1)).toEqual(['Total', '1', '0', '1', '1', '1', '2', '1', '3']);
  });

  it('reloads shortly after a record changes', async () => {
    const setup = await open({ config: (ids) => ({ pivot: { rows: [{ fieldId: ids.status }] } }) });
    await screen.findByRole('table', { name: 'Grid' }, FIRST_LOAD);
    setup.server.remote(setup.fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: setup.ids.tableId,
        records: [{ id: setup.fixture.recordId(0), values: { [setup.ids.status]: DONE } }],
      },
    ]);
    await waitFor(() =>
      expect(rows()).toEqual([
        ['Status', 'Records'],
        ['Open', '1'],
        ['Done', '3'],
        ['Total', '4'],
      ]),
    );
    expect(setup.requests()).toHaveLength(2);
  });

  it('says what it needs when nothing is set up, and why when it can’t sum up', async () => {
    await open({ plain: true });
    expect(screen.getByRole('heading', { name: 'Choose rows for this table' })).toBeDefined();
    expect(
      screen.getByText(
        'Pick a field in Rows above, such as a single select or a date, to sum up the records by it.',
      ),
    ).toBeDefined();
    cleanup();
    await open({ role: 'reader' });
    expect(screen.getByText('This pivot table isn’t set up yet.')).toBeDefined();
    cleanup();
    const failing = await summaryFixture('pivot', { config: byMonth });
    sessions.push(failing.session);
    let answer: ViewAggregate = { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
    failing.server.viewAggregateResponder = () => answer;
    mount(
      <Harness
        session={failing.session}
        viewId={failing.ids.viewId}
        View={PivotView}
        Settings={PivotSettings}
      />,
    );
    expect(
      await screen.findByText(
        'This pivot table uses a field that was deleted or that you can’t see.',
        {},
        FIRST_LOAD,
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download table as CSV' }).hasAttribute('disabled')).toBe(true);
    answer = {
      kind: 'pivot',
      columns: [],
      rows: [{ keys: [OPEN], label: 'Open', cells: [], total: [3, 12] }],
      totals: null,
      capped: { rows: true, columns: false },
    };
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(/Showing the first 1,000 rows\.\s+Totals count every record\./),
    ).toBeDefined();
  });

  it('starts a new pivot on a single select, counting records', async () => {
    const { session, ids } = await summaryFixture('pivot');
    sessions.push(session);
    const schema = session.getSchema();
    const fields = schema.fields.get(ids.tableId)!;
    expect(
      VIEW_DEFINITIONS.pivot.initialConfig(schema.tableById.get(ids.tableId)!, fields).pivot,
    ).toMatchObject({
      rows: [{ fieldId: ids.status, dateBucket: null }],
      column: null,
      values: [{ fn: 'count', fieldId: null }],
      rowTotals: true,
      columnTotals: true,
    });
  });
});

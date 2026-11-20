import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type ViewAggregate } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../../data/types';
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
import { RestrictedFields } from '../../permissions/restricted';
import { VIEW_DEFINITIONS } from '../registry';
import { ChartSettings, ChartView } from './index';

const charts = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  pick: undefined as ((point: { dataIndex: number; seriesIndex: number }) => void) | undefined,
}));
vi.mock('../../dashboards/echarts', () => ({
  mountChart: (
    _element: HTMLElement,
    onPick?: (point: { dataIndex: number; seriesIndex: number }) => void,
  ) => {
    charts.pick = onPick;
    return {
      update: (option: Record<string, unknown>) => charts.options.push(option),
      resize: () => undefined,
      dispose: () => undefined,
    };
  },
}));

const sessions: DatabaseSession[] = [];
const delay = SUMMARY_REFRESH.delayMs;
beforeEach(() => {
  charts.options = [];
  charts.pick = undefined;
  SUMMARY_REFRESH.delayMs = 20;
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
  SUMMARY_REFRESH.delayMs = delay;
});

const byStatus = (ids: SummaryIds) => ({ chart: { groupBy: { fieldId: ids.status } } });
/** The canvas loads on demand, which takes a while in a full, busy test run. */
const FIRST_DRAW = { timeout: 10_000 };

async function open(options: Parameters<typeof summaryFixture>[1] = {}) {
  const setup = await summaryFixture('chart', options);
  sessions.push(setup.session);
  const onExpand = vi.fn();
  mount(
    <Harness
      session={setup.session}
      viewId={setup.ids.viewId}
      View={ChartView}
      Settings={ChartSettings}
      onExpand={onExpand}
    />,
  );
  return { ...setup, onExpand };
}

const lastChart = () => charts.options.at(-1)!;
const drawn = () => (lastChart().series as Array<{ data: unknown }>).map((series) => series.data);

describe('the chart view', () => {
  it('draws the records grouped by its field, asked for in the person’s time zone', async () => {
    const setup = await open({ config: byStatus });
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0), FIRST_DRAW);
    expect(screen.getByRole('img', { name: 'Grid' })).toBeDefined();
    expect(lastChart().xAxis).toMatchObject({ type: 'category', data: ['Open', 'Done'] });
    expect(drawn()).toEqual([[2, 2]]);
    expect(setup.requests()).toHaveLength(1);
    expect(setup.requests()[0]!.path).toBe(
      `/api/databases/${setup.fixture.databaseId}/views/${setup.ids.viewId}/aggregate`,
    );
    expect(setup.requests()[0]!.options.body).toEqual({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('puts the same numbers in an accessible table one click away', async () => {
    await open({ config: byStatus });
    await userEvent.click(await screen.findByRole('button', { name: 'Show as table' }, FIRST_DRAW));
    const table = screen.getByRole('table', { name: 'Grid' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Status', 'Count of records']);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Open', 'Done']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['2', '2']);
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show as chart' }));
    expect(await screen.findByRole('img', { name: 'Grid' })).toBeDefined();
  });

  it('lists the records behind a bar, and behind a table cell, and opens one', async () => {
    const setup = await open({ config: byStatus });
    await waitFor(() => expect(charts.pick).toBeDefined(), FIRST_DRAW);
    act(() => charts.pick!({ dataIndex: 1, seriesIndex: 0 }));
    const list = await screen.findByRole('region', { name: 'Done' });
    await waitFor(() => expect(within(list).getByText('2 records')).toBeDefined());
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Record 2', 'Record 4']);
    expect(links[0]!.getAttribute('href')).toBe(
      `/${setup.fixture.databaseId}/${setup.ids.tableId}/${setup.ids.viewId}/${setup.fixture.recordId(1)}`,
    );
    await userEvent.click(links[1]!);
    expect(setup.onExpand).toHaveBeenCalledWith(setup.fixture.recordId(3));
    expect(setup.requests().at(-1)!.options.body).toMatchObject({ records: { row: [DONE], limit: 50 } });
    await userEvent.click(within(list).getByRole('button', { name: 'Close the list' }));
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    await userEvent.click(within(screen.getByRole('table', { name: 'Grid' })).getAllByRole('button')[0]!);
    const opened = await screen.findByRole('region', { name: 'Open' });
    await waitFor(() =>
      expect(
        within(opened)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Record 1', 'Record 3']),
    );
  });

  it('lists a split bar’s records by its category and its series', async () => {
    const setup = await open({
      count: 6,
      config: (ids) => ({
        chart: { groupBy: { fieldId: ids.due, dateBucket: 'quarter' }, seriesBy: ids.status, stacked: true },
      }),
    });
    await waitFor(() => expect(charts.pick).toBeDefined(), FIRST_DRAW);
    await waitFor(() =>
      expect(drawn()).toEqual([
        [2, 1],
        [1, 2],
      ]),
    );
    expect(lastChart().yAxis).toMatchObject({ type: 'value' });
    expect(
      (lastChart().series as Array<{ name: string; stack?: string }>).map((line) => [line.name, line.stack]),
    ).toEqual([
      ['Open', 'total'],
      ['Done', 'total'],
    ]);
    act(() => charts.pick!({ dataIndex: 1, seriesIndex: 1 }));
    const list = await screen.findByRole('region', { name: '2026-04-01, Done' });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Record 4', 'Record 6']),
    );
    expect(setup.requests().at(-1)!.options.body).toMatchObject({
      records: { row: ['2026-04-01'], column: DONE },
    });
  });

  it('saves its settings from the settings bar and draws the new numbers', async () => {
    const setup = await open({ config: byStatus });
    await waitFor(() => expect(drawn()).toEqual([[2, 2]]), FIRST_DRAW);
    await userEvent.click(screen.getByRole('button', { name: 'Column Chart' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Bar' }));
    await waitFor(() => expect(lastChart().yAxis).toMatchObject({ type: 'category', inverse: true }));
    await userEvent.click(screen.getByRole('button', { name: /Group by/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Due/ }));
    await waitFor(() =>
      expect(setup.commands().at(-1)).toMatchObject({
        kind: 'view.update',
        config: { chart: { groupBy: { fieldId: setup.ids.due, dateBucket: 'month' } } },
      }),
    );
    await waitFor(() => expect(drawn()).toEqual([[1, 1, 1, 1]]));
    expect(screen.getByRole('button', { name: /Dates by/ })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: /Value/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Sum' }));
    await waitFor(() =>
      expect(setup.commands().at(-1)).toMatchObject({
        config: { chart: { value: { fn: 'sum', fieldId: setup.ids.number } } },
      }),
    );
    await waitFor(() => expect(drawn()).toEqual([[0, 1, 2, 3]]));
    // Every change waits for its save, so each answer describes the settings the server holds.
    expect(setup.requests().length).toBeLessThanOrEqual(3);
  });

  it('reloads shortly after a record changes', async () => {
    const setup = await open({ config: byStatus });
    await waitFor(() => expect(drawn()).toEqual([[2, 2]]), FIRST_DRAW);
    setup.server.remote(setup.fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: setup.ids.tableId,
        records: [{ id: setup.fixture.recordId(1), values: { [setup.ids.status]: OPEN } }],
      },
    ]);
    await waitFor(() => expect(drawn()).toEqual([[3, 1]]));
    expect(setup.requests()).toHaveLength(2);
  });

  it('shows a filter being typed once it’s saved, since the server computes from saved settings', async () => {
    const setup = await open({ config: byStatus });
    await waitFor(() => expect(drawn()).toEqual([[2, 2]]), FIRST_DRAW);
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    await waitFor(() => expect(setup.requests()).toHaveLength(2));
    await userEvent.type(screen.getByRole('textbox', { name: 'Value' }), 'Record 1');
    // The screen saves a typed filter after a pause, and only then does the chart ask again.
    await waitFor(() => expect(drawn()).toEqual([[1]]), { timeout: 5_000 });
    expect(setup.commands().at(-1)).toMatchObject({
      kind: 'view.update',
      config: { filter: { conditions: [{ fieldId: setup.ids.name, value: 'Record 1' }] } },
    });
    // The draft asks for nothing; only the saved filter does.
    expect(setup.requests()).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Filtered by Name' })).toBeDefined();
  });

  it('counts the fields its filter names that the person sees, a restricted one among them', async () => {
    const restricted = newId('field');
    const gone = newId('field');
    const setup = await summaryFixture('chart', {
      config: (ids) => ({
        ...byStatus(ids),
        filter: {
          conjunction: 'and',
          conditions: [
            { id: 'restricted', fieldId: restricted, operator: 'isNotEmpty' },
            { id: 'gone', fieldId: gone, operator: 'isNotEmpty' },
          ],
        },
      }),
    });
    sessions.push(setup.session);
    mount(
      <RestrictedFields.Provider value={new Set([restricted])}>
        <Harness
          session={setup.session}
          viewId={setup.ids.viewId}
          View={() => <div />}
          Settings={ChartSettings}
        />
      </RestrictedFields.Provider>,
    );
    expect(await screen.findByRole('button', { name: 'Filtered by 1 field' })).toBeDefined();
  });

  it('says what it needs when nothing is set up, and why when it can’t draw', async () => {
    await open({ plain: true });
    expect(screen.getByRole('heading', { name: 'Choose what to chart' })).toBeDefined();
    expect(
      screen.getByText(
        'Pick a field in Group by above, such as a single select or a date, to chart the records by it.',
      ),
    ).toBeDefined();
    cleanup();
    await open({ role: 'reader' });
    expect(screen.getByText('This chart isn’t set up yet.')).toBeDefined();
    cleanup();
    const failing = await summaryFixture('chart', { config: byStatus });
    sessions.push(failing.session);
    let answer: ViewAggregate = { kind: 'error', messageKey: 'dashboards.tile.badAggregate' };
    failing.server.viewAggregateResponder = () => answer;
    mount(
      <Harness
        session={failing.session}
        viewId={failing.ids.viewId}
        View={ChartView}
        Settings={ChartSettings}
      />,
    );
    expect(await screen.findByText('That calculation doesn’t fit its field.', {}, FIRST_DRAW)).toBeDefined();
    answer = {
      kind: 'chart',
      categories: [{ key: OPEN, label: 'Open' }],
      series: [{ key: null, label: '', values: [7] }],
      capped: { categories: true, series: false },
    };
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Showing the first 1,000 categories.')).toBeDefined();
    await waitFor(() => expect(drawn()).toEqual([[7]]));
  });

  it('starts a new chart on a single select, or on a date by month, counting records', async () => {
    const { session, ids } = await summaryFixture('chart');
    sessions.push(session);
    const schema = session.getSchema();
    const table = schema.tableById.get(ids.tableId)!;
    const fields = schema.fields.get(ids.tableId)!;
    const byType = (type: string) => fields.filter((field) => field.type === type);
    expect(VIEW_DEFINITIONS.chart.initialConfig(table, fields).chart).toMatchObject({
      groupBy: { fieldId: ids.status, dateBucket: null },
      value: { fn: 'count', fieldId: null },
    });
    expect(
      VIEW_DEFINITIONS.chart.initialConfig(table, [...byType('text'), ...byType('date')]).chart,
    ).toMatchObject({
      groupBy: { fieldId: ids.due, dateBucket: 'month' },
    });
    expect(VIEW_DEFINITIONS.chart.initialConfig(table, byType('text')).chart?.groupBy).toBeNull();
  });
});

import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newId, type SummaryKind, type ViewAggregate } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../data';
import { useSchema } from '../../data/hooks';
import { FakeServer } from '../../data/testing';
import type { DatabaseSession, ViewRows } from '../../data/types';
import { i18n } from '../../i18n';
import { useViewConfig } from '../../screens/database/screen/useViewConfig';
import { renderShell } from '../../screens/database/shell/test-support';
import { GridView } from '../GridView';
import { seedTable } from '../test-support';

/**
 * The document these tests run in lays nothing out, so the grid is given a size to draw into:
 * its scroller reports one, and every observer of sizes hears about it at once.
 */
const layout = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!,
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!,
};
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe() {
        // No entries: the grid reads sizes itself, and React Aria's own observers ignore an empty list.
        queueMicrotask(() => this.callback([]));
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const sized = (size: number, original: PropertyDescriptor) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('rio-grid__scroller') ? size : original.get!.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized(1400, layout.width));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized(400, layout.height));
});

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', layout.width);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', layout.height);
  vi.unstubAllGlobals();
});

const red = newId('choice');
const blue = newId('choice');

/** Five projects, one of them nearly empty, with a summary chosen for some of their fields. */
/** The fields' IDs by name */
interface Ids {
  name: string;
  amount: string;
  due: string;
  done: string;
  notes: string;
  tags: string;
}

async function projects(summaries: (ids: Ids) => Record<string, SummaryKind> = () => ({})) {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Amount', type: 'currency', options: { code: 'USD' } },
      { name: 'Due', type: 'date' },
      { name: 'Done', type: 'checkbox' },
      { name: 'Notes', type: 'text' },
      {
        name: 'Tags',
        type: 'multipleSelect',
        options: {
          choices: [
            { id: red, name: 'Red', color: 'red' },
            { id: blue, name: 'Blue', color: 'blue' },
          ],
        },
      },
    ],
    5,
    (index, [name, amount, due, done, notes, tags]) =>
      [
        {
          [name!]: 'Alpha',
          [amount!]: 100,
          [due!]: '2026-01-15',
          [done!]: true,
          [notes!]: 'First',
          [tags!]: [red],
        },
        { [name!]: 'Beta', [amount!]: 250.5, [due!]: '2026-02-01', [tags!]: [red, blue] },
        { [name!]: 'Gamma', [amount!]: 50, [due!]: '2026-02-20', [done!]: true, [notes!]: 'Third' },
        { [name!]: 'Delta', [tags!]: [blue] },
        { [name!]: 'Epsilon', [amount!]: 75, [due!]: '2026-03-03', [notes!]: 'Fifth' },
      ][index]!,
  );
  const [name, amount, due, done, notes, tags] = fixture.ids as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const ids: Ids = { name, amount, due, done, notes, tags };
  const view = fixture.database.schema.views.find((item) => item.id === fixture.viewId)!;
  view.config.summaries = summaries(ids);
  return { server, fixture, ids };
}

/** The grid as the database screen shows it, with its settings saved the way the screen saves them. */
function Grid({
  session,
  rows,
  viewId,
  tableId,
}: {
  session: DatabaseSession;
  rows: ViewRows;
  viewId: string;
  tableId: string;
}) {
  const schema = useSchema(session)!;
  const view = schema.viewById.get(viewId)!;
  const fields = schema.fields.get(tableId)!;
  const { config, change } = useViewConfig(session, view, fields);
  return (
    <GridView
      session={session}
      rows={rows}
      table={schema.tableById.get(tableId)!}
      view={{ ...view, config }}
      fields={fields}
      format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
      peers={[]}
      onConfig={change}
      onExpand={vi.fn()}
      onField={vi.fn()}
      onFilter={vi.fn()}
    />
  );
}

async function open(setup: Awaited<ReturnType<typeof projects>>) {
  const session = await openDatabase(setup.fixture.databaseId, setup.server.deps());
  const rows = session.openView(setup.fixture.viewId);
  dispose.push(() => {
    rows.close();
    session.close();
  });
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const view = renderShell(
    <Grid session={session} rows={rows} viewId={setup.fixture.viewId} tableId={setup.fixture.tableId} />,
  );
  /** The footer cell a screen reader reads with this name */
  const footer = (name: string) => screen.findByRole('gridcell', { name });
  const saved = () =>
    setup.fixture.database.schema.views.find((item) => item.id === setup.fixture.viewId)!.config.summaries;
  return { ...view, session, rows, footer, saved };
}

describe('the summary row', () => {
  it('counts the view’s records and shows each column’s summary formatted like its field', async () => {
    const setup = await projects((ids) => ({
      [ids.amount]: 'sum',
      [ids.due]: 'earliest',
      [ids.done]: 'checked',
      [ids.notes]: 'percentFilled',
      [ids.tags]: 'unique',
    }));
    const grid = await open(setup);
    expect(await grid.footer('5 records')).toBeDefined();
    const sum = await grid.footer('Sum $475.50 (Amount)');
    // The summary's name reads first and its value after it, as the column aligns them.
    expect(within(sum).getByText('Sum')).toBeDefined();
    expect(within(sum).getByText('$475.50')).toBeDefined();
    expect(sum.getAttribute('aria-haspopup')).toBe('menu');
    expect(await grid.footer('Earliest Jan 15, 2026 (Due)')).toBeDefined();
    expect(await grid.footer('Checked 2 (Done)')).toBeDefined();
    expect(await grid.footer('Percent filled 60% (Notes)')).toBeDefined();
    expect(await grid.footer('Unique 2 (Tags)')).toBeDefined();
    // The primary field's footer counts records, so it has no summaries to choose from.
    expect((await grid.footer('5 records')).hasAttribute('aria-haspopup')).toBe(false);
  });

  it('chooses a summary from a column’s footer menu, offering what fits its field, and saves it with the view', async () => {
    const setup = await projects();
    const grid = await open(setup);
    await userEvent.click(await grid.footer('Summarize: Amount, no summary'));
    const menu = await screen.findByRole('menu', { name: 'Summary for Amount' });
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual([
      'None',
      'Count',
      'Filled',
      'Empty',
      'Percent filled',
      'Unique',
      'Sum',
      'Average',
      'Median',
      'Minimum',
      'Maximum',
      'Range',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'None' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Average' }));
    expect(await grid.footer('Average $118.88 (Amount)')).toBeDefined();
    await waitFor(() => expect(grid.saved()).toEqual({ [setup.ids.amount]: 'average' }));

    await userEvent.click(await grid.footer('Summarize: Due, no summary'));
    const dates = await screen.findByRole('menu', { name: 'Summary for Due' });
    expect(within(dates).queryByRole('menuitemradio', { name: 'Sum' })).toBeNull();
    await userEvent.click(within(dates).getByRole('menuitemradio', { name: 'Range' }));
    expect(await grid.footer('Range 47 days (Due)')).toBeDefined();

    await userEvent.click(await grid.footer('Summarize: Done, no summary'));
    const boxes = await screen.findByRole('menu', { name: 'Summary for Done' });
    expect(within(boxes).queryByRole('menuitemradio', { name: 'Filled' })).toBeNull();
    await userEvent.click(within(boxes).getByRole('menuitemradio', { name: 'Unchecked' }));
    expect(await grid.footer('Unchecked 3 (Done)')).toBeDefined();

    // None takes the summary away again.
    await userEvent.click(await grid.footer('Average $118.88 (Amount)'));
    const again = await screen.findByRole('menu', { name: 'Summary for Amount' });
    expect(within(again).getByRole('menuitemradio', { name: 'Average' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.click(within(again).getByRole('menuitemradio', { name: 'None' }));
    expect(await grid.footer('Summarize: Amount, no summary')).toBeDefined();
    await waitFor(() =>
      expect(grid.saved()).toEqual({ [setup.ids.due]: 'range', [setup.ids.done]: 'unchecked' }),
    );
  });

  it('opens a footer cell from the keyboard, down from the last row', async () => {
    const setup = await projects((ids) => ({ [ids.amount]: 'max' }));
    const grid = await open(setup);
    await grid.footer('Maximum $250.50 (Amount)');
    const input = grid.container.querySelector<HTMLTextAreaElement>('.rio-grid-view__engine textarea')!;
    act(() => input.focus());
    await userEvent.keyboard('{Control>}{ArrowDown}{/Control}{ArrowRight}{ArrowDown}');
    await waitFor(() =>
      expect(grid.container.querySelector('.rio-grid__live')!.textContent).toBe('Maximum $250.50 (Amount)'),
    );
    expect((await grid.footer('Maximum $250.50 (Amount)')).hasAttribute('data-active')).toBe(true);
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Summary for Amount' });
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Minimum' }));
    expect(await grid.footer('Minimum $50.00 (Amount)')).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('refreshes shortly after records change, the reader’s own and other people’s', async () => {
    const setup = await projects((ids) => ({ [ids.amount]: 'sum' }));
    const grid = await open(setup);
    await grid.footer('Sum $475.50 (Amount)');
    act(() => {
      grid.session.run([
        {
          kind: 'record.update',
          tableId: setup.fixture.tableId,
          records: [{ id: setup.fixture.recordId(0), values: { [setup.ids.amount]: 1000 } }],
        },
      ]);
    });
    expect(await grid.footer('Sum $1,375.50 (Amount)')).toBeDefined();
    act(() => {
      setup.server.remote(setup.fixture.databaseId, [
        {
          kind: 'record.create',
          tableId: setup.fixture.tableId,
          records: [{ id: newId('record'), values: { [setup.ids.name]: 'Zeta', [setup.ids.amount]: 24.5 } }],
        },
      ]);
    });
    expect(await grid.footer('Sum $1,400.00 (Amount)')).toBeDefined();
    expect(await grid.footer('6 records')).toBeDefined();
  });

  it('shows summaries to people who can’t change the view, without offering a menu', async () => {
    const setup = await projects((ids) => ({ [ids.amount]: 'sum' }));
    setup.fixture.database.schema.database.role = 'reader';
    const grid = await open(setup);
    const sum = await grid.footer('Sum $475.50 (Amount)');
    expect(sum.hasAttribute('aria-haspopup')).toBe(false);
    const empty = await grid.footer('Summarize: Due, no summary');
    expect(within(empty).queryByText('Summarize')).toBeNull();
    await userEvent.click(sum);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it.each([
    new DOMException('The operation was aborted.', 'AbortError'),
    new TypeError('Fetch API cannot load /aggregate due to access control checks.'),
    new TypeError('NetworkError when attempting to fetch resource.'),
  ])('handles a pending aggregate refresh after unmount: %s', async (error) => {
    const setup = await projects((ids) => ({ [ids.amount]: 'sum' }));
    const grid = await open(setup);
    await grid.footer('Sum $475.50 (Amount)');
    let reject!: (error: unknown) => void;
    const pending = new Promise<ViewAggregate>((_, fail) => {
      reject = fail;
    });
    let signal: AbortSignal | undefined;
    const aggregate = vi.spyOn(grid.session, 'viewAggregate').mockImplementationOnce((_, __, abort) => {
      signal = abort;
      return pending;
    });
    dispose.push(() => aggregate.mockRestore());
    await act(async () => {
      await grid.session.run([
        {
          kind: 'record.update',
          tableId: setup.fixture.tableId,
          records: [{ id: setup.fixture.recordId(0), values: { [setup.ids.amount]: 1000 } }],
        },
      ]).done;
    });
    await waitFor(() => expect(aggregate).toHaveBeenCalledTimes(1));
    const unhandled: unknown[] = [];
    const capture = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', capture);
    dispose.push(() => process.off('unhandledRejection', capture));
    grid.unmount();
    expect(signal?.aborted).toBe(true);
    reject(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});

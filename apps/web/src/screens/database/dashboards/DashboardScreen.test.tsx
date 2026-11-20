import { i18n } from '@lingui/core';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardData } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing, session as identity } from '../share/testing';
import { DashboardScreen } from './DashboardScreen';
import { closeAll, dashboardFixture, everyKind, type DashboardFixture } from './test-support';

const charts = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, mounted: 0, disposed: 0 }));
vi.mock('./echarts', () => ({
  mountChart: () => {
    charts.mounted++;
    return {
      update: (option: Record<string, unknown>) => charts.options.push(option),
      resize: () => undefined,
      dispose: () => {
        charts.disposed++;
      },
    };
  },
}));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  charts.options = [];
  charts.mounted = charts.disposed = 0;
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
});

function Screen({ session, dashboardId }: { session: DatabaseSession; dashboardId: string }) {
  const schema = useSchema(session);
  const dashboard = schema?.dashboardById.get(dashboardId);
  return schema && dashboard ? (
    <DashboardScreen session={session} schema={schema} dashboard={dashboard} refreshDelay={20} />
  ) : null;
}

async function open(options: Parameters<typeof dashboardFixture>[0] = {}): Promise<DashboardFixture> {
  const setup = await dashboardFixture(options);
  sessions.push(setup.session);
  renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
  return setup;
}

const tile = (name: string) => screen.getByRole('article', { name });
const lastChart = () => charts.options.at(-1)!;

describe('the dashboard screen', () => {
  it('shows each kind of tile with its data', async () => {
    const setup = await open({ tiles: everyKind });
    expect(screen.getByRole('heading', { level: 2, name: 'Operations' })).toBeDefined();
    await waitFor(() => expect(within(tile('Records')).getByText('4')).toBeDefined());
    expect(within(tile('Records')).getByText('4 records')).toBeDefined();
    expect(within(tile('Total')).getByText('6')).toBeDefined();
    const links = within(tile('Latest')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Record 1', 'Record 2', 'Record 3']);
    expect(links[0]!.getAttribute('href')).toBe(
      `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}/${setup.fixture.recordId(0)}`,
    );
    expect(within(tile('Latest')).getAllByText('Number')).toHaveLength(3);
    expect(within(tile('Latest')).getByText('4 records')).toBeDefined();
    const note = tile('Read me');
    expect(within(note).getByRole('heading', { level: 5, name: 'Goals' })).toBeDefined();
    expect(note.querySelector('strong')?.textContent).toBe('every');
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    expect(within(tile('By status')).getByRole('img', { name: 'By status' })).toBeDefined();
    expect(lastChart().xAxis).toMatchObject({ type: 'category', data: ['Open', 'Done'] });
    expect((lastChart().series as Array<{ data: unknown }>)[0]!.data).toEqual([2, 2]);
    // One request carries every data tile, with the person's time zone.
    expect(setup.dataRequests()).toHaveLength(1);
    expect(setup.dataRequests()[0]!.options.body).toEqual({
      tileIds: ['tileCount01', 'tileTotal01', 'tileChart01', 'tileList01'],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('puts the chart’s data in an accessible table behind a toggle', async () => {
    await open({ tiles: everyKind });
    const chart = tile('By status');
    await userEvent.click(await within(chart).findByRole('button', { name: 'Show as table' }));
    const table = within(chart).getByRole('table', { name: 'By status' });
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
    expect(within(chart).queryByRole('img')).toBeNull();
    await userEvent.click(within(chart).getByRole('button', { name: 'Show as chart' }));
    expect(await within(chart).findByRole('img', { name: 'By status' })).toBeDefined();
    expect(within(chart).queryByRole('table')).toBeNull();
  });

  it('shows each tile loading on its own, then its data', async () => {
    const setup = await dashboardFixture({ tiles: everyKind });
    sessions.push(setup.session);
    let answer: (data: DashboardData) => void = () => undefined;
    setup.server.dashboardResponder = () =>
      new Promise<DashboardData>((resolve) => {
        answer = resolve;
      });
    renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
    for (const name of ['Records', 'Total', 'By status', 'Latest']) {
      expect(within(tile(name)).getByRole('progressbar', { name: 'Loading' })).toBeDefined();
      expect(tile(name).querySelector('[aria-busy="true"]')).not.toBeNull();
    }
    expect(within(tile('Read me')).queryByRole('progressbar')).toBeNull();
    await waitFor(() => expect(setup.dataRequests()).toHaveLength(1));
    act(() =>
      answer({
        tiles: {
          tileCount01: { kind: 'number', value: 12, records: 12 },
          tileTotal01: { kind: 'number', value: null, records: 0 },
        },
      }),
    );
    expect(await within(tile('Records')).findByText('12')).toBeDefined();
    expect(within(tile('Total')).getByText('(Empty)')).toBeDefined();
    expect(within(tile('Total')).getByText('0 records')).toBeDefined();
    // A tile the answer left out can't show anything, and says so.
    expect(within(tile('Latest')).getByText('This tile can’t show its data right now.')).toBeDefined();
  });

  it('words each tile’s own error through the server’s messages and tries again', async () => {
    const setup = await dashboardFixture({ tiles: everyKind });
    sessions.push(setup.session);
    setup.server.dashboardResponder = () => ({
      tiles: {
        tileCount01: { kind: 'error', messageKey: 'dashboards.tile.fieldMissing' },
        tileTotal01: { kind: 'error', messageKey: 'dashboards.tile.somethingNew' },
        tileChart01: { kind: 'error', messageKey: 'dashboards.tile.tableMissing' },
        tileList01: { kind: 'records', rows: [], total: 0 },
      },
    });
    renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
    expect(
      await within(tile('Records')).findByText(
        'A field this tile uses was deleted, or you don’t have access to it.',
      ),
    ).toBeDefined();
    expect(within(tile('Total')).getByText('This tile can’t show its data right now.')).toBeDefined();
    expect(
      within(tile('By status')).getByText('This tile’s table was deleted, or you don’t have access to it.'),
    ).toBeDefined();
    expect(within(tile('Latest')).getByText('0 records')).toBeDefined();
    setup.server.dashboardResponder = undefined;
    setup.server.failNext(500, '/data');
    await userEvent.click(within(tile('Records')).getByRole('button', { name: 'Try again' }));
    expect(await within(tile('Records')).findByText('Something went wrong on the server.')).toBeDefined();
    await userEvent.click(within(tile('Records')).getByRole('button', { name: 'Try again' }));
    expect(await within(tile('Records')).findByText('4 records')).toBeDefined();
    expect(setup.dataRequests().at(-1)!.options.body).toMatchObject({ tileIds: ['tileCount01'] });
  });

  it('refreshes the tiles of a table after its records change, once for a burst', async () => {
    const setup = await open({ tiles: everyKind });
    await waitFor(() => expect(within(tile('Records')).getByText('4 records')).toBeDefined());
    expect(setup.dataRequests()).toHaveLength(1);
    await act(async () => {
      await setup.session.run([
        {
          kind: 'record.create',
          tableId: setup.fixture.tableId,
          records: [{ id: 'rec00000000000091', values: {} }],
        },
      ]).done;
      setup.server.remote(setup.fixture.databaseId, [
        {
          kind: 'record.create',
          tableId: setup.fixture.tableId,
          records: [{ id: 'rec00000000000092', values: {} }],
        },
      ]);
    });
    await waitFor(() => expect(within(tile('Records')).getByText('6 records')).toBeDefined());
    expect(setup.dataRequests()).toHaveLength(2);
    expect(setup.dataRequests()[1]!.options.body).toMatchObject({
      tileIds: ['tileCount01', 'tileTotal01', 'tileChart01', 'tileList01'],
    });
  });

  it('invites adding a tile to an empty dashboard', async () => {
    await open();
    expect(screen.getByText(/^This dashboard is empty\./).textContent).toBe(
      'This dashboard is empty.  Add a tile to show a number, a chart, a pivot table, some records, or a note.',
    );
    expect(screen.queryByRole('button', { name: 'Edit layout' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a tile' }));
    expect(screen.getByRole('dialog', { name: 'Add a tile' })).toBeDefined();
  });

  it('shows readers the tiles without menus or layout controls', async () => {
    await open({ tiles: everyKind, role: 'reader' });
    await waitFor(() => expect(within(tile('Records')).getByText('4 records')).toBeDefined());
    for (const name of ['Edit layout', 'Add a tile', 'More for Records', 'More for Read me'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dashboard filters' }));
    const filters = screen.getByRole('dialog', { name: 'Dashboard filters' });
    expect(within(filters).getByRole('button', { name: 'Add condition' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('stacks tiles in reading order and offers layout editing on phones', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('max-width: 767px'),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    await open({ tiles: (ids) => [...everyKind(ids)].reverse() });
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: /Move or resize/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Add a tile' })).toBeDefined();
    expect(
      screen
        .getAllByRole('article')
        .map(
          (article) => article.getAttribute('aria-labelledby') && article.querySelector('h3')?.textContent,
        ),
    ).toEqual(['Records', 'Total', 'By status', 'Latest', 'Read me']);
  });

  it('opens a record from a records tile over the dashboard', async () => {
    await open({ tiles: everyKind });
    await userEvent.click(await within(tile('Latest')).findByRole('link', { name: 'Record 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record 2' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['card', 'Escape'],
    ['card', 'Close'],
    ['panel', 'Escape'],
    ['panel', 'Close'],
  ] as const)('returns focus to the opening link after closing a %s with %s', async (layout, action) => {
    const setup = await dashboardFixture({ tiles: everyKind });
    sessions.push(setup.session);
    renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />, {
      ...identity,
      preferences: { ...identity.preferences, recordLayout: layout },
    });
    const user = userEvent.setup();
    const link = await within(tile('Latest')).findByRole('link', { name: 'Record 2' });
    link.focus();
    await user.keyboard('{Enter}');
    const role = layout === 'card' ? 'dialog' : 'region';
    const record = await screen.findByRole(role, { name: 'Record 2' });
    expect(record.contains(document.activeElement)).toBe(true);
    if (action === 'Escape') await user.keyboard('{Escape}');
    else await user.click(within(record).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole(role, { name: 'Record 2' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
  });
});

describe('tile menus', () => {
  it('edits, duplicates, and deletes a tile, with an undo for the delete', async () => {
    const setup = await open({ tiles: everyKind });
    const notices = vi.spyOn(toast, 'show');
    await userEvent.click(screen.getByRole('button', { name: 'More for Records' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit tile' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Open work');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save tile' }));
    expect(screen.getByRole('article', { name: 'Open work' })).toBeDefined();
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    const edited = setup.updates()[0]!.config!.tiles.find((item) => item.id === 'tileCount01')!;
    expect(edited).toMatchObject({ title: 'Open work', place: { x: 0, y: 0, w: 3, h: 2 } });

    await userEvent.click(screen.getByRole('button', { name: 'More for Total' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(screen.getAllByRole('article', { name: 'Total' })).toHaveLength(2);
    await waitFor(() => expect(setup.updates()).toHaveLength(2));
    const copy = setup.updates()[1]!.config!.tiles.at(-1)!;
    expect(copy).toMatchObject({ kind: 'number', title: 'Total', place: { x: 0, y: 6, w: 3, h: 2 } });
    expect(copy.id).not.toBe('tileTotal01');

    await userEvent.click(screen.getByRole('button', { name: 'More for Read me' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByRole('article', { name: 'Read me' })).toBeNull();
    expect(notices).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Deleted Read me' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(3));
    const undo = notices.mock.calls.at(-1)![0].action!;
    await act(async () => {
      undo.onPress();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByRole('article', { name: 'Read me' })).toBeDefined();
  });
});

describe('undo on the dashboard', () => {
  it('undoes and redoes the last change with the keyboard, but not while typing', async () => {
    const setup = await open({ tiles: everyKind });
    await userEvent.click(screen.getByRole('button', { name: 'More for Read me' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    screen.getByRole('button', { name: 'Add a tile' }).focus();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(await screen.findByRole('article', { name: 'Read me' })).toBeDefined();
    await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Read me' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Add a tile' }));
    const title = within(screen.getByRole('dialog', { name: 'Add a tile' })).getByRole('textbox', {
      name: 'Title',
    });
    await userEvent.type(title, 'Draft');
    await userEvent.keyboard('{Control>}z{/Control}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('article', { name: 'Read me' })).toBeNull();
  });
});

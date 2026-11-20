import { i18n } from '@lingui/core';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTHER_GROUP_KEY, decodeWhere, type Tile } from '@riosoma/contracts';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing } from '../share/testing';
import { DashboardScreen, type DashboardScreenProps } from './DashboardScreen';
import { drillToken, parseDrill } from './drill';
import { DONE, OPEN, closeAll, dashboardFixture, everyKind, type DashboardFixture } from './test-support';

const charts = vi.hoisted(() => ({
  pick: undefined as undefined | ((point: { dataIndex: number; seriesIndex: number }) => void),
}));
vi.mock('./echarts', () => ({
  mountChart: (
    _element: HTMLElement,
    onPick?: (point: { dataIndex: number; seriesIndex: number }) => void,
  ) => {
    charts.pick = onPick;
    return { update: () => undefined, resize: () => undefined, dispose: () => undefined };
  },
}));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  charts.pick = undefined;
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
});

type Linked = Pick<DashboardScreenProps, 'drill' | 'onDrillChange' | 'onOpenView'>;

function Screen({
  session,
  dashboardId,
  ...linked
}: { session: DatabaseSession; dashboardId: string } & Linked) {
  const schema = useSchema(session);
  const dashboard = schema?.dashboardById.get(dashboardId);
  return schema && dashboard ? (
    <DashboardScreen session={session} schema={schema} dashboard={dashboard} refreshDelay={20} {...linked} />
  ) : null;
}

async function open(
  options: Parameters<typeof dashboardFixture>[0] = { tiles: everyKind },
  linked: Linked = {},
): Promise<DashboardFixture> {
  const setup = await dashboardFixture(options);
  sessions.push(setup.session);
  renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} {...linked} />);
  return setup;
}

const tile = (name: string) => screen.getByRole('article', { name });
const drillRequests = (setup: DashboardFixture) =>
  setup.server.requests.filter((request) => request.path.endsWith('/records'));

describe('the records behind a chart tile', () => {
  it('opens a sheet named for the bar, with its records and a link to a grid view filtered the same way', async () => {
    const onOpenView = vi.fn();
    const setup = await open({ tiles: everyKind }, { onOpenView });
    await waitFor(() => expect(charts.pick).toBeDefined());
    // The drawn chart says where its values can be reached without a pointer.
    const image = within(tile('By status')).getByRole('img', { name: 'By status' });
    expect(document.getElementById(image.getAttribute('aria-describedby')!)?.textContent).toMatch(
      /^To reach each value from the keyboard, show the chart as a table\./,
    );
    act(() => charts.pick!({ dataIndex: 1, seriesIndex: 0 }));
    const sheet = await screen.findByRole('dialog', { name: 'Status is Done, 2 records' });
    expect(drillRequests(setup).at(-1)!.options.body).toEqual({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      slice: { category: DONE },
      offset: 0,
      limit: 50,
    });
    const names = within(sheet)
      .getAllByRole('listitem')
      .map((item) => within(item).getAllByRole('link')[0]!.textContent);
    expect(names).toEqual(['Record 2', 'Record 4']);
    // Each record shows the value the chart groups it by.
    expect(within(sheet).getAllByText('Done')).toHaveLength(2);
    const link = within(sheet).getByRole('link', { name: 'Open in Grid' });
    const href = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(href.pathname).toBe(
      `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    );
    expect(decodeWhere(href.searchParams.get('where')!)).toEqual({
      conjunction: 'and',
      conditions: [{ id: 'drill1', fieldId: setup.ids.status, operator: 'is', value: DONE }],
    });
    await userEvent.click(link);
    expect(onOpenView).toHaveBeenCalledWith(
      setup.fixture.tableId,
      setup.fixture.viewId,
      href.searchParams.get('where'),
    );
  });

  it('reaches every value from the keyboard, opens with Enter, and gives focus back when Escape closes it', async () => {
    // A reader has no tile menu, so the table comes right after its toggle.
    await open({ tiles: everyKind, role: 'reader' });
    const chart = tile('By status');
    await userEvent.click(await within(chart).findByRole('button', { name: 'Show as table' }));
    // The table's region, then each value in turn, named by its category and its value.
    await userEvent.tab();
    expect(document.activeElement).toBe(within(chart).getByRole('region', { name: 'By status' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(within(chart).getByRole('button', { name: 'Open, 2' }));
    await userEvent.tab();
    const done = within(chart).getByRole('button', { name: 'Done, 2' });
    expect(document.activeElement).toBe(done);
    expect(done.getAttribute('aria-haspopup')).toBe('dialog');
    await userEvent.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog', { name: 'Status is Done, 2 records' });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(done));
  });

  it('keeps the open part in the address, so a link opens it, and clears it on close', async () => {
    const onDrillChange = vi.fn();
    const drill = drillToken({ tileId: 'tileChart01', slice: { category: OPEN } });
    await open({ tiles: everyKind }, { drill, onDrillChange });
    const sheet = await screen.findByRole('dialog', { name: 'Status is Open, 2 records' });
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(onDrillChange).toHaveBeenLastCalledWith(null);
  });

  it('puts right an address that names no chart on the dashboard', async () => {
    const onDrillChange = vi.fn();
    await open(
      { tiles: everyKind },
      { drill: drillToken({ tileId: 'tileGone001', slice: { category: OPEN } }), onDrillChange },
    );
    await waitFor(() => expect(onDrillChange).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens one part of a divided chart, and names both sides of it', async () => {
    const divided = (ids: Parameters<typeof everyKind>[0]): Tile[] =>
      everyKind(ids).map((item) =>
        item.kind === 'chart'
          ? { ...item, groupBy: { fieldId: ids.number, dateBucket: null }, seriesBy: ids.status }
          : item,
      );
    const setup = await open({ tiles: divided });
    await waitFor(() => expect(charts.pick).toBeDefined());
    await waitFor(() => expect(within(tile('By status')).queryByRole('progressbar')).toBeNull());
    // Category 0 holds record 1, which is Open: the first series.
    act(() => charts.pick!({ dataIndex: 0, seriesIndex: 0 }));
    expect(
      await screen.findByRole('dialog', { name: 'Number is 0 and Status is Open, 1 record' }),
    ).toBeDefined();
    expect(drillRequests(setup).at(-1)!.options.body).toMatchObject({ slice: { category: 0, series: OPEN } });
  });

  it('explains a part it can’t list instead of listing something close', async () => {
    const setup = await open();
    setup.server.tileRecordsResponder = () => ({
      kind: 'error',
      messageKey: 'dashboards.drill.otherUnsupported',
    });
    await waitFor(() => expect(charts.pick).toBeDefined());
    act(() => charts.pick!({ dataIndex: 0, seriesIndex: 0 }));
    const sheet = await screen.findByRole('dialog', { name: 'Status is Open' });
    expect(within(sheet).getByRole('alert').textContent).toContain('no filter picks out exactly its records');
    expect(within(sheet).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(sheet).queryByRole('link')).toBeNull();
  });

  it('says so when no grid view can show the records', async () => {
    const setup = await open();
    setup.server.tileRecordsResponder = (_dashboard, _tile, request, database) => ({
      kind: 'records',
      rows: [database.rows(setup.fixture.tableId).get(setup.fixture.recordId(1))!],
      total: 1,
      open: null,
    });
    await waitFor(() => expect(charts.pick).toBeDefined());
    act(() => charts.pick!({ dataIndex: 1, seriesIndex: 0 }));
    const sheet = await screen.findByRole('dialog', { name: 'Status is Done, 1 record' });
    expect(
      within(sheet).getByText(
        'No grid view of this table can show exactly these records, so they’re listed only here.',
      ),
    ).toBeDefined();
  });
});

describe('drill tokens', () => {
  it('round-trip every kind of key, and refuse anything else', () => {
    const cases = [
      { tileId: 'tileChart01', slice: { category: null } },
      { tileId: 'tileChart01', slice: { category: OTHER_GROUP_KEY } },
      { tileId: 'tileChart01', slice: { category: 12.5 } },
      { tileId: 'tileChart01', slice: { category: 'a:b/c d%é', series: null } },
      { tileId: 'tile_0-x', slice: { category: 'true', series: OTHER_GROUP_KEY } },
    ];
    for (const drill of cases) expect(parseDrill(drillToken(drill))).toEqual(drill);
    for (const text of [
      '',
      'tile',
      'tileChart01',
      'x:e',
      'tileChart01:q',
      'tileChart01:n',
      'tileChart01:e:e:e',
    ])
      expect(parseDrill(text)).toBeNull();
  });
});

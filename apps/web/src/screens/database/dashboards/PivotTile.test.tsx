import { i18n } from '@lingui/core';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FieldMeta,
  GROUP_KEY_MAX_LENGTH,
  PivotSettings,
  type DashboardFilters,
  type Tile,
} from '@riosoma/contracts';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing } from '../share/testing';
import { DashboardScreen } from './DashboardScreen';
import { drillToken, parseDrill } from './drill';
import { dataKey } from './data';
import { DrillDrawer } from './DrillDrawer';
import { DONE, OPEN, closeAll, dashboardFixture, type DashboardFixture } from './test-support';

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
});

function Screen({
  session,
  dashboardId,
  filters,
}: {
  session: DatabaseSession;
  dashboardId: string;
  filters?: DashboardFilters;
}) {
  const schema = useSchema(session);
  const dashboard = schema?.dashboardById.get(dashboardId);
  return schema && dashboard ? (
    <DashboardScreen
      session={session}
      schema={schema}
      dashboard={dashboard}
      refreshDelay={20}
      filters={filters}
    />
  ) : null;
}

async function open(
  filters?: (ids: { tableId: string; number: string }) => DashboardFilters,
  prepare?: (setup: DashboardFixture) => void,
) {
  const setup = await dashboardFixture({
    tiles: (ids) => [
      {
        id: 'tilePivot01',
        kind: 'pivot',
        title: 'Totals by status',
        place: { x: 0, y: 0, w: 6, h: 4 },
        source: { tableId: ids.tableId, viewId: null, filter: null },
        pivot: PivotSettings.parse({
          rows: [{ fieldId: ids.status }],
          values: [{ fn: 'sum', fieldId: ids.number }],
        }),
      },
    ],
  });
  sessions.push(setup.session);
  prepare?.(setup);
  renderSharing(
    <Screen session={setup.session} dashboardId={setup.dashboard.id} filters={filters?.(setup.ids)} />,
  );
  await screen.findByRole('table', { name: 'Totals by status' });
  return setup;
}

function LinkedRows({ setup, nested }: { setup: DashboardFixture; nested: boolean }) {
  const schema = useSchema(setup.session);
  if (!schema) return null;
  const fields = (schema.fields.get(setup.ids.tableId) ?? []).map((field) =>
    field.id === setup.ids.status || field.id === setup.ids.name
      ? FieldMeta.parse({
          ...field,
          name: field.id === setup.ids.status ? 'Client' : 'Project',
          type: 'link',
          options: { linkedTableId: setup.ids.tableId },
        })
      : field,
  );
  const client = 'rec00000000000001';
  const project = 'rec00000000000002';
  return (
    <DrillDrawer
      session={setup.session}
      schema={{ ...schema, fields: new Map([[setup.ids.tableId, fields]]) }}
      dashboardId={setup.dashboard.id}
      tile={{
        id: 'tilePivot01',
        kind: 'pivot',
        title: '',
        place: { x: 0, y: 0, w: 6, h: 4 },
        source: { tableId: setup.ids.tableId, viewId: null, filter: null },
        pivot: PivotSettings.parse({ rows: [{ fieldId: setup.ids.status }, { fieldId: setup.ids.name }] }),
      }}
      slice={{ row: nested ? [client, project] : [client] }}
      data={{
        kind: 'pivot',
        columns: [],
        totals: null,
        capped: { rows: false, columns: false },
        rows: [
          { keys: ['rec00000000000003'], label: 'Other client', cells: [], total: [1] },
          { keys: ['rec00000000000003', project], label: 'Renewal', cells: [], total: [1] },
          { keys: [client], label: 'Acme', cells: [], total: [1] },
          { keys: [client, project], label: 'Launch', cells: [], total: [1] },
        ],
      }}
      format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
      onOpenRecord={() => {}}
      onClose={() => {}}
    />
  );
}

describe('pivot dashboard tiles', () => {
  it('offers an accessible table, opens a cell with Enter, and returns focus on Escape', async () => {
    const setup = await open();
    const table = screen.getByRole('table', { name: 'Totals by status' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['StatusSum of Number', 'Open2', 'Done4', 'Total6']);
    const cell = within(table).getByRole('button', { name: 'Open, 2' });
    cell.focus();
    await userEvent.keyboard('{Enter}');
    const drawer = await screen.findByRole('dialog', { name: 'Status is Open, 2 records' });
    expect(within(drawer).getByRole('link', { name: 'Record 1' })).toBeDefined();
    expect(within(drawer).getByRole('link', { name: 'Record 3' })).toBeDefined();
    expect(within(drawer).queryByRole('link', { name: 'Record 2' })).toBeNull();
    expect(
      setup.server.requests.filter((request) => request.path.endsWith('/records')).at(-1)?.options.body,
    ).toMatchObject({ slice: { row: [OPEN] } });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(cell);
  });

  it('refreshes after record changes, duplicates its definition, and resizes with the keyboard', async () => {
    const setup = await open();
    setup.server.remote(setup.fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: setup.ids.tableId,
        records: [{ id: setup.fixture.recordId(0), values: { [setup.ids.number]: 10 } }],
      },
    ]);
    await screen.findByRole('button', { name: 'Open, 12' });
    await userEvent.click(screen.getByRole('button', { name: 'More for Totals by status' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Duplicate(?: |$)/ }));
    await waitFor(() => expect(screen.getAllByRole('table', { name: 'Totals by status' })).toHaveLength(2));
    const saved = setup.updates().at(-1)!.config!.tiles;
    expect(saved[1]).toMatchObject({
      kind: 'pivot',
      pivot: saved[0]!.kind === 'pivot' ? saved[0]!.pivot : undefined,
    });
    expect(saved[1]!.id).not.toBe(saved[0]!.id);
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    const handle = screen.getAllByRole('button', { name: 'Move or resize Totals by status' })[0]!;
    handle.focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(setup.updates().at(-1)!.config!.tiles[0]!.place.w).toBe(7));
  });

  it('carries dashboard filters into data and drill requests', async () => {
    const setup = await open((ids) => [
      {
        tableId: ids.tableId,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'amount', fieldId: ids.number, operator: 'gt', value: 0 }],
        },
      },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Open, 2' }));
    await screen.findByRole('dialog', { name: 'Status is Open, 1 record' });
    const records = setup.server.requests.filter((request) => request.path.endsWith('/records')).at(-1)!;
    expect(records.options.body).toMatchObject({
      filters: (setup.dataRequests()[0]!.options.body as { filters: DashboardFilters }).filters,
    });
  });

  it('changes conditions and date ranges through the dashboard controls', async () => {
    const setup = await open(undefined, (setup) => {
      const rows = setup.server.database(setup.fixture.databaseId).rows(setup.ids.tableId);
      for (let index = 0; index < 4; index++) {
        const row = rows.get(setup.fixture.recordId(index))!;
        row.values[setup.ids.due] =
          index === 1 ? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) : '2000-01-01';
        rows.set(row);
      }
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dashboard filters' }));
    const dialog = screen.getByRole('dialog', { name: 'Dashboard filters' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add condition' }));
    let condition = within(dialog).getAllByRole('group', { name: /Condition$/ })[0]!;
    await userEvent.click(within(condition).getByRole('button', { name: /Field$/ }));
    await userEvent.click(screen.getByRole('option', { name: /^Number(?: |$)/ }));
    await userEvent.click(within(condition).getByRole('button', { name: /Condition$/ }));
    await userEvent.click(screen.getByRole('option', { name: /^>(?: |$)/ }));
    await userEvent.type(within(condition).getByRole('textbox', { name: 'Value' }), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add condition' }));
    condition = within(dialog).getAllByRole('group', { name: /Condition$/ })[1]!;
    await userEvent.click(within(condition).getByRole('button', { name: /Field$/ }));
    await userEvent.click(screen.getByRole('option', { name: /^Due(?: |$)/ }));
    await userEvent.click(within(condition).getByRole('button', { name: /Condition$/ }));
    await userEvent.click(screen.getByRole('option', { name: /^is within(?: |$)/ }));
    await userEvent.click(within(condition).getByRole('button', { name: /Value$/ }));
    await userEvent.click(screen.getByRole('option', { name: /^the past month(?: |$)/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Done, 1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Status is Done, 1 record' });
    expect(within(drawer).getByRole('link', { name: 'Record 2' })).toBeDefined();
    const request = setup.server.requests.filter((request) => request.path.endsWith('/records')).at(-1)!;
    expect(request.options.body).toMatchObject({
      filters: [
        {
          tableId: setup.ids.tableId,
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId: setup.ids.number, operator: 'gt', value: 0 },
              { fieldId: setup.ids.due, operator: 'isWithin', value: { mode: 'pastMonth' } },
            ],
          },
        },
      ],
    });
    expect(setup.updates()).toEqual([]);
  });

  it.each([false, true])('names linked row groups from their full key prefix, nested: %s', async (nested) => {
    const setup = await dashboardFixture();
    sessions.push(setup.session);
    setup.server.tileRecordsResponder = () => ({ kind: 'records', rows: [], total: 1, open: null });
    renderSharing(<LinkedRows setup={setup} nested={nested} />);
    expect(
      await screen.findByRole('dialog', {
        name: nested ? 'Client is Acme and Project is Launch, 1 record' : 'Client is Acme, 1 record',
      }),
    ).toBeDefined();
  });

  it('shows a plain attention state for unavailable fields', async () => {
    const setup = await open();
    setup.server.dashboardResponder = () => ({
      tiles: { tilePivot01: { kind: 'error', messageKey: 'dashboards.tile.unavailable' } },
    });
    act(() =>
      setup.server.remote(setup.fixture.databaseId, [
        {
          kind: 'record.update',
          tableId: setup.ids.tableId,
          records: [{ id: setup.fixture.recordId(0), values: { [setup.ids.number]: 10 } }],
        },
      ]),
    );
    expect(
      await screen.findByText(/This tile needs attention\.\s+Edit it to choose fields you can see\./),
    ).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps deep links for nested cells and totals and refetches only when the query changes', () => {
    for (const slice of [
      { row: [OPEN, null, 12], column: DONE },
      { row: [] },
      {
        row: Array.from({ length: 3 }, () => '日'.repeat(GROUP_KEY_MAX_LENGTH)),
        column: '日'.repeat(GROUP_KEY_MAX_LENGTH),
      },
    ]) {
      const drill = { tileId: 'tilePivot01', slice };
      expect(parseDrill(drillToken(drill))).toEqual(drill);
    }
    expect(parseDrill('tilePivot01:p%7Bbad')).toBeNull();
    const tile: Extract<Tile, { kind: 'pivot' }> = {
      id: 'tilePivot01',
      kind: 'pivot',
      title: '',
      place: { x: 0, y: 0, w: 6, h: 4 },
      source: { tableId: 'tbl00000000000001', viewId: null, filter: null },
      pivot: PivotSettings.parse({ rows: [{ fieldId: 'fld00000000000001' }] }),
    };
    expect(dataKey({ ...tile, title: 'Updated', place: { ...tile.place, w: 7 } })).toBe(dataKey(tile));
    expect(dataKey({ ...tile, pivot: { ...tile.pivot, rowTotals: false } })).not.toBe(dataKey(tile));
  });
});

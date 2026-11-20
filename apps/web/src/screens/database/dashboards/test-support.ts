import {
  FieldMeta,
  newId,
  ViewMeta,
  type DashboardMeta,
  type DatabaseRole,
  type Tile,
} from '@riosoma/contracts';
import { openDatabase } from '../../../data/session';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';

export const OPEN = 'cho00000000000001';
export const DONE = 'cho00000000000002';

export type DashboardFixture = Awaited<ReturnType<typeof dashboardFixture>>;

/**
 * A database with Name, Number, Status, and Due fields, records numbered from zero, and one
 * dashboard holding the tiles a test asks for.  Records alternate between Open and Done, and
 * each falls due a month after the one before, from January 2026.
 */
export async function dashboardFixture(
  options: {
    tiles?: (ids: { tableId: string; name: string; number: string; status: string; due: string }) => Tile[];
    count?: number;
    role?: DatabaseRole;
    /** Adds a chart view (Due by quarter, sum of Number, split by Status) a tile can be drawn from */
    chartView?: boolean;
  } = {},
) {
  const server = new FakeServer();
  const count = options.count ?? 4;
  const fixture = server.createDatabase(count);
  const database = server.database(fixture.databaseId);
  const base = database.field(fixture.textFieldId);
  const status = FieldMeta.parse({
    ...base,
    id: newId('field'),
    name: 'Status',
    position: 2,
    type: 'singleSelect',
    options: {
      choices: [
        { id: OPEN, name: 'Open', color: 'blue' },
        { id: DONE, name: 'Done', color: 'green' },
      ],
    },
  });
  const due = FieldMeta.parse({
    ...base,
    id: newId('field'),
    name: 'Due',
    position: 3,
    type: 'date',
    options: {},
  });
  database.schema.fields.push(status, due);
  for (let index = 0; index < count; index++) {
    const row = database.rows(fixture.tableId).get(fixture.recordId(index))!;
    row.values[status.id] = index % 2 ? DONE : OPEN;
    row.values[due.id] = `${2026 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-15`;
    database.rows(fixture.tableId).set(row);
  }
  database.schema.database.role = options.role ?? 'owner';
  const ids = {
    tableId: fixture.tableId,
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    status: status.id,
    due: due.id,
  };
  const at = new Date(0).toISOString();
  const dashboard: DashboardMeta = {
    id: newId('dashboard'),
    databaseId: fixture.databaseId,
    name: 'Operations',
    position: 0,
    config: { tiles: options.tiles?.(ids) ?? [] },
    createdAt: at,
    updatedAt: at,
  };
  database.schema.dashboards = [dashboard];
  let chartViewId: string | null = null;
  if (options.chartView) {
    const view = ViewMeta.parse({
      id: newId('view'),
      tableId: fixture.tableId,
      type: 'chart',
      name: 'Revenue chart',
      position: 1,
      createdBy: null,
      createdAt: at,
      updatedAt: at,
      config: {
        chart: {
          chart: 'bar',
          groupBy: { fieldId: due.id, dateBucket: 'quarter' },
          value: { fn: 'sum', fieldId: fixture.numberFieldId },
          seriesBy: status.id,
          sort: 'valueDescending',
          stacked: true,
        },
      },
    });
    database.schema.views.push(view);
    chartViewId = view.id;
  }
  const session: DatabaseSession = await openDatabase(fixture.databaseId, server.deps());
  const updates = () =>
    server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .flatMap(
        (request) =>
          (request.options.body as { commands: Array<{ kind: string; config?: { tiles: Tile[] } }> })
            .commands,
      )
      .filter((command) => command.kind === 'dashboard.update');
  const dataRequests = () => server.requests.filter((request) => request.path.endsWith('/data'));
  return { server, fixture, session, dashboard, ids, chartViewId, updates, dataRequests };
}

/** The tiles most tests start from: one of each kind, laid out in two rows */
export function everyKind(ids: { tableId: string; number: string; status: string }): Tile[] {
  const source = { tableId: ids.tableId, viewId: null, filter: null };
  return [
    {
      id: 'tileCount01',
      kind: 'number',
      title: 'Records',
      place: { x: 0, y: 0, w: 3, h: 2 },
      source,
      value: { fn: 'count', fieldId: null },
    },
    {
      id: 'tileTotal01',
      kind: 'number',
      title: 'Total',
      place: { x: 3, y: 0, w: 3, h: 2 },
      source,
      value: { fn: 'sum', fieldId: ids.number },
    },
    {
      id: 'tileChart01',
      kind: 'chart',
      title: 'By status',
      place: { x: 6, y: 0, w: 6, h: 4 },
      source,
      chart: 'column',
      groupBy: { fieldId: ids.status, dateBucket: null },
      value: { fn: 'count', fieldId: null },
      seriesBy: null,
      sort: 'category',
      limit: 20,
      stacked: false,
    },
    {
      id: 'tileList01',
      kind: 'records',
      title: 'Latest',
      place: { x: 0, y: 2, w: 6, h: 4 },
      source,
      fieldIds: [ids.number],
      limit: 3,
    },
    {
      id: 'tileNote01',
      kind: 'text',
      title: 'Read me',
      place: { x: 6, y: 4, w: 6, h: 2 },
      text: '## Goals\n\nClose **every** ticket.',
    },
  ];
}

export function closeAll(sessions: DatabaseSession[]): void {
  for (const session of sessions.splice(0)) session.close();
}

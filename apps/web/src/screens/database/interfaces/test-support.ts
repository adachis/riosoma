import {
  FieldMeta,
  GridConfig,
  newId,
  type Block,
  type DatabaseRole,
  type InterfaceMeta,
  type InterfacePage,
  type ViewMeta,
} from '@riosoma/contracts';
import { openDatabase } from '../../../data/session';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';

export const OPEN = 'cho00000000000001';
export const DONE = 'cho00000000000002';
export const PAGE_ID = 'pageMain01';

export interface FixtureIds {
  tableId: string;
  viewId: string;
  formViewId: string;
  name: string;
  number: string;
  status: string;
}

export type InterfaceFixture = Awaited<ReturnType<typeof interfaceFixture>>;

/**
 * A database with Name, Number, and Status fields, records numbered from zero that alternate
 * between Open and Done, a form view asking for a name and a number, and one interface whose
 * first page holds the blocks a test asks for.
 */
export async function interfaceFixture(
  options: {
    blocks?: (ids: FixtureIds) => Block[];
    /** Pages after the first */
    pages?: (ids: FixtureIds) => InterfacePage[];
    count?: number;
    role?: DatabaseRole;
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
  database.schema.fields.push(status);
  for (let index = 0; index < count; index++) {
    const row = database.rows(fixture.tableId).get(fixture.recordId(index))!;
    row.values[status.id] = index % 2 ? DONE : OPEN;
    database.rows(fixture.tableId).set(row);
  }
  const at = new Date(0).toISOString();
  const form: ViewMeta = {
    id: newId('view'),
    tableId: fixture.tableId,
    type: 'form',
    name: 'Request form',
    config: GridConfig.parse({
      form: {
        title: 'New request',
        questions: [{ fieldId: fixture.textFieldId }, { fieldId: fixture.numberFieldId }],
      },
    }),
    position: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: server.userId,
  };
  database.schema.views.push(form);
  database.schema.database.role = options.role ?? 'owner';
  const ids: FixtureIds = {
    tableId: fixture.tableId,
    viewId: fixture.viewId,
    formViewId: form.id,
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    status: status.id,
  };
  const value: InterfaceMeta = {
    id: newId('interface'),
    databaseId: fixture.databaseId,
    name: 'Front desk',
    position: 0,
    pages: [
      { id: PAGE_ID, name: 'Requests', blocks: options.blocks?.(ids) ?? [] },
      ...(options.pages?.(ids) ?? []),
    ],
    createdAt: at,
    updatedAt: at,
  };
  database.schema.interfaces = [value];
  const session: DatabaseSession = await openDatabase(fixture.databaseId, server.deps());
  const commands = () =>
    server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .flatMap(
        (request) =>
          (request.options.body as { commands: Array<{ kind: string } & Record<string, unknown>> }).commands,
      );
  const updates = () =>
    commands().filter(
      (command): command is { kind: 'interface.update'; pages?: InterfacePage[] } =>
        command.kind === 'interface.update',
    );
  const recordRequests = () =>
    server.requests
      .filter((request) => request.path.endsWith('/records') && request.options.method === 'POST')
      .map((request) => request.options.body as Record<string, unknown>);
  return { server, fixture, session, value, ids, commands, updates, recordRequests };
}

const place = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** A page with one block of each kind */
export function everyBlock(ids: FixtureIds): Block[] {
  return [
    {
      id: 'blkRecords01',
      kind: 'records',
      title: 'Queue',
      place: place(0, 0, 6, 5),
      source: { tableId: ids.tableId, viewId: ids.viewId, filter: null },
      fieldIds: [ids.number, ids.status],
      display: 'list',
      showFieldNames: true,
    },
    {
      id: 'blkRecord001',
      kind: 'record',
      title: 'Details',
      place: place(6, 0, 6, 5),
      recordsBlockId: 'blkRecords01',
      fieldIds: [ids.name, ids.number],
    },
    {
      id: 'blkCount0001',
      kind: 'number',
      title: 'Open requests',
      place: place(0, 5, 3, 2),
      source: {
        tableId: ids.tableId,
        viewId: null,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'open', fieldId: ids.status, operator: 'is', value: OPEN }],
        },
      },
      value: { fn: 'count', fieldId: null },
    },
    {
      id: 'blkChart0001',
      kind: 'chart',
      title: 'By status',
      place: place(3, 5, 6, 4),
      source: { tableId: ids.tableId, viewId: null, filter: null },
      chart: 'column',
      groupBy: { fieldId: ids.status, dateBucket: null },
      value: { fn: 'count', fieldId: null },
      seriesBy: null,
      sort: 'category',
      limit: 20,
      stacked: false,
    },
    {
      id: 'blkHeading01',
      kind: 'text',
      title: '',
      place: place(0, 9, 12, 1),
      style: 'heading',
      text: 'Welcome to the desk',
    },
    {
      id: 'blkText00001',
      kind: 'text',
      title: '',
      place: place(0, 10, 6, 2),
      style: 'paragraph',
      text: 'Ask for **anything** you need.',
    },
    {
      id: 'blkStatus001',
      kind: 'filter',
      title: '',
      place: place(9, 5, 3, 1),
      control: 'choice',
      tableId: ids.tableId,
      fieldId: ids.status,
      blockIds: [],
    },
    {
      id: 'blkSearch001',
      kind: 'filter',
      title: 'Find a request',
      place: place(9, 6, 3, 1),
      control: 'search',
      tableId: ids.tableId,
      fieldId: ids.name,
      blockIds: [],
    },
    {
      id: 'blkForm00001',
      kind: 'button',
      title: '',
      place: place(6, 10, 3, 1),
      label: 'New request',
      action: { kind: 'form', tableId: ids.tableId, viewId: ids.formViewId },
    },
    {
      id: 'blkHelp00001',
      kind: 'button',
      title: '',
      place: place(9, 10, 3, 1),
      label: 'Help',
      action: { kind: 'url', url: 'https://example.com/help' },
    },
  ];
}

export function closeAll(sessions: DatabaseSession[]): void {
  for (const session of sessions.splice(0)) session.close();
}

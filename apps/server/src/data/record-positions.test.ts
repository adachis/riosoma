import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseCreate,
  UndoResult,
  newId,
  type CommandBatchResult,
  type CommandResult,
  type RowsPage,
  type ServerMessage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
let address: string;
const clientId = newId('client');
const sockets: WebSocket[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'positions');
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

/** A table of five records, named in the order they were added, with a grid and two lists. */
async function fixture() {
  const name = newId('field');
  const records = NAMES.map(() => newId('record'));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Errands',
    table: {
      id: newId('table'),
      name: 'Errands',
      fields: [{ id: name, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const databaseId = input.id;
  const tableId = input.table.id;
  await send(databaseId, [
    {
      kind: 'record.create',
      tableId,
      records: records.map((id, index) => ({ id, values: { [name]: NAMES[index] } })),
    },
  ]);
  const list = newId('view');
  const other = newId('view');
  for (const [id, viewName] of [
    [list, 'Today'],
    [other, 'This week'],
  ] as const)
    expect(
      await send(databaseId, [
        { kind: 'view.create', view: { id, tableId, name: viewName, type: 'list', config: {} } },
      ]),
    ).toMatchObject([{ status: 'applied' }]);
  const byName = (text: string) => records[NAMES.indexOf(text)]!;
  return { databaseId, tableId, name, list, other, grid: input.table.view.id, records, byName };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function send(
  databaseId: string,
  commands: Array<Record<string, unknown>>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<CommandResult[]> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId,
      commands: commands.map((command) => ({ id: newId('command'), groupId, ...command })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results;
}

function move(
  f: Fixture,
  names: string[],
  place: { before: string } | { after: string },
  options: { viewId?: string; who?: SignedIn; groupId?: string } = {},
) {
  const anchor = 'before' in place ? { before: f.byName(place.before) } : { after: f.byName(place.after) };
  return send(
    f.databaseId,
    [
      {
        kind: 'record.move',
        tableId: f.tableId,
        viewId: options.viewId ?? f.list,
        recordIds: names.map(f.byName),
        place: anchor,
      },
    ],
    options.who,
    options.groupId,
  );
}

async function page(viewId: string, who: SignedIn = server.owner): Promise<RowsPage> {
  const response = await server.app.inject({
    url: `/api/views/${viewId}/rows?offset=0&limit=100&tz=UTC&refresh=1`,
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>();
}

async function order(f: Fixture, viewId = f.list): Promise<string[]> {
  return (await page(viewId)).rows.map((row) => String(row?.values[f.name] ?? ''));
}

async function reverse(f: Fixture, groupId: string, direction: 'undo' | 'redo' = 'undo') {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/${direction}`,
    headers: server.owner.headers,
    payload: { clientId, groupId, commandId: newId('command') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return UndoResult.parse(response.json());
}

async function grant(f: Fixture, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function stored(f: Fixture, viewId = f.list): Promise<number> {
  const result = await query(
    server.pool,
    sql`SELECT 1 FROM ${ident(server.schemas.app, 'record_positions')} WHERE view_id = ${viewId}`,
  );
  return result.rowCount ?? 0;
}

describe('a list’s own order', () => {
  it('moves records next to others in one list, leaving the table’s other views alone', async () => {
    const f = await fixture();
    expect(await order(f)).toEqual(NAMES);
    expect(await move(f, ['Charlie'], { before: 'Alpha' })).toMatchObject([{ status: 'applied' }]);
    expect(await order(f)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta', 'Echo']);
    await move(f, ['Alpha'], { after: 'Echo' });
    expect(await order(f)).toEqual(['Charlie', 'Bravo', 'Delta', 'Echo', 'Alpha']);
    // Several records keep the order they're given, next to one that has moved before.
    await move(f, ['Echo', 'Bravo'], { before: 'Charlie' });
    expect(await order(f)).toEqual(['Echo', 'Bravo', 'Charlie', 'Delta', 'Alpha']);
    await move(f, ['Delta'], { after: 'Echo' });
    expect(await order(f)).toEqual(['Echo', 'Delta', 'Bravo', 'Charlie', 'Alpha']);
    // Only the records that moved have a place of their own, and only in this list.
    expect(await stored(f)).toBe(5);
    expect(await stored(f, f.other)).toBe(0);
    expect(await order(f, f.other)).toEqual(NAMES);
    expect(await order(f, f.grid)).toEqual(NAMES);
    // The other list keeps an order of its own.
    await move(f, ['Echo'], { before: 'Bravo' }, { viewId: f.other });
    expect(await order(f, f.other)).toEqual(['Alpha', 'Echo', 'Bravo', 'Charlie', 'Delta']);
    expect(await order(f)).toEqual(['Echo', 'Delta', 'Bravo', 'Charlie', 'Alpha']);
  });

  it('keeps records nobody moved in the order they were added, and follows a sort instead while there is one', async () => {
    const f = await fixture();
    await move(f, ['Delta'], { before: 'Bravo' });
    expect(await order(f)).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie', 'Echo']);
    const foxtrot = newId('record');
    await send(f.databaseId, [
      {
        kind: 'record.create',
        tableId: f.tableId,
        records: [{ id: foxtrot, values: { [f.name]: 'Foxtrot' } }],
      },
    ]);
    // A new record has never moved, so it comes last, after everything added before it.
    expect(await order(f)).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie', 'Echo', 'Foxtrot']);
    await send(f.databaseId, [
      { kind: 'view.update', viewId: f.list, config: { sorts: [{ fieldId: f.name, direction: 'desc' }] } },
    ]);
    expect(await order(f)).toEqual(['Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
    expect(await move(f, ['Alpha'], { before: 'Echo' })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.moveSorted' } },
    ]);
    // Without the sort, the list's own order comes back as it was.
    await send(f.databaseId, [{ kind: 'view.update', viewId: f.list, config: { sorts: [] } }]);
    expect(await order(f)).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie', 'Echo', 'Foxtrot']);
    // A record put back from the trash returns to its place.
    await send(f.databaseId, [{ kind: 'record.trash', tableId: f.tableId, recordIds: [f.byName('Delta')] }]);
    expect(await order(f)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Echo', 'Foxtrot']);
    await send(f.databaseId, [
      { kind: 'record.restore', tableId: f.tableId, recordIds: [f.byName('Delta')] },
    ]);
    expect(await order(f)).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie', 'Echo', 'Foxtrot']);
  });

  it('always has room, however many records land between the same two', async () => {
    const f = await fixture();
    for (let round = 0; round < 40; round++) {
      await move(f, [round % 2 ? 'Charlie' : 'Delta'], { after: 'Alpha' });
      expect((await order(f)).slice(0, 2)).toEqual(['Alpha', round % 2 ? 'Charlie' : 'Delta']);
    }
    expect(await order(f)).toEqual(['Alpha', 'Charlie', 'Delta', 'Bravo', 'Echo']);
  });

  it('undoes and redoes a move, and leaves a record someone has moved since', async () => {
    const f = await fixture();
    const creator = await server.addMember({ name: 'Casey Creator' });
    await grant(f, creator, 'creator');
    const first = newId('action');
    await move(f, ['Charlie'], { before: 'Alpha' }, { groupId: first });
    expect(await order(f)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta', 'Echo']);
    expect(await reverse(f, first)).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await order(f)).toEqual(NAMES);
    expect(await stored(f)).toBe(0);
    expect(await reverse(f, first, 'redo')).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await order(f)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta', 'Echo']);

    const second = newId('action');
    await move(f, ['Charlie', 'Echo'], { after: 'Delta' }, { groupId: second });
    expect(await order(f)).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie', 'Echo']);
    // Someone else moves Echo, so undoing puts back only Charlie.  Echo took Charlie's old place
    // at the top, so Charlie goes back just before it.
    await move(f, ['Echo'], { before: 'Alpha' }, { who: creator });
    expect(await order(f)).toEqual(['Echo', 'Alpha', 'Bravo', 'Delta', 'Charlie']);
    expect(await reverse(f, second)).toMatchObject({ status: 'applied', skipped: 1 });
    expect(await order(f)).toEqual(['Charlie', 'Echo', 'Alpha', 'Bravo', 'Delta']);
    expect(await reverse(f, second, 'redo')).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await order(f)).toEqual(['Echo', 'Alpha', 'Bravo', 'Delta', 'Charlie']);
  });

  it('refuses people who can’t edit records, views without manual order, and records that aren’t there', async () => {
    const f = await fixture();
    for (const role of ['reader', 'commenter']) {
      const member = await server.addMember({ name: `A ${role}` });
      await grant(f, member, role);
      expect(await move(f, ['Charlie'], { before: 'Alpha' }, { who: member })).toMatchObject([
        { status: 'rejected', error: { code: 'forbidden', messageKey: 'data.access.denied' } },
      ]);
    }
    const editor = await server.addMember({ name: 'Eddie Editor' });
    await grant(f, editor, 'editor');
    expect(await move(f, ['Charlie'], { before: 'Alpha' }, { who: editor })).toMatchObject([
      { status: 'applied' },
    ]);
    const calendar = newId('view');
    await send(f.databaseId, [
      {
        kind: 'view.create',
        view: { id: calendar, tableId: f.tableId, name: 'Calendar', type: 'calendar', config: {} },
      },
    ]);
    expect(await move(f, ['Charlie'], { before: 'Alpha' }, { viewId: calendar })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.moveList' } },
    ]);
    expect(await move(f, ['Charlie', 'Alpha'], { before: 'Alpha' })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.moveSelf' } },
    ]);
    await send(f.databaseId, [{ kind: 'record.trash', tableId: f.tableId, recordIds: [f.byName('Bravo')] }]);
    expect(await move(f, ['Bravo'], { before: 'Alpha' })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.missing' } },
    ]);
    expect(await move(f, ['Alpha'], { after: 'Bravo' })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.missing' } },
    ]);
    expect(await order(f)).toEqual(['Charlie', 'Alpha', 'Delta', 'Echo']);
  });

  it('audits each move and tells tabs showing the list that its order changed', async () => {
    const f = await fixture();
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/realtime`, {
      headers: { cookie: server.owner.headers.cookie, origin: new URL(address).origin },
    });
    sockets.push(socket);
    const inbox: ServerMessage[] = [];
    socket.addEventListener('message', (event) =>
      inbox.push(JSON.parse(String(event.data)) as ServerMessage),
    );
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const next = async <T extends ServerMessage['type']>(
      type: T,
      wanted: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ) => {
      const started = Date.now();
      for (;;) {
        const index = inbox.findIndex(
          (message) => message.type === type && wanted(message as Extract<ServerMessage, { type: T }>),
        );
        if (index >= 0) return inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
        if (Date.now() - started > 10_000) throw new Error(`no ${type} arrived`);
        await delay(10);
      }
    };
    const say = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
    say({ type: 'hello', csrf: server.owner.info.csrfToken, clientId: newId('client') });
    await next('ready');
    say({ type: 'subscribe', databaseId: f.databaseId, sinceSeq: 0 });
    await next('caughtUp');
    const shown = await page(f.list);
    say({ type: 'watch', databaseId: f.databaseId, viewId: f.list, snapshot: shown.snapshot });
    say({ type: 'ping' });
    await next('pong');

    await move(f, ['Echo'], { before: 'Bravo' });
    const change = await next('change', (message) => message.change.kind === 'record.moved');
    expect(change.change).toMatchObject({
      kind: 'record.moved',
      tableId: f.tableId,
      viewId: f.list,
      recordIds: [f.byName('Echo')],
    });
    expect(change.change).not.toHaveProperty('prev');
    expect(await next('viewDelta')).toMatchObject({
      databaseId: f.databaseId,
      viewId: f.list,
      snapshot: shown.snapshot,
      entered: [],
      left: [],
      moved: [f.byName('Echo')],
    });

    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE metadata->>'databaseId' = ${f.databaseId} AND action = 'data.records.moved'`,
    );
    expect(audit.rows).toEqual([
      {
        action: 'data.records.moved',
        metadata: expect.objectContaining({ tableId: f.tableId, viewId: f.list, count: 1 }),
      },
    ]);
  });
});

describe('manual order across arranging views', () => {
  it.each(['gallery', 'kanban'])('saves %s order per view and restores it in one undo step', async (type) => {
    const f = await fixture();
    const viewId = newId('view');
    expect(
      await send(f.databaseId, [
        { kind: 'view.create', view: { id: viewId, tableId: f.tableId, name: 'Arranged', type, config: {} } },
      ]),
    ).toMatchObject([{ status: 'applied' }]);
    const groupId = newId('action');
    expect(await move(f, ['Echo'], { before: 'Alpha' }, { viewId, groupId })).toMatchObject([
      { status: 'applied' },
    ]);
    expect(await order(f, viewId)).toEqual(['Echo', 'Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(await order(f, f.grid)).toEqual(NAMES);
    await reverse(f, groupId);
    expect(await order(f, viewId)).toEqual(NAMES);
    await reverse(f, groupId, 'redo');
    expect(await order(f, viewId)).toEqual(['Echo', 'Alpha', 'Bravo', 'Charlie', 'Delta']);
    await send(f.databaseId, [
      { kind: 'view.update', viewId, config: { sorts: [{ fieldId: f.name, direction: 'asc' }] } },
    ]);
    expect(await move(f, ['Delta'], { before: 'Alpha' }, { viewId })).toMatchObject([
      { status: 'rejected', error: { messageKey: 'data.record.moveSorted' } },
    ]);
    expect(await order(f, viewId)).toEqual(NAMES);
  });
});

it('moves a card into a column at its requested position and undoes both changes together', async () => {
  const f = await fixture();
  const fieldId = newId('field');
  const ready = newId('choice');
  const done = newId('choice');
  const viewId = newId('view');
  expect(
    await send(f.databaseId, [
      {
        kind: 'field.create',
        tableId: f.tableId,
        field: {
          id: fieldId,
          name: 'Stage',
          type: 'singleSelect',
          options: {
            choices: [
              { id: ready, name: 'Ready', color: 'blue' },
              { id: done, name: 'Done', color: 'green' },
            ],
          },
        },
      },
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: f.records.map((id, index) => ({ id, values: { [fieldId]: index < 2 ? ready : done } })),
      },
      {
        kind: 'view.create',
        view: {
          id: viewId,
          tableId: f.tableId,
          name: 'Board',
          type: 'kanban',
          config: { kanban: { stackFieldId: fieldId } },
        },
      },
    ]),
  ).toMatchObject([{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }]);
  const groupId = newId('action');
  expect(
    await send(
      f.databaseId,
      [
        {
          kind: 'record.update',
          tableId: f.tableId,
          records: [{ id: f.byName('Delta'), values: { [fieldId]: ready } }],
        },
        {
          kind: 'record.move',
          tableId: f.tableId,
          viewId,
          recordIds: [f.byName('Delta')],
          place: { before: f.byName('Alpha') },
        },
      ],
      server.owner,
      groupId,
    ),
  ).toMatchObject([{ status: 'applied' }, { status: 'applied' }]);
  const stack = async () => {
    const response = await server.app.inject({
      url: `/api/views/${viewId}/rows?stack=${ready}&refresh=1`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowsPage>().rows.map((row) => row?.values[f.name]);
  };
  expect(await stack()).toEqual(['Delta', 'Alpha', 'Bravo']);
  await reverse(f, groupId);
  expect(await stack()).toEqual(['Alpha', 'Bravo']);
  expect((await page(viewId)).rows.find((row) => row?.id === f.byName('Delta'))?.values[fieldId]).toBe(done);
});

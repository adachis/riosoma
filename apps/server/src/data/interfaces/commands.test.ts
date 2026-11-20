import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  DatabaseSchema,
  TRASH_RETENTION_DAYS,
  UndoResult,
  newId,
  type Change,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseRole,
  type ServerMessage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { purgeTrash } from '../purge.js';
import type { ListedTrash } from '../trash-routes.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'itfcmd');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function create() {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Database',
    table: {
      id: newId('table'),
      name: 'Requests',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: newId('field'), name: 'Amount', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const [name, amount] = input.table.fields.map((field) => field.id) as [string, string];
  return { id: input.id, tableId: input.table.id, viewId: input.table.view.id, name, amount };
}

async function send(
  databaseId: string,
  input: Record<string, unknown>,
  who = server.owner,
): Promise<{ result: CommandResult; command: Command }> {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { result: response.json<CommandBatchResult>().results[0]!, command };
}

async function run(databaseId: string, input: Record<string, unknown>, who = server.owner) {
  const { result, command } = await send(databaseId, input, who);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  return command;
}

async function reverse(
  databaseId: string,
  groupId: string,
  direction: 'undo' | 'redo' = 'undo',
  who = server.owner,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: who.headers,
    payload: { clientId, groupId, commandId: newId('command') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return UndoResult.parse(response.json());
}

async function schema(databaseId: string, who = server.owner) {
  const response = await server.app.inject({
    url: `/api/databases/${databaseId}/schema`,
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}

async function grant(databaseId: string, who: SignedIn, role: DatabaseRole) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function trash(databaseId: string) {
  const response = await server.app.inject({
    url: `/api/databases/${databaseId}/trash`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ListedTrash>();
}

const place = (y = 0) => ({ x: 0, y, w: 6, h: 4 });
const blockId = () => `blk${newId('record').slice(3)}`;

/** A page with a records block over the table's grid, and a record block that follows it. */
function page(db: { tableId: string; viewId: string; name: string; amount: string }, name = 'Requests') {
  const records = blockId();
  return {
    id: `page${newId('record').slice(3)}`,
    name,
    blocks: [
      {
        id: records,
        kind: 'records',
        place: place(),
        source: { tableId: db.tableId, viewId: db.viewId },
        fieldIds: [db.amount],
      },
      { id: blockId(), kind: 'record', place: place(4), recordsBlockId: records, fieldIds: [db.name] },
    ],
  };
}

const names = async (databaseId: string) =>
  ((await schema(databaseId)).interfaces ?? []).map((item) => item.name);

describe('interface commands', () => {
  it('saves code and page replacements as one audited undoable command and enforces reader roles', async () => {
    const db = await create();
    const id = newId('interface');
    const initial = page(db);
    await run(db.id, { kind: 'interface.create', interface: { id, name: 'Desk', pages: [initial] } });
    const code = {
      id: blockId(),
      kind: 'code',
      place: place(8),
      html: '<main></main>',
      css: '',
      javascript: '',
    };
    const next = { ...initial, name: 'Updated page', blocks: [...initial.blocks, code] };
    const creator = await server.addMember();
    await grant(db.id, creator, 'creator');
    const changed = await run(db.id, { kind: 'interface.update', interfaceId: id, pages: [next] }, creator);
    expect((await schema(db.id)).interfaces?.[0]?.pages[0]).toMatchObject(next);
    const audit = await query<{ action: string }>(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.interface.updated' AND actor_id = ${creator.userId}`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(await reverse(db.id, changed.groupId, 'undo', creator)).toMatchObject({ status: 'applied' });
    expect((await schema(db.id)).interfaces?.[0]?.pages[0]?.blocks).toHaveLength(2);
    const reader = await server.addMember();
    await grant(db.id, reader, 'reader');
    expect(
      (await send(db.id, { kind: 'interface.update', interfaceId: id, pages: [next] }, reader)).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    const recordId = newId('record');
    await run(db.id, {
      kind: 'record.create',
      tableId: db.tableId,
      records: [{ id: recordId, values: { [db.name]: 'Before' } }],
    });
    expect(
      (
        await send(
          db.id,
          {
            kind: 'record.update',
            tableId: db.tableId,
            records: [{ id: recordId, values: { [db.name]: 'After' } }],
          },
          reader,
        )
      ).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
  });

  it('creates, renames, changes pages, moves, trashes, and restores interfaces, recording and auditing each change', async () => {
    const db = await create();
    const [first, second, third] = [newId('interface'), newId('interface'), newId('interface')];
    await run(db.id, { kind: 'interface.create', interface: { id: first, name: 'First' } });
    await run(db.id, { kind: 'interface.create', interface: { id: second, name: 'Second' } });
    await run(db.id, { kind: 'interface.create', interface: { id: third, name: 'Third' }, position: 0.5 });
    expect(await names(db.id)).toEqual(['First', 'Third', 'Second']);
    const created = (await schema(db.id)).interfaces!.find((item) => item.id === first)!;
    expect(created).toMatchObject({ databaseId: db.id, position: 0, pages: [] });

    const requests = page(db);
    await run(db.id, { kind: 'interface.update', interfaceId: first, name: 'Desk', pages: [requests] });
    await run(db.id, { kind: 'interface.move', interfaceId: second, position: -1 });
    const current = await schema(db.id);
    expect(current.interfaces!.map((item) => item.name)).toEqual(['Second', 'Desk', 'Third']);
    const stored = current.interfaces![1]!.pages[0]!;
    expect(stored.blocks[0]).toMatchObject({
      kind: 'records',
      title: '',
      display: 'list',
      source: { tableId: db.tableId, viewId: db.viewId, filter: null },
    });
    expect(stored.blocks[1]).toMatchObject({ kind: 'record', recordsBlockId: requests.blocks[0]!.id });

    await run(db.id, { kind: 'interface.trash', interfaceId: third });
    expect(await names(db.id)).toEqual(['Second', 'Desk']);
    await run(db.id, { kind: 'interface.restore', interfaceId: third });
    expect(await names(db.id)).toEqual(['Second', 'Desk', 'Third']);

    const log = await query<{ kind: string; body: { interface?: { name: string } }; prev: unknown }>(
      server.pool,
      sql`SELECT kind, body, prev FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${db.id} AND kind LIKE 'interface.%' ORDER BY seq`,
    );
    expect(log.rows.map((row) => row.kind)).toEqual([
      'interface.created',
      'interface.created',
      'interface.created',
      'interface.updated',
      'interface.updated',
      'interface.trashed',
      'interface.restored',
    ]);
    expect(log.rows[3]!.body.interface!.name).toBe('Desk');
    expect(log.rows[3]!.prev).toMatchObject({ interface: { id: first, name: 'First', pages: [] } });
    expect(log.rows[5]!.prev).toEqual({ trashed: false });
    expect(log.rows[6]!.prev).toEqual({ trashed: true });
    const audit = await query<{ action: string; metadata: { interfaceId?: string } }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.interface.%' AND metadata ->> 'databaseId' = ${db.id} ORDER BY id`,
    );
    expect(audit.rows.map((row) => row.action)).toContain('data.interface.trashed');
    expect(audit.rows.find((row) => row.action === 'data.interface.trashed')?.metadata.interfaceId).toBe(
      third,
    );
  });

  it('refuses a taken ID and changes to trashed interfaces', async () => {
    const db = await create();
    const id = newId('interface');
    await run(db.id, { kind: 'interface.create', interface: { id, name: 'Desk' } });
    expect(
      (await send(db.id, { kind: 'interface.create', interface: { id, name: 'Again' } })).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    await run(db.id, { kind: 'interface.trash', interfaceId: id });
    for (const input of [
      { kind: 'interface.update', interfaceId: id, name: 'Nope' },
      { kind: 'interface.move', interfaceId: id, position: 3 },
    ])
      expect((await send(db.id, input)).result).toMatchObject({
        status: 'rejected',
        error: { code: 'not_found' },
      });
    const elsewhere = await create();
    expect((await send(elsewhere.id, { kind: 'interface.restore', interfaceId: id })).result).toMatchObject({
      status: 'rejected',
      error: { code: 'not_found' },
    });
  });

  it('lets owners and creators change interfaces, shows them to everyone who can read, and refuses everyone else', async () => {
    const db = await create();
    const id = newId('interface');
    await run(db.id, { kind: 'interface.create', interface: { id, name: 'Desk', pages: [page(db)] } });
    const roles: Array<[DatabaseRole | null, 'applied' | 'forbidden' | 'not_found']> = [
      ['creator', 'applied'],
      ['editor', 'forbidden'],
      ['commenter', 'forbidden'],
      ['reader', 'forbidden'],
      [null, 'not_found'],
    ];
    for (const [role, outcome] of roles) {
      const person = await server.addMember();
      if (role) {
        await grant(db.id, person, role);
        const seen = (await schema(db.id, person)).interfaces!.find((item) => item.id === id);
        expect(seen?.pages[0]?.blocks).toHaveLength(2);
      }
      const commands = [
        { kind: 'interface.create', interface: { id: newId('interface'), name: `By ${role}` } },
        { kind: 'interface.update', interfaceId: id, name: `Renamed by ${role}` },
        { kind: 'interface.move', interfaceId: id, position: 7 },
        { kind: 'interface.trash', interfaceId: id },
        { kind: 'interface.restore', interfaceId: id },
      ];
      for (const input of commands) {
        const { result } = await send(db.id, input, person);
        if (outcome === 'applied') expect(result.status, JSON.stringify(result)).toBe('applied');
        else expect(result).toMatchObject({ status: 'rejected', error: { code: outcome } });
      }
    }
    expect(await names(db.id)).toEqual(['By creator', 'Renamed by creator']);
  });

  it('undoes and redoes creating, changing pages, moving, trashing, and restoring', async () => {
    const db = await create();
    const id = newId('interface');
    const creation = await run(db.id, { kind: 'interface.create', interface: { id, name: 'Desk' } });
    expect(await reverse(db.id, creation.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await names(db.id)).toEqual([]);
    expect(await reverse(db.id, creation.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Desk']);

    const update = await run(db.id, {
      kind: 'interface.update',
      interfaceId: id,
      name: 'Front desk',
      pages: [page(db)],
    });
    const move = await run(db.id, { kind: 'interface.move', interfaceId: id, position: 9 });
    const current = async () => (await schema(db.id)).interfaces!.find((item) => item.id === id)!;
    expect(await reverse(db.id, move.groupId)).toMatchObject({ status: 'applied' });
    expect(await current()).toMatchObject({ name: 'Front desk', position: 0 });
    expect(await reverse(db.id, update.groupId)).toMatchObject({ status: 'applied' });
    expect(await current()).toMatchObject({ name: 'Desk', pages: [] });
    expect(await reverse(db.id, update.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect((await current()).pages).toHaveLength(1);
    expect(await reverse(db.id, move.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await current()).toMatchObject({ name: 'Front desk', position: 9 });

    const trashed = await run(db.id, { kind: 'interface.trash', interfaceId: id });
    expect(await reverse(db.id, trashed.groupId)).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Front desk']);
    expect(await reverse(db.id, trashed.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual([]);
    const restored = await run(db.id, { kind: 'interface.restore', interfaceId: id });
    expect(await reverse(db.id, restored.groupId)).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual([]);
    expect(await reverse(db.id, restored.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Front desk']);
  });

  it('refuses pages that read other databases or tables, or name blocks that aren’t there', async () => {
    const db = await create();
    const other = await create();
    const clients = {
      id: newId('table'),
      name: 'Clients',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    };
    await run(db.id, { kind: 'table.create', table: clients });
    const id = newId('interface');
    const attempt = (blocks: Array<Record<string, unknown>>) =>
      send(db.id, {
        kind: 'interface.create',
        interface: { id, name: 'Desk', pages: [{ id: 'pageOne01', name: 'One', blocks }] },
      });
    const records = (extra: Record<string, unknown> = {}) => ({
      id: 'records01',
      kind: 'records',
      place: place(),
      source: { tableId: db.tableId, viewId: db.viewId },
      ...extra,
    });
    const notFound: Array<Array<Record<string, unknown>>> = [
      [records({ source: { tableId: other.tableId, viewId: other.viewId } })],
      [records({ source: { tableId: db.tableId, viewId: other.viewId } })],
      [records({ source: { tableId: db.tableId, viewId: clients.view.id } })],
      [records({ fieldIds: [other.name] })],
      [
        records({
          source: {
            tableId: db.tableId,
            viewId: db.viewId,
            filter: {
              conjunction: 'and',
              conditions: [{ id: 'a', fieldId: other.name, operator: 'isNotEmpty' }],
            },
          },
        }),
      ],
      [
        records(),
        {
          id: 'record01',
          kind: 'record',
          place: place(4),
          recordsBlockId: 'records01',
          fieldIds: [clients.fields[0]!.id],
        },
      ],
      [
        {
          id: 'number01',
          kind: 'number',
          place: place(),
          source: { tableId: other.tableId },
          value: { fn: 'count' },
        },
      ],
      [
        {
          id: 'chart001',
          kind: 'chart',
          place: place(),
          source: { tableId: db.tableId },
          groupBy: { fieldId: other.name },
          value: { fn: 'count' },
        },
      ],
      [
        {
          id: 'filter01',
          kind: 'filter',
          place: place(),
          control: 'search',
          tableId: db.tableId,
          fieldId: other.name,
        },
      ],
      // A form button opens a form view, and the table's grid isn't one.
      [
        {
          id: 'button01',
          kind: 'button',
          place: place(),
          action: { kind: 'form', tableId: db.tableId, viewId: db.viewId },
        },
      ],
    ];
    for (const blocks of notFound)
      expect((await attempt(blocks)).result, JSON.stringify(blocks)).toMatchObject({
        status: 'rejected',
        error: { code: 'not_found', messageKey: 'errors.notFound' },
      });
    const invalid: Array<Array<Record<string, unknown>>> = [
      [records(), records()],
      [{ id: 'record01', kind: 'record', place: place(), recordsBlockId: 'missing01' }],
      [{ id: 'record01', kind: 'record', place: place(), recordsBlockId: null, fieldIds: [db.name] }],
      [
        records(),
        {
          id: 'filter01',
          kind: 'filter',
          place: place(4),
          control: 'search',
          tableId: clients.id,
          fieldId: clients.fields[0]!.id,
          blockIds: ['records01'],
        },
      ],
    ];
    for (const blocks of invalid)
      expect((await attempt(blocks)).result, JSON.stringify(blocks)).toMatchObject({
        status: 'rejected',
        error: { code: 'validation_failed' },
      });
    const twice = { id: 'pageOne01', name: 'One', blocks: [] };
    expect(
      (
        await send(db.id, {
          kind: 'interface.create',
          interface: { id, name: 'Desk', pages: [twice, twice] },
        })
      ).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'validation_failed' } });
    // Links outside http and https never reach the server's storage.
    expect(
      Command.safeParse({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'interface.create',
        interface: {
          id,
          name: 'Desk',
          pages: [
            {
              id: 'pageOne01',
              name: 'One',
              blocks: [
                {
                  id: 'button01',
                  kind: 'button',
                  place: place(),
                  action: { kind: 'url', url: 'javascript:alert(1)' },
                },
              ],
            },
          ],
        },
      }).success,
    ).toBe(false);

    const form = newId('view');
    await run(db.id, {
      kind: 'view.create',
      view: { id: form, tableId: db.tableId, name: 'Ask', type: 'form' },
    });
    await run(db.id, {
      kind: 'interface.create',
      interface: {
        id,
        name: 'Desk',
        pages: [
          {
            id: 'pageOne01',
            name: 'One',
            blocks: [
              records(),
              {
                id: 'button01',
                kind: 'button',
                place: place(4),
                label: 'Ask',
                action: { kind: 'form', tableId: db.tableId, viewId: form },
              },
              {
                id: 'filter01',
                kind: 'filter',
                place: place(8),
                control: 'search',
                tableId: db.tableId,
                fieldId: db.name,
                blockIds: ['records01'],
              },
              {
                id: 'link0001',
                kind: 'button',
                place: place(12),
                label: 'Help',
                action: { kind: 'url', url: 'https://example.com/help' },
              },
            ],
          },
        ],
      },
    });
  });

  it('keeps references an interface held after what they named was purged', async () => {
    const db = await create();
    const extra = newId('field');
    await run(db.id, {
      kind: 'field.create',
      tableId: db.tableId,
      field: { id: extra, name: 'Extra', type: 'number' },
    });
    await run(db.id, { kind: 'field.trash', fieldId: extra });
    const id = newId('interface');
    const held = {
      id: 'records01',
      kind: 'records',
      place: place(),
      source: { tableId: db.tableId, viewId: db.viewId },
      fieldIds: [extra],
    };
    await run(db.id, {
      kind: 'interface.create',
      interface: { id, name: 'Desk', pages: [{ id: 'pageOne01', name: 'One', blocks: [held] }] },
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${extra}`,
    );
    await purgeTrash(server.ctx);
    const moved = { ...held, place: { x: 6, y: 0, w: 6, h: 4 } };
    await run(db.id, {
      kind: 'interface.update',
      interfaceId: id,
      pages: [
        { id: 'pageOne01', name: 'One', blocks: [moved] },
        { id: 'pageTwo01', name: 'Two', blocks: [] },
      ],
    });
    await run(db.id, { kind: 'interface.update', interfaceId: id, name: 'Renamed' });
    expect(
      (
        await send(db.id, {
          kind: 'interface.update',
          interfaceId: id,
          pages: [
            { id: 'pageOne01', name: 'One', blocks: [{ ...moved, fieldIds: [extra, newId('field')] }] },
          ],
        })
      ).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });
});

describe('interface broadcasts', () => {
  it('sends interface changes to people reading the database, without previous values', async () => {
    const db = await create();
    const reader = await server.addMember();
    await grant(db.id, reader, 'reader');
    const seq = (await schema(db.id)).seq;
    // The socket's origin must match the address it listens on, so leave out the configured one.
    server.config.baseUrl = undefined;
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/realtime`, {
      headers: { cookie: reader.headers.cookie, origin: new URL(address).origin },
    });
    socket.addEventListener('message', (event) =>
      messages.push(JSON.parse(String(event.data)) as ServerMessage),
    );
    const until = async (check: () => boolean) => {
      const started = performance.now();
      while (!check()) {
        if (performance.now() - started > 5_000) throw new Error('condition timed out');
        await delay(10);
      }
    };
    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.send(JSON.stringify({ type: 'hello', csrf: reader.info.csrfToken, clientId: newId('client') }));
      await until(() => messages.some((message) => message.type === 'ready'));
      socket.send(JSON.stringify({ type: 'subscribe', databaseId: db.id, sinceSeq: seq }));
      await until(() => messages.some((message) => message.type === 'caughtUp'));
      const id = newId('interface');
      await run(db.id, { kind: 'interface.create', interface: { id, name: 'Live' } });
      await run(db.id, { kind: 'interface.update', interfaceId: id, name: 'Renamed' });
      await run(db.id, { kind: 'interface.trash', interfaceId: id });
      const changes = () =>
        messages.flatMap((message): Change[] => (message.type === 'change' ? [message.change] : []));
      await until(() => changes().length === 3);
      expect(changes()).toMatchObject([
        { kind: 'interface.created', interface: { id, name: 'Live', databaseId: db.id } },
        { kind: 'interface.updated', interface: { id, name: 'Renamed' } },
        { kind: 'interface.trashed', interfaceId: id },
      ]);
      expect(changes().every((change) => !('prev' in change))).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe('interfaces in the trash', () => {
  it('lists trashed interfaces, restores them, and purges them after the retention period', async () => {
    const db = await create();
    const id = newId('interface');
    const kept = newId('interface');
    await run(db.id, { kind: 'interface.create', interface: { id, name: 'Desk' } });
    await run(db.id, { kind: 'interface.create', interface: { id: kept, name: 'Kept' } });
    await run(db.id, { kind: 'interface.trash', interfaceId: id });
    expect((await trash(db.id)).items).toEqual([
      {
        kind: 'interface',
        id,
        name: 'Desk',
        tableId: null,
        tableName: null,
        trashedAt: expect.any(String),
        trashedBy: server.owner.userId,
      },
    ]);
    await run(db.id, { kind: 'interface.restore', interfaceId: id });
    expect((await trash(db.id)).items).toEqual([]);

    const trashing = await run(db.id, { kind: 'interface.trash', interfaceId: id });
    await purgeTrash(server.ctx);
    expect((await trash(db.id)).items.map((item) => item.id)).toEqual([id]);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'interfaces')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${id}`,
    );
    expect((await trash(db.id)).items).toEqual([]);
    await purgeTrash(server.ctx);
    const rows = async () =>
      (
        await query<{ id: string }>(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'interfaces')} WHERE database_id = ${db.id}`,
        )
      ).rows.map((row) => row.id);
    expect(await rows()).toEqual([kept]);
    expect(await reverse(db.id, trashing.groupId)).toMatchObject({ status: 'nothing', skipped: 1 });

    await run(db.id, { kind: 'database.trash' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${db.id}`,
    );
    await purgeTrash(server.ctx);
    expect(await rows()).toEqual([]);
  });
});

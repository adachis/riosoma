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
  server = await startServer(kit, 'dashcmd');
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
      name: 'Projects',
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

async function reverse(databaseId: string, groupId: string, direction: 'undo' | 'redo' = 'undo') {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: server.owner.headers,
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

function numberTile(tableId: string, extra: Record<string, unknown> = {}) {
  return {
    id: newId('dashboard').slice(3),
    kind: 'number',
    place: { x: 0, y: 0, w: 3, h: 2 },
    source: { tableId },
    value: { fn: 'count' },
    ...extra,
  };
}

const names = async (databaseId: string) =>
  ((await schema(databaseId)).dashboards ?? []).map((dashboard) => dashboard.name);

describe('dashboard commands', () => {
  it('creates, renames, reconfigures, moves, trashes, and restores dashboards, recording each change', async () => {
    const db = await create();
    const first = newId('dashboard');
    const second = newId('dashboard');
    const third = newId('dashboard');
    await run(db.id, { kind: 'dashboard.create', dashboard: { id: first, name: 'First' } });
    await run(db.id, { kind: 'dashboard.create', dashboard: { id: second, name: 'Second' } });
    await run(db.id, { kind: 'dashboard.create', dashboard: { id: third, name: 'Third' }, position: 0.5 });
    expect(await names(db.id)).toEqual(['First', 'Third', 'Second']);
    const created = (await schema(db.id)).dashboards!.find((dashboard) => dashboard.id === first)!;
    expect(created).toMatchObject({ databaseId: db.id, position: 0, config: { tiles: [] } });

    const tile = numberTile(db.tableId);
    await run(db.id, {
      kind: 'dashboard.update',
      dashboardId: first,
      name: 'Renamed',
      config: { tiles: [tile] },
    });
    await run(db.id, { kind: 'dashboard.move', dashboardId: second, position: -1 });
    const current = await schema(db.id);
    expect(current.dashboards!.map((dashboard) => dashboard.name)).toEqual(['Second', 'Renamed', 'Third']);
    expect(current.dashboards![1]!.config.tiles[0]).toMatchObject({
      ...tile,
      title: '',
      source: { tableId: db.tableId, viewId: null, filter: null },
      value: { fn: 'count', fieldId: null },
    });

    await run(db.id, { kind: 'dashboard.trash', dashboardId: third });
    expect(await names(db.id)).toEqual(['Second', 'Renamed']);
    await run(db.id, { kind: 'dashboard.restore', dashboardId: third });
    expect(await names(db.id)).toEqual(['Second', 'Renamed', 'Third']);

    const log = await query<{ kind: string; body: { dashboard?: { name: string } }; prev: unknown }>(
      server.pool,
      sql`SELECT kind, body, prev FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${db.id} AND kind LIKE 'dashboard.%' ORDER BY seq`,
    );
    expect(log.rows.map((row) => row.kind)).toEqual([
      'dashboard.created',
      'dashboard.created',
      'dashboard.created',
      'dashboard.updated',
      'dashboard.updated',
      'dashboard.trashed',
      'dashboard.restored',
    ]);
    expect(log.rows[3]!.body.dashboard!.name).toBe('Renamed');
    expect(log.rows[3]!.prev).toMatchObject({
      dashboard: { id: first, name: 'First', config: { tiles: [] } },
    });
    expect(log.rows[5]!.prev).toEqual({ trashed: false });
    expect(log.rows[6]!.prev).toEqual({ trashed: true });
    const audit = await query<{ action: string; metadata: { dashboardId?: string } }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.dashboard.trashed' AND metadata ->> 'databaseId' = ${db.id}`,
    );
    expect(audit.rows[0]?.metadata.dashboardId).toBe(third);
  });

  it('refuses a taken ID and changes to trashed dashboards', async () => {
    const db = await create();
    const id = newId('dashboard');
    await run(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Board' } });
    expect(
      (await send(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Again' } })).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    await run(db.id, { kind: 'dashboard.trash', dashboardId: id });
    for (const input of [
      { kind: 'dashboard.update', dashboardId: id, name: 'Nope' },
      { kind: 'dashboard.move', dashboardId: id, position: 3 },
    ])
      expect((await send(db.id, input)).result).toMatchObject({
        status: 'rejected',
        error: { code: 'not_found' },
      });
    const elsewhere = await create();
    expect((await send(elsewhere.id, { kind: 'dashboard.restore', dashboardId: id })).result).toMatchObject({
      status: 'rejected',
      error: { code: 'not_found' },
    });
  });

  it('lets owners and creators change dashboards, and refuses everyone else', async () => {
    const db = await create();
    const id = newId('dashboard');
    await run(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Board' } });
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
        expect((await schema(db.id, person)).dashboards!.map((dashboard) => dashboard.id)).toContain(id);
      }
      const commands = [
        { kind: 'dashboard.create', dashboard: { id: newId('dashboard'), name: `By ${role}` } },
        { kind: 'dashboard.update', dashboardId: id, name: `Renamed by ${role}` },
        { kind: 'dashboard.move', dashboardId: id, position: 7 },
        { kind: 'dashboard.trash', dashboardId: id },
        { kind: 'dashboard.restore', dashboardId: id },
      ];
      for (const input of commands) {
        const { result } = await send(db.id, input, person);
        if (outcome === 'applied') expect(result.status, JSON.stringify(result)).toBe('applied');
        else expect(result).toMatchObject({ status: 'rejected', error: { code: outcome } });
      }
    }
    expect(await names(db.id)).toEqual(['By creator', 'Renamed by creator']);
  });

  it('undoes and redoes creating, updating, moving, trashing, and restoring', async () => {
    const db = await create();
    const id = newId('dashboard');
    const creation = await run(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Board' } });
    expect(await reverse(db.id, creation.groupId)).toMatchObject({ status: 'applied', skipped: 0 });
    expect(await names(db.id)).toEqual([]);
    expect(await reverse(db.id, creation.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Board']);

    const tile = numberTile(db.tableId, { value: { fn: 'sum', fieldId: db.amount } });
    const update = await run(db.id, {
      kind: 'dashboard.update',
      dashboardId: id,
      name: 'Totals',
      config: { tiles: [tile] },
    });
    const move = await run(db.id, { kind: 'dashboard.move', dashboardId: id, position: 9 });
    const board = async () => (await schema(db.id)).dashboards!.find((dashboard) => dashboard.id === id)!;
    expect(await reverse(db.id, move.groupId)).toMatchObject({ status: 'applied' });
    expect(await board()).toMatchObject({ name: 'Totals', position: 0 });
    expect(await reverse(db.id, update.groupId)).toMatchObject({ status: 'applied' });
    expect(await board()).toMatchObject({ name: 'Board', config: { tiles: [] } });
    expect(await reverse(db.id, update.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect((await board()).config.tiles).toHaveLength(1);
    expect(await reverse(db.id, move.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await board()).toMatchObject({ name: 'Totals', position: 9 });

    const trashed = await run(db.id, { kind: 'dashboard.trash', dashboardId: id });
    expect(await reverse(db.id, trashed.groupId)).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Totals']);
    expect(await reverse(db.id, trashed.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual([]);
    const restored = await run(db.id, { kind: 'dashboard.restore', dashboardId: id });
    expect(await reverse(db.id, restored.groupId)).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual([]);
    expect(await reverse(db.id, restored.groupId, 'redo')).toMatchObject({ status: 'applied' });
    expect(await names(db.id)).toEqual(['Totals']);
  });

  it('refuses configurations that read other databases or tables, and keeps references a dashboard held', async () => {
    const db = await create();
    const other = await create();
    const secondTable = {
      id: newId('table'),
      name: 'Clients',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    };
    await run(db.id, { kind: 'table.create', table: secondTable });
    const id = newId('dashboard');
    const tile = (extra: Record<string, unknown>) => numberTile(db.tableId, extra);
    const refused: Array<Record<string, unknown>> = [
      numberTile(other.tableId),
      tile({ source: { tableId: db.tableId, viewId: other.viewId } }),
      tile({ source: { tableId: db.tableId, viewId: secondTable.view.id } }),
      tile({ value: { fn: 'sum', fieldId: other.amount } }),
      tile({ value: { fn: 'countUnique', fieldId: secondTable.fields[0]!.id } }),
      tile({
        source: {
          tableId: db.tableId,
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'a', fieldId: other.name, operator: 'isNotEmpty' }],
          },
        },
      }),
      { ...tile({}), kind: 'records', fieldIds: [other.name] },
      {
        ...tile({}),
        kind: 'chart',
        groupBy: { fieldId: db.name },
        seriesBy: other.name,
      },
    ];
    for (const config of refused) {
      expect(
        (
          await send(db.id, {
            kind: 'dashboard.create',
            dashboard: { id, name: 'Board', config: { tiles: [config] } },
          })
        ).result,
        JSON.stringify(config),
      ).toMatchObject({ status: 'rejected', error: { code: 'not_found', messageKey: 'errors.notFound' } });
    }
    const duplicate = tile({});
    expect(
      (
        await send(db.id, {
          kind: 'dashboard.create',
          dashboard: { id, name: 'Board', config: { tiles: [duplicate, duplicate] } },
        })
      ).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'validation_failed' } });

    // Trashed fields pass, and a field purged since stays acceptable in the tile that held it.
    const extra = newId('field');
    await run(db.id, {
      kind: 'field.create',
      tableId: db.tableId,
      field: { id: extra, name: 'Extra', type: 'number' },
    });
    await run(db.id, { kind: 'field.trash', fieldId: extra });
    const held = tile({ value: { fn: 'sum', fieldId: extra } });
    await run(db.id, {
      kind: 'dashboard.create',
      dashboard: { id, name: 'Board', config: { tiles: [held] } },
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${extra}`,
    );
    await purgeTrash(server.ctx);
    const moved = { ...held, place: { x: 4, y: 1, w: 3, h: 2 } };
    await run(db.id, { kind: 'dashboard.update', dashboardId: id, config: { tiles: [moved, tile({})] } });
    await run(db.id, { kind: 'dashboard.update', dashboardId: id, name: 'Renamed' });
    expect(
      (
        await send(db.id, {
          kind: 'dashboard.update',
          dashboardId: id,
          config: { tiles: [moved, tile({ value: { fn: 'max', fieldId: newId('field') } })] },
        })
      ).result,
    ).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });
});

describe('dashboard broadcasts', () => {
  it('sends dashboard changes to people reading the database, without previous values', async () => {
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
      const id = newId('dashboard');
      await run(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Live' } });
      await run(db.id, { kind: 'dashboard.update', dashboardId: id, name: 'Renamed' });
      await run(db.id, { kind: 'dashboard.trash', dashboardId: id });
      const changes = () =>
        messages.flatMap((message): Change[] => (message.type === 'change' ? [message.change] : []));
      await until(() => changes().length === 3);
      expect(changes()).toMatchObject([
        { kind: 'dashboard.created', dashboard: { id, name: 'Live', databaseId: db.id } },
        { kind: 'dashboard.updated', dashboard: { id, name: 'Renamed' } },
        { kind: 'dashboard.trashed', dashboardId: id },
      ]);
      expect(changes().every((change) => !('prev' in change))).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe('dashboards in the trash', () => {
  it('lists trashed dashboards, restores them, and purges them after the retention period', async () => {
    const db = await create();
    const id = newId('dashboard');
    const kept = newId('dashboard');
    await run(db.id, { kind: 'dashboard.create', dashboard: { id, name: 'Board' } });
    await run(db.id, { kind: 'dashboard.create', dashboard: { id: kept, name: 'Kept' } });
    await run(db.id, { kind: 'dashboard.trash', dashboardId: id });
    expect((await trash(db.id)).items).toEqual([
      {
        kind: 'dashboard',
        id,
        name: 'Board',
        tableId: null,
        tableName: null,
        trashedAt: expect.any(String),
        trashedBy: server.owner.userId,
      },
    ]);
    const reader = await server.addMember();
    await grant(db.id, reader, 'reader');
    const listed = await server.app.inject({ url: `/api/databases/${db.id}/trash`, headers: reader.headers });
    expect(listed.json<ListedTrash>().items.map((item) => item.id)).toEqual([id]);
    await run(db.id, { kind: 'dashboard.restore', dashboardId: id });
    expect((await trash(db.id)).items).toEqual([]);

    const trashing = await run(db.id, { kind: 'dashboard.trash', dashboardId: id });
    await purgeTrash(server.ctx);
    expect((await trash(db.id)).items.map((item) => item.id)).toEqual([id]);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'dashboards')}
      SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${id}`,
    );
    expect((await trash(db.id)).items).toEqual([]);
    await purgeTrash(server.ctx);
    const rows = async () =>
      (
        await query<{ id: string }>(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'dashboards')} WHERE database_id = ${db.id}`,
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

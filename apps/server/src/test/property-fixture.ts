import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type ServerMessage,
} from '@riosoma/contracts';
import { ident, join, query, sql } from '@riosoma/db';
import { startTestPostgres } from '@riosoma/testkit';
import { loadFields } from '../data/metadata.js';
import { columnType } from '../data/physical/columns.js';
import { startServer, type ServerFixture } from './fixture.js';

export async function startPropertyServer() {
  const kit = await startTestPostgres();
  try {
    const server = await startServer(kit, 'properties');
    server.config.baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    return {
      server,
      async close() {
        try {
          await server.close();
        } finally {
          await kit.stop();
        }
      },
    };
  } catch (error) {
    await kit.stop();
    throw error;
  }
}

export async function propertyRequest<T>(
  server: ServerFixture,
  url: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const response = await server.app.inject({
    method: options.method ?? 'GET',
    url,
    headers: {
      ...server.owner.headers,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<T>();
}

export async function propertyCommand(
  server: ServerFixture,
  databaseId: string,
  input: Record<string, unknown>,
) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const result = await propertyRequest<CommandBatchResult>(server, `/api/databases/${databaseId}/commands`, {
    method: 'POST',
    body: { clientId: newId('client'), commands: [command] },
  });
  assert.equal(result.results[0]?.status, 'applied', JSON.stringify(result));
  return command;
}

export async function createPropertyDatabase(server: ServerFixture) {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Properties',
    table: {
      id: newId('table'),
      name: 'Records',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: newId('field'), name: 'Convertible', type: 'text' },
        { id: newId('field'), name: 'Optional', type: 'text' },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: Array.from({ length: 4 }, () => ({ id: newId('record') })),
    },
  });
  await propertyRequest(server, '/api/databases', { method: 'POST', body: input });
  const linkedTable = {
    id: newId('table'),
    name: 'Targets',
    fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
    view: { id: newId('view'), name: 'Grid' },
    records: Array.from({ length: 3 }, () => ({ id: newId('record') })),
  };
  await propertyCommand(server, input.id, { kind: 'table.create', table: linkedTable });
  const linkId = newId('field');
  await propertyCommand(server, input.id, {
    kind: 'field.create',
    tableId: input.table.id,
    field: { id: linkId, name: 'Targets', type: 'link', options: { linkedTableId: linkedTable.id } },
  });
  await propertyCommand(server, input.id, {
    kind: 'record.update',
    tableId: input.table.id,
    records: input.table.records.map(({ id }, index) => ({
      id,
      values: {
        [input.table.fields[0]!.id]: `Record ${index}`,
        [input.table.fields[1]!.id]: ['001.00', 'invalid', '-2', '0'][index],
        [linkId]: linkedTable.records.slice(0, index % 3).map(({ id: targetId }) => targetId),
      },
    })),
  });
  return { input, linkedTable, linkId };
}

type Identity = { fields: string[]; records: string[] };

/** Drop each generated case so nightly runs do not accumulate thousands of physical tables. */
export async function dropPropertyDatabase(server: ServerFixture, databaseId: string) {
  const tables = (
    await query<{ id: string }>(
      server.pool,
      sql`
    SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}
  `,
    )
  ).rows;
  const links = (
    await query<{ id: string }>(
      server.pool,
      sql`
    SELECT id FROM ${ident(server.schemas.app, 'links')}
    WHERE left_table_id = ANY(${tables.map(({ id }) => id)}::text[])
  `,
    )
  ).rows;
  for (const { id } of links)
    await query(server.pool, sql`DROP TABLE ${ident(server.schemas.data, `lnk_${id}`)}`);
  for (const { id } of tables) await query(server.pool, sql`DROP TABLE ${ident(server.schemas.data, id)}`);
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'commands')} WHERE database_id = ${databaseId}`,
  );
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${databaseId}`,
  );
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
}

/** Retained creation tombstones and column backups are storage, rather than editable state. */
export async function propertySnapshot(server: ServerFixture, databaseId: string, known?: Identity) {
  const tableIds = (
    await query<{ id: string }>(
      server.pool,
      sql`
    SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId} ORDER BY id
  `,
    )
  ).rows.map(({ id }) => id);
  // Each checkpoint follows a completed command.  Read its independent parts together, and
  // resolve field metadata once for all tables, rather than paying for serial round trips.
  const [fieldResult, viewResult, storedFields, positionResult, linkResult] = await Promise.all([
    query<{ id: string; state: Record<string, unknown> }>(
      server.pool,
      sql`
    SELECT id, (to_jsonb(f) - 'updated_at' - 'trashed_at' - 'column_name')
      || jsonb_build_object('trashed', trashed_at IS NOT NULL) AS state
    FROM ${ident(server.schemas.app, 'fields')} f WHERE table_id = ANY(${tableIds}::text[])
      AND (trashed_at IS NULL OR ${known === undefined} OR id = ANY(${known?.fields ?? []}::text[])) ORDER BY id
  `,
    ),
    query(
      server.pool,
      sql`
    SELECT to_jsonb(v) - 'updated_at' AS state FROM ${ident(server.schemas.app, 'views')} v
    WHERE table_id = ANY(${tableIds}::text[]) ORDER BY id
  `,
    ),
    loadFields(server.pool, server.schemas, tableIds, { includeTrashed: true }),
    query(
      server.pool,
      sql`
    SELECT view_id, record_id, position::text FROM ${ident(server.schemas.app, 'record_positions')}
    WHERE view_id IN (SELECT id FROM ${ident(server.schemas.app, 'views')} WHERE table_id = ANY(${tableIds}::text[]))
    ORDER BY view_id, record_id
  `,
    ),
    query<{ id: string }>(
      server.pool,
      sql`
    SELECT id FROM ${ident(server.schemas.app, 'links')} WHERE left_table_id = ANY(${tableIds}::text[]) ORDER BY id
  `,
    ),
  ]);
  const fields = fieldResult.rows;
  const records = (
    await Promise.all(
      tableIds.map(async (tableId) => {
        const stored = storedFields.filter(
          (field) =>
            field.tableId === tableId && fields.some(({ id }) => id === field.id) && columnType(field),
        );
        const values = stored.flatMap((field) => [sql`${field.id}::text`, sql`r.${ident(field.columnName)}`]);
        return (
          await query<{ id: string; state: unknown }>(
            server.pool,
            sql`
      SELECT __id AS id, jsonb_build_object(
        'id', __id, 'tableId', ${tableId}::text, 'createdAt', __created_at, 'createdBy', __created_by,
        'trashed', __deleted_at IS NOT NULL, 'overrides', __overrides,
        'values', jsonb_build_object(${join(values, ', ')})) AS state
      FROM ${ident(server.schemas.data, tableId)} r
      WHERE __deleted_at IS NULL OR ${known === undefined} OR __id = ANY(${known?.records ?? []}::text[])
      ORDER BY __id
    `,
          )
        ).rows;
      }),
    )
  ).flat();
  records.sort((a, b) => a.id.localeCompare(b.id));
  const edges = await Promise.all(
    linkResult.rows.map(async ({ id }) => ({
      id,
      rows: (
        await query(
          server.pool,
          sql`
      SELECT * FROM ${ident(server.schemas.data, `lnk_${id}`)} ORDER BY left_rid, right_rid
    `,
        )
      ).rows,
    })),
  );
  return {
    identity: { fields: fields.map(({ id }) => id), records: records.map(({ id }) => id) },
    state: {
      fields: fields.map(({ state }) => state),
      views: viewResult.rows,
      records: records.map(({ state }) => state),
      positions: positionResult.rows,
      edges,
    },
  };
}

export async function propertyHistory(server: ServerFixture, databaseId: string) {
  const [changes, records, groups] = await Promise.all([
    query<{ seq: string; group_id: string; undo_of: string | null; redo_of: string | null }>(
      server.pool,
      sql`
      SELECT * FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId} ORDER BY seq
    `,
    ),
    query(
      server.pool,
      sql`
      SELECT * FROM ${ident(server.schemas.app, 'record_changes')} WHERE database_id = ${databaseId}
      ORDER BY seq, table_id, record_id
    `,
    ),
    query<{ group_id: string; state: string }>(
      server.pool,
      sql`
      SELECT group_id, state FROM ${ident(server.schemas.app, 'undo_groups')}
      WHERE database_id = ${databaseId} ORDER BY group_id
    `,
    ),
  ]);
  return { changes: changes.rows, records: records.rows, groups: groups.rows };
}

export async function propertyUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, 'property condition timed out');
    await delay(2);
  }
}

/** Buffers actual server messages so tests can control delivery without replacing the realtime route. */
export class PropertySocket {
  private socket: WebSocket;
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  readonly pending: ServerMessage[] = [];
  readonly received: ServerMessage[] = [];
  held = false;
  closed = false;
  readonly opening: Promise<void>;
  constructor(server: ServerFixture) {
    this.socket = new WebSocket(server.config.baseUrl!.replace(/^http/, 'ws') + '/api/realtime', {
      headers: { cookie: server.owner.headers.cookie, origin: server.config.baseUrl! },
    });
    this.opening = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        if (this.closed) this.socket.close();
        else this.emit('open', {});
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('property socket upgrade failed')));
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.received.push(message);
      if (this.held && ['change', 'caughtUp', 'viewDelta'].includes(message.type)) this.pending.push(message);
      else this.deliver(message);
    });
    this.socket.addEventListener('close', () => this.emit('close', {}));
    this.socket.addEventListener('error', () => this.emit('error', {}));
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  private emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    assert.ok(this.socket && !this.closed, 'socket is disconnected');
    this.socket.send(data);
  }
  deliver(message: ServerMessage) {
    if (!this.closed) this.emit('message', { data: JSON.stringify(message) });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    this.emit('close', {});
  }
}

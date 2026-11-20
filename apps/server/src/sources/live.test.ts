import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  encodeWhere,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type PositionResult,
  type RowData,
  type RowsPage,
  type SourceMeta,
  type TableMeta,
} from '@riosoma/contracts';
import { closeLivePools, forgetLiveColumns } from '@riosoma/connectors';
import { refusedPort, startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { ident, query, sql } from '@riosoma/db';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { AccessScope } from '../data/access.js';
import { rowsById } from '../api-v1/reads.js';
import { actorFor } from '../automations/run.js';
import { Simulation } from '../automations/simulation.js';
import { findRecords } from '../data/commands/find.js';
import { RoutineTools } from '../routines/tools.js';
import { claimSyncs, runSync } from './sync.js';

/**
 * Live tables against a real source: a second PostgreSQL database the test kit starts beside the
 * app's own.  MySQL and SQL Server get the same reads in the connectors' live tests.
 */

let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
let databaseId: string;
let sourceDb: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let remote: pg.Client;
let source: SourceMeta;

const STATUS = ['open', 'closed', 'waiting'];

async function run(input: Record<string, unknown>, who = server.owner) {
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId: newId('client'), commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { result: response.json<CommandBatchResult>().results[0]!, groupId };
}

async function applied(input: Record<string, unknown>, who = server.owner) {
  const { result, groupId } = await run(input, who);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  return groupId;
}

async function rejected(input: Record<string, unknown>, messageKey: string, who = server.owner) {
  const { result } = await run(input, who);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'rejected', error: { messageKey } });
}

async function page(viewId: string, params: Record<string, string> = {}, who = server.owner) {
  const search = new URLSearchParams({ offset: '0', limit: '100', ...params });
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/views/${viewId}/rows?${search}`,
    headers: who.headers,
  });
  return response;
}

async function rows(
  viewId: string,
  params: Record<string, string> = {},
  who = server.owner,
): Promise<RowsPage> {
  const response = await page(viewId, params, who);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowsPage>();
}

interface LiveTable {
  id: string;
  viewId: string;
  key: string;
  name: string;
  qty: string;
  done: string;
  due: string;
  status: string;
  note: string;
}

async function createTable(
  options: { object?: string; freshness?: 'copy' | 'live'; sourceId?: string } = {},
): Promise<LiveTable> {
  const t: LiveTable = {
    id: newId('table'),
    viewId: newId('view'),
    key: newId('field'),
    name: newId('field'),
    qty: newId('field'),
    done: newId('field'),
    due: newId('field'),
    status: newId('field'),
    note: newId('field'),
  };
  await applied({
    kind: 'table.create',
    table: {
      id: t.id,
      name: t.id,
      source: {
        sourceId: options.sourceId ?? source.id,
        select: { kind: 'object', object: { schema: 'public', name: options.object ?? 'items' } },
        keyColumns: ['id'],
        everyMinutes: null,
        freshness: options.freshness ?? 'live',
      },
      fields: [
        { id: t.name, name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
        { id: t.key, name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
        { id: t.qty, name: 'Qty', type: 'number', source: { column: 'qty', sourceType: '' } },
        { id: t.done, name: 'Done', type: 'checkbox', source: { column: 'done', sourceType: '' } },
        { id: t.due, name: 'Due', type: 'date', source: { column: 'due', sourceType: '' } },
        { id: t.status, name: 'Status', type: 'singleSelect', source: { column: 'status', sourceType: '' } },
        { id: t.note, name: 'Note', type: 'text' },
      ],
      view: { id: t.viewId, name: 'Grid' },
      records: [],
    },
  });
  return t;
}

async function setView(t: LiveTable, config: Record<string, unknown>) {
  await applied({ kind: 'view.update', viewId: t.viewId, config });
}

async function tableMeta(id: string): Promise<TableMeta> {
  return (await loadTable(server.pool, server.schemas, id))!;
}

function valuesOf(page: RowsPage, fieldId: string): unknown[] {
  return page.rows.map((row) => row?.values[fieldId] ?? null);
}

async function addSource(): Promise<SourceMeta> {
  const url = new URL(sourceDb.url);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: `Remote ${newId('source')}`,
      connection: {
        kind: 'postgres',
        host: url.hostname,
        port: Number(url.port || 5432),
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username),
        tls: { mode: 'disable' },
      },
      secrets: { password: decodeURIComponent(url.password) || 'test' },
      access: 'creators',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourceMeta>();
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'livesrc');
  editor = await server.addMember();
  sourceDb = await kit.createDatabase('livesource');
  remote = new pg.Client({ connectionString: sourceDb.url });
  await remote.connect();
  await remote.query(`CREATE TABLE items (id integer PRIMARY KEY, name varchar(80), qty numeric(10,2),
    done boolean, due date, status text)`);
  for (let i = 1; i <= 30; i++)
    await remote.query('INSERT INTO items VALUES ($1, $2, $3, $4, $5, $6)', [
      i,
      `Item ${String(i).padStart(2, '0')}`,
      i % 7,
      i % 3 === 0,
      `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
      STATUS[i % 3],
    ]);
  await remote.query(`CREATE VIEW slow_items AS SELECT * FROM items WHERE pg_sleep(0.05) IS NOT NULL`);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Live',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${editor.userId}, 'editor')`,
  );
  source = await addSource();
}, 60_000);

afterAll(async () => {
  await closeLivePools();
  forgetLiveColumns();
  await remote?.end();
  await sourceDb?.drop();
  await server?.close();
  await kit?.stop();
});

describe('live tables', () => {
  it('rebuilds rows and positions when a snapshot belongs to a different where token', async () => {
    const t = await createTable();
    const all = await rows(t.viewId);
    const where = encodeWhere({
      conjunction: 'and',
      conditions: [{ id: 'part', fieldId: t.key, operator: 'eq', value: 1 }],
    });
    const fresh = await rows(t.viewId, { where });
    expect(fresh.total).toBe(1);
    const reused = await rows(t.viewId, { where, snapshot: all.snapshot });
    expect(reused.total).toBe(1);
    expect(reused.rebuilt).toBe(true);
    expect(valuesOf(reused, t.key)).toEqual([1]);
    expect(reused.snapshot).not.toBe(all.snapshot);
    const same = await rows(t.viewId, { where, snapshot: reused.snapshot });
    expect(same).toMatchObject({ total: 1, rebuilt: false, snapshot: reused.snapshot });
    const position = await server.app.inject({
      method: 'GET',
      url: `/api/views/${t.viewId}/position?${new URLSearchParams({
        where,
        snapshot: all.snapshot,
        recordId: all.rows[1]!.id,
      })}`,
      headers: server.owner.headers,
    });
    expect(position.statusCode, position.body).toBe(200);
    expect(position.json<PositionResult>()).toMatchObject({ total: 1, index: null });
    const cleared = await rows(t.viewId, { snapshot: reused.snapshot });
    expect(cleared).toMatchObject({ total: 30, rebuilt: true });
  });

  it('finds current source values through the automation reader', async () => {
    const t = await createTable();
    await rows(t.viewId, { limit: '1' });
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    try {
      await remote.query('UPDATE items SET qty = 947 WHERE id = 1');
      const found = await findRecords(server.app, actor!, databaseId, {
        tableId: t.id,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'current', fieldId: t.qty, operator: 'eq', value: 947 }],
        },
        limit: 10,
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.values[t.qty]).toBe(947);
    } finally {
      await remote.query('UPDATE items SET qty = 1 WHERE id = 1');
    }
  });

  it('rolls back records and choices discovered by a simulated search', async () => {
    const t = await createTable();
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const before = await loadFields(server.pool, server.schemas, [t.id]);
    const simulation = new Simulation(server.pool);
    try {
      const found = await simulation.change((db) =>
        findRecords(server.app, actor!, databaseId, { tableId: t.id, limit: 2 }, db, simulation),
      );
      expect(found).toHaveLength(2);
      expect(found[0]?.values[t.status]).not.toBeNull();
    } finally {
      await simulation.discard();
    }
    expect(
      (await query(server.pool, sql`SELECT __id FROM ${ident(server.schemas.data, t.id)}`)).rows,
    ).toHaveLength(0);
    expect(await loadFields(server.pool, server.schemas, [t.id])).toEqual(before);
  });

  it('refuses unsupported live search filters instead of widening automation results', async () => {
    const t = await createTable();
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    await expect(
      findRecords(server.app, actor!, databaseId, {
        tableId: t.id,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'local', fieldId: t.note, operator: 'is', value: 'Wanted' }],
        },
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.filterUnsupported' });
  });

  it('checks record locks against fresh source values before changing a local field', async () => {
    const t = await createTable();
    const record = (await rows(t.viewId, { limit: '1' })).rows[0]!;
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id: record.id, values: { [t.qty]: 1 } }],
    });
    await applied({
      kind: 'record.clearOverrides',
      tableId: t.id,
      records: [{ id: record.id, fieldIds: [t.qty] }],
    });
    await applied({
      kind: 'table.update',
      tableId: t.id,
      recordLock: {
        bypass: 'nobody',
        reason: 'Reviewed at the source',
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'reviewed', fieldId: t.qty, operator: 'eq', value: 1 }],
        },
      },
    });
    try {
      await remote.query('UPDATE items SET qty = 2 WHERE id = 1');
      await applied({
        kind: 'record.update',
        tableId: t.id,
        records: [{ id: record.id, values: { [t.note]: 'Editable now' } }],
      });
      await remote.query('UPDATE items SET qty = 1 WHERE id = 1');
      await rejected(
        {
          kind: 'record.update',
          tableId: t.id,
          records: [{ id: record.id, values: { [t.note]: 'Must stay unchanged' } }],
        },
        'data.locks.recordLocked',
      );
      expect((await rows(t.viewId, { limit: '1', refresh: '1' })).rows[0]).toMatchObject({
        values: { [t.note]: 'Editable now' },
      });
    } finally {
      await remote.query('UPDATE items SET qty = 1 WHERE id = 1');
    }
  });

  it('groups live source values before sorts and computes summaries across every page', async () => {
    const t = await createTable();
    await setView(t, {
      groups: [{ fieldId: t.done, direction: 'asc' }],
      sorts: [{ fieldId: t.qty, direction: 'desc' }],
      summaries: { [t.qty]: 'sum' },
    });
    const first = await rows(t.viewId, { limit: '5' });
    expect(first.groups?.map((group) => [group.values[t.done], group.start, group.count])).toEqual([
      [false, 0, 20],
      [true, 20, 10],
    ]);
    const total = (done: boolean) =>
      Array.from({ length: 30 }, (_, index) => index + 1)
        .filter((index) => (index % 3 === 0) === done)
        .reduce((sum, index) => sum + (index % 7), 0);
    expect(first.groups?.map((group) => group.summaries[t.qty]?.value)).toEqual([total(false), total(true)]);
    expect(valuesOf(first, t.done)).toEqual(Array(5).fill(false));
    const quantities = valuesOf(first, t.qty) as number[];
    expect(quantities).toEqual([...quantities].sort((a, b) => b - a));
    const second = await rows(t.viewId, { snapshot: first.snapshot, offset: '20', limit: '5' });
    expect(second.groups).toBeUndefined();
    expect(valuesOf(second, t.done)).toEqual(Array(5).fill(true));
  });
  it('start ready to read, and never sync on a schedule', async () => {
    const t = await createTable();
    const table = await tableMeta(t.id);
    expect(table.source).toMatchObject({ freshness: 'live', status: { state: 'idle', nextSyncAt: null } });
    expect((await claimSyncs(server.ctx, 100)).map((job) => job.table_id)).not.toContain(t.id);
    await rejected({ kind: 'table.sync', tableId: t.id }, 'sources.live.noSync');
  });

  it('page the source in two phases, on a snapshot that holds still until refreshed', async () => {
    const t = await createTable();
    const first = await rows(t.viewId, { limit: '10' });
    expect(first.total).toBe(30);
    expect(first.live).toMatchObject({ skipped: [], truncatedAt: null });
    expect(valuesOf(first, t.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.rows[0]).toMatchObject({
      values: { [t.name]: 'Item 01', [t.qty]: 1, [t.due]: '2026-03-02' },
    });
    await remote.query(`INSERT INTO items VALUES (31, 'Item 31', 3, false, '2026-04-01', 'open')`);
    try {
      const second = await rows(t.viewId, { limit: '10', offset: '10', snapshot: first.snapshot });
      expect(second).toMatchObject({ snapshot: first.snapshot, total: 30, rebuilt: false });
      expect(valuesOf(second, t.key)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const fresh = await rows(t.viewId, { limit: '10', refresh: '1' });
      expect(fresh.total).toBe(31);
      const position = await server.app.inject({
        method: 'GET',
        url: `/api/views/${t.viewId}/position?recordId=${second.rows[4]!.id}&snapshot=${fresh.snapshot}`,
        headers: server.owner.headers,
      });
      expect(position.json<PositionResult>()).toMatchObject({ index: 14, total: 31 });
    } finally {
      await remote.query('DELETE FROM items WHERE id = 31');
    }
  });

  it('keep each record’s ID from one read to the next', async () => {
    const t = await createTable();
    const once = await rows(t.viewId);
    const again = await rows(t.viewId, { refresh: '1' });
    expect(again.rows.map((row) => row!.id)).toEqual(once.rows.map((row) => row!.id));
    const record = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${t.id}/records/${once.rows[2]!.id}`,
      headers: server.owner.headers,
    });
    expect(record.json<RowData>()).toMatchObject({ id: once.rows[2]!.id, values: { [t.key]: 3 } });
  });

  it('filter and sort in the source, choices included', async () => {
    const t = await createTable();
    await rows(t.viewId);
    const table = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${databaseId}/schema`,
      headers: server.owner.headers,
    });
    const status = table.json<DatabaseSchema>().fields.find((field) => field.id === t.status) as {
      options: { choices: Array<{ id: string; name: string }> };
    };
    expect(status.options.choices.map((choice) => choice.name).sort()).toEqual([...STATUS].sort());
    const open = status.options.choices.find((choice) => choice.name === 'open')!.id;
    await setView(t, {
      filter: {
        conjunction: 'and',
        conditions: [
          { id: 'a', fieldId: t.qty, operator: 'gte', value: 4 },
          { id: 'b', fieldId: t.status, operator: 'is', value: open },
          { id: 'c', fieldId: t.name, operator: 'contains', value: 'item' },
        ],
      },
      sorts: [
        { fieldId: t.qty, direction: 'desc' },
        { fieldId: t.name, direction: 'asc' },
      ],
    });
    const page = await rows(t.viewId, { refresh: '1' });
    const expected = Array.from({ length: 30 }, (_, index) => index + 1)
      .filter((i) => i % 7 >= 4 && STATUS[i % 3] === 'open')
      .sort((a, b) => (b % 7) - (a % 7) || a - b);
    expect(valuesOf(page, t.key)).toEqual(expected);
    expect(page.rows.every((row) => row!.values[t.status] === open)).toBe(true);
    expect(page.live).toMatchObject({ skipped: [], sourceOrder: true });
  });

  it('fall back with a note for a filter or sort the source can’t apply', async () => {
    const t = await createTable();
    await setView(t, {
      filter: {
        conjunction: 'and',
        conditions: [
          { id: 'a', fieldId: t.note, operator: 'contains', value: 'x' },
          { id: 'b', fieldId: t.key, operator: 'lte', value: 5 },
        ],
      },
      sorts: [{ fieldId: t.note, direction: 'asc' }],
    });
    const page = await rows(t.viewId);
    expect(valuesOf(page, t.key)).toEqual([1, 2, 3, 4, 5]);
    expect(page.live!.skipped).toEqual([
      { part: 'filter', fieldId: t.note, reason: 'localField' },
      { part: 'sort', fieldId: t.note, reason: 'localField' },
    ]);
  });

  it('lay overrides over live values, and keep local fields, comments, and history', async () => {
    const t = await createTable();
    const first = await rows(t.viewId, { limit: '5' });
    const record = first.rows[1]!;
    const groupId = await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id: record.id, values: { [t.name]: 'Renamed here', [t.note]: 'Local note' } }],
    });
    let read = await rows(t.viewId, { limit: '5', refresh: '1' });
    expect(read.rows[1]).toMatchObject({
      id: record.id,
      values: { [t.name]: 'Renamed here', [t.note]: 'Local note' },
      overrides: { [t.name]: { source: 'Item 02', by: server.owner.userId } },
    });
    await remote.query(`UPDATE items SET name = 'Item 02 at the source' WHERE id = 2`);
    read = await rows(t.viewId, { limit: '5', refresh: '1' });
    expect(read.rows[1]).toMatchObject({
      values: { [t.name]: 'Renamed here' },
      overrides: { [t.name]: { source: 'Item 02 at the source' } },
    });
    // A filter on a field someone overrides can't run in the source.
    await setView(t, {
      filter: { conjunction: 'and', conditions: [{ id: 'a', fieldId: t.name, operator: 'is', value: 'x' }] },
    });
    const filtered = await rows(t.viewId, { refresh: '1' });
    expect(filtered.total).toBe(30);
    expect(filtered.live!.skipped).toEqual([{ part: 'filter', fieldId: t.name, reason: 'overridden' }]);
    await setView(t, { filter: null });
    await applied({
      kind: 'comment.create',
      tableId: t.id,
      recordId: record.id,
      comment: { id: newId('comment'), body: 'Looks right' },
    });
    const comments = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${t.id}/records/${record.id}/comments`,
      headers: server.owner.headers,
    });
    expect(comments.statusCode, comments.body).toBe(200);
    expect(comments.body).toContain('Looks right');
    const history = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${t.id}/records/${record.id}/history`,
      headers: server.owner.headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).toContain('Renamed here');
    await applied({
      kind: 'record.clearOverrides',
      tableId: t.id,
      records: [{ id: record.id, fieldIds: [t.name] }],
    });
    read = await rows(t.viewId, { limit: '5', refresh: '1' });
    expect(read.rows[1]!.values[t.name]).toBe('Item 02 at the source');
    expect(read.rows[1]!.overrides).toBeUndefined();
    expect(read.rows[1]!.values[t.note]).toBe('Local note');
    const undo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/undo`,
      headers: server.owner.headers,
      payload: { groupId, commandId: newId('command'), clientId: newId('client') },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    read = await rows(t.viewId, { limit: '5', refresh: '1' });
    expect(read.rows[1]!.values[t.note]).toBeNull();
    await remote.query(`UPDATE items SET name = 'Item 02' WHERE id = 2`);
  });

  it.each(['field', 'record'])(
    'withholds duplicate live keys under %s access restrictions',
    async (restriction) => {
      const object = `duplicate_${randomBytes(8).toString('hex')}`;
      await remote.query(`CREATE TABLE "${object}" AS TABLE items WITH NO DATA`);
      const key = randomBytes(3).readUIntBE(0, 3);
      try {
        await remote.query(`INSERT INTO "${object}" SELECT * FROM items WHERE id = 1`);
        await remote.query(`UPDATE "${object}" SET id = $1`, [key]);
        const t = await createTable({ object });
        const response = await server.app.inject({
          method: 'PUT',
          url:
            restriction === 'field' ? `/api/fields/${t.key}/permissions` : `/api/tables/${t.id}/record-rules`,
          headers: server.owner.headers,
          payload:
            restriction === 'field'
              ? { restricted: { roles: ['owner'], users: [] }, locked: null }
              : {
                  rules: [
                    {
                      id: newId('recordRule'),
                      roles: ['editor'],
                      users: [],
                      condition: {
                        conjunction: 'and',
                        conditions: [{ id: 'visible', fieldId: t.name, operator: 'is', value: 'Item 01' }],
                      },
                    },
                  ],
                },
        });
        expect(response.statusCode, response.body).toBe(200);
        const initial = await rows(t.viewId, {}, editor);
        expect(initial.rows).toHaveLength(1);
        if (restriction === 'field') expect(initial.rows[0]!.values).not.toHaveProperty(t.key);
        await remote.query(`INSERT INTO "${object}" SELECT * FROM "${object}"`);
        const failed = await page(t.viewId, { refresh: '1' }, editor);
        expect(failed.statusCode).toBe(422);
        expect(failed.json().error).toEqual({
          code: 'validation_failed',
          messageKey: 'sources.sync.keyDuplicate',
          userFault: true,
        });
        expect(failed.body).not.toContain(String(key));
        const owner = await page(t.viewId, { refresh: '1' });
        expect(owner.json().error.params.key).toContain(String(key));
      } finally {
        await remote.query(`DROP TABLE "${object}"`);
      }
    },
  );

  it('batches history cells using record rules evaluated by the live source', async () => {
    const t = await createTable();
    const history = newId('field');
    await applied({
      kind: 'field.create',
      tableId: t.id,
      field: { id: history, name: 'Changes', type: 'changeLog' },
    });
    const records = (await rows(t.viewId, { limit: '3' })).rows.filter((row) => row !== null);
    const first = records[0]!;
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id: first.id, values: { [t.note]: 'History entry' } }],
    });
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${t.id}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['editor'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'first', fieldId: t.key, operator: 'eq', value: first.values[t.key] }],
            },
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const read = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${t.id}/records/history`,
      headers: editor.headers,
      payload: { ids: records.map((row) => row.id), fieldIds: [history] },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual([
      { id: first.id, values: { [history]: [expect.objectContaining({ fieldIds: [t.note] })] } },
    ]);
  });

  it('apply a record rule in the source, and refuse rules and overrides it can’t keep', async () => {
    const t = await createTable();
    await rows(t.viewId);
    const schema = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${databaseId}/schema`,
      headers: server.owner.headers,
    });
    const status = schema.json<DatabaseSchema>().fields.find((field) => field.id === t.status) as {
      options: { choices: Array<{ id: string; name: string }> };
    };
    const open = status.options.choices.find((choice) => choice.name === 'open')!.id;
    const put = (conditions: unknown[]) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/tables/${t.id}/record-rules`,
        headers: server.owner.headers,
        payload: {
          rules: [
            {
              id: newId('recordRule'),
              roles: ['editor'],
              users: [],
              condition: { conjunction: 'and', conditions },
            },
          ],
        },
      });
    const local = await put([{ id: 'n', fieldId: t.note, operator: 'isEmpty' }]);
    expect(local.json()).toMatchObject({ error: { messageKey: 'sources.live.ruleUntranslatable' } });
    const saved = await put([{ id: 's', fieldId: t.status, operator: 'is', value: open }]);
    expect(saved.statusCode, saved.body).toBe(200);
    await setView(t, { groups: [{ fieldId: t.done, direction: 'asc' }] });
    const limited = await rows(t.viewId, { refresh: '1' }, editor);
    expect(limited.groups?.map((group) => [group.values[t.done], group.count])).toEqual([[true, 10]]);
    const expected = Array.from({ length: 30 }, (_, index) => index + 1).filter(
      (i) => STATUS[i % 3] === 'open',
    );
    expect(valuesOf(limited, t.key)).toEqual(expected);
    expect((await rows(t.viewId, { refresh: '1' })).total).toBe(30);
    const everyone = await rows(t.viewId);
    const hidden = everyone.rows.find((row) => row!.values[t.status] !== open)!;
    const shown = limited.rows[0]!;
    const denied = await server.app.inject({
      method: 'GET',
      url: `/api/tables/${t.id}/records/${hidden.id}`,
      headers: editor.headers,
    });
    expect(denied.statusCode).toBe(404);
    await rejected(
      { kind: 'record.update', tableId: t.id, records: [{ id: hidden.id, values: { [t.note]: 'no' } }] },
      'data.access.recordHidden',
      editor,
    );
    await applied(
      { kind: 'record.update', tableId: t.id, records: [{ id: shown.id, values: { [t.note]: 'mine' } }] },
      editor,
    );
    await rejected(
      { kind: 'record.update', tableId: t.id, records: [{ id: shown.id, values: { [t.status]: null } }] },
      'sources.live.ruleField',
    );
    await applied(
      {
        kind: 'comment.create',
        tableId: t.id,
        recordId: shown.id,
        comment: { id: newId('comment'), body: 'Seen' },
      },
      editor,
    );
  });

  it('stop a read at its statement timeout, and show a source that’s down as an error', async () => {
    const slow = await createTable({ object: 'slow_items' });
    server.ctx.config.liveTimeoutMs = 300;
    try {
      const timedOut = await page(slow.viewId);
      expect(timedOut.statusCode).toBe(503);
      expect(timedOut.json()).toMatchObject({ error: { messageKey: 'sources.live.timeout' } });
    } finally {
      server.ctx.config.liveTimeoutMs = undefined;
    }
    // A source that answered when the table was made, then went away.  Its address is one nothing
    // can take over, so a read that reaches for it never reaches another test's server instead.
    const moving = await addSource();
    const t = await createTable({ sourceId: moving.id });
    expect((await rows(t.viewId)).total).toBe(30);
    const url = new URL(sourceDb.url);
    const moved = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${moving.id}`,
      headers: server.owner.headers,
      payload: {
        connection: {
          kind: 'postgres',
          host: '127.0.0.1',
          port: await refusedPort(),
          database: decodeURIComponent(url.pathname.slice(1)),
          user: decodeURIComponent(url.username),
          tls: { mode: 'disable' },
        },
        secrets: { password: decodeURIComponent(url.password) || 'test' },
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const failed = await page(t.viewId, { refresh: '1' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: { messageKey: 'sources.live.unreachable' } });
  }, 30_000);

  it('switch from Copy to Live keeping overrides and local fields, and back with a first sync', async () => {
    const t = await createTable({ freshness: 'copy' });
    await applied({ kind: 'table.sync', tableId: t.id });
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    // A copy lists records in the order the source first gave them, and a live read lists them by key.
    const copied = await rows(t.viewId);
    expect(copied.live).toBeUndefined();
    const record = copied.rows.find((row) => row!.values[t.key] === 3)!;
    await applied({
      kind: 'record.update',
      tableId: t.id,
      records: [{ id: record.id, values: { [t.qty]: 99, [t.note]: 'Kept' } }],
    });
    await applied({ kind: 'table.updateSource', tableId: t.id, settings: { freshness: 'live' } });
    expect((await tableMeta(t.id)).source).toMatchObject({ freshness: 'live', status: { nextSyncAt: null } });
    await remote.query('UPDATE items SET qty = 5 WHERE id = 3');
    const live = await rows(t.viewId, { limit: '3' });
    expect(live.live).toBeDefined();
    expect(live.rows[2]).toMatchObject({
      id: record.id,
      values: { [t.qty]: 99, [t.note]: 'Kept' },
      overrides: { [t.qty]: { source: 5 } },
    });
    await applied({ kind: 'table.updateSource', tableId: t.id, settings: { freshness: 'copy' } });
    const switching = await tableMeta(t.id);
    expect(switching.source).toMatchObject({
      freshness: 'copy',
      status: { state: 'queued', switchingToCopy: true },
    });
    // Until its first sync finishes, the table keeps reading live.
    expect((await rows(t.viewId, { limit: '3' })).live).toBeDefined();
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    const done = await tableMeta(t.id);
    expect(done.source!.status.switchingToCopy).toBeUndefined();
    expect(done.source!.status.state).toBe('idle');
    const after = await rows(t.viewId, { limit: '100' });
    expect(after.live).toBeUndefined();
    expect(after.total).toBe(30);
    expect(after.rows.find((row) => row!.id === record.id)).toMatchObject({
      id: record.id,
      values: { [t.qty]: 99, [t.note]: 'Kept' },
      overrides: { [t.qty]: { source: 5 } },
    });
    await remote.query('UPDATE items SET qty = 3 WHERE id = 3');
  }, 30_000);

  it('refuse what needs every record at hand', async () => {
    const t = await createTable();
    await rejected(
      {
        kind: 'field.create',
        tableId: t.id,
        field: { id: newId('field'), name: 'Total', type: 'formula', options: { expression: '1' } },
      },
      'sources.live.fieldUnavailable',
    );
    const schema = await server.app.inject({
      method: 'GET',
      url: `/api/databases/${databaseId}/schema`,
      headers: server.owner.headers,
    });
    const local = schema.json<DatabaseSchema>().tables.find((table) => table.name === 'Local')!;
    await rejected(
      {
        kind: 'field.create',
        tableId: local.id,
        field: { id: newId('field'), name: 'Items', type: 'link', options: { linkedTableId: t.id } },
      },
      'sources.live.fieldUnavailable',
    );
    const copy = await createTable({ freshness: 'copy' });
    await applied({
      kind: 'field.create',
      tableId: copy.id,
      field: { id: newId('field'), name: 'Total', type: 'formula', options: { expression: '1' } },
    });
    await rejected(
      { kind: 'table.updateSource', tableId: copy.id, settings: { freshness: 'live' } },
      'sources.live.fieldsInTheWay',
    );
    const stacks = await server.app.inject({
      method: 'GET',
      url: `/api/views/${t.viewId}/stacks`,
      headers: server.owner.headers,
    });
    expect(stacks.json()).toMatchObject({ error: { messageKey: 'sources.live.viewUnsupported' } });
  });

  it('download a live view in the source’s order', async () => {
    const t = await createTable();
    await setView(t, {
      sorts: [{ fieldId: t.key, direction: 'desc' }],
      groups: [{ fieldId: t.done, direction: 'asc' }],
    });
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/views/${t.viewId}/export?format=csv&locale=en-US&timeZone=UTC`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const lines = response.body.trim().split(/\r?\n/);
    expect(lines).toHaveLength(31);
    expect(lines[1]).toContain('Item 30');
    expect(lines[30]).toContain('Item 01');
  });
});

it('reads a joined table through two live sources after remote values change', async () => {
  const object = newId('table');
  await query(remote, sql`CREATE TABLE ${ident(object)} (LIKE items INCLUDING ALL)`);
  await query(
    remote,
    sql`INSERT INTO ${ident(object)} (id, name, qty, done, due, status) VALUES (1, 'Before', 2, false, NULL, 'open')`,
  );
  const left = await createTable({ object });
  const right = await createTable({ object });
  const id = newId('table');
  const field = newId('field');
  const viewId = newId('view');
  await applied({
    kind: 'table.create',
    table: {
      id,
      name: id,
      fields: [{ id: field, name: 'Joined name', type: 'text' }],
      view: { id: viewId, name: 'Grid' },
      joined: {
        baseTableId: left.id,
        steps: [
          {
            tableId: right.id,
            leftTableId: left.id,
            leftFieldId: left.key,
            rightFieldId: right.key,
            kind: 'inner',
          },
        ],
        fields: [{ tableId: right.id, fieldId: right.name, outputFieldId: field }],
      },
    },
  });
  expect(valuesOf(await rows(viewId), field)).toEqual(['Before']);
  await query(remote, sql`UPDATE ${ident(object)} SET name = 'After' WHERE id = 1`);
  expect(valuesOf(await rows(viewId), field)).toEqual(['After']);
});

it('reads a joined table over live inputs while another run holds an input’s lease', async () => {
  const object = newId('table');
  await query(remote, sql`CREATE TABLE ${ident(object)} (LIKE items INCLUDING ALL)`);
  await query(
    remote,
    sql`INSERT INTO ${ident(object)} (id, name, qty, done, due, status) VALUES (1, 'Held', 3, false, NULL, 'open')`,
  );
  const left = await createTable({ object });
  const right = await createTable({ object });
  const id = newId('table');
  const field = newId('field');
  const viewId = newId('view');
  await applied({
    kind: 'table.create',
    table: {
      id,
      name: id,
      fields: [{ id: field, name: 'Joined name', type: 'text' }],
      view: { id: viewId, name: 'Grid' },
      joined: {
        baseTableId: left.id,
        steps: [
          {
            tableId: right.id,
            leftTableId: left.id,
            leftFieldId: left.key,
            rightFieldId: right.key,
            kind: 'inner',
          },
        ],
        fields: [{ tableId: right.id, fieldId: right.name, outputFieldId: field }],
      },
    },
  });
  expect(valuesOf(await rows(viewId), field)).toEqual(['Held']);
  // A scheduled sync, or another person's read, holds the lease on both inputs.
  for (const held of [left.id, right.id])
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'table_sources')}
      SET lease_at = now(), lease_token = ${newId('job')} WHERE table_id = ${held}`,
    );
  await query(remote, sql`UPDATE ${ident(object)} SET name = 'Waiting' WHERE id = 1`);
  const held = await page(viewId);
  expect(held.statusCode, held.body).toBe(200);
  expect(valuesOf(held.json<RowsPage>(), field), 'the read takes the values already there').toEqual(['Held']);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'table_sources')}
    SET lease_at = NULL, lease_token = NULL WHERE table_id = ANY(${[left.id, right.id]}::text[])`,
  );
  expect(valuesOf(await rows(viewId), field)).toEqual(['Waiting']);
});

async function routineReads(tableIds: string[], who = editor): Promise<RoutineTools> {
  const owner = (await actorFor(server.pool, server.schemas, who.userId, server.owner.info.org.id))!;
  return new RoutineTools({
    app: server.app,
    owner: { ...owner, email: who.email, name: 'Snapshot reader' },
    runId: newId('routineRun'),
    autonomy: 'previewBig',
    allowPrivateHosts: false,
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    resolve: async () => {
      throw new Error('A snapshot read cannot resolve an outside address');
    },
    late: async () => undefined,
    routine: {
      id: newId('routine'),
      orgId: owner.orgId,
      ownerId: owner.userId,
      databaseId,
      name: 'Read snapshots',
      instructions: 'Count and read stored records.',
      plan: {
        summary: 'Read snapshots',
        steps: [],
        reads: tableIds,
        writes: [],
        sends: [],
        fetches: [],
      },
      schedule: { kind: 'hourly' },
      timeZone: 'UTC',
      locale: 'en-US',
      costCapUsd: 1,
      approvedRecipients: [],
      approvedSites: [],
      declinedSites: [],
      paused: false,
      adminPaused: false,
      pausedReason: null,
      failures: 0,
      nextRunAt: null,
    },
  });
}

it('routine reads keep nested joined snapshots and fail closed on live rules without outbound requests or record changes', async () => {
  const object = newId('table');
  await query(remote, sql`CREATE TABLE ${ident(object)} (LIKE items INCLUDING ALL)`);
  await query(
    remote,
    sql`INSERT INTO ${ident(object)} (id, name, qty) VALUES (1, 'Before', 2), (2, 'Hidden', 3)`,
  );
  const left = await createTable({ object });
  const right = await createTable({ object });
  const joinOf = async (base: { id: string; key: string; name: string }) => {
    const joined = { id: newId('table'), key: newId('field'), name: newId('field') };
    await applied({
      kind: 'table.create',
      table: {
        id: joined.id,
        name: joined.id,
        fields: [
          { id: joined.name, name: 'Name', type: 'text' },
          { id: joined.key, name: 'Key', type: 'number' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        joined: {
          baseTableId: base.id,
          steps: [
            {
              tableId: right.id,
              leftTableId: base.id,
              leftFieldId: base.key,
              rightFieldId: right.key,
              kind: 'inner',
            },
          ],
          fields: [
            { tableId: base.id, fieldId: base.name, outputFieldId: joined.name },
            { tableId: base.id, fieldId: base.key, outputFieldId: joined.key },
          ],
        },
      },
    });
    return joined;
  };
  const joined = await joinOf(left);
  const nested = await joinOf(joined);
  const rule = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${left.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: left.name, operator: 'is', value: 'Before' }],
          },
        },
      ],
    },
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const reads = await routineReads([left.id, joined.id, nested.id]);
  const snapshot = async () =>
    Promise.all(
      [left, right, joined, nested].map(async (table) => ({
        records: (
          await query(server.pool, sql`SELECT * FROM ${ident(server.schemas.data, table.id)} ORDER BY __id`)
        ).rows,
        table: await tableMeta(table.id),
      })),
    );
  const before = await snapshot();
  await query(remote, sql`UPDATE ${ident(object)} SET name = 'After unattended read' WHERE id = 1`);
  const outbound = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await reads.call({ id: newId('command'), name: 'get_schema', arguments: {} });
    const unrestricted = await routineReads([left.id, joined.id, nested.id], server.owner);
    for (const table of [nested, joined]) {
      const count = await reads.call({
        id: newId('command'),
        name: 'count_records',
        arguments: { tableId: table.id },
      });
      expect.soft(count).toEqual({ count: 0 });
      const found = await reads.call({
        id: newId('command'),
        name: 'find_records',
        arguments: { tableId: table.id },
      });
      expect.soft(found).toMatchObject({ records: [] });
      expect
        .soft(
          await unrestricted.call({
            id: newId('command'),
            name: 'count_records',
            arguments: { tableId: table.id },
          }),
        )
        .toEqual({ count: 2 });
      const stored = await unrestricted.call({
        id: newId('command'),
        name: 'find_records',
        arguments: { tableId: table.id },
      });
      expect.soft(stored).toMatchObject({
        records: expect.arrayContaining([{ id: expect.any(String), [table.name]: 'Before', [table.key]: 1 }]),
      });
      expect.soft(JSON.stringify(stored)).not.toContain('After unattended read');
    }
    for (const reader of [reads, unrestricted])
      for (const name of ['count_records', 'find_records'])
        expect
          .soft(
            await reader
              .call({ id: newId('command'), name, arguments: { tableId: left.id } })
              .catch((error: unknown) => error),
          )
          .toMatchObject({ messageKey: 'sources.live.viewUnsupported' });
    expect.soft(await snapshot()).toEqual(before);
    const database = decodeURIComponent(new URL(sourceDb.url).pathname.slice(1));
    expect
      .soft(
        outbound.mock.contexts.filter(
          (client) => client instanceof pg.Client && Reflect.get(client, 'database') === database,
        ),
      )
      .toHaveLength(0);
    expect(reads.activity).toEqual([]);
    expect(reads.approvals).toBe(0);
  } finally {
    outbound.mockRestore();
  }
});

it('refuses routine reads of never-joined live identity rows and fails closed on negative record rules', async () => {
  const object = newId('table');
  await query(remote, sql`CREATE TABLE ${ident(object)} (LIKE items INCLUDING ALL)`);
  await query(remote, sql`INSERT INTO ${ident(object)} SELECT * FROM items`);
  const t = await createTable({ object });
  const browsed = await rows(t.viewId);
  const hidden = browsed.rows.find((row) => row?.values[t.done] === false)!;
  await applied({
    kind: 'record.update',
    tableId: t.id,
    records: [{ id: hidden.id, values: { [t.note]: 'Private note', [t.name]: 'Private override' } }],
  });
  await query(remote, sql`UPDATE ${ident(object)} SET done = true WHERE id = ${hidden.values[t.key]}`);
  const rule = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${t.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'unchecked', fieldId: t.done, operator: 'is', value: false }],
          },
        },
      ],
    },
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const limited = await rows(t.viewId, { refresh: '1' }, editor);
  expect(limited.total).toBe(19);
  expect(limited.rows.map((row) => row?.id)).not.toContain(hidden.id);
  const snapshot = async () =>
    (await query(server.pool, sql`SELECT * FROM ${ident(server.schemas.data, t.id)} ORDER BY __id`)).rows;
  const before = await snapshot();
  const outbound = vi.spyOn(pg.Client.prototype, 'query');
  try {
    for (const who of [editor, server.owner]) {
      const reads = await routineReads([t.id], who);
      for (const name of ['find_records', 'count_records']) {
        const answer = await reads
          .call({ id: newId('command'), name, arguments: { tableId: t.id } })
          .catch((error: unknown) => error);
        expect.soft(answer).toMatchObject({ messageKey: 'sources.live.viewUnsupported' });
        expect.soft(JSON.stringify(answer)).not.toContain(hidden.id);
        expect.soft(JSON.stringify(answer)).not.toContain('Private');
      }
    }
    const actor = (await actorFor(server.pool, server.schemas, editor.userId, server.owner.info.org.id))!;
    const scope = new AccessScope(server.pool, server.schemas, actor, { readOnly: true });
    await scope.require(databaseId, 'read');
    // Even IDs confirmed by an earlier interactive read cannot authorize a stored routine read.
    scope.confirmLive(
      t.id,
      browsed.rows.map((row) => row!.id),
    );
    expect
      .soft(
        await rowsById(
          {
            pool: server.pool,
            schemas: server.schemas,
            actor,
            scope,
            table: (await loadTable(server.pool, server.schemas, t.id))!,
            fields: scope.visibleFields(t.id, await loadFields(server.pool, server.schemas, [t.id])),
          },
          browsed.rows.map((row) => row!.id),
        ),
      )
      .toEqual([]);
    expect.soft(await snapshot()).toEqual(before);
    const database = decodeURIComponent(new URL(sourceDb.url).pathname.slice(1));
    expect
      .soft(
        outbound.mock.contexts.filter(
          (client) => client instanceof pg.Client && Reflect.get(client, 'database') === database,
        ),
      )
      .toHaveLength(0);
  } finally {
    outbound.mockRestore();
  }
});

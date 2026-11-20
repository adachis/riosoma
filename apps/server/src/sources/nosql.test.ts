import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  newId,
  SourceConnection,
  type CommandBatchResult,
  type DatabaseSchema,
  type SourceMeta,
  type SourcePreview,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadTable } from '../data/metadata.js';
import { checkNoSqlSource } from './nosql.js';
import { claimSyncs, runSync } from './sync.js';
import * as sourceStore from './store.js';

let kit: TestPostgres;
let server: ServerFixture;
let remote: Server;
let endpoint = '';
let databaseId = '';
let sequence = 1;
let failChanges = false;
let docs = Array.from({ length: 25 }, (_, n) => ({ _id: `item-${n}`, name: `Row ${n}` }));
let changes: Array<{ id: string; doc?: (typeof docs)[number]; deleted?: boolean }> = [];
const selected = { kind: 'object' as const, object: { schema: null, name: 'items' } };

/** The part of Mango a filtered read asks this stand-in for: equality, ranges, and the two joins. */
function matches(doc: Record<string, unknown>, selector: Record<string, unknown>): boolean {
  return Object.entries(selector).every(([field, test]) => {
    if (field === '$and' || field === '$or') {
      const parts = (test as Record<string, unknown>[]).map((inner) => matches(doc, inner));
      return field === '$and' ? parts.every(Boolean) : parts.some(Boolean);
    }
    const value = doc[field];
    const ordered = (wanted: unknown, holds: (a: number, b: number) => boolean): boolean =>
      typeof value === 'number' && typeof wanted === 'number' && holds(value, wanted);
    return Object.entries(test as Record<string, unknown>).every(([operator, wanted]) => {
      if (operator === '$eq') return value === wanted;
      if (operator === '$ne') return value !== wanted;
      if (operator === '$gt') return ordered(wanted, (a, b) => a > b);
      if (operator === '$gte') return ordered(wanted, (a, b) => a >= b);
      if (operator === '$lt') return ordered(wanted, (a, b) => a < b);
      if (operator === '$lte') return ordered(wanted, (a, b) => a <= b);
      return false;
    });
  });
}

function answer(path: string, body: string, res: ServerResponse): void {
  const url = new URL(path, 'http://127.0.0.1');
  if (url.pathname.endsWith('/_changes') && failChanges) {
    res.writeHead(503).end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/_all_dbs') res.end(JSON.stringify(['items']));
  else if (url.pathname.endsWith('/_find')) {
    const asked = JSON.parse(body) as { selector: Record<string, unknown>; limit?: number };
    const found = docs.filter((doc) => matches(doc, asked.selector));
    res.end(JSON.stringify({ docs: found.slice(0, asked.limit ?? found.length) }));
  } else if (url.pathname.endsWith('/_all_docs'))
    res.end(
      JSON.stringify({
        rows: docs
          .slice(0, Number(url.searchParams.get('limit') ?? 1000))
          .map((doc) => ({ id: doc._id, doc })),
      }),
    );
  else if (url.pathname.endsWith('/_changes'))
    res.end(
      JSON.stringify({
        results: url.searchParams.get('since') === `sequence-${sequence}` ? [] : changes,
        last_seq: `sequence-${sequence}`,
        pending: 0,
      }),
    );
  else res.end(JSON.stringify({ update_seq: `sequence-${sequence}` }));
}

beforeAll(async () => {
  remote = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => answer(req.url!, Buffer.concat(parts).toString('utf8'), res));
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  server = await startServer(kit, 'nosqlsrc', { automationsAllowPrivateHosts: true });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Documents',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  databaseId = response.json<DatabaseSchema>().database.id;
}, 60000);

it('preserves CouchDB cursors for unchanged resolved credentials and clears them after rotation', async () => {
  const password = randomBytes(16).toString('hex');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Credential changes',
      connection: { kind: 'couchdb', endpoint, user: 'reader' },
      secrets: { password },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const source = created.json<SourceMeta>();
  const tableId = newId('table');
  await command({
    kind: 'table.create',
    table: {
      id: tableId,
      name: 'Credential changes',
      source: { sourceId: source.id, select: selected, keyColumns: ['_id'], everyMinutes: null },
      fields: [
        { id: newId('field'), name: 'Name', type: 'text', source: { column: 'name', sourceType: 'string' } },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  expect(await sync(tableId)).toMatchObject({ state: 'idle' });
  const committed = await state(tableId);
  expect(committed.cursor).toBe(`sequence-${sequence}`);
  const resolveSecrets = vi.spyOn(sourceStore, 'secretsFor');
  try {
    for (const payload of [{ name: 'Renamed credential changes' }, { secrets: { password } }]) {
      const updated = await server.app.inject({
        method: 'PATCH',
        url: `/api/sources/${source.id}`,
        headers: server.owner.headers,
        payload,
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(await state(tableId)).toEqual(committed);
    }
    const rotated = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { secrets: { password: randomBytes(16).toString('hex') } },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(await state(tableId)).toBeNull();
    expect(resolveSecrets).toHaveBeenCalled();
    for (const call of resolveSecrets.mock.calls) expect(call[2]).toBeDefined();
  } finally {
    resolveSecrets.mockRestore();
  }
}, 60000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  if (remote) await new Promise<void>((resolve) => remote.close(() => resolve()));
});
async function command(body: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...body }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({ status: 'applied' });
}
async function sync(tableId: string, confirmRemovals = false) {
  await command({ kind: 'table.sync', tableId, confirmRemovals });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!.source!.status;
}
async function state(tableId: string) {
  return (
    await query<{ fetch_state: Record<string, unknown> }>(
      server.pool,
      sql`SELECT fetch_state FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ${tableId}`,
    )
  ).rows[0]!.fetch_state;
}
async function active(tableId: string) {
  return (
    await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone`,
    )
  ).rows[0]!.count;
}
it('holds every document service to the private-network rule', () => {
  for (const kind of ['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb']) {
    const connection = SourceConnection.parse({
      kind,
      endpoint,
      user: 'reader',
      region: 'us-east-1',
      projectId: 'rio-test',
      database: 'test',
      emulator: true,
    });
    expect(() =>
      checkNoSqlSource(connection, { production: true, automationsAllowPrivateHosts: false }),
    ).toThrow();
    expect(() =>
      checkNoSqlSource(connection, { production: true, automationsAllowPrivateHosts: true }),
    ).not.toThrow();
  }
});
it('preserves unstaged rows and committed cursors through deltas, failures, and deletion holds', async () => {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Documents',
      connection: { kind: 'couchdb', endpoint, user: 'reader' },
      secrets: { password: randomBytes(16).toString('hex') },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const source = created.json<SourceMeta>();
  const preview = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/preview`,
    headers: server.owner.headers,
    payload: { select: selected },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const columns = preview.json<SourcePreview>().columns;
  const tableId = newId('table');
  await command({
    kind: 'table.create',
    table: {
      id: tableId,
      name: 'Items',
      source: { sourceId: source.id, select: selected, keyColumns: ['_id'], everyMinutes: null },
      fields: columns.map((c) => ({
        id: newId('field'),
        name: c.name,
        type: c.suggested!.type,
        options: c.suggested!.options,
        source: { column: c.name, sourceType: c.sourceType },
      })),
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  expect(await sync(tableId)).toMatchObject({ state: 'idle', stats: { added: 25 } });
  expect(await state(tableId)).toMatchObject({ cursor: 'sequence-1' });
  docs[0] = { ...docs[0]!, name: 'Changed' };
  changes = [
    { id: docs[0]!._id, doc: { ...docs[0]!, name: 'Earlier' } },
    { id: docs[0]!._id, doc: docs[0]! },
  ];
  sequence++;
  expect(await sync(tableId)).toMatchObject({ state: 'idle', stats: { changed: 1, removed: 0 } });
  expect(await active(tableId)).toBe('25');
  failChanges = true;
  sequence++;
  expect(await sync(tableId)).toMatchObject({ state: 'failed' });
  expect(await state(tableId)).toMatchObject({ cursor: 'sequence-2' });
  failChanges = false;
  changes = docs.slice(0, 20).map((doc) => ({ id: doc._id, deleted: true }));
  docs = docs.slice(20);
  expect(await sync(tableId)).toMatchObject({ state: 'held', held: { removing: 20, total: 25 } });
  expect(await active(tableId)).toBe('25');
  expect(await state(tableId)).toMatchObject({
    cursor: 'sequence-2',
    pending: { incremental: true, validators: { cursor: 'sequence-3' } },
  });
  const renamed = await server.app.inject({
    method: 'PATCH',
    url: `/api/sources/${source.id}`,
    headers: server.owner.headers,
    payload: { name: 'Renamed documents' },
  });
  expect(renamed.statusCode, renamed.body).toBe(200);
  await command({ kind: 'table.updateSource', tableId, settings: { everyMinutes: 60 } });
  expect(await state(tableId)).toMatchObject({ pending: { incremental: true } });
  expect(await sync(tableId, true)).toMatchObject({ state: 'idle', stats: { removed: 20 } });
  expect(await active(tableId)).toBe('5');
  expect(await state(tableId)).toMatchObject({ cursor: 'sequence-3' });
  expect((await state(tableId)).pending).toBeUndefined();
  expect(await sync(tableId)).toMatchObject({ state: 'idle', stats: { removed: 0 } });
  expect(await active(tableId)).toBe('5');
  await command({ kind: 'table.updateSource', tableId, settings: { removeMissing: false } });
  expect(await state(tableId)).toBeNull();
}, 60000);

it('narrows a document service with a filter for an admin and refuses everyone else', async () => {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Filtered documents',
      connection: { kind: 'couchdb', endpoint, user: 'reader' },
      secrets: { password: randomBytes(16).toString('hex') },
      access: 'creators',
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const source = created.json<SourceMeta>();
  const member = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'creator')`,
  );
  // Every document service reads a filter, not only MongoDB, and only an admin may write one.
  const wanted = docs[0]!;
  const select = { ...selected, filter: JSON.stringify({ _id: wanted._id }) };
  const refused = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/preview`,
    headers: member.headers,
    payload: { select },
  });
  expect(refused.json()).toMatchObject({ error: { messageKey: 'sources.filterAdminsOnly' } });
  const narrowed = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/preview`,
    headers: server.owner.headers,
    payload: { select },
  });
  expect(narrowed.statusCode, narrowed.body).toBe(200);
  const preview = narrowed.json<SourcePreview>();
  const cell = (column: string) =>
    preview.rows[0]![preview.columns.findIndex((entry) => entry.name === column)];
  expect(preview.rows).toHaveLength(1);
  expect(cell('_id')).toBe(wanted._id);
  expect(cell('name')).toBe(wanted.name);
}, 60000);

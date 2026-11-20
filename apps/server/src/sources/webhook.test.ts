/**
 * Webhook sources end to end: an address shown once and kept as a hash, posts that become records
 * through the command bus as the table's person, keyed posts that update them, lists that make
 * several, signatures and replays, a new address that retires the old one, the size and pace
 * limits, the delivery log and its hour of bodies, and a record rule that holds for a table a
 * webhook fills.  Then long whole numbers kept exact, posts kept through a passing problem, the
 * limits on choices a post adds, and a webhook's table restored from a snapshot.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  LIMITS,
  newId,
  WEBHOOK_SOURCE_LIMITS,
  type CommandBatchResult,
  type DatabaseCopy,
  type DatabaseSchema,
  type HistoryPage,
  type RowData,
  type RowsPage,
  type SnapshotMeta,
  type SourceMeta,
  type SourcePreview,
  type TableMeta,
  type WebhookAddress,
  type WebhookSourceLog,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { redactPathSecrets } from '../logger.js';
import { transientFailure } from './inbound-writer.js';
import { claimSyncs } from './sync.js';
import { createWebhookConnector, signatureProblem } from './webhook.js';
import { contractAdapter, exerciseFixture, runConnectorContract } from '@riosoma/connectors';
import { SourceConnection } from '@riosoma/contracts';

let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;
/** A shared secret made for this run, never written down whole. */
const SECRET = ['whsec', randomBytes(12).toString('hex')].join('_');
const POSTS = { kind: 'object' as const, object: { schema: null, name: 'posts' } };

it('runs shared discovery contracts before a webhook has received posts', async () => {
  await exerciseFixture(
    createWebhookConnector(server.app.ctx),
    {
      connection: SourceConnection.parse({ kind: 'webhook' }),
      secrets: {},
    },
    POSTS,
    [],
    0,
  );
});

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'hooksrc');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Hooks',
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
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

afterEach(() => {
  vi.useRealTimers();
});

async function createSource(
  connection: Record<string, unknown> = {},
  secrets: Record<string, string> = {},
): Promise<SourceMeta & { webhookPath: string }> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: { name: `Hook ${newId('source')}`, connection: { kind: 'webhook', ...connection }, secrets },
  });
  expect(response.statusCode, response.body).toBe(200);
  const meta = response.json<SourceMeta & { webhookPath: string }>();
  expect(meta.webhookPath).toMatch(/^\/api\/inbound\/[A-Za-z0-9_-]{43}$/);
  return meta;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function sign(body: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function commands(who: SignedIn, input: Array<Record<string, unknown>>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: input.map((command) => ({ id: newId('command'), groupId: newId('action'), ...command })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results;
}

async function applied(input: Record<string, unknown>, who = server.owner): Promise<void> {
  const [result] = await commands(who, [input]);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

async function log(sourceId: string): Promise<WebhookSourceLog> {
  const response = await server.app.inject({
    url: `/api/sources/${sourceId}/webhook-deliveries`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WebhookSourceLog>();
}

const written = () => server.ctx.inbound!.drain();

/** What the mapping step shows, which also keeps it open. */
async function preview(sourceId: string): Promise<SourcePreview> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${sourceId}/preview`,
    headers: server.owner.headers,
    payload: { select: POSTS },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourcePreview>();
}

/** The posts a webhook still holds, oldest first. */
async function queued(sourceId: string) {
  const result = await query<{ attempts: number; failed: boolean; waiting: boolean }>(
    server.pool,
    sql`SELECT attempts, failed_at IS NOT NULL AS failed, next_attempt_at > now() AS waiting
    FROM ${ident(server.schemas.app, 'source_hook_posts')} WHERE source_id = ${sourceId} ORDER BY seq`,
  );
  return result.rows;
}

/** Makes a webhook's waiting posts due now, as if their wait had passed. */
async function due(sourceId: string): Promise<void> {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'source_hook_posts')} SET next_attempt_at = now()
    WHERE source_id = ${sourceId} AND next_attempt_at IS NOT NULL`,
  );
}

interface Mapped {
  tableId: string;
  viewId: string;
  field: Record<string, string>;
}

/** A synced table of a webhook, with these paths as fields of these types. */
async function hookTable(
  source: SourceMeta,
  columns: Record<string, string>,
  keyColumns: string[],
): Promise<Mapped> {
  const tableId = newId('table');
  const viewId = newId('view');
  const field = Object.fromEntries(Object.keys(columns).map((path) => [path, newId('field')]));
  await applied({
    kind: 'table.create',
    table: {
      id: tableId,
      name: `Posts ${tableId.slice(-4)}`,
      source: { sourceId: source.id, select: POSTS, keyColumns, everyMinutes: null },
      fields: Object.entries(columns).map(([path, type]) => ({
        id: field[path],
        name: path,
        type,
        options: {},
        source: { column: path, sourceType: 'string' },
      })),
      view: { id: viewId, name: 'Grid' },
      records: [],
    },
  });
  return { tableId, viewId, field };
}

describe('setting up a webhook', () => {
  it('shows its address once, keeps only a hash, and maps paths from posts sent while mapping', async () => {
    const source = await createSource();
    const token = source.webhookPath.split('/').pop()!;
    const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
    expect(listed.body).not.toContain(token);
    expect(listed.json<SourceMeta[]>().find((entry) => entry.id === source.id)!.webhook).toMatchObject({
      lastPostAt: null,
      bodiesUntil: null,
    });
    const stored = await query(server.pool, sql`SELECT * FROM ${ident(server.schemas.app, 'source_hooks')}`);
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(redactPathSecrets(source.webhookPath)).toBe('/api/inbound/[redacted]');

    // A post before the mapping step opens is written, but isn't a sample.
    expect((await post(source.webhookPath, { id: 1, early: true })).statusCode).toBe(202);
    expect((await preview(source.id)).columns).toEqual([]);
    for (const id of [1, 2])
      expect(
        (
          await post(source.webhookPath, {
            id,
            name: `Person ${id}`,
            contact: { email: `p${id}@example.test` },
          })
        ).statusCode,
      ).toBe(202);
    const shown = await preview(source.id);
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['id', 'number'],
      ['name', 'text'],
      ['contact.email', 'email'],
    ]);
    expect(shown.rows).toEqual([
      [2, 'Person 2', 'p2@example.test'],
      [1, 'Person 1', 'p1@example.test'],
    ]);
    expect(shown.keyCandidates[0]).toEqual(['id']);
    await written();

    // Once the step closes, its samples go.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'source_hooks')} SET samples_until = now() - interval '1 second' WHERE source_id = ${source.id}`,
    );
    await written();
    const samples = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'source_hook_samples')} WHERE source_id = ${source.id}`,
    );
    expect(samples.rowCount).toBe(0);
  });
});

describe('posting to a webhook', () => {
  it('creates a record, updates it by key, makes several from a list, and writes as the table’s person', async () => {
    const source = await createSource();
    const table = await hookTable(
      source,
      { id: 'text', name: 'text', 'contact.email': 'email', amount: 'number', tags: 'multipleSelect' },
      ['id'],
    );
    const first = await post(source.webhookPath, {
      id: 'a-1',
      name: 'Ada',
      contact: { email: 'ada@example.test' },
      amount: 10,
      tags: ['new', 'vip'],
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ accepted: 1 });
    await written();
    let [ada] = await rows(table.tableId);
    expect(ada!.values).toMatchObject({
      [table.field.id!]: 'a-1',
      [table.field.name!]: 'Ada',
      [table.field['contact.email']!]: 'ada@example.test',
      [table.field.amount!]: 10,
    });
    expect(ada!.createdBy).toBe(server.owner.userId);
    const tags = (await loadFields(server.pool, server.schemas, [table.tableId])).find(
      (field) => field.id === table.field.tags,
    )!;
    expect(
      (tags.options as { choices: Array<{ name: string }> }).choices.map((choice) => choice.name),
    ).toEqual(['new', 'vip']);

    // The same key updates the record, and its history says who wrote it.
    await post(source.webhookPath, { id: 'a-1', name: 'Ada Lovelace', amount: 12 });
    await written();
    const all = await rows(table.tableId);
    expect(all).toHaveLength(1);
    [ada] = all;
    expect(ada!.values).toMatchObject({ [table.field.name!]: 'Ada Lovelace', [table.field.amount!]: 12 });
    const history = await server.app.inject({
      url: `/api/tables/${table.tableId}/records/${ada!.id}/history`,
      headers: server.owner.headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    const entries = history.json<HistoryPage>().entries;
    expect(entries.map((entry) => [entry.kind, entry.actorId])).toEqual([
      ['updated', server.owner.userId],
      ['created', server.owner.userId],
    ]);

    // A list makes a record of each item, and a later item with a key in the same post stands.
    const listed = await post(source.webhookPath, [
      { id: 'b-1', name: 'Bea' },
      { id: 'c-1', name: 'Cy' },
      { id: 'b-1', name: 'Bea Two' },
    ]);
    expect(listed.json()).toMatchObject({ accepted: 3 });
    await written();
    const names = (await rows(table.tableId)).map((row) => row.values[table.field.name!]);
    expect(names).toEqual(['Ada Lovelace', 'Bea Two', 'Cy']);
    const synced = (await loadTable(server.pool, server.schemas, table.tableId)) as TableMeta;
    expect(synced.source!.status).toMatchObject({ state: 'idle', stats: { added: 2, changed: 0 } });

    // People still can't add records to it themselves.
    const [refused] = await commands(server.owner, [
      { kind: 'record.create', tableId: table.tableId, records: [{ id: newId('record'), values: {} }] },
    ]);
    expect(refused).toMatchObject({ status: 'rejected', error: { messageKey: 'sources.syncedReadOnly' } });
    // And it never syncs.
    const [sync] = await commands(server.owner, [
      { kind: 'table.sync', tableId: table.tableId, confirmRemovals: false },
    ]);
    expect(sync).toMatchObject({ status: 'rejected', error: { messageKey: 'sources.webhook.noSync' } });
  });

  it('adds a record for each post without a key, and splits lists only when asked', async () => {
    const source = await createSource({ records: 'data', split: false });
    const table = await hookTable(source, { name: 'text', items: 'longText' }, []);
    for (let n = 0; n < 2; n += 1) await post(source.webhookPath, { data: { name: 'Same', items: [1, 2] } });
    const missing = await post(source.webhookPath, { other: true });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ error: 'records_missing' });
    await written();
    expect((await rows(table.tableId)).map((row) => row.values[table.field.name!])).toEqual(['Same', 'Same']);
    expect((await rows(table.tableId))[0]!.values[table.field.items!]).toBe('1, 2');
  });

  it('refuses the wrong content type, bad JSON, and a post over the size limit, with plain codes', async () => {
    const source = await createSource();
    const typed = await post(source.webhookPath, '{}', { 'content-type': 'text/plain' });
    expect([typed.statusCode, typed.json()]).toEqual([415, { error: 'unsupported_content_type' }]);
    const broken = await post(source.webhookPath, '{"id": ');
    expect([broken.statusCode, broken.json()]).toEqual([400, { error: 'invalid_json' }]);
    const huge = await post(
      source.webhookPath,
      JSON.stringify({ text: 'x'.repeat(WEBHOOK_SOURCE_LIMITS.bodyBytes) }),
    );
    expect([huge.statusCode, huge.json()]).toEqual([413, { error: 'payload_too_large' }]);
    const tooMany = await post(
      source.webhookPath,
      Array.from({ length: WEBHOOK_SOURCE_LIMITS.recordsPerPost + 1 }, (_unused, id) => ({ id })),
    );
    expect(tooMany.json()).toEqual({ error: 'too_many_records' });
    const unknown = await post(`/api/inbound/${'A'.repeat(43)}`, {});
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'not_found' }]);
    const entries = (await log(source.id)).deliveries;
    expect(entries.map((entry) => [entry.status, entry.refusal])).toEqual([
      [413, 'too_many_records'],
      [413, 'payload_too_large'],
      [400, 'invalid_json'],
      [415, 'unsupported_content_type'],
    ]);
    expect(entries.every((entry) => entry.body === null)).toBe(true);
  });

  it('checks signatures, refuses a replayed time, and takes Riosoma’s own form and the hex form', async () => {
    const source = await createSource(
      { signature: { format: 'timestamped', header: 'Riosoma-Signature', toleranceSeconds: 300 } },
      { signingSecret: SECRET },
    );
    expect(JSON.stringify(source)).not.toContain(SECRET);
    const table = await hookTable(source, { name: 'text' }, []);
    const body = JSON.stringify({ name: 'Signed' });
    const header = (value: string) => ({ 'riosoma-signature': value });
    expect((await post(source.webhookPath, body)).json()).toEqual({ error: 'signature_missing' });
    const wrong = await post(source.webhookPath, body, header(sign(body, undefined, `${SECRET}x`)));
    expect([wrong.statusCode, wrong.json()]).toEqual([401, { error: 'signature_invalid' }]);
    const tampered = await post(source.webhookPath, JSON.stringify({ name: 'Changed' }), header(sign(body)));
    expect(tampered.json()).toEqual({ error: 'signature_invalid' });
    // A post signed ten minutes ago, sent again now, is a replay.
    const replayed = await post(
      source.webhookPath,
      body,
      header(sign(body, Math.floor(Date.now() / 1000) - 600)),
    );
    expect([replayed.statusCode, replayed.json()]).toEqual([401, { error: 'timestamp_expired' }]);
    const good = await post(source.webhookPath, body, header(sign(body)));
    expect(good.statusCode, good.body).toBe(202);
    await written();
    expect((await rows(table.tableId)).map((row) => row.values[table.field.name!])).toEqual(['Signed']);

    // The hex form many services send, with and without a time the signature covers.
    const hex = { format: 'hex' as const, header: 'X-Hub-Signature-256', toleranceSeconds: 300 };
    const bytes = Buffer.from(body);
    const digest = createHmac('sha256', SECRET).update(bytes).digest('hex');
    expect(signatureProblem(hex, SECRET, { 'x-hub-signature-256': `sha256=${digest}` }, bytes)).toBeNull();
    expect(signatureProblem(hex, SECRET, { 'x-hub-signature-256': digest }, bytes)).toBeNull();
    expect(signatureProblem(hex, SECRET, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, bytes)).toBe(
      'signature_invalid',
    );
    const timed = { ...hex, timestampHeader: 'X-Timestamp' };
    const now = Math.floor(Date.now() / 1000);
    const at = (seconds: number) => ({
      'x-timestamp': String(seconds),
      'x-hub-signature-256': createHmac('sha256', SECRET).update(`${seconds}.`).update(bytes).digest('hex'),
    });
    expect(signatureProblem(timed, SECRET, at(now), bytes)).toBeNull();
    expect(signatureProblem(timed, SECRET, at(now - 3_600), bytes)).toBe('timestamp_expired');
    expect(signatureProblem(timed, SECRET, { 'x-hub-signature-256': digest }, bytes)).toBe(
      'signature_missing',
    );
  });

  it('refuses the old address once a new one is made', async () => {
    const source = await createSource();
    const table = await hookTable(source, { name: 'text' }, []);
    const made = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/webhook-address`,
      headers: server.owner.headers,
    });
    expect(made.statusCode, made.body).toBe(200);
    const { path } = made.json<WebhookAddress>();
    expect(path).not.toBe(source.webhookPath);
    const old = await post(source.webhookPath, { name: 'Old' });
    expect([old.statusCode, old.json()]).toEqual([404, { error: 'not_found' }]);
    expect((await post(path, { name: 'New' })).statusCode).toBe(202);
    await written();
    expect((await rows(table.tableId)).map((row) => row.values[table.field.name!])).toEqual(['New']);
  });

  it('asks senders to wait past the pace, and while paused', async () => {
    const source = await createSource({ postsPerMinute: 2 });
    expect((await post(source.webhookPath, { n: 1 })).statusCode).toBe(202);
    expect((await post(source.webhookPath, { n: 2 })).statusCode).toBe(202);
    const third = await post(source.webhookPath, { n: 3 });
    expect([third.statusCode, third.json()]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(third.headers['retry-after'])).toBeLessThanOrEqual(60);
    const paused = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'webhook', postsPerMinute: 2, paused: true } },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    const refused = await post(source.webhookPath, { n: 4 });
    expect([refused.statusCode, refused.json()]).toEqual([503, { error: 'paused' }]);
    expect((await log(source.id)).deliveries.map((entry) => entry.refusal)).toEqual([
      'paused',
      'rate_limited',
      null,
      null,
    ]);
  });

  it('keeps bodies in the log for an hour, and then stops and forgets them on its own', async () => {
    const source = await createSource();
    const bodies = async (on: boolean) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/sources/${source.id}/webhook-bodies`,
        headers: server.owner.headers,
        payload: { on },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<WebhookSourceLog>();
    };
    const stored = async () =>
      (
        await query<{ body: string | null }>(
          server.pool,
          sql`SELECT body FROM ${ident(server.schemas.app, 'source_hook_deliveries')}
          WHERE source_id = ${source.id} ORDER BY seq DESC`,
        )
      ).rows.map((row) => row.body);
    await post(source.webhookPath, { secret: 'before' });
    const until = Date.parse((await bodies(true)).bodiesUntil!);
    expect(until - Date.now()).toBeGreaterThan(59 * 60_000);
    await post(source.webhookPath, { note: 'kept' });
    expect((await log(source.id)).deliveries.map((entry) => entry.body)).toEqual([
      JSON.stringify({ note: 'kept' }),
      null,
    ]);
    // An hour and a minute later, by the server's own clock, reading the log forgets what it kept.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await post(source.webhookPath, { note: 'not kept' });
    const later = await log(source.id);
    expect(later.bodiesUntil).toBeNull();
    expect(later.deliveries.map((entry) => entry.body)).toEqual([null, null, null]);
    expect(await stored()).toEqual([null, null, null]);
    vi.useRealTimers();

    // And without anyone reading the log, the writer's cleanup forgets them once the hour is up.
    await bodies(true);
    await post(source.webhookPath, { note: 'kept again' });
    expect((await stored())[0]).toBe(JSON.stringify({ note: 'kept again' }));
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'source_hooks')} SET bodies_until = now() - interval '1 second'
      WHERE source_id = ${source.id}`,
    );
    await written();
    expect(await stored()).toEqual([null, null, null, null]);
    // Turning it off forgets what it kept.
    const off = await server.app.inject({
      method: 'PUT',
      url: `/api/sources/${source.id}/webhook-bodies`,
      headers: server.owner.headers,
      payload: { on: false },
    });
    expect(off.json<WebhookSourceLog>().deliveries.every((entry) => entry.body === null)).toBe(true);
  });

  it('counts posts too large against the pace, and answers an unknown, paused, or mistyped address first', async () => {
    const source = await createSource({ postsPerMinute: 2 });
    const huge = JSON.stringify({ text: 'x'.repeat(WEBHOOK_SOURCE_LIMITS.bodyBytes) });
    for (let n = 0; n < 2; n += 1) {
      const refused = await post(source.webhookPath, huge);
      expect([refused.statusCode, refused.json()]).toEqual([413, { error: 'payload_too_large' }]);
    }
    const third = await post(source.webhookPath, huge);
    expect([third.statusCode, third.json()]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect((await log(source.id)).deliveries.map((entry) => entry.refusal)).toEqual([
      'rate_limited',
      'payload_too_large',
      'payload_too_large',
    ]);
    const unknown = await post(`/api/inbound/${'B'.repeat(43)}`, huge);
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'not_found' }]);
    const other = await createSource();
    const typed = await post(other.webhookPath, huge, { 'content-type': 'text/plain' });
    expect([typed.statusCode, typed.json()]).toEqual([415, { error: 'unsupported_content_type' }]);
    const paused = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${other.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'webhook', paused: true } },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    const waiting = await post(other.webhookPath, huge);
    expect([waiting.statusCode, waiting.json()]).toEqual([503, { error: 'paused' }]);
  });

  it('keeps the last 100 deliveries', async () => {
    const source = await createSource({ postsPerMinute: 500 });
    for (let n = 0; n < WEBHOOK_SOURCE_LIMITS.deliveries + 5; n += 1) await post(source.webhookPath, '{', {});
    const kept = await log(source.id);
    expect(kept.deliveries).toHaveLength(WEBHOOK_SOURCE_LIMITS.deliveries);
  });
});

describe('who sees a webhook’s table', () => {
  it('shows a limited viewer only the records their rule allows', async () => {
    const source = await createSource();
    const table = await hookTable(source, { id: 'text', name: 'text', region: 'text' }, ['id']);
    const reader = await server.addMember({ name: 'Reader' });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${reader.userId}, 'reader')`,
    );
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${table.tableId}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'west', fieldId: table.field.region, operator: 'is', value: 'West' }],
            },
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
    await post(source.webhookPath, [
      { id: '1', name: 'Wes', region: 'West' },
      { id: '2', name: 'Eve', region: 'East' },
      { id: '3', name: 'Wynn', region: 'West' },
    ]);
    await written();
    const read = async (who: SignedIn) => {
      const response = await server.app.inject({
        url: `/api/views/${table.viewId}/rows?limit=100`,
        headers: who.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<RowsPage>().rows.map((row) => row!.values[table.field.name!]);
    };
    expect(await read(server.owner)).toEqual(['Wes', 'Eve', 'Wynn']);
    expect(await read(reader)).toEqual(['Wes', 'Wynn']);
  });

  it('refuses a post its table’s person may not write, and says so in the log', async () => {
    const source = await createSource();
    const writer = await server.addMember({ name: 'Writer' });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${writer.userId}, 'creator')`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'sources')} SET access = 'creators' WHERE id = ${source.id}`,
    );
    const tableId = newId('table');
    const name = newId('field');
    await applied(
      {
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Theirs',
          source: { sourceId: source.id, select: POSTS, keyColumns: [], everyMinutes: null },
          fields: [
            {
              id: name,
              name: 'name',
              type: 'text',
              options: {},
              source: { column: 'name', sourceType: 'string' },
            },
          ],
          view: { id: newId('view'), name: 'Grid' },
          records: [],
        },
      },
      writer,
    );
    // The person who made the table loses access, so its posts can't be written as them.
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE principal_id = ${writer.userId}`,
    );
    await post(source.webhookPath, { name: 'Nobody writes this' });
    await written();
    expect(await rows(tableId)).toEqual([]);
    const [entry] = (await log(source.id)).deliveries;
    expect(entry).toMatchObject({ status: 202, written: true });
    expect(entry!.error).toBeTruthy();
    const table = (await loadTable(server.pool, server.schemas, tableId)) as TableMeta;
    expect(table.source!.status.state).toBe('failed');
  });
});

describe('long whole numbers', () => {
  it('keeps whole numbers past 2^53 exact, as keys, as values, and in the mapping step’s samples', async () => {
    const source = await createSource();
    const table = await hookTable(source, { id: 'text', name: 'text' }, ['id']);
    // Opening the mapping step keeps what's posted next as samples.
    expect((await preview(source.id)).rows).toEqual([]);
    // Two IDs a JavaScript number can't tell apart are two records.
    const both = await post(
      source.webhookPath,
      '[{"id": 9007199254740993, "name": "A"}, {"id": 9007199254740992, "name": "B"}]',
    );
    expect(both.statusCode, both.body).toBe(202);
    await written();
    const byId = async () =>
      Object.fromEntries(
        (await rows(table.tableId)).map((row) => [
          row.values[table.field.id!],
          row.values[table.field.name!],
        ]),
      );
    expect(await byId()).toEqual({ '9007199254740993': 'A', '9007199254740992': 'B' });
    // A later post for one of them changes only that one.
    await post(source.webhookPath, '{"id": 9007199254740993, "name": "A again"}');
    await written();
    expect(await byId()).toEqual({ '9007199254740993': 'A again', '9007199254740992': 'B' });
    const shown = await preview(source.id);
    expect(shown.rows).toEqual([
      ['9007199254740993', 'A again'],
      ['9007199254740993', 'A'],
      ['9007199254740992', 'B'],
    ]);
  });
});

describe('writing through trouble', () => {
  /** Makes writes to a table fail the way a lock that timed out does, until the returned step runs. */
  async function busy(tableId: string): Promise<() => Promise<void>> {
    const fn = ident(server.schemas.data, `busy_${tableId}`);
    const data = ident(server.schemas.data, tableId);
    await query(
      server.pool,
      sql`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'busy' USING ERRCODE = 'lock_not_available'; END $$`,
    );
    await query(
      server.pool,
      sql`CREATE TRIGGER busy BEFORE INSERT OR UPDATE ON ${data} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    return async () => {
      await query(server.pool, sql`DROP TRIGGER busy ON ${data}`);
      await query(server.pool, sql`DROP FUNCTION ${fn}()`);
    };
  }

  async function heard(sourceId: string) {
    const result = await query<{ recipient_id: string; target: Record<string, unknown> }>(
      server.pool,
      sql`SELECT recipient_id, target FROM ${ident(server.schemas.app, 'notifications')}
      WHERE kind = 'webhookFailed' AND subject_id = ${sourceId}`,
    );
    return result.rows;
  }

  it('keeps a post through a passing problem, tries again later, and gives up only after an hour of tries', async () => {
    const source = await createSource();
    const table = await hookTable(source, { id: 'text', name: 'text' }, ['id']);
    const names = async () => (await rows(table.tableId)).map((row) => row.values[table.field.name!]);
    const clear = await busy(table.tableId);
    expect((await post(source.webhookPath, { id: '1', name: 'First' })).statusCode).toBe(202);
    await written();
    // The post waits to try again, and the next one waits behind it, so they're written in order.
    expect((await post(source.webhookPath, { id: '2', name: 'Second' })).statusCode).toBe(202);
    await written();
    expect((await log(source.id)).deliveries.map((entry) => [entry.written, entry.error])).toEqual([
      [false, null],
      [false, 'sources.webhook.retrying'],
    ]);
    expect(await names()).toEqual([]);
    expect(await queued(source.id)).toEqual([
      { attempts: 1, failed: false, waiting: true },
      { attempts: 0, failed: false, waiting: null },
    ]);
    const synced = (await loadTable(server.pool, server.schemas, table.tableId)) as TableMeta;
    expect(synced.source!.status.state).toBe('idle');

    // Once the problem passes, both are written, in the order they came.
    await clear();
    await due(source.id);
    await written();
    expect(await names()).toEqual(['First', 'Second']);
    expect(await queued(source.id)).toEqual([]);
    expect((await log(source.id)).deliveries.map((entry) => [entry.written, entry.error])).toEqual([
      [true, null],
      [true, null],
    ]);

    // Ten tries in less than an hour aren't enough to give up.
    const again = await busy(table.tableId);
    await post(source.webhookPath, { id: '3', name: 'Third' });
    for (let n = 0; n < 10; n += 1) {
      await due(source.id);
      await written();
    }
    expect(await queued(source.id)).toEqual([{ attempts: 10, failed: false, waiting: true }]);
    expect(await heard(source.id)).toEqual([]);
    // Past an hour, the next failure marks it failed, keeps it, and its source's person hears once.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'source_hook_posts')}
      SET first_failed_at = now() - interval '61 minutes', next_attempt_at = now() WHERE source_id = ${source.id}`,
    );
    await written();
    expect(await queued(source.id)).toEqual([{ attempts: 11, failed: true, waiting: null }]);
    const [gaveUp] = (await log(source.id)).deliveries;
    expect(gaveUp).toMatchObject({ status: 202, written: false, error: 'sources.webhook.gaveUp' });
    expect(await heard(source.id)).toEqual([
      {
        recipient_id: server.owner.userId,
        target: { sourceId: source.id, sourceName: source.name },
      },
    ]);

    // A failed post holds nothing up, and nobody hears about it again.
    await again();
    await post(source.webhookPath, { id: '4', name: 'Fourth' });
    await written();
    await written();
    expect(await names()).toEqual(['First', 'Second', 'Fourth']);
    expect(await heard(source.id)).toHaveLength(1);
    expect(await queued(source.id)).toEqual([{ attempts: 11, failed: true, waiting: null }]);
  });

  it('tries again after locks, deadlocks, serialization failures, timeouts, and lost connections, and not after refusals', () => {
    const coded = (code: string) => Object.assign(new Error('database'), { code });
    for (const code of ['55P03', '40P01', '40001', '57014', '08006', '57P01', 'ECONNRESET', 'ECONNREFUSED'])
      expect(transientFailure(coded(code)), code).toBe(true);
    expect(transientFailure(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(transientFailure(new Error('Query read timeout'))).toBe(true);
    expect(
      transientFailure(new AppError('unavailable', 'errors.unavailable', { cause: coded('40P01') })),
    ).toBe(true);
    expect(transientFailure(new AppError('validation_failed', 'data.value.invalid'))).toBe(false);
    expect(transientFailure(coded('23505'))).toBe(false);
    expect(transientFailure(coded('22P02'))).toBe(false);
    expect(transientFailure(new TypeError('not a function'))).toBe(false);
  });
});

describe('choices a post adds', () => {
  it('stops at the field’s choice limit and the name limit, and refuses the records that need more', async () => {
    const source = await createSource();
    const table = await hookTable(source, { id: 'text', tags: 'multipleSelect' }, ['id']);
    const choices = async () =>
      (
        (await loadFields(server.pool, server.schemas, [table.tableId])).find(
          (field) => field.id === table.field.tags,
        )!.options as { choices: Array<{ name: string }> }
      ).choices.map((choice) => choice.name);
    const ids = async () => (await rows(table.tableId)).map((row) => row.values[table.field.id!]);
    const long = 'x'.repeat(LIMITS.nameLength + 1);
    await post(source.webhookPath, [
      { id: 'long', tags: [long] },
      { id: 'fine', tags: ['fine'] },
    ]);
    await written();
    expect(await ids()).toEqual(['fine']);
    expect(await choices()).toEqual(['fine']);
    expect((await log(source.id)).deliveries[0]).toMatchObject({
      written: true,
      error: 'sources.webhook.choicesFull',
    });

    // One choice short of the limit is taken, and the record that needs one more is refused.
    await post(
      source.webhookPath,
      Array.from({ length: LIMITS.choicesPerField }, (_unused, n) => ({ id: `t${n}`, tags: [`tag ${n}`] })),
    );
    await written();
    expect(await choices()).toHaveLength(LIMITS.choicesPerField);
    const kept = await ids();
    expect(kept).toHaveLength(LIMITS.choicesPerField);
    expect(kept).not.toContain(`t${LIMITS.choicesPerField - 1}`);
    expect((await log(source.id)).deliveries[0]).toMatchObject({ error: 'sources.webhook.choicesFull' });
    const synced = (await loadTable(server.pool, server.schemas, table.tableId)) as TableMeta;
    expect(synced.source!.status).toMatchObject({
      state: 'idle',
      stats: { added: LIMITS.choicesPerField - 1 },
    });

    // Choices the field has already still work.
    await post(source.webhookPath, { id: 'again', tags: ['fine', 'tag 0'] });
    await written();
    expect(await ids()).toContain('again');
    expect((await log(source.id)).deliveries[0]).toMatchObject({ written: true, error: null });
  });
});

describe('a webhook’s table restored from a snapshot', () => {
  it('comes back waiting for posts, never queued for a sync', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: newId('database'),
        name: 'Restorable hooks',
        table: {
          id: newId('table'),
          name: 'Local',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const original = created.json<DatabaseSchema>().database.id;
    const source = await createSource();
    const tableId = newId('table');
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${original}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'table.create',
            table: {
              id: tableId,
              name: 'Posted',
              source: { sourceId: source.id, select: POSTS, keyColumns: ['id'], everyMinutes: null },
              fields: [
                {
                  id: newId('field'),
                  name: 'id',
                  type: 'text',
                  source: { column: 'id', sourceType: 'json' },
                },
                {
                  id: newId('field'),
                  name: 'name',
                  type: 'text',
                  source: { column: 'name', sourceType: 'json' },
                },
              ],
              view: { id: newId('view'), name: 'Grid' },
              records: [],
            },
          },
        ],
      },
    });
    expect(response.json<CommandBatchResult>().results[0], response.body).toMatchObject({
      status: 'applied',
    });
    await post(source.webhookPath, { id: '1', name: 'Before the snapshot' });
    await written();

    const snapshot = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${original}/snapshots`,
      headers: server.owner.headers,
      payload: { name: 'With a webhook' },
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const restoring = await server.app.inject({
      method: 'POST',
      url: `/api/snapshots/${snapshot.json<SnapshotMeta>().id}/restore`,
      headers: server.owner.headers,
      payload: { name: 'Restored hooks' },
    });
    expect(restoring.statusCode, restoring.body).toBe(200);
    const copy = restoring.json<DatabaseCopy>();
    await server.ctx.databaseCopies!.settled(copy.id);
    const done = await server.app.inject({
      url: `/api/database-copies/${copy.id}`,
      headers: server.owner.headers,
    });
    expect(done.json<DatabaseCopy>()).toMatchObject({ state: 'finished', report: { syncedTables: 1 } });
    const restored = await query<{ table_id: string; status: { state: string }; next_sync_at: Date | null }>(
      server.pool,
      sql`SELECT ts.table_id, ts.status, ts.next_sync_at FROM ${ident(server.schemas.app, 'table_sources')} ts
      JOIN ${ident(server.schemas.app, 'tables')} t ON t.id = ts.table_id
      WHERE ts.source_id = ${source.id} AND t.database_id = ${done.json<DatabaseCopy>().databaseId!}`,
    );
    expect(restored.rows).toHaveLength(1);
    const [again] = restored.rows;
    expect([again!.status.state, again!.next_sync_at]).toEqual(['idle', null]);
    expect((await claimSyncs(server.ctx, 100)).map((job) => job.table_id)).not.toContain(again!.table_id);

    // Its posts fill both tables.
    await post(source.webhookPath, { id: '2', name: 'After the restore' });
    await written();
    const names = async (id: string) =>
      (
        await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM ${ident(server.schemas.data, id)}`,
        )
      ).rows[0]!.count;
    expect([await names(tableId), await names(again!.table_id)]).toEqual(['2', '2']);
  });
});

it('runs every declared capability against independently posted samples', async () => {
  const source = await createSource();
  await preview(source.id);
  expect(
    (
      await post(source.webhookPath, [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ])
    ).statusCode,
  ).toBe(202);
  await written();
  const connector = createWebhookConnector(server.app.ctx);
  const context = {
    connection: SourceConnection.parse({ kind: 'webhook' }),
    sourceId: source.id,
    secrets: { signingSecret: randomBytes(24).toString('hex') },
  };
  const sample = await connector.preview(context, POSTS, 3);
  expect(sample.rows).toHaveLength(2);
  await runConnectorContract(
    contractAdapter({
      connector,
      context,
      select: POSTS,
      columns: sample.columns,
      keys: await connector.keyCandidates(context, POSTS.object),
      expectedRows: [],
      read: { columns: sample.columns.map((column) => column.name), types: {}, keyColumns: [] },
      requests: () => [],
      failure: (ctx) =>
        connector.preview(ctx, { kind: 'object', object: { schema: null, name: 'missing' } }, 1),
    }),
  );
});

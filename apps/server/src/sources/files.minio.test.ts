/**
 * Bucket sources against a real S3-compatible service: MinIO, which runs anywhere in one
 * container.  The suite runs only when `RIOSOMA_TEST_MINIO_URL` names one, like
 * `http://localhost:9000`, and signs in with MinIO's default keys unless
 * `RIOSOMA_TEST_MINIO_ACCESS_KEY` and `RIOSOMA_TEST_MINIO_SECRET_KEY` say otherwise.
 */
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { claimSyncs, runSync } from './sync.js';

const MINIO = process.env.RIOSOMA_TEST_MINIO_URL;
const ACCESS_KEY = process.env.RIOSOMA_TEST_MINIO_ACCESS_KEY ?? 'minioadmin';
const SECRET_KEY = process.env.RIOSOMA_TEST_MINIO_SECRET_KEY ?? 'minioadmin';
const BUCKET = `rio-${Date.now().toString(36)}`;

/** A request to MinIO signed the way any S3 client signs one, for setting the bucket up. */
async function s3(method: 'PUT' | 'DELETE', path: string, body?: string): Promise<Response> {
  const url = new URL(path, MINIO);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const payload = 'UNSIGNED-PAYLOAD';
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payload,
    'x-amz-date': stamp,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    '',
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, text: string) => createHmac('sha256', key).update(text).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, day), 'us-east-1'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...sent } = headers;
  return fetch(url, {
    method,
    body,
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  });
}

async function put(key: string, body: string): Promise<void> {
  const response = await s3('PUT', `/${BUCKET}/${key}`, body);
  expect(response.status, await response.text()).toBe(200);
}

let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;
const OBJECTS = { prefix: 'exports/' };

describe.skipIf(!MINIO)('bucket sources on MinIO', () => {
  beforeAll(async () => {
    const made = await s3('PUT', `/${BUCKET}`);
    expect(made.status, await made.text()).toBe(200);
    await put('exports/2026-09-01.csv', 'id,city,total\n1,Lima,10\n2,Oslo,20\n');
    await put('exports/2026-09-02.csv', 'id,city,total\n3,Kyiv,30\n');
    await put('exports/notes.txt', 'not a table');
    await put('elsewhere/secret.csv', 'id\n99\n');
    kit = await startTestPostgres();
    server = await startServer(kit, 'minio', { automationsAllowPrivateHosts: true });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: newId('database'),
        name: 'Bucket',
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
    for (const key of [
      'exports/2026-09-01.csv',
      'exports/2026-09-02.csv',
      'exports/notes.txt',
      'elsewhere/secret.csv',
    ])
      await s3('DELETE', `/${BUCKET}/${key}`).catch(() => undefined);
    await s3('DELETE', `/${BUCKET}`).catch(() => undefined);
    await server?.close();
    await kit?.stop();
  });

  async function createSource(secretAccessKey = SECRET_KEY, bucket = BUCKET): Promise<SourceMeta> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: `MinIO ${newId('source')}`,
        connection: { kind: 'bucket', endpoint: MINIO, bucket, prefix: OBJECTS.prefix, pathStyle: true },
        secrets: { accessKeyId: ACCESS_KEY, secretAccessKey },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SourceMeta>();
  }

  async function test(source: SourceMeta): Promise<SourceTestResult & { body: string }> {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    return { ...response.json<SourceTestResult>(), body: response.body };
  }

  async function applied(input: Record<string, unknown>) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
      },
    });
    const result = response.json<CommandBatchResult>().results[0]!;
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

  async function sync(tableId: string): Promise<void> {
    await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  }

  it('tests, lists, previews, and syncs every file under a prefix as one table', async () => {
    const source = await createSource();
    const tested = await test(source);
    expect(tested.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['parse', 'ok'],
    ]);
    expect(tested.ok).toBe(true);
    const listed = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(listed.json<SourceObject[]>().map((object) => [object.name, object.type])).toEqual([
      ['exports/*.csv', 'files'],
      ['exports/2026-09-01.csv', 'file'],
      ['exports/2026-09-02.csv', 'file'],
    ]);
    const select = { kind: 'object' as const, object: { schema: null, name: 'exports/*.csv' } };
    const shown = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select },
    });
    const preview = shown.json<SourcePreview>();
    expect(preview.rows).toEqual([
      [1, 'Lima', 10],
      [2, 'Oslo', 20],
      [3, 'Kyiv', 30],
    ]);
    expect(preview.keyCandidates).toEqual([['id'], ['city'], ['total']]);
    const outside = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: { kind: 'object', object: { schema: null, name: 'elsewhere/secret.csv' } } },
    });
    expect(outside.json()).toMatchObject({ error: { messageKey: 'sources.sync.objectMissing' } });

    const tableId = newId('table');
    const field = { id: newId('field'), city: newId('field'), total: newId('field') };
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Cities',
        source: { sourceId: source.id, select, keyColumns: ['id'], everyMinutes: null },
        fields: [
          { id: field.city, name: 'City', type: 'text', source: { column: 'city', sourceType: 'VARCHAR' } },
          { id: field.id, name: 'ID', type: 'number', source: { column: 'id', sourceType: 'VARCHAR' } },
          {
            id: field.total,
            name: 'Total',
            type: 'number',
            source: { column: 'total', sourceType: 'VARCHAR' },
          },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    await sync(tableId);
    const first = await rows(tableId);
    expect(first.map((row) => row.values[field.city])).toEqual(['Lima', 'Oslo', 'Kyiv']);
    const oslo = first[1]!;
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: oslo.id, values: { [field.city]: 'Oslo, Norway' } }],
    });
    await put('exports/2026-09-01.csv', 'id,city,total\n1,Lima,11\n2,Christiania,21\n');
    await put('exports/2026-09-03.csv', 'id,city,total\n4,Accra,40\n');
    await sync(tableId);
    const after = await rows(tableId);
    expect(after.map((row) => row.values[field.id])).toEqual([1, 2, 3, 4]);
    const kept = after.find((row) => row.id === oslo.id)!;
    expect(kept.values).toMatchObject({ [field.city]: 'Oslo, Norway', [field.total]: 21 });
    expect(kept.overrides![field.city]).toMatchObject({ source: 'Christiania' });
    await s3('DELETE', `/${BUCKET}/exports/2026-09-03.csv`);
  });

  it('says when the secret is wrong or the bucket is missing, without repeating the keys', async () => {
    const wrong = await test(await createSource('not-the-minio-secret'));
    expect(wrong.ok).toBe(false);
    expect(wrong.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.file.keys',
    });
    expect(wrong.steps.at(-1)!.detail).toContain('SignatureDoesNotMatch');
    expect(wrong.body).not.toContain('not-the-minio-secret');
    const missing = await test(await createSource(SECRET_KEY, `${BUCKET}-missing`));
    expect(missing.steps.at(-1)).toMatchObject({ step: 'authenticate', messageKey: 'sources.file.noBucket' });
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SourceConnection, type SourceMeta } from '@riosoma/contracts';
import { connectorFor, registerConnector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'warehouses');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const connections = [
  SourceConnection.parse({
    kind: 'redshift',
    host: 'warehouse.invalid',
    region: 'us-east-1',
    database: 'events',
    user: 'reader',
    clusterIdentifier: 'events',
  }),
  SourceConnection.parse({
    kind: 'athena',
    region: 'us-east-1',
    database: 'events',
    workgroup: 'readers',
    resultsLocation: 's3://results/queries/',
  }),
  SourceConnection.parse({ kind: 'duckdb-file', path: '/data/events.duckdb' }),
];

it.each(connections)(
  'keeps $kind settings administrative, secrets sealed, and changes audited',
  async (connection) => {
    const member = await server.addMember();
    const original = connectorFor(connection.kind);
    const secrets =
      connection.kind === 'duckdb-file'
        ? {}
        : {
            accessKeyId: randomBytes(12).toString('hex'),
            secretAccessKey: randomBytes(24).toString('hex'),
            sessionToken: randomBytes(16).toString('hex'),
          };
    const payload = { name: `Source ${connection.kind}`, connection, secrets, access: 'admins' };
    const request = (
      headers: typeof server.owner.headers,
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      body?: Record<string, unknown>,
    ) => server.app.inject({ headers, method, url, payload: body });
    expect((await request(member.headers, 'POST', '/api/sources', payload)).statusCode).toBe(403);
    const saved = await request(server.owner.headers, 'POST', '/api/sources', payload);
    expect(saved.statusCode, saved.body).toBe(200);
    const source = saved.json<SourceMeta>();
    expect(source.kind).toBe(connection.kind);
    expect(source.secrets).toEqual(Object.keys(secrets));
    for (const value of Object.values(secrets)) expect(saved.body).not.toContain(value);
    const hidden = await server.app.inject({ url: '/api/sources', headers: member.headers });
    expect(hidden.json<SourceMeta[]>().some((entry) => entry.id === source.id)).toBe(false);
    let reads = 0;
    registerConnector({
      ...original,
      async listObjects() {
        reads++;
        return [{ schema: 'main', name: 'events', type: 'table', rowEstimate: null }];
      },
    });
    try {
      const denied = await server.app.inject({
        url: `/api/sources/${source.id}/objects`,
        headers: member.headers,
      });
      expect(denied.statusCode).toBe(403);
      expect(reads).toBe(0);
      const allowed = await server.app.inject({
        url: `/api/sources/${source.id}/objects`,
        headers: server.owner.headers,
      });
      expect(allowed.statusCode).toBe(200);
      expect(reads).toBe(1);
      expect(
        (
          await request(server.owner.headers, 'PATCH', `/api/sources/${source.id}`, {
            name: 'Renamed source',
            ...(connection.kind === 'athena'
              ? { connection: { ...connection, maxScannedBytes: 10_000_000 } }
              : {}),
          })
        ).statusCode,
      ).toBe(200);
      expect((await request(server.owner.headers, 'DELETE', `/api/sources/${source.id}`)).statusCode).toBe(
        204,
      );
      const events = await query<{ action: string; metadata: unknown }>(
        server.pool,
        sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'sourceId' = ${source.id} ORDER BY at`,
      );
      expect(events.rows.map((row) => row.action)).toEqual([
        'data.source.created',
        'data.source.updated',
        'data.source.deleted',
      ]);
      for (const value of Object.values(secrets)) expect(JSON.stringify(events.rows)).not.toContain(value);
    } finally {
      registerConnector(original);
    }
  },
);

it('requires new headers for a different download address, and drops them when switching storage', async () => {
  const headers = server.owner.headers;
  const secret = randomBytes(24).toString('hex');
  const connection = SourceConnection.parse({
    kind: 'duckdb-file',
    storage: 'url',
    url: `https://${['files', 'invalid'].join('.')}/events.duckdb`,
  });
  const created = await server.app.inject({
    headers,
    method: 'POST',
    url: '/api/sources',
    payload: {
      name: 'Downloaded events',
      connection,
      access: 'admins',
      secrets: { headers: `Authorization: Bearer ${secret}` },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const source = created.json<SourceMeta>();
  const moved = await server.app.inject({
    headers,
    method: 'PATCH',
    url: `/api/sources/${source.id}`,
    payload: {
      connection: { ...connection, url: `https://${['other', 'invalid'].join('.')}/events.duckdb` },
    },
  });
  expect(moved.statusCode).toBe(422);
  expect(moved.json().error.messageKey).toBe('sources.secretsReenter');
  const bucket = await server.app.inject({
    headers,
    method: 'PATCH',
    url: `/api/sources/${source.id}`,
    payload: {
      connection: { kind: 'duckdb-file', storage: 'bucket', bucket: 'source-files' },
      secrets: {
        accessKeyId: randomBytes(12).toString('hex'),
        secretAccessKey: randomBytes(24).toString('hex'),
      },
    },
  });
  expect(bucket.statusCode, bucket.body).toBe(200);
  expect(bucket.json<SourceMeta>().secrets).toEqual(['accessKeyId', 'secretAccessKey']);
});

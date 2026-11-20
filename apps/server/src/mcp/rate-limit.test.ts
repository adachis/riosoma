import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type McpAppActivity, type McpRateSettings, type TokenCreated } from '@riosoma/contracts';
import { createPool } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { oauthClient } from './client.test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
let origin: string;
const headers = { accept: 'application/json, text/event-stream' };
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'mcp_rate');
  origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
  server.config.baseUrl = origin;
}, 60_000);
afterEach(async () => {
  await settings({ callsPerMinute: 120, appOverrides: {} });
  await server.pool.query(`DELETE FROM "${server.schemas.app}".auth_attempts WHERE key LIKE 'mcp:%'`);
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function settings(value: McpRateSettings) {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/mcp/settings',
    headers: server.owner.headers,
    payload: value,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual(value);
}
async function token() {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Rate test', scopes: ['schema.bases:read', 'data.records:write'], databases: 'all' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}
function request(value: TokenCreated, id = 1, app = server.app, method = 'tools/list', params?: object) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...headers, authorization: `Bearer ${value.token}` },
    payload: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
  });
}
async function activity() {
  const response = await server.app.inject({ url: '/api/admin/mcp/activity', headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<McpAppActivity[]>();
}

it('admits 120 requests, refuses the 121st with a protocol error, and starts no write', async () => {
  const value = await token();
  const target = await readFixture(server, [{ type: 'text' }]);
  for (let id = 1; id <= 120; id++) expect((await request(value, id)).statusCode).toBe(200);
  const refused = await request(value, 121, server.app, 'tools/call', {
    name: 'create_records',
    arguments: { tableId: target.table.id, records: [{ fields: { 'Field 0': 'Refused' } }] },
  });
  expect(refused.statusCode).toBe(429);
  expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  expect(refused.json()).toMatchObject({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: expect.stringMatching(/120 calls per minute.*Retry in \d+ seconds/),
      data: {
        code: 'rate_limited',
        messageKey: 'mcp.rateLimited',
        params: { limit: 120, seconds: Number(refused.headers['retry-after']) },
      },
    },
  });
  const changes = await server.pool.query(
    `SELECT count(*)::int AS count FROM "${server.schemas.app}".changes WHERE database_id = $1`,
    [target.table.databaseId],
  );
  expect(changes.rows[0].count).toBe(0);
});

it('rolls individual admissions out of the window without letting refusals extend it', async () => {
  await settings({ callsPerMinute: 2, appOverrides: {} });
  const value = await token();
  expect((await request(value)).statusCode).toBe(200);
  const key = `mcp:call:${server.owner.info.org.id}:${value.id}`;
  await server.pool.query(
    `UPDATE "${server.schemas.app}".auth_attempts SET at = clock_timestamp() - interval '30 seconds' WHERE key = $1`,
    [key],
  );
  expect((await request(value)).statusCode).toBe(200);
  const refused = await request(value);
  expect(refused.statusCode).toBe(429);
  expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(30);
  await server.pool.query(
    `UPDATE "${server.schemas.app}".auth_attempts SET at = at - interval '31 seconds' WHERE key = $1`,
    [key],
  );
  expect((await request(value)).statusCode).toBe(200);
  expect((await request(value)).statusCode).toBe(429);
});

it('keeps tokens independent, counts every transport request, and disables enforcement with No limit', async () => {
  await settings({ callsPerMinute: 1, appOverrides: {} });
  const first = await token();
  const second = await token();
  expect((await request(first)).statusCode).toBe(200);
  expect((await request(first)).statusCode).toBe(429);
  expect((await request(second)).statusCode).toBe(200);
  const get = await server.app.inject({ url: '/mcp', headers: { authorization: `Bearer ${second.token}` } });
  expect(get.statusCode).toBe(429);
  expect(get.headers['retry-after']).toBeTruthy();
  await settings({ callsPerMinute: null, appOverrides: {} });
  const client = new Client({ name: 'rate-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${first.token}` } },
      }),
    );
    for (let index = 0; index < 5; index++)
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

it('counts authenticated malformed bodies and refuses subsequent requests before reading their bodies', async () => {
  await settings({ callsPerMinute: 1, appOverrides: {} });
  const value = await token();
  const input = {
    method: 'POST' as const,
    url: '/mcp',
    headers: { authorization: `Bearer ${value.token}`, 'content-type': 'application/json' },
    payload: '{',
  };
  expect((await server.app.inject(input)).statusCode).toBe(400);
  const refused = await server.app.inject(input);
  expect(refused.statusCode).toBe(429);
  expect(refused.headers['retry-after']).toBeTruthy();
  expect(refused.json()).toMatchObject({ id: null, error: { data: { messageKey: 'mcp.rateLimited' } } });
});

it('shares admission and refusal audits across two independent server instances', async () => {
  await settings({ callsPerMinute: 5, appOverrides: {} });
  const value = await token();
  const pool = createPool(server.config.database!);
  const other: FastifyInstance = await buildApp({ ...server.ctx, pool });
  try {
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, index) => request(value, index + 1, index % 2 ? other : server.app)),
    );
    expect(replies.filter((response) => response.statusCode === 200)).toHaveLength(5);
    expect(replies.filter((response) => response.statusCode === 429)).toHaveLength(15);
    const events = await server.pool.query(
      `SELECT metadata FROM "${server.schemas.audit}".events WHERE action = 'mcp.rate_limited' AND metadata ->> 'tokenId' = $1`,
      [value.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].metadata.callsPerMinute).toBe(5);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".auth_attempts SET at = at - interval '61 seconds' WHERE key = $1`,
      [`mcp:audit:${server.owner.info.org.id}:${value.id}`],
    );
    expect((await request(value)).statusCode).toBe(429);
    const later = await server.pool.query(
      `SELECT count(*)::int AS count FROM "${server.schemas.audit}".events WHERE action = 'mcp.rate_limited' AND metadata ->> 'tokenId' = $1`,
      [value.id],
    );
    expect(later.rows[0].count).toBe(2);
  } finally {
    await other.close();
    await pool.end();
  }
});

it('honors per-app overrides for a real SDK client and reports every limit hit', async () => {
  const dynamic = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/oauth/settings',
    headers: server.owner.headers,
    payload: { dynamicRegistration: true },
  });
  expect(dynamic.statusCode, dynamic.body).toBe(200);
  const sdk = oauthClient(`${origin}/mcp`, `${origin}/callback`);
  try {
    await expect(sdk.connect()).rejects.toThrow();
    const authorization = sdk.authorizationUrl()!;
    const clientId = authorization.searchParams.get('client_id')!;
    const start = await server.app.inject({ url: authorization.pathname + authorization.search });
    expect(start.statusCode, start.body).toBe(303);
    const pending = new URL(start.headers.location!, origin).searchParams.get('request')!;
    const consent = await server.app.inject({
      url: `/api/oauth/consent?request=${pending}`,
      headers: server.owner.headers,
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const approved = await server.app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      headers: server.owner.headers,
      payload: { request: pending, approve: true, databases: 'all' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await settings({ callsPerMinute: 1, appOverrides: { [clientId]: null } });
    await sdk.finish(new URL(approved.json<{ redirect: string }>().redirect).searchParams.get('code')!);
    await sdk.client.listTools();
    const before = (await activity()).find((row) => row.clientId === clientId)!;
    await settings({ callsPerMinute: null, appOverrides: { [clientId]: before.callsLastMinute + 1 } });
    await sdk.client.listTools();
    await expect(sdk.client.listTools()).rejects.toMatchObject({
      code: 429,
      message: expect.stringContaining('MCP limit'),
    });
    await expect(sdk.client.listTools()).rejects.toMatchObject({ code: 429 });
    const after = (await activity()).find((row) => row.clientId === clientId)!;
    expect(after.callsLastMinute).toBe(before.callsLastMinute + 3);
    expect(after.limitedLastDay).toBe(2);
    await settings({ callsPerMinute: null, appOverrides: {} });
    expect((await sdk.client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await sdk.client.close();
  }
});

it('validates settings, preserves unrelated organization settings, and requires an organization Integrations admin', async () => {
  const member = await server.addMember();
  for (const url of ['/api/admin/mcp/settings', '/api/admin/mcp/activity']) {
    expect((await server.app.inject({ url, headers: member.headers })).statusCode).toBe(403);
  }
  const before = await server.pool.query(`SELECT settings FROM "${server.schemas.app}".orgs WHERE id = $1`, [
    server.owner.info.org.id,
  ]);
  for (const callsPerMinute of [0, -1, 1.5, 1_000_001, 'none']) {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/mcp/settings',
      headers: server.owner.headers,
      payload: { callsPerMinute },
    });
    expect(response.statusCode).toBe(422);
  }
  await settings({ callsPerMinute: 45, appOverrides: {} });
  const after = await server.pool.query(
    `SELECT settings - 'mcpRateLimit' AS settings FROM "${server.schemas.app}".orgs WHERE id = $1`,
    [server.owner.info.org.id],
  );
  const { mcpRateLimit: _limit, ...unrelated } = before.rows[0].settings as Record<string, unknown>;
  expect(after.rows[0].settings).toEqual(unrelated);
});

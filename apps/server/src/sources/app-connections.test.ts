import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, registerAppCatalog, RestEndpoint, type SourceMeta } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, registerConnector, type AppPreset } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { registerOAuthProvider, type OAuthAccount } from '../oauth/providers.js';
import { unsealCredential } from '../credentials/service.js';
import { restConnectorOptions } from './rest.js';
import { claimSyncs, runSync } from './sync.js';

let listener: Server;
let origin: string;
let kit: TestPostgres;
let server: ServerFixture;
let expiresIn = 60;
let refuseRefresh = false;
let refuseAccess = false;
let rateLimited = false;
const codes = new Map<string, string>();
const access = new Map<string, { person: string; renewed: boolean }>();
const refresh = new Map<string, string>();
const issued = new Set<string>();
const grants: string[] = [];
const calls: Array<{ person: string; renewed: boolean; path: string; company: string | null }> = [];
const secret = randomBytes(24).toString('hex');
const company = 'company/with spaces';
const base = 'https://riosoma.example.test';

beforeAll(async () => {
  listener = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const grant = input.get('grant_type') ?? '';
      grants.push(grant);
      const person =
        grant === 'refresh_token'
          ? refresh.get(input.get('refresh_token') ?? '')
          : codes.get(input.get('code') ?? '');
      if (!person || (grant === 'refresh_token' && refuseRefresh))
        return answer(400, { error: 'invalid_grant', error_description: `external-answer ${secret}` });
      const next = randomBytes(24).toString('hex');
      const renewal = randomBytes(24).toString('hex');
      issued.add(next);
      issued.add(renewal);
      access.set(next, { person, renewed: grant === 'refresh_token' });
      refresh.set(renewal, person);
      if (grant === 'refresh_token') refresh.delete(input.get('refresh_token') ?? '');
      return answer(200, {
        access_token: next,
        refresh_token: renewal,
        expires_in: expiresIn,
        scope: 'items.read',
      });
    }
    const identity = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!identity || refuseAccess) return answer(401, { error: `external-answer ${secret}` });
    if (rateLimited && url.pathname !== '/account') {
      res.setHeader('x-ratelimit-remaining', '0');
      return answer(403, { message: `external-answer ${secret}` });
    }
    if (url.pathname === '/account')
      return answer(200, { id: identity.person, name: identity.person, email: null });
    calls.push({ ...identity, path: url.pathname, company: url.searchParams.get('company') });
    return answer(200, [{ id: 1, name: identity.person }]);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  server = await startServer(kit, 'app_accounts', {
    baseUrl: base,
    automationsAllowPrivateHosts: true,
    oauthApps: {
      github: { clientId: 'example-client', clientSecret: secret },
      'example-company': { clientId: 'example-client', clientSecret: secret },
    },
  });
  const presets: AppPreset[] = [];
  for (const provider of ['github', 'example-company']) {
    registerOAuthProvider({
      id: provider,
      authorizeUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      scope: 'items.read',
      ...(provider === 'example-company' ? { callbackValues: ['realmId'] } : {}),
      async account(credential, signal) {
        const response = await fetch(`${origin}/account`, {
          headers: { authorization: `Bearer ${credential}` },
          signal,
        });
        return response.json() as Promise<OAuthAccount>;
      },
    });
    const endpoint = RestEndpoint.parse({
      name: 'items',
      path: provider === 'github' ? '/items' : '/companies/{value:realmId}/items',
      query: provider === 'github' ? [] : [{ name: 'company', value: '{value:realmId}' }],
      records: '',
    });
    presets.push({
      catalog: {
        id: provider === 'github' ? 'account-fixture' : 'company-fixture',
        name: 'Example',
        settings: [],
        connect: { provider },
      },
      rateLimited: APP_PRESETS.find((preset) => preset.catalog.id === 'github')!.rateLimited,
      target: { address: origin, auth: { method: 'bearer' }, requestsPerSecond: 100 },
      objects: [{ name: 'items', key: 'id', endpoint }],
      test: { name: 'items', key: 'id', endpoint },
    });
  }
  registerAppCatalog(presets.map((preset) => preset.catalog));
  registerConnector(
    createAppConnector(
      restConnectorOptions(server.config, async () => [{ address: '127.0.0.1', family: 4 }]),
      presets,
    ),
  );
}, 90_000);
beforeEach(() => {
  calls.length = 0;
  grants.length = 0;
  expiresIn = 60;
  refuseRefresh = false;
  refuseAccess = false;
  rateLimited = false;
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  listener?.closeAllConnections();
  if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
});

function safe(value: unknown) {
  const text = JSON.stringify(value);
  expect([...issued, secret].some((value) => text.includes(value))).toBe(false);
  expect(text.includes('external-answer')).toBe(false);
}

async function connect(
  person = server.owner,
  provider = 'github',
  callbackCompany: string | undefined = company,
  accountId = person.userId,
) {
  const start = await server.app.inject({ url: `/api/oauth/start/${provider}`, headers: person.headers });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  const code = randomBytes(12).toString('hex');
  codes.set(code, accountId);
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  callback.searchParams.set('code', code);
  if (callbackCompany !== undefined) callback.searchParams.set('realmId', callbackCompany);
  const response = await server.app.inject({
    url: callback.pathname + callback.search,
    headers: person.headers,
  });
  const landed = new URL(String(response.headers.location), base);
  expect(landed.searchParams.get('connected')).toBe(provider);
  safe(response.body);
  return (
    await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE user_id = ${person.userId} AND provider = ${provider}`,
    )
  ).rows[0]!.id;
}

const draft = (connectionId: string, app = 'account-fixture') => ({
  name: 'Connected projects',
  access: 'creators',
  connection: { kind: 'app', app, settings: { connectionId } },
  secrets: {},
});
async function create(connectionId: string, app = 'account-fixture') {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: draft(connectionId, app),
  });
  expect(response.statusCode, response.body).toBe(200);
  safe(response.json());
  return response.json<SourceMeta>();
}
async function inspect(source: SourceMeta, person = server.owner) {
  return server.app.inject({ url: `/api/sources/${source.id}/objects`, headers: person.headers });
}

async function scheduledTable(source: SourceMeta, person = server.owner) {
  const databaseId = newId('database');
  const database = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Account sync',
      table: {
        id: newId('table'),
        name: 'Notes',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(database.statusCode).toBe(200);
  if (person !== server.owner) {
    const grant = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${databaseId}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'user', id: person.userId }, role: 'creator' },
    });
    expect(grant.statusCode).toBe(200);
  }
  const tableId = newId('table');
  const command = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: person.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'table.create',
          table: {
            id: tableId,
            name: 'Remote items',
            fields: [
              { id: newId('field'), name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
            ],
            view: { id: newId('view'), name: 'Grid' },
            source: {
              sourceId: source.id,
              select: { kind: 'object', object: { schema: null, name: 'items' } },
              keyColumns: ['id'],
              everyMinutes: 15,
            },
          },
        },
      ],
    },
  });
  expect(command.statusCode, command.body).toBe(200);
  expect(command.json().results[0]?.status, command.body).toBe('applied');
  return tableId;
}

async function runScheduled(tableId: string) {
  const job = (await claimSyncs(server.ctx, 100)).find((job) => job.table_id === tableId);
  expect(Boolean(job)).toBe(true);
  await runSync(server.ctx, job!);
  return (
    await query<{ status: { state: string; error: unknown } }>(
      server.pool,
      sql`SELECT status FROM ${ident(server.schemas.app, 'table_sources')} WHERE table_id = ${tableId}`,
    )
  ).rows[0]!.status;
}

describe('app connected accounts', () => {
  it('connects, saves only a connection reference, and renews access before testing and inspecting', async () => {
    const id = await connect();
    const source = await create(id);
    expect(source.secrets).toEqual([]);
    expect(source.connection).toMatchObject({
      settings: { connectionId: id, connectedBy: server.owner.info.user.name },
    });
    const stored = (
      await query<{ connection: unknown; sealed_secrets: string }>(
        server.pool,
        sql`SELECT connection, sealed_secrets FROM ${ident(server.schemas.app, 'sources')} WHERE id = ${source.id}`,
      )
    ).rows[0]!;
    safe(stored.connection);
    expect(
      JSON.parse(
        await unsealCredential(
          server.config.secretKey,
          stored.sealed_secrets,
          `source:${source.id}`,
          server.owner.info.org.id,
          server.pool,
        ),
      ),
    ).toEqual({});
    const listed = await server.app.inject({ url: '/api/connections', headers: server.owner.headers });
    safe(listed.json());
    expect(
      listed.json().providers.find((entry: { provider: string }) => entry.provider === 'github').account.id,
    ).toBe(id);
    grants.length = 0;
    calls.length = 0;
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json().ok).toBe(true);
    safe(tested.json());
    expect(grants).toEqual(['refresh_token']);
    expect(calls.every((call) => call.renewed && call.person === server.owner.userId)).toBe(true);
    const inspected = await inspect(source);
    expect(inspected.statusCode).toBe(200);
    expect(grants).toEqual(['refresh_token', 'refresh_token']);
    safe(inspected.json());
    const draftTest = await server.app.inject({
      method: 'POST',
      url: '/api/sources/test',
      headers: server.owner.headers,
      payload: draft(id),
    });
    expect(draftTest.json().ok).toBe(true);
    safe(draftTest.json());
  });

  it('refuses another person, the wrong provider, another organization, and supplied secrets before saving or testing', async () => {
    const member = await server.addMember();
    const otherId = await connect(member);
    const wrongProvider = await connect(server.owner, 'example-company');
    const own = await connect();
    for (const id of [otherId, wrongProvider, newId('connection')]) {
      for (const url of ['/api/sources', '/api/sources/test']) {
        const response = await server.app.inject({
          method: 'POST',
          url,
          headers: server.owner.headers,
          payload: draft(id),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json().error.messageKey).toBe('sources.app.connectionRequired');
        safe(response.json());
      }
    }
    const orgId = newId('org');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${orgId}, 'Other organization')`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'oauth_connections')} SET org_id = ${orgId} WHERE id = ${own}`,
    );
    const crossOrg = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: draft(own),
    });
    expect(crossOrg.json().error.messageKey).toBe('sources.app.connectionRequired');
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE id = ${own}`,
    );
    const id = await connect();
    const supplied = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: { ...draft(id), secrets: { token: randomBytes(20).toString('hex') } },
    });
    expect(supplied.json().error.messageKey).toBe('sources.app.connectionSecrets');
    const source = await create(id);
    const update = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: draft(otherId).connection },
    });
    expect(update.json().error.messageKey).toBe('sources.app.connectionRequired');
  });

  it('runs a scheduled sync as the connecting person even when another creator sets up the table', async () => {
    const id = await connect();
    const source = await create(id);
    const creator = await server.addMember({ name: 'Other creator' });
    await connect(creator);
    const tableId = await scheduledTable(source, creator);
    grants.length = 0;
    calls.length = 0;
    expect((await runScheduled(tableId)).state).toBe('idle');
    expect(grants).toEqual(['refresh_token']);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.renewed && call.person === server.owner.userId)).toBe(true);
    const rows = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.data, tableId)}`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it.each(['deactivated', 'removed'])(
    'stops inspection and scheduled syncs before using an account whose owner is %s',
    async (state) => {
      const id = await connect();
      const source = await create(id);
      const creator = await server.addMember();
      const tableId = await scheduledTable(source, creator);
      if (state === 'deactivated')
        await query(
          server.pool,
          sql`UPDATE ${ident(server.schemas.app, 'users')}
          SET deactivated_at = statement_timestamp(), automation_access_retained = true
          WHERE id = ${server.owner.userId}`,
        );
      else
        await query(
          server.pool,
          sql`DELETE FROM ${ident(server.schemas.app, 'memberships')}
          WHERE org_id = ${server.owner.info.org.id} AND user_id = ${server.owner.userId}`,
        );
      grants.length = 0;
      calls.length = 0;
      try {
        const status = await runScheduled(tableId);
        expect(status).toMatchObject({
          state: 'failed',
          error: { messageKey: 'sources.app.reconnect', params: { name: server.owner.info.user.name } },
        });
        const inspected = await inspect(source, creator);
        expect(inspected.json().error).toMatchObject({ messageKey: 'sources.app.reconnect' });
        expect(grants).toEqual([]);
        expect(calls).toEqual([]);
        safe(status);
      } finally {
        if (state === 'deactivated')
          await query(
            server.pool,
            sql`UPDATE ${ident(server.schemas.app, 'users')}
            SET deactivated_at = NULL, automation_access_retained = false WHERE id = ${server.owner.userId}`,
          );
        else
          await query(
            server.pool,
            sql`INSERT INTO ${ident(server.schemas.app, 'memberships')}
            (org_id, user_id, kind) VALUES (${server.owner.info.org.id}, ${server.owner.userId}, 'owner')`,
          );
      }
    },
  );

  it('keeps references when the same account reconnects and requires selection after replacing it', async () => {
    const id = await connect();
    const source = await create(id);
    const tableId = await scheduledTable(source);
    expect(await connect()).toBe(id);
    expect((await inspect(source)).statusCode).toBe(200);
    const replacement = await connect(server.owner, 'github', company, 'replacement-account');
    expect(replacement).not.toBe(id);
    grants.length = 0;
    calls.length = 0;
    expect((await inspect(source)).json().error).toMatchObject({ messageKey: 'sources.app.reconnect' });
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json().error).toMatchObject({ messageKey: 'sources.app.reconnect' });
    expect((await runScheduled(tableId)).error).toMatchObject({ messageKey: 'sources.app.reconnect' });
    expect(grants).toEqual([]);
    expect(calls).toEqual([]);
    const updated = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: draft(replacement).connection },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect((await inspect(source)).statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.person === 'replacement-account')).toBe(true);
    safe(updated.json());
  });

  it('warns before disconnecting, names affected sources, and fails removed accounts with their connecting person', async () => {
    const id = await connect();
    const source = await create(id);
    const tableId = await scheduledTable(source);
    const warning = await server.app.inject({
      method: 'DELETE',
      url: '/api/connections/github',
      headers: server.owner.headers,
    });
    expect(warning.statusCode).toBe(409);
    expect(warning.json().error).toMatchObject({
      messageKey: 'sources.app.disconnectWarning',
      params: { sources: expect.stringContaining(source.name) },
    });
    const listed = await server.app.inject({ url: '/api/connections', headers: server.owner.headers });
    expect(
      listed.json().providers.find((entry: { provider: string }) => entry.provider === 'github').account
        .sources,
    ).toContainEqual({ id: source.id, name: source.name });
    const removed = await server.app.inject({
      method: 'DELETE',
      url: '/api/connections/github?confirm=true',
      headers: server.owner.headers,
    });
    expect(removed.statusCode).toBe(204);
    const failure = await inspect(source);
    expect(failure.json().error).toMatchObject({
      messageKey: 'sources.app.reconnect',
      params: { name: server.owner.info.user.name },
    });
    const status = await runScheduled(tableId);
    expect(status.state).toBe('failed');
    expect(status.error).toMatchObject({
      messageKey: 'sources.app.reconnect',
      params: { name: server.owner.info.user.name },
    });
    safe(status);
  });

  it.each(['refresh', 'access'])(
    'asks the connecting person to reconnect after refused %s access',
    async (kind) => {
      const id = await connect();
      const source = await create(id);
      refuseRefresh = kind === 'refresh';
      refuseAccess = kind === 'access';
      const failed = await inspect(source);
      expect(failed.json().error).toMatchObject({
        messageKey: 'sources.app.reconnect',
        params: { name: server.owner.info.user.name },
      });
      safe(failed.json());
      const row = (
        await query<{ broken_at: Date | null }>(
          server.pool,
          sql`SELECT broken_at FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE id = ${id}`,
        )
      ).rows[0]!;
      expect(row.broken_at).not.toBeNull();
    },
  );

  it('keeps a connection healthy through rate limits and resumes without connecting again', async () => {
    expiresIn = 3_600;
    const id = await connect();
    const source = await create(id);
    rateLimited = true;
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json()).toMatchObject({
      ok: false,
      steps: expect.arrayContaining([expect.objectContaining({ messageKey: 'sources.app.rateLimited' })]),
    });
    expect((await inspect(source)).json().error).toMatchObject({ messageKey: 'sources.app.rateLimited' });
    const stored = await query<{ broken_at: Date | null }>(
      server.pool,
      sql`SELECT broken_at FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE id = ${id}`,
    );
    expect(stored.rows[0]?.broken_at).toBeNull();
    rateLimited = false;
    expect((await inspect(source)).statusCode).toBe(200);
    expect(grants).toEqual(['authorization_code']);
    safe(tested.json());
  });

  it('retains declared callback values through renewal and supplies them only for the active preset run', async () => {
    const id = await connect(server.owner, 'example-company');
    const source = await create(id, 'company-fixture');
    expect(JSON.stringify(source).includes(company)).toBe(false);
    calls.length = 0;
    const response = await inspect(source);
    expect(response.statusCode, response.body).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every(
        (call) =>
          call.renewed &&
          call.path === `/companies/${encodeURIComponent(company)}/items` &&
          call.company === company,
      ),
    ).toBe(true);
    safe(response.json());
  });
});

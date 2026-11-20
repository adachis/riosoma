import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { generate } from 'otplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  newId,
  TOKEN_SCOPES,
  type AuthenticatorConfirmed,
  type AuthenticatorSetup,
  type OAuthApp,
  type OAuthAppCreate,
  type OAuthConsent,
  type OAuthGrant,
  type OAuthSettings,
  type SecondStepProof,
  type TokenScope,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { numbers, readFixture } from '../data/snapshots.test-helpers.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { tokenHash } from '../auth/database.js';
import { PATCH_SCHEMA, USER_SCHEMA } from '../auth/scim/patch.js';
import { clientAddress } from './store.js';

let kit: TestPostgres;
let server: ServerFixture;
let origin: string;
let webDir: string;
const callback = 'https://client.example.test/callback';
const READS: TokenScope[] = ['data.records:read', 'schema.bases:read'];
const fresh = () => randomBytes(32).toString('base64url');
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

let addresses = 0;
/** A network address of its own, so one test's requests never count against another's limits. */
function anyAddress(): string {
  addresses += 1;
  return `198.18.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`;
}

beforeAll(async () => {
  kit = await startTestPostgres();
  // A built app for the server to fall back to, as it does in production for addresses it doesn't know.
  webDir = mkdtempSync(join(tmpdir(), 'rio-oauth-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Riosoma</title>');
  server = await startServer(kit, 'oauth_apps', { webDir });
  origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
  server.config.baseUrl = origin;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  if (webDir) rmSync(webDir, { recursive: true, force: true });
});

async function makeApp(confidential = false, who = server.owner, overrides: Partial<OAuthAppCreate> = {}) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/oauth/apps',
    headers: who.headers,
    payload: {
      name: 'Calendar connector',
      icon: 'database',
      homepage: 'https://client.example.test',
      redirectUris: [callback],
      confidential,
      scopes: READS,
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<OAuthApp & { clientSecret?: string }>();
}

function authorization(
  clientId: string,
  resource = `${origin}/api/v1`,
  overrides: Record<string, string> = {},
) {
  const verifier = fresh();
  const state = fresh();
  return {
    verifier,
    state,
    input: {
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callback,
      scope: READS.join(' '),
      state,
      resource,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...overrides,
    },
  };
}

/** Starts an authorization from its own address and answers its status. */
async function authorizeStatus(
  clientId: string,
  overrides: Record<string, string> = {},
  resource = `${origin}/api/v1`,
) {
  const response = await server.app.inject({
    url: `/oauth/authorize?${new URLSearchParams(authorization(clientId, resource, overrides).input)}`,
    remoteAddress: anyAddress(),
  });
  return response.statusCode;
}

async function begin(
  clientId: string,
  who = server.owner,
  resource = `${origin}/api/v1`,
  overrides: Record<string, string> = {},
) {
  const flow = authorization(clientId, resource, overrides);
  const started = await server.app.inject({
    url: `/oauth/authorize?${new URLSearchParams(flow.input)}`,
    remoteAddress: anyAddress(),
  });
  expect(started.statusCode, started.body).toBe(303);
  const request = new URL(started.headers.location!, origin).searchParams.get('request')!;
  const consent = await server.app.inject({
    url: `/api/oauth/consent?request=${request}`,
    headers: who.headers,
  });
  expect(consent.statusCode, consent.body).toBe(200);
  return { ...flow, request, consent: consent.json<OAuthConsent>() };
}

async function approve(
  flow: Awaited<ReturnType<typeof begin>>,
  who = server.owner,
  databases: 'all' | string[] = 'all',
  proof?: SecondStepProof,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: who.headers,
    payload: { request: flow.request, approve: true, databases, ...(proof ? { proof } : {}) },
  });
  expect(response.statusCode, response.body).toBe(200);
  const redirect = new URL(response.json<{ redirect: string }>().redirect);
  expect(redirect.searchParams.get('state')).toBe(flow.input.state);
  expect(redirect.searchParams.get('iss')).toBe(origin);
  return redirect.searchParams.get('code')!;
}

async function form(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(values).toString(),
    remoteAddress: anyAddress(),
  });
}

function exchangeInput(app: OAuthApp, flow: Awaited<ReturnType<typeof begin>>, code: string) {
  return {
    grant_type: 'authorization_code',
    client_id: app.id,
    code,
    redirect_uri: flow.input.redirect_uri,
    code_verifier: flow.verifier,
    resource: flow.input.resource,
  };
}

async function token(
  app: OAuthApp,
  who = server.owner,
  databases: 'all' | string[] = 'all',
  resource = `${origin}/api/v1`,
  overrides: Record<string, string> = {},
) {
  const flow = await begin(app.id, who, resource, overrides);
  const code = await approve(flow, who, databases);
  const response = await form('/oauth/token', exchangeInput(app, flow, code));
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OAuthTokens>();
}
const read = (value: string) => server.app.inject({ url: '/api/v1/databases', headers: bearer(value) });
const refresh = (app: OAuthApp, value: string, resource = `${origin}/api/v1`) =>
  form('/oauth/token', { grant_type: 'refresh_token', client_id: app.id, refresh_token: value, resource });
const connections = async (who = server.owner) =>
  (await server.app.inject({ url: '/api/oauth/grants', headers: who.headers })).json<OAuthGrant[]>();

async function events(action: string, clientId: string) {
  const result = await query<{
    actor_id: string | null;
    target: string | null;
    metadata: Record<string, unknown>;
  }>(
    server.pool,
    sql`SELECT actor_id, target, metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = ${action} AND metadata->>'clientId' = ${clientId} ORDER BY id`,
  );
  return result.rows;
}

async function share(databaseId: string, userId: string, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}(org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${userId}, ${role})`,
  );
}

it('completes the code flow, stores only credential hashes, and remembers the scope set', async () => {
  const app = await makeApp();
  const flow = await begin(app.id);
  expect(flow.consent).toMatchObject({
    app: { verified: true, icon: 'database' },
    remembered: null,
    connected: false,
    scopes: READS,
    redirectHost: 'client.example.test',
  });
  const code = await approve(flow);
  const exchanged = await form('/oauth/token', exchangeInput(app, flow, code));
  expect(exchanged.statusCode, exchanged.body).toBe(200);
  expect(exchanged.headers['cache-control']).toBe('no-store');
  const tokens = exchanged.json<OAuthTokens>();
  expect(tokens.expires_in).toBe(3_600);
  expect((await read(tokens.access_token)).statusCode).toBe(200);
  const stored = await query<{ hash: string; lifetime: number }>(
    server.pool,
    sql`SELECT hash, extract(epoch FROM (expires_at - clock_timestamp()))::int AS lifetime FROM ${ident(server.schemas.app, 'oauth_credentials')} WHERE hash = ${tokenHash(tokens.access_token)}`,
  );
  expect(stored.rows[0]!.hash).not.toBe(tokens.access_token);
  expect(stored.rows[0]!.lifetime).toBeGreaterThan(3_590);
  expect(stored.rows[0]!.lifetime).toBeLessThanOrEqual(3_600);
  expect((await begin(app.id)).consent).toMatchObject({ remembered: 'all', connected: true });
  const actions = await query<{ action: string; metadata: unknown }>(
    server.pool,
    sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'clientId' = ${app.id}`,
  );
  expect(actions.rows.map((event) => event.action)).toEqual(
    expect.arrayContaining(['oauth.authorization.approved', 'oauth.token.issued']),
  );
  expect(JSON.stringify(actions.rows)).not.toContain(tokens.access_token);
  expect(JSON.stringify(actions.rows)).not.toContain(code);
});

it.each(['plain', 'redirect', 'missing_state', 'missing_resource', 'duplicate'] as const)(
  'refuses an unsafe authorization request: %s',
  async (failure) => {
    const app = await makeApp();
    const flow = authorization(app.id);
    const params = new URLSearchParams(flow.input);
    if (failure === 'plain') params.set('code_challenge_method', 'plain');
    if (failure === 'redirect') params.set('redirect_uri', `${callback}/changed`);
    if (failure === 'missing_state') params.delete('state');
    if (failure === 'missing_resource') params.delete('resource');
    if (failure === 'duplicate') params.append('client_id', app.id);
    const response = await server.app.inject({
      url: `/oauth/authorize?${params}`,
      remoteAddress: anyAddress(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  },
);

it('refuses a wrong verifier and redirect, consumes codes once, and revokes tokens on code reuse', async () => {
  const app = await makeApp();
  const flow = await begin(app.id);
  const code = await approve(flow);
  const input = exchangeInput(app, flow, code);
  for (const patch of [{ code_verifier: fresh() }, { redirect_uri: `${callback}/wrong` }]) {
    const response = await form('/oauth/token', { ...input, ...patch });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_grant' });
  }
  const exchanged = await form('/oauth/token', input);
  expect(exchanged.statusCode).toBe(200);
  expect((await form('/oauth/token', input)).json()).toEqual({ error: 'invalid_grant' });
  expect((await read(exchanged.json<OAuthTokens>().access_token)).statusCode).toBe(401);
});

it('limits resources, scopes, and chosen databases on the actual REST and MCP routes', async () => {
  const app = await makeApp();
  const allowed = await readFixture(server);
  const hidden = await readFixture(server);
  const tokens = await token(app, server.owner, [allowed.table.databaseId]);
  const listed = await read(tokens.access_token);
  expect(listed.json<{ databases: { id: string }[] }>().databases.map((db) => db.id)).toEqual([
    allowed.table.databaseId,
  ]);
  expect(
    (
      await server.app.inject({
        url: `/api/v1/tables/${allowed.table.id}/records`,
        headers: bearer(tokens.access_token),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.app.inject({
        url: `/api/v1/tables/${hidden.table.id}/records`,
        headers: bearer(tokens.access_token),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${allowed.table.id}/records`,
        headers: bearer(tokens.access_token),
        payload: { records: [{ fields: {} }] },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: bearer(tokens.access_token),
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await server.app.inject({ url: '/api/databases', headers: bearer(tokens.access_token) })).statusCode,
  ).toBe(401);
  expect(
    (await server.app.inject({ url: '/v0/meta/bases', headers: bearer(tokens.access_token) })).statusCode,
  ).toBe(401);
  expect((await refresh(app, tokens.refresh_token!, `${origin}/mcp`)).json()).toEqual({
    error: 'invalid_target',
  });
  const mcp = await token(app, server.owner, 'all', `${origin}/mcp`);
  expect((await read(mcp.access_token)).statusCode).toBe(401);
});

it('applies the person’s current record and field permissions to OAuth reads', async () => {
  const app = await makeApp();
  const person = await server.addMember();
  const table = await readFixture(server, [{ type: 'number' }, { type: 'text' }]);
  await numbers(server, table, [1, 2]);
  await share(table.table.databaseId, person.userId, 'reader');
  const field = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${table.fields[1]!.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(field.statusCode, field.body).toBe(200);
  const rule = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${table.table.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: table.fields[0]!.id, operator: 'eq', value: 1 }],
          },
        },
      ],
    },
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const tokens = await token(app, person, [table.table.databaseId]);
  const records = await server.app.inject({
    url: `/api/v1/tables/${table.table.id}/records`,
    headers: bearer(tokens.access_token),
  });
  expect(records.statusCode, records.body).toBe(200);
  const body = records.json<{ records: Record<string, unknown>; order: string[] }>();
  expect(body.order).toHaveLength(1);
  expect(JSON.stringify(body.records)).not.toContain('Field 1');
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${table.table.databaseId} AND principal_id = ${person.userId}`,
  );
  expect(
    (
      await server.app.inject({
        url: `/api/v1/tables/${table.table.id}/records`,
        headers: bearer(tokens.access_token),
      })
    ).statusCode,
  ).toBe(404);
});

it('rotates refresh tokens and revokes the whole grant when an old token is reused', async () => {
  const app = await makeApp();
  const tokens = await token(app);
  const rotated = await refresh(app, tokens.refresh_token!);
  expect(rotated.statusCode, rotated.body).toBe(200);
  const next = rotated.json<OAuthTokens>();
  expect(next.refresh_token).not.toBe(tokens.refresh_token);
  expect((await read(next.access_token)).statusCode).toBe(200);
  expect((await refresh(app, tokens.refresh_token!)).json()).toEqual({ error: 'invalid_grant' });
  expect((await read(tokens.access_token)).statusCode).toBe(401);
  expect((await read(next.access_token)).statusCode).toBe(401);
  expect((await refresh(app, next.refresh_token!)).json()).toEqual({ error: 'invalid_grant' });
  const actions = await query<{ action: string }>(
    server.pool,
    sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'clientId' = ${app.id}`,
  );
  expect(actions.rows.map((event) => event.action)).toEqual(
    expect.arrayContaining(['oauth.token.refreshed', 'oauth.credential.reused', 'oauth.grant.revoked']),
  );
});

it('serializes concurrent refreshes so a reused token cannot leave a live descendant', async () => {
  const app = await makeApp();
  const tokens = await token(app);
  const responses = await Promise.all([
    refresh(app, tokens.refresh_token!),
    refresh(app, tokens.refresh_token!),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
  const successful = responses.find((response) => response.statusCode === 200)!.json<OAuthTokens>();
  expect((await read(successful.access_token)).statusCode).toBe(401);
});

it('requires confidential client authentication and rejects the old secret after rotation', async () => {
  const app = await makeApp(true);
  const flow = await begin(app.id);
  const code = await approve(flow);
  const input = exchangeInput(app, flow, code);
  expect((await form('/oauth/token', input)).statusCode).toBe(401);
  expect((await form('/oauth/token', { ...input, client_secret: fresh() })).statusCode).toBe(401);
  const rotated = await server.app.inject({
    method: 'POST',
    url: `/api/admin/oauth/apps/${app.id}/secret`,
    headers: server.owner.headers,
  });
  const secret = rotated.json<{ clientSecret: string }>().clientSecret;
  expect((await form('/oauth/token', { ...input, client_secret: app.clientSecret! })).statusCode).toBe(401);
  const result = await form('/oauth/token', input, {
    authorization: `Basic ${Buffer.from(`${app.id}:${secret}`).toString('base64')}`,
  });
  expect(result.statusCode, result.body).toBe(200);
  const list = await server.app.inject({ url: '/api/admin/oauth/apps', headers: server.owner.headers });
  expect(list.body).not.toContain(secret);
  expect(list.body).not.toContain('secret_hash');
  const hashes = await query<{ secret_hash: string }>(
    server.pool,
    sql`SELECT secret_hash FROM ${ident(server.schemas.app, 'oauth_clients')} WHERE id = ${app.id}`,
  );
  expect(hashes.rows[0]!.secret_hash).toBe(tokenHash(secret));
});

it.each(['access', 'refresh'] as const)(
  'revokes a grant using its %s token and conceals unknown credentials',
  async (kind) => {
    const app = await makeApp();
    const other = await makeApp();
    const tokens = await token(app);
    const value = kind === 'access' ? tokens.access_token : tokens.refresh_token!;
    expect((await form('/oauth/revoke', { client_id: other.id, token: value })).statusCode).toBe(200);
    expect((await read(tokens.access_token)).statusCode).toBe(200);
    expect((await form('/oauth/revoke', { client_id: app.id, token: value })).statusCode).toBe(200);
    expect((await read(tokens.access_token)).statusCode).toBe(401);
    expect((await refresh(app, tokens.refresh_token!)).statusCode).toBe(400);
    expect((await form('/oauth/revoke', { client_id: app.id, token: fresh() })).statusCode).toBe(200);
  },
);

it('revokes only a live token, and only the installation it belongs to', async () => {
  const app = await makeApp();
  const first = await token(app);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'oauth_credentials')} SET expires_at = clock_timestamp() - interval '1 second' WHERE hash = ${tokenHash(first.access_token)}`,
  );
  const rotated = (await refresh(app, first.refresh_token!)).json<OAuthTokens>();
  expect((await read(rotated.access_token)).statusCode).toBe(200);
  // An expired access token and a spent refresh token are no longer tokens, so revoking them
  // answers as usual and changes nothing (RFC 7009, section 2.2).
  for (const old of [first.access_token, first.refresh_token!]) {
    expect((await form('/oauth/revoke', { client_id: app.id, token: old })).statusCode).toBe(200);
    expect((await read(rotated.access_token)).statusCode).toBe(200);
  }
  // A second installation of the same app, for the same person, is a grant of its own.
  const second = await token(app);
  expect((await form('/oauth/revoke', { client_id: app.id, token: rotated.access_token })).statusCode).toBe(
    200,
  );
  expect((await read(rotated.access_token)).statusCode).toBe(401);
  expect((await refresh(app, rotated.refresh_token!)).statusCode).toBe(400);
  expect((await read(second.access_token)).statusCode).toBe(200);
  // Revoking the connection in settings ends every installation it has.
  const third = await token(app);
  const mine = (await connections()).filter((connection) => connection.clientId === app.id);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ installations: 2, resources: [`${origin}/api/v1`], databases: 'all' });
  const removed = await server.app.inject({
    method: 'DELETE',
    url: `/api/oauth/grants/${mine[0]!.id}`,
    headers: server.owner.headers,
  });
  expect(removed.statusCode).toBe(204);
  for (const tokens of [second, third]) {
    expect((await read(tokens.access_token)).statusCode).toBe(401);
    expect((await refresh(app, tokens.refresh_token!)).statusCode).toBe(400);
  }
  expect((await connections()).filter((connection) => connection.clientId === app.id)).toEqual([]);
  const revoked = await events('oauth.grant.revoked', app.id);
  expect(revoked.map((event) => event.metadata.reason).sort()).toEqual([
    'client_request',
    'person_request',
    'person_request',
  ]);
  expect((await begin(app.id)).consent).toMatchObject({ remembered: null, connected: false });
});

it.each(['suspend', 'remove_membership', 'guest', 'remove_person'] as const)(
  'permanently revokes grants when the person changes: %s',
  async (change) => {
    const app = await makeApp();
    const person = await server.addMember();
    const tokens = await token(app, person);
    if (change === 'suspend') {
      for (const deactivated of [true, false]) {
        const changed = await server.app.inject({
          method: 'PATCH',
          url: `/api/org/members/${person.userId}/status`,
          headers: server.owner.headers,
          payload: { deactivated },
        });
        expect(changed.statusCode, changed.body).toBe(200);
      }
    } else if (change === 'remove_membership') {
      await query(
        server.pool,
        sql`DELETE FROM ${ident(server.schemas.app, 'memberships')} WHERE user_id = ${person.userId}`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'memberships')}(org_id, user_id, kind) VALUES (${person.info.org.id}, ${person.userId}, 'member')`,
      );
    } else if (change === 'guest') {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET kind = 'guest' WHERE user_id = ${person.userId}`,
      );
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET kind = 'member' WHERE user_id = ${person.userId}`,
      );
    } else
      await query(
        server.pool,
        sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${person.userId}`,
      );
    expect((await read(tokens.access_token)).statusCode).toBe(401);
    expect((await refresh(app, tokens.refresh_token!)).statusCode).toBe(400);
    // The People command credits its administrator.  Direct data changes have no acting person.
    expect(await events('oauth.grant.revoked', app.id)).toEqual([
      {
        actor_id: change === 'suspend' ? server.owner.userId : null,
        target: app.id,
        metadata: expect.objectContaining({ clientId: app.id, userId: person.userId }),
      },
    ]);
  },
);

it('credits revocations a trigger makes to whoever acted, and records what each registration asked for', async () => {
  const app = await makeApp();
  expect(await events('oauth.app.registered', app.id)).toEqual([
    {
      actor_id: server.owner.userId,
      target: null,
      metadata: {
        clientId: app.id,
        verified: true,
        dynamic: false,
        name: 'Calendar connector',
        homepage: 'https://client.example.test',
        redirectUris: [callback],
        scopes: READS,
        confidential: false,
      },
    },
  ]);
  const person = await server.addMember();
  await token(app, person);
  await withTransaction(server.pool, async (db) => {
    await db.query(`SELECT set_config('riosoma.acting', $1, true)`, [
      JSON.stringify({ actorId: server.owner.userId, metadata: { actorKind: 'administrator' } }),
    ]);
    await query(
      db,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = clock_timestamp() WHERE id = ${person.userId}`,
    );
  });
  expect(await events('oauth.grant.revoked', app.id)).toEqual([
    {
      actor_id: server.owner.userId,
      target: app.id,
      metadata: expect.objectContaining({
        actorKind: 'administrator',
        clientId: app.id,
        userId: person.userId,
        reason: 'person_inactive',
      }),
    },
  ]);
});

it('ends app connections when provisioning suspends or removes a person, crediting the directory', async () => {
  const orgId = server.owner.info.org.id;
  const providerId = randomBytes(16).toString('hex');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sso_providers')} (id, org_id, kind, name, issuer, client_id, sealed_secret, allowed_domains)
    VALUES (${providerId}, ${orgId}, 'oidc', 'Directory', 'https://example.test/identity', ${fresh()}, ${fresh()}, ARRAY['example.test'])`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sso_domain_verifications')} (org_id, provider_id, domain, challenge, verified_at)
    VALUES (${orgId}, ${providerId}, 'example.test', ${fresh()}, clock_timestamp())`,
  );
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/admin/scim/tokens',
    headers: server.owner.headers,
    payload: { name: 'Directory provisioning' },
  });
  expect(created.statusCode, created.body).toBe(200);
  const directory = created.json<{ id: string; token: string }>();
  const scim = (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
    server.app.inject({
      method,
      url: `/scim/v2/${path}`,
      headers: {
        authorization: `Bearer ${directory.token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/scim+json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const app = await makeApp();
  const suspended = await server.addMember();
  const removed = await server.addMember();
  const reached = new Map<string, OAuthTokens>();
  for (const person of [suspended, removed]) {
    reached.set(person.userId, await token(app, person));
    const adopted = await scim('POST', 'Users', {
      schemas: [USER_SCHEMA],
      userName: person.email,
      externalId: `directory-${person.userId}`,
      active: true,
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
  }
  const deactivate = {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  };
  expect((await scim('PATCH', `Users/${suspended.userId}`, deactivate)).statusCode).toBe(200);
  const settings = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/scim',
    headers: server.owner.headers,
    payload: { dryRun: false, deleteAction: 'remove' },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  expect((await scim('DELETE', `Users/${removed.userId}`)).statusCode).toBe(204);
  for (const tokens of reached.values()) {
    expect((await read(tokens.access_token)).statusCode).toBe(401);
    expect((await refresh(app, tokens.refresh_token!)).statusCode).toBe(400);
  }
  const revoked = await events('oauth.grant.revoked', app.id);
  expect(revoked.map((event) => [event.metadata.userId, event.metadata.reason])).toEqual([
    [suspended.userId, 'person_inactive'],
    [removed.userId, 'person_removed'],
  ]);
  for (const event of revoked)
    expect(event).toMatchObject({
      actor_id: null,
      metadata: { actorKind: 'scim_token', tokenId: directory.id, clientId: app.id },
    });
});

it('enforces the Integrations role and lets people and administrators revoke connections', async () => {
  const person = await server.addMember();
  expect(
    (await server.app.inject({ url: '/api/admin/oauth/apps', headers: person.headers })).statusCode,
  ).toBe(403);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['integrations'] WHERE user_id = ${person.userId}`,
  );
  const app = await makeApp(false, person);
  const tokens = await token(app, person);
  const grant = (await connections(person))[0]!;
  expect(
    (
      await server.app.inject({
        method: 'DELETE',
        url: `/api/oauth/grants/${grant.id}`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await server.app.inject({
        method: 'DELETE',
        url: `/api/oauth/grants/${grant.id}`,
        headers: person.headers,
      })
    ).statusCode,
  ).toBe(204);
  expect((await read(tokens.access_token)).statusCode).toBe(401);
  const newer = await token(app, person);
  const adminGrants = await server.app.inject({
    url: '/api/admin/oauth/grants',
    headers: server.owner.headers,
  });
  const live = adminGrants.json<OAuthGrant[]>().find((g) => g.clientId === app.id && !g.revokedAt)!;
  expect(
    (
      await server.app.inject({
        method: 'DELETE',
        url: `/api/admin/oauth/grants/${live.id}`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(204);
  expect((await read(newer.access_token)).statusCode).toBe(401);
  const final = await token(app, person);
  expect(
    (
      await server.app.inject({
        method: 'DELETE',
        url: `/api/admin/oauth/apps/${app.id}`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(204);
  expect((await read(final.access_token)).statusCode).toBe(401);
  expect(await authorizeStatus(app.id)).toBe(401);
});

it('binds consent to the browser session, checks CSRF, and refuses inaccessible databases', async () => {
  const app = await makeApp();
  const flow = await begin(app.id);
  const other = await server.addMember();
  const body = { request: flow.request, approve: true, databases: 'all' };
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: { cookie: server.owner.headers.cookie },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await server.app.inject({ url: `/api/oauth/consent?request=${flow.request}`, headers: other.headers }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: other.headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(404);
  const denied = await server.app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: server.owner.headers,
    payload: { ...body, approve: false },
  });
  expect(new URL(denied.json<{ redirect: string }>().redirect).searchParams.get('error')).toBe(
    'access_denied',
  );
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: server.owner.headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(404);
  const limited = await begin(app.id, other);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/oauth/consent',
        headers: other.headers,
        payload: { request: limited.request, approve: true, databases: [newId('database')] },
      })
    ).statusCode,
  ).toBe(403);
});

it('takes the same fresh second step to approve an app that making a personal access token takes', async () => {
  const app = await makeApp();
  const person = await server.addMember();
  const started = await server.app.inject({
    method: 'POST',
    url: '/api/me/mfa/authenticator',
    headers: person.headers,
  });
  expect(started.statusCode, started.body).toBe(200);
  const { secret } = started.json<AuthenticatorSetup>();
  const confirmed = await server.app.inject({
    method: 'POST',
    url: '/api/me/mfa/authenticator/confirm',
    headers: person.headers,
    payload: { code: await generate({ secret, epoch: Math.floor(Date.now() / 1_000) }) },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const recoveryCodes = confirmed.json<AuthenticatorConfirmed>().recoveryCodes!;
  // Just as a personal access token needs one, so a copied session alone can't add a way in.
  const madeToken = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: person.headers,
    payload: { name: 'Nightly', scopes: READS, databases: 'all' },
  });
  expect(madeToken.json<{ error: { messageKey: string } }>().error.messageKey).toBe('mfa.proof.required');
  const flow = await begin(app.id, person);
  const decide = (proof?: unknown) =>
    server.app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      headers: person.headers,
      payload: { request: flow.request, approve: true, databases: 'all', ...(proof ? { proof } : {}) },
    });
  const bare = await decide();
  expect(bare.statusCode).toBe(403);
  expect(bare.json<{ error: { messageKey: string } }>().error.messageKey).toBe('mfa.proof.required');
  const wrong = await decide({ method: 'recovery', code: 'aaaaa-bbbbb' });
  expect(wrong.statusCode).toBe(403);
  expect(wrong.json<{ error: { messageKey: string } }>().error.messageKey).toBe('mfa.code.invalid');
  const code = await approve(flow, person, 'all', { method: 'recovery', code: recoveryCodes[0]! });
  expect((await form('/oauth/token', exchangeInput(app, flow, code))).statusCode).toBe(200);
  expect(await events('oauth.authorization.approved', app.id)).toEqual([
    expect.objectContaining({
      actor_id: person.userId,
      metadata: expect.objectContaining({ proof: 'recovery' }),
    }),
  ]);
  // Saying no adds nothing, so it needs no proof.
  const denied = await begin(app.id, person);
  const refusal = await server.app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: person.headers,
    payload: { request: denied.request, approve: false, databases: 'all' },
  });
  expect(refusal.statusCode).toBe(200);
});

it('turns off webhooks an app made when its installation ends or its person is suspended', async () => {
  const app = await makeApp(false, server.owner, { scopes: [...TOKEN_SCOPES] });
  const person = await server.addMember();
  const fixture = await readFixture(server);
  const databaseId = fixture.table.databaseId;
  await share(databaseId, person.userId, 'creator');
  const everything = { scope: [...TOKEN_SCOPES].sort().join(' ') };
  const hook = async (access: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/webhooks`,
      headers: bearer(access),
      payload: { url: 'https://hooks.example.test/receiver', events: ['record.updated'] },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  };
  const state = async (id: string) =>
    (
      await query<{ enabled: boolean; disabled_reason: string | null }>(
        server.pool,
        sql`SELECT enabled, disabled_reason FROM ${ident(server.schemas.app, 'webhooks')} WHERE id = ${id}`,
      )
    ).rows[0];
  const first = await token(app, person, 'all', `${origin}/api/v1`, everything);
  const made = await hook(first.access_token);
  expect(await state(made)).toEqual({ enabled: true, disabled_reason: null });
  expect((await form('/oauth/revoke', { client_id: app.id, token: first.refresh_token! })).statusCode).toBe(
    200,
  );
  expect(await state(made)).toEqual({ enabled: false, disabled_reason: 'webhooks.disabled.grantEnded' });
  const second = await token(app, person, 'all', `${origin}/api/v1`, everything);
  const later = await hook(second.access_token);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = clock_timestamp() WHERE id = ${person.userId}`,
  );
  expect(await state(later)).toEqual({ enabled: false, disabled_reason: 'webhooks.disabled.grantEnded' });
  const disabled = await events('data.webhook.disabled', app.id);
  expect(disabled.map((event) => event.metadata.webhookId)).toEqual([made, later]);
});

it('narrows every installation at once when the person approves again with fewer databases or scopes', async () => {
  const app = await makeApp();
  const person = await server.addMember();
  const a = await readFixture(server);
  const b = await readFixture(server);
  for (const fixture of [a, b]) await share(fixture.table.databaseId, person.userId, 'reader');
  const listed = async (access: string) =>
    (await read(access))
      .json<{ databases: { id: string }[] }>()
      .databases.map((db) => db.id)
      .sort();
  const first = await token(app, person, 'all');
  expect(await listed(first.access_token)).toEqual([a.table.databaseId, b.table.databaseId].sort());
  const again = await begin(app.id, person);
  expect(again.consent).toMatchObject({ remembered: 'all', connected: true });
  const code = await approve(again, person, [a.table.databaseId]);
  const second = (await form('/oauth/token', exchangeInput(app, again, code))).json<OAuthTokens>();
  expect(await listed(second.access_token)).toEqual([a.table.databaseId]);
  // The first installation narrowed at the same moment, and stays narrow after a refresh.
  expect(await listed(first.access_token)).toEqual([a.table.databaseId]);
  const refreshed = (await refresh(app, first.refresh_token!)).json<OAuthTokens>();
  expect(await listed(refreshed.access_token)).toEqual([a.table.databaseId]);
  expect(await connections(person)).toEqual([
    expect.objectContaining({ clientId: app.id, databases: [a.table.databaseId], installations: 2 }),
  ]);
  // Fewer scopes narrow every installation too.
  const fewer = await begin(app.id, person, `${origin}/api/v1`, { scope: 'data.records:read' });
  expect(fewer.consent).toMatchObject({ remembered: null, connected: true });
  await approve(fewer, person, [a.table.databaseId]);
  for (const access of [second.access_token, refreshed.access_token]) {
    expect((await read(access)).statusCode).toBe(403);
    expect(
      (await server.app.inject({ url: `/api/v1/tables/${a.table.id}/records`, headers: bearer(access) }))
        .statusCode,
    ).toBe(200);
  }
  expect((await refresh(app, second.refresh_token!)).json<OAuthTokens>().scope).toBe('data.records:read');
});

it('accepts a token request without the resource its authorization named, and a refresh that asks for less', async () => {
  const app = await makeApp();
  const fixture = await readFixture(server);
  const flow = await begin(app.id);
  const code = await approve(flow);
  const { resource: _named, ...unnamed } = exchangeInput(app, flow, code);
  const exchanged = await form('/oauth/token', unnamed);
  expect(exchanged.statusCode, exchanged.body).toBe(200);
  const tokens = exchanged.json<OAuthTokens & { resource: string }>();
  expect(tokens.resource).toBe(`${origin}/api/v1`);
  const narrowed = await form('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: app.id,
    refresh_token: tokens.refresh_token!,
    scope: 'data.records:read',
  });
  expect(narrowed.statusCode, narrowed.body).toBe(200);
  const narrow = narrowed.json<OAuthTokens>();
  expect(narrow.scope).toBe('data.records:read');
  expect((await read(narrow.access_token)).statusCode).toBe(403);
  expect(
    (
      await server.app.inject({
        url: `/api/v1/tables/${fixture.table.id}/records`,
        headers: bearer(narrow.access_token),
      })
    ).statusCode,
  ).toBe(200);
  // Asking for more than was granted is refused, and the refresh token still holds the whole grant.
  const more = await form('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: app.id,
    refresh_token: narrow.refresh_token!,
    scope: 'data.records:read data.records:write',
  });
  expect(more.json()).toEqual({ error: 'invalid_scope' });
  const whole = await form('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: app.id,
    refresh_token: narrow.refresh_token!,
  });
  expect(whole.statusCode, whole.body).toBe(200);
  expect(whole.json<OAuthTokens>().scope).toBe(READS.join(' '));
  expect((await read(whole.json<OAuthTokens>().access_token)).statusCode).toBe(200);
});

it('expires codes, access tokens, refresh tokens, and consent requests using database time', async () => {
  const app = await makeApp();
  const flow = await begin(app.id);
  const code = await approve(flow);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'oauth_credentials')} SET expires_at = clock_timestamp() - interval '1 second' WHERE hash = ${tokenHash(code)}`,
  );
  expect((await form('/oauth/token', exchangeInput(app, flow, code))).statusCode).toBe(400);
  const tokens = await token(app);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'oauth_credentials')} SET expires_at = clock_timestamp() - interval '1 second' WHERE hash = ANY(${[tokenHash(tokens.access_token), tokenHash(tokens.refresh_token!)]}::text[])`,
  );
  expect((await read(tokens.access_token)).statusCode).toBe(401);
  expect((await refresh(app, tokens.refresh_token!)).statusCode).toBe(400);
  const pending = await begin(app.id);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'oauth_requests')} SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${tokenHash(pending.request)}`,
  );
  expect(
    (
      await server.app.inject({
        url: `/api/oauth/consent?request=${pending.request}`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(404);
});

it('keeps each address to 20 waiting authorization requests per app, so no address can lock out another', async () => {
  const app = await makeApp();
  const attacker = '203.0.113.7';
  // As if the attacker had filled the whole allowance an app once had for everyone.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'oauth_requests')} (id, client_id, address, parameters)
    SELECT md5(random()::text || n), ${app.id}, ${tokenHash(attacker)}, '{}'::jsonb FROM generate_series(1, 1000) n`,
  );
  const start = (remoteAddress: string) =>
    server.app.inject({
      url: `/oauth/authorize?${new URLSearchParams(authorization(app.id).input)}`,
      remoteAddress,
    });
  const victim = await start('198.51.100.9');
  expect(victim.statusCode, victim.body).toBe(303);
  const requests: string[] = [];
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await start(attacker);
    expect(response.statusCode, response.body).toBe(303);
    requests.push(new URL(response.headers.location!, origin).searchParams.get('request')!);
  }
  const waiting = await query<{ count: number }>(
    server.pool,
    sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.app, 'oauth_requests')}
    WHERE client_id = ${app.id} AND address = ${tokenHash(attacker)} AND used_at IS NULL`,
  );
  expect(waiting.rows[0]!.count).toBe(20);
  const consent = (request: string) =>
    server.app.inject({ url: `/api/oauth/consent?request=${request}`, headers: server.owner.headers });
  expect((await consent(requests[0]!)).statusCode).toBe(404);
  expect((await consent(requests[20]!)).statusCode).toBe(200);
  // One subscriber's IPv6 addresses count as one address, and a mapped IPv4 address as itself.
  expect(clientAddress('2001:db8:0:1:aaaa::1')).toBe(clientAddress('2001:db8::1:ffff:0:0:2'));
  expect(clientAddress('2001:db8:0:1::1')).not.toBe(clientAddress('2001:db8:0:2::1'));
  expect(clientAddress(`::ffff:${attacker}`)).toBe(attacker);
});

async function dynamic(enabled: boolean) {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/oauth/settings',
    headers: server.owner.headers,
    payload: { dynamicRegistration: enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

it('keeps dynamic registration off by default and permits only public MCP clients when enabled', async () => {
  const metadata = await server.app.inject({ url: '/.well-known/oauth-authorization-server' });
  expect(metadata.json()).not.toHaveProperty('registration_endpoint');
  const input = {
    client_name: 'MCP calendar',
    redirect_uris: [callback],
    token_endpoint_auth_method: 'none',
  };
  expect(
    (await server.app.inject({ method: 'POST', url: '/oauth/register', payload: input })).statusCode,
  ).toBe(403);
  await dynamic(true);
  expect((await server.app.inject({ url: '/.well-known/oauth-authorization-server' })).json()).toHaveProperty(
    'registration_endpoint',
    `${origin}/oauth/register`,
  );
  for (const patch of [
    { token_endpoint_auth_method: 'client_secret_basic' },
    { scope: 'schema.bases:delete' },
    { redirect_uris: ['http://client.example.test/callback'] },
    { redirect_uris: [`${callback}#fragment`] },
  ]) {
    expect(
      (await server.app.inject({ method: 'POST', url: '/oauth/register', payload: { ...input, ...patch } }))
        .statusCode,
    ).toBe(400);
  }
  const registered = await server.app.inject({ method: 'POST', url: '/oauth/register', payload: input });
  expect(registered.statusCode, registered.body).toBe(201);
  const clientId = registered.json<{ client_id: string }>().client_id;
  expect(await events('oauth.app.registered', clientId)).toEqual([
    {
      actor_id: null,
      target: clientId,
      metadata: expect.objectContaining({
        name: 'MCP calendar',
        redirectUris: [callback],
        scopes: ['data.records:read', 'data.records:write', 'schema.bases:read', 'schema.bases:write'],
        verified: false,
      }),
    },
  ]);
  const flow = await begin(clientId, server.owner, `${origin}/mcp`);
  expect(flow.consent.app.verified).toBe(false);
  expect(await authorizeStatus(clientId)).toBe(400);
  await dynamic(false);
  expect(
    (
      await server.app.inject({
        url: `/oauth/authorize?${new URLSearchParams(flow.input)}`,
        remoteAddress: anyAddress(),
      })
    ).statusCode,
  ).toBe(400);
});

it('lets an address make 5 dynamic registrations a day, and expires unused ones after 7 days and idle ones after 90', async () => {
  await dynamic(true);
  try {
    const loopback = 'http://127.0.0.1/callback';
    const register = (remoteAddress: string, name = 'MCP client') =>
      server.app.inject({
        method: 'POST',
        url: '/oauth/register',
        remoteAddress,
        payload: { client_name: name, redirect_uris: [loopback] },
      });
    const busy = '198.19.0.1';
    const made: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await register(busy);
      expect(response.statusCode, response.body).toBe(201);
      made.push(response.json<{ client_id: string }>().client_id);
    }
    expect((await register(busy)).statusCode).toBe(429);
    // An organization full of registrations nobody used gets their places back after 7 days.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'oauth_clients')}
      (id, org_id, name, icon, homepage, redirect_uris, scopes, verified, created_at)
      SELECT md5(random()::text || n), ${server.owner.info.org.id}, 'filler', 'app', '',
        ARRAY['https://filler.example.test/cb'], ARRAY['data.records:read'], false,
        clock_timestamp() - interval '8 days'
      FROM generate_series(1, 500) n`,
    );
    const real = await register('198.19.0.2', 'Real client');
    expect(real.statusCode, real.body).toBe(201);
    const age = (id: string, created: string, used: string | null) =>
      query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'oauth_clients')}
        SET created_at = clock_timestamp() - ${created}::interval,
          last_used_at = clock_timestamp() - ${used}::interval
        WHERE id = ${id}`,
      );
    const start = (id: string) => authorizeStatus(id, { redirect_uri: loopback }, `${origin}/mcp`);
    await age(made[0]!, '8 days', null);
    expect(await start(made[0]!)).toBe(401);
    await age(made[1]!, '200 days', '91 days');
    expect(await start(made[1]!)).toBe(401);
    await age(made[2]!, '200 days', '89 days');
    expect(await start(made[2]!)).toBe(303);
    const listed = (
      await server.app.inject({ url: '/api/admin/oauth/apps', headers: server.owner.headers })
    ).json<OAuthApp[]>();
    const revoked = (id: string) => listed.find((entry) => entry.id === id)?.revokedAt ?? null;
    expect(revoked(made[0]!)).not.toBeNull();
    expect(revoked(made[1]!)).not.toBeNull();
    expect(revoked(made[2]!)).toBeNull();
    expect((await events('oauth.app.expired', made[0]!))[0]?.metadata).toMatchObject({ reason: 'unused' });
    expect((await events('oauth.app.expired', made[1]!))[0]?.metadata).toMatchObject({ reason: 'idle' });
  } finally {
    await dynamic(false);
  }
});

it.each([
  'https://trusted.example∕callback.attacker.test/x',
  'https://trusted.example%E3%80%82attacker.test/cb',
  'https://good%2Eevil.test/cb',
  'https://gооgle.com/cb',
  'https://good.test/cb/../../evil',
  'https://good.test/cb/%2e%2e/evil',
  'https://Good.test/cb',
  'https://good.test:443/cb',
  'https://good.test./cb',
])('refuses a redirect URI the browser reads differently from how it is written: %s', async (uri) => {
  const admin = await server.app.inject({
    method: 'POST',
    url: '/api/admin/oauth/apps',
    headers: server.owner.headers,
    payload: {
      name: 'Look-alike',
      homepage: 'https://client.example.test',
      redirectUris: [uri],
      confidential: false,
      scopes: READS,
    },
  });
  expect(admin.statusCode).toBe(422);
  await dynamic(true);
  try {
    const registered = await server.app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress: anyAddress(),
      payload: { client_name: 'Trusted Example', redirect_uris: [uri] },
    });
    expect(registered.statusCode).toBe(400);
  } finally {
    await dynamic(false);
  }
});

it('shows the host the browser will send the code to, and accepts punycode written as the browser reads it', async () => {
  const uri = 'https://xn--ggle-55da.com/cb';
  const app = await makeApp(false, server.owner, { redirectUris: [uri] });
  const flow = await begin(app.id, server.owner, `${origin}/api/v1`, { redirect_uri: uri });
  expect(flow.consent).toMatchObject({ redirectUri: uri, redirectHost: 'xn--ggle-55da.com' });
});

it('lets a public client return to a loopback address on any port, and holds a confidential client to its exact port', async () => {
  for (const uri of [
    'https://*.example.test/callback',
    'https://client.example.test/*',
    'https://client.example.test/callback#part',
  ]) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/admin/oauth/apps',
      headers: server.owner.headers,
      payload: {
        name: 'Wildcard',
        homepage: 'https://client.example.test',
        redirectUris: [uri],
        confidential: false,
        scopes: READS,
      },
    });
    expect(response.statusCode).toBe(422);
  }
  const app = await makeApp(false, server.owner, {
    redirectUris: ['http://127.0.0.1/callback', 'http://[::1]:8080/callback', 'http://localhost/callback'],
  });
  for (const [uri, host] of [
    ['http://127.0.0.1:49153/callback', '127.0.0.1:49153'],
    ['http://127.0.0.1/callback', '127.0.0.1'],
    ['http://[::1]:5173/callback', '[::1]:5173'],
    ['http://localhost:3000/callback', 'localhost:3000'],
  ] as const) {
    const flow = await begin(app.id, server.owner, `${origin}/api/v1`, { redirect_uri: uri });
    expect(flow.consent).toMatchObject({ redirectUri: uri, redirectHost: host });
  }
  // The scheme, host, and path still match exactly.
  for (const uri of [
    'http://127.0.0.1:49153/other',
    'http://localhost:3000/callback/',
    'http://127.0.0.2:49153/callback',
    'https://127.0.0.1:49153/callback',
    'http://127.0.0.1:80/callback',
  ])
    expect(await authorizeStatus(app.id, { redirect_uri: uri })).toBe(400);
  // The code goes only to the port the request named.
  const flow = await begin(app.id, server.owner, `${origin}/api/v1`, {
    redirect_uri: 'http://localhost:3000/callback',
  });
  const code = await approve(flow);
  const input = exchangeInput(app, flow, code);
  expect(
    (await form('/oauth/token', { ...input, redirect_uri: 'http://localhost:3001/callback' })).json(),
  ).toEqual({
    error: 'invalid_grant',
  });
  expect((await form('/oauth/token', input)).statusCode).toBe(200);
  const localhost = await server.app.inject({
    method: 'POST',
    url: '/api/admin/oauth/apps',
    headers: server.owner.headers,
    payload: {
      name: 'Server app',
      homepage: 'https://client.example.test',
      redirectUris: ['http://localhost:3000/callback'],
      confidential: true,
      scopes: READS,
    },
  });
  expect(localhost.statusCode).toBe(422);
  const confidential = await makeApp(true, server.owner, {
    redirectUris: ['http://127.0.0.1:49152/callback'],
  });
  expect(await authorizeStatus(confidential.id, { redirect_uri: 'http://127.0.0.1:49153/callback' })).toBe(
    400,
  );
  expect(await authorizeStatus(confidential.id, { redirect_uri: 'http://127.0.0.1:49152/callback' })).toBe(
    303,
  );
});

it('answers exactly the old 401s, without a metadata pointer, while the base URL is plain HTTP on a network host', async () => {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Nightly', scopes: ['schema.bases:read'], databases: 'all' },
  });
  expect(created.statusCode, created.body).toBe(200);
  const personal = created.json<{ token: string }>().token;
  server.config.baseUrl = 'http://riosoma.lan:3000';
  try {
    for (const authorization of [
      `Bearer ${['rio', 'pat', 'malformed'].join('_')}`,
      undefined,
      `Bearer ${fresh()}`,
    ]) {
      const response = await server.app.inject({
        url: '/api/v1/databases',
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.json()).toMatchObject({
        error: { code: 'unauthenticated', messageKey: 'errors.tokenInvalid' },
      });
    }
    const mcp = await server.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(mcp.statusCode).toBe(401);
    expect(mcp.headers['www-authenticate']).toBeUndefined();
    expect(
      (await server.app.inject({ url: '/api/v1/databases', headers: bearer(personal) })).statusCode,
    ).toBe(200);
    const settings = await server.app.inject({
      url: '/api/admin/oauth/settings',
      headers: server.owner.headers,
    });
    expect(settings.json<OAuthSettings>()).toMatchObject({ available: false });
    expect((await server.app.inject({ url: '/.well-known/oauth-authorization-server' })).statusCode).toBe(
      503,
    );
  } finally {
    server.config.baseUrl = origin;
  }
  const pointed = await server.app.inject({ url: '/api/v1/databases' });
  expect(pointed.statusCode).toBe(401);
  expect(pointed.headers['www-authenticate']).toBe(
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/v1"`,
  );
  const settings = await server.app.inject({
    url: '/api/admin/oauth/settings',
    headers: server.owner.headers,
  });
  expect(settings.json<OAuthSettings>()).toMatchObject({ available: true });
});

it('advertises schema writes in MCP resource metadata', async () => {
  const response = await server.app.inject({ url: '/.well-known/oauth-protected-resource/mcp' });
  expect(response.statusCode).toBe(200);
  expect(response.json<{ scopes_supported: string[] }>().scopes_supported).toContain('schema.bases:write');
});

it('names each resource in its own metadata document, and answers unknown well-known addresses with JSON 404', async () => {
  for (const path of ['api/v1', 'mcp']) {
    const response = await server.app.inject({ url: `/.well-known/oauth-protected-resource/${path}` });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ resource: string; authorization_servers: string[] }>();
    expect(document).toMatchObject({ resource: `${origin}/${path}`, authorization_servers: [origin] });
    // RFC 9728 section 3.1: the address comes from the resource, so the two must agree.
    const resource = new URL(document.resource);
    expect(`${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`).toBe(
      `${origin}/.well-known/oauth-protected-resource/${path}`,
    );
  }
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource/other',
  ]) {
    const response = await server.app.inject({ url: path });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  }
  // Every other address is still a way into the app.
  const page = await server.app.inject({ url: '/settings/connected-apps' });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
});

it('drives MCP discovery from its 401, registers, signs in with PKCE, and calls a tool through the client transport', async () => {
  await dynamic(true);
  const unauthorized = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(unauthorized.status).toBe(401);
  const challenge = unauthorized.headers.get('www-authenticate')!;
  expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`).then((response) =>
    response.json(),
  );
  expect(resource).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  let information: OAuthClientInformationMixed | undefined;
  let savedTokens: OAuthTokens | undefined;
  let verifier = '';
  let authorizationUrl: URL | undefined;
  const state = fresh();
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: {
      client_name: 'MCP transport test',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    state: () => state,
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => savedTokens,
    saveTokens: (value) => {
      savedTokens = value;
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    redirectToAuthorization: (value) => {
      authorizationUrl = value;
    },
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
  const client = new Client({ name: 'riosoma-oauth-test', version: '1.0.0' });
  try {
    await expect(client.connect(transport)).rejects.toThrow();
    expect(information?.client_id).toBeTruthy();
    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl?.searchParams.get('resource')).toBe(`${origin}/mcp`);
    const start = await fetch(authorizationUrl!, { redirect: 'manual' });
    expect(start.status).toBe(303);
    const request = new URL(start.headers.get('location')!, origin).searchParams.get('request')!;
    const consent = await fetch(`${origin}/api/oauth/consent?request=${request}`, {
      headers: server.owner.headers,
    });
    expect(consent.status).toBe(200);
    const approved = await fetch(`${origin}/api/oauth/consent`, {
      method: 'POST',
      headers: { ...server.owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ request, approve: true, databases: 'all' }),
    });
    const redirect = new URL(((await approved.json()) as { redirect: string }).redirect);
    expect(redirect.searchParams.get('state')).toBe(state);
    await transport.finishAuth(redirect.searchParams.get('code')!);
    expect(savedTokens?.access_token).toBeTruthy();
    await client.close();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }),
    );
    const result = await client.callTool({ name: 'list_databases', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toHaveProperty('databases');
  } finally {
    await client.close();
    await dynamic(false);
  }
});

it('binds codes to their registered client and rejects duplicate form parameters', async () => {
  const app = await makeApp();
  const other = await makeApp();
  const flow = await begin(app.id);
  const code = await approve(flow);
  const input = exchangeInput(app, flow, code);
  expect((await form('/oauth/token', { ...input, client_id: other.id })).json()).toEqual({
    error: 'invalid_grant',
  });
  expect((await form('/oauth/token', { ...input, resource: `${origin}/mcp` })).json()).toEqual({
    error: 'invalid_target',
  });
  const duplicate = await server.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `${new URLSearchParams(input)}&code=${encodeURIComponent(fresh())}`,
    remoteAddress: anyAddress(),
  });
  expect(duplicate.statusCode).toBe(400);
  expect((await form('/oauth/token', input)).statusCode).toBe(200);
});

it('issues refresh tokens only when a dynamic client registered the refresh grant type', async () => {
  await dynamic(true);
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress: anyAddress(),
      payload: {
        client_name: 'Short session client',
        redirect_uris: [callback],
        grant_types: ['authorization_code'],
      },
    });
    expect(response.statusCode).toBe(201);
    const flow = await begin(response.json<{ client_id: string }>().client_id, server.owner, `${origin}/mcp`);
    const code = await approve(flow);
    const exchanged = await form('/oauth/token', exchangeInput(flow.consent.app, flow, code));
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect(exchanged.json()).not.toHaveProperty('refresh_token');
  } finally {
    await dynamic(false);
  }
});

it('hands an installed app’s intercepted authorization navigation back to the server', async () => {
  const app = await makeApp();
  const flow = authorization(app.id);
  const response = await server.app.inject({
    url: `/api/oauth/authorize?${new URLSearchParams(flow.input)}`,
    remoteAddress: anyAddress(),
  });
  expect(response.statusCode, response.body).toBe(200);
  const request = response.json<{ request: string }>().request;
  const consent = await server.app.inject({
    url: `/api/oauth/consent?request=${request}`,
    headers: server.owner.headers,
  });
  expect(consent.statusCode).toBe(200);
  expect(consent.json<OAuthConsent>().app.id).toBe(app.id);
});

it('refreshes operator connections and exchanges operator codes while demo mode is on', async () => {
  const member = await server.addMember();
  const app = await makeApp();
  const tokens = await token(app);
  const flow = await begin(app.id);
  const code = await approve(flow);
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  try {
    const session = await server.app.inject('/api/auth/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const exchanged = await form('/oauth/token', exchangeInput(app, flow, code));
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    let current = tokens;
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const rotated = await form(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: app.id,
          refresh_token: current.refresh_token!,
        },
        headers,
      );
      expect(rotated.statusCode, rotated.body).toBe(200);
      current = rotated.json<OAuthTokens>();
      expect((await read(current.access_token)).statusCode).toBe(200);
    }
  } finally {
    server.config.demoMode = false;
  }
});

it('refuses reserved member OAuth codes and refresh tokens before bookkeeping', async () => {
  const member = await server.addMember();
  const app = await makeApp();
  const tokens = await token(app, member);
  const flow = await begin(app.id, member);
  const code = await approve(flow, member);
  const snapshot = async () =>
    (
      await server.pool.query(
        `SELECT table_name, md5(string_agg(row_value, '' ORDER BY row_value)) AS checksum FROM (
      SELECT 'credentials' AS table_name, row_to_json(t)::text AS row_value FROM "${server.schemas.app}".oauth_credentials t
      UNION ALL SELECT 'grants', row_to_json(t)::text FROM "${server.schemas.app}".oauth_grants t
      UNION ALL SELECT 'attempts', row_to_json(t)::text FROM "${server.schemas.app}".auth_attempts t
      UNION ALL SELECT 'audit', row_to_json(t)::text FROM "${server.schemas.audit}".events t
    ) rows GROUP BY table_name ORDER BY table_name`,
      )
    ).rows;
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  try {
    const before = await snapshot();
    for (const input of [
      exchangeInput(app, flow, code),
      {
        grant_type: 'refresh_token',
        client_id: app.id,
        refresh_token: tokens.refresh_token!,
      },
    ]) {
      const response = await form('/oauth/token', input);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { messageKey: 'demo.readOnly' } });
    }
    expect(await snapshot()).toEqual(before);
  } finally {
    server.config.demoMode = false;
  }
});

it('requires the operator code proof before bypassing a demo cookie or recording attempts', async () => {
  const member = await server.addMember();
  const app = await makeApp();
  const flow = await begin(app.id);
  const code = await approve(flow);
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  try {
    const session = await server.app.inject('/api/auth/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const snapshot = async () =>
      (await server.pool.query(`SELECT key, at FROM "${server.schemas.app}".auth_attempts ORDER BY key, at`))
        .rows;
    const before = await snapshot();
    const response = await form(
      '/oauth/token',
      {
        ...exchangeInput(app, flow, code),
        code_verifier: fresh(),
      },
      { cookie },
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { messageKey: 'demo.readOnly' } });
    expect(await snapshot()).toEqual(before);
  } finally {
    server.config.demoMode = false;
  }
});

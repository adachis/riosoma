import { createHash, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  newId,
  type ConnectionsView,
  type IntegrationView,
  type NotificationChannelPreferences,
  type NotificationCommandResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { credential } from '../data/notifications.js';
import { deliverChannels } from '../notifications/channel-delivery.js';
import {
  startFakeMicrosoft,
  type FakeMicrosoft,
  type FakeMicrosoftDelegation,
} from '../test/fake-microsoft.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

const provider = 'microsoft-teams';
const base = 'https://riosoma.example.test';
const next = '/settings/notifications#organization';
const account = { name: 'Teams Sender', email: 'sender@example.test' };
const delegation: FakeMicrosoftDelegation = {
  tenant: randomUUID(),
  account: { id: 'microsoft-sender', ...account },
  messages: [],
};
const realFetch = globalThis.fetch;
const request: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== 'login.microsoftonline.com' && url.hostname !== 'graph.microsoft.com')
    throw new Error(`Unexpected request to ${url.hostname}`);
  return realFetch(new URL(url.pathname + url.search, fake.url), init);
};

let kit: TestPostgres;
let fake: FakeMicrosoft;
let server: ServerFixture;
let client: { tenantId: string; clientId: string; clientSecret: string };

beforeAll(async () => {
  kit = await startTestPostgres();
  fake = await startFakeMicrosoft(delegation);
  client = { tenantId: fake.tenant, clientId: fake.clientId, clientSecret: fake.secret };
  server = await startServer(kit, 'teams_oauth', {
    baseUrl: base,
    oauthApps: { [provider]: client, 'microsoft-calendar': client },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await fake?.close();
  await kit?.stop();
});

function location(response: LightMyRequestResponse): URL {
  expect(response.statusCode, response.body).toBe(302);
  return new URL(String(response.headers.location), base);
}

async function start(person = server.owner, id = provider) {
  return location(
    await server.app.inject({
      url: `/api/oauth/start/${id}?${new URLSearchParams({ next })}`,
      headers: person.headers,
    }),
  );
}

async function finish(authorize: URL, person = server.owner, code = 'approved') {
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code }).toString();
  return location(await server.app.inject({ url: callback.href, headers: person.headers }));
}

async function command(person: SignedIn, input: object) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/notifications/commands',
    headers: person.headers,
    payload: { id: newId('command'), ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<NotificationCommandResult>();
  expect(result.status, response.body).toBe('applied');
}

async function setIntegrationsRole(person: SignedIn, grant: boolean) {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${grant ? ['integrations'] : []}::text[]
    WHERE user_id = ${person.userId}`,
  );
}

async function channelSettings(person = server.owner) {
  const response = await server.app.inject({ url: '/api/notifications/channels', headers: person.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationChannelPreferences>();
}

const stored = () =>
  credential(server.pool, server.schemas, server.config.secretKey, server.owner.info.org.id, 'teams');

it('uses the configured tenant for Microsoft Calendar authorization and code exchange', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  const authorize = await start(server.owner, 'microsoft-calendar');
  expect(authorize.origin).toBe('https://login.microsoftonline.com');
  expect(authorize.pathname).toBe(`/${fake.tenant}/oauth2/v2.0/authorize`);
  expect((await finish(authorize)).searchParams.get('connected')).toBe('microsoft-calendar');
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://login.microsoftonline.com/${fake.tenant}/oauth2/v2.0/token`);
});

it('requires a tenant in Integrations and keeps Teams outside personal connections', async () => {
  const previous = server.config.oauthApps![provider];
  delete server.config.oauthApps![provider];
  try {
    const response = await server.app.inject({
      url: '/api/admin/integrations',
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<IntegrationView[]>().find((entry) => entry.provider === provider)).toMatchObject({
      configured: false,
      redirectUri: `${base}/api/oauth/callback/${provider}`,
    });
    const put = (payload: object) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/admin/integrations/${provider}`,
        headers: server.owner.headers,
        payload,
      });
    const incomplete = await put({ clientId: client.clientId, clientSecret: client.clientSecret });
    expect(incomplete.statusCode, incomplete.body).toBe(422);
    expect(incomplete.json().error.messageKey).toBe('drives.incompleteApp');
    expect((await start()).searchParams.get('connectError')).toBe('drives.unavailable');
    expect((await channelSettings()).teamsSignInAvailable).toBe(false);
    const configured = await put(client);
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({ configured: true, fromEnvironment: false });
    expect(configured.body).not.toContain(client.clientSecret);
    expect((await start()).searchParams.get('client_id')).toBe(client.clientId);
    expect((await channelSettings()).teamsSignInAvailable).toBe(true);
    const connections = await server.app.inject({ url: '/api/connections', headers: server.owner.headers });
    expect(connections.statusCode, connections.body).toBe(200);
    expect(connections.json<ConnectionsView>().providers.map((entry) => entry.provider)).not.toContain(
      provider,
    );
  } finally {
    server.config.oauthApps![provider] = previous;
  }
});

it('seals the organization grant, records audit and undo, delivers, and keeps the sender on rotation', async () => {
  const admin = await server.addMember();
  await setIntegrationsRole(admin, true);
  const previous = { channel: 'teams', ...client, refreshToken: randomUUID() };
  await command(server.owner, { kind: 'notifications.connection', connection: previous });

  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  const authorize = await start(admin);
  expect(authorize.origin).toBe('https://login.microsoftonline.com');
  expect(authorize.pathname).toBe(`/${fake.tenant}/oauth2/v2.0/authorize`);
  expect(authorize.searchParams.get('scope')).toBe(
    'offline_access User.Read User.ReadBasic.All Chat.Create ChatMessage.Send',
  );
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const landed = await finish(authorize, admin);
  expect(landed.pathname + landed.hash).toBe(next);
  expect(landed.searchParams.get('connected')).toBe(provider);
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://login.microsoftonline.com/${fake.tenant}/oauth2/v2.0/token`);
  const verifier = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get('code_verifier')!;
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
    authorize.searchParams.get('code_challenge'),
  );

  const refreshToken = delegation.refreshToken!;
  expect(refreshToken).toBeTruthy();
  expect(await stored()).toEqual({ channel: 'teams', ...client, refreshToken, account });
  const sealed = await query<{ sealed: string }>(
    server.pool,
    sql`SELECT sealed FROM ${ident(server.schemas.app, 'notification_credentials')} WHERE name = 'teams'`,
  );
  expect(sealed.rows).toHaveLength(1);
  for (const value of [client.clientSecret, refreshToken, account.email])
    expect(sealed.rows[0]!.sealed).not.toContain(value);
  const audit = await query(
    server.pool,
    sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}
    WHERE actor_id = ${admin.userId} AND action = 'notifications.connection'`,
  );
  expect(audit.rows).toHaveLength(1);
  const personal = await query(
    server.pool,
    sql`SELECT 1 FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE provider = ${provider}`,
  );
  expect(personal.rows).toEqual([]);

  const recipient = await server.addMember();
  for (const person of [admin, recipient]) {
    const response = await server.app.inject({ url: '/api/notifications/channels', headers: person.headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(refreshToken);
    expect(response.json().teamsAccount).toEqual(person === admin ? account : undefined);
  }
  await command(recipient, {
    kind: 'notifications.preferences',
    update: { channels: { teams: { feedbackReply: true } } },
  });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'notifications')}(id, org_id, recipient_id, kind, subject_id, target, email)
    VALUES (${newId('notification')}, ${recipient.info.org.id}, ${recipient.userId}, 'feedbackReply', ${randomUUID()}, '{"excerpt":"Reply"}'::jsonb, 'pending')`,
  );
  const undo = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'notification_actions')} WHERE user_id = ${admin.userId}`,
  );
  expect(undo.rows).toHaveLength(1);
  expect(landed.searchParams.get('connectionAction')).toBe(undo.rows[0]!.id);
  await command(admin, { kind: 'notifications.undo', actionId: undo.rows[0]!.id });
  expect(await stored()).toEqual(previous);

  expect((await finish(await start(admin), admin)).searchParams.get('connected')).toBe(provider);
  const beforeRotation = delegation.refreshToken;
  await deliverChannels(server.app, request);
  expect(delegation.messages).toHaveLength(1);
  expect(delegation.refreshToken).not.toBe(beforeRotation);
  expect(await stored()).toEqual({
    channel: 'teams',
    ...client,
    refreshToken: delegation.refreshToken,
    account,
  });
  await command(server.owner, { kind: 'notifications.disconnect', channel: 'teams' });
});

it('refuses members at start and checks the current Integrations grant at callback', async () => {
  const admin = await server.addMember();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  expect((await start(admin)).searchParams.get('connectError')).toBe('drives.connect.denied');
  await setIntegrationsRole(admin, true);
  const authorize = await start(admin);
  await setIntegrationsRole(admin, false);
  expect((await finish(authorize, admin)).searchParams.get('connectError')).toBe('drives.connect.denied');
  expect(fetch).not.toHaveBeenCalled();
  expect(await stored()).toBeNull();

  await setIntegrationsRole(admin, true);
  const inFlight = await start(admin);
  fetch.mockImplementationOnce(async (input, init) => {
    await setIntegrationsRole(admin, false);
    return request(input, init);
  });
  expect((await finish(inFlight, admin)).searchParams.get('connectError')).toBe('drives.connect.denied');
  expect(await stored()).toBeNull();
});

it('fails without a refresh token and consumes the state', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  const authorize = await start();
  expect((await finish(authorize, server.owner, 'without-refresh')).searchParams.get('connectError')).toBe(
    'drives.connect.failed',
  );
  expect((await finish(authorize)).searchParams.get('connectError')).toBe('drives.connect.state');
  expect(await stored()).toBeNull();
});

it('refuses expired state and a different session for the same account', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  const expired = await start();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'oauth_flows')} SET expires_at = now() - interval '1 second'
    WHERE state_hash = ${createHash('sha256').update(expired.searchParams.get('state')!).digest('hex')}`,
  );
  expect((await finish(expired)).searchParams.get('connectError')).toBe('drives.connect.state');

  const authorize = await start();
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    payload: { email: server.owner.email, password: 'a long test password' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0]! : String(header)).split(';')[0]!;
  expect(
    (
      await finish(authorize, { ...server.owner, headers: { ...server.owner.headers, cookie } })
    ).searchParams.get('connectError'),
  ).toBe('drives.connect.state');
  expect(fetch).not.toHaveBeenCalled();
  expect(await stored()).toBeNull();
});

it('trims and bounds the Teams sender from Microsoft Graph', async () => {
  const previous = delegation.account;
  const name = 'n'.repeat(256);
  const email = 'e'.repeat(320);
  delegation.account = { ...previous, name: `  ${name}extra  `, email: `  ${email}extra  ` };
  vi.spyOn(globalThis, 'fetch').mockImplementation(request);
  try {
    expect((await finish(await start())).searchParams.get('connected')).toBe(provider);
    expect((await channelSettings()).teamsAccount).toEqual({ name, email });
  } finally {
    delegation.account = previous;
    await command(server.owner, { kind: 'notifications.disconnect', channel: 'teams' });
  }
});

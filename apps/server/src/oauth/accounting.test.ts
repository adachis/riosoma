import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsView, type ConnectedProvider } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { APP_PRESETS, createAppConnector } from '@riosoma/connectors';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { appConnectionContext, ownAppConnection } from '../sources/app-connections.js';
import { restConnectorOptions } from '../sources/rest.js';
import { driveAccess } from './connections.js';
import type { Actor } from '../http/policy.js';
import { registerOAuthProvider } from './providers.js';
import { xero } from './xero.js';
import { quickbooks } from './quickbooks.js';

let listener: Server;
let origin: string;
let kit: TestPostgres;
let server: ServerFixture;
let organizations = 1;
let refused = false;
let sandbox = false;
let basicValid = true;
let refusedOrganization = '';
const clientId = 'accounting-client';
const secret = randomBytes(24).toString('hex');
const refresh = new Set<string>();
const issued = new Set<string>();
const realFetch = globalThis.fetch;
const base = 'https://riosoma.example.test';

beforeAll(async () => {
  listener = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/token') {
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const input = new URLSearchParams(text);
      const valid =
        req.headers.authorization === `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` &&
        !input.has('client_secret') &&
        !input.has('client_id');
      basicValid &&= valid;
      if (!valid) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      const renewal = input.get('refresh_token');
      if (
        refused ||
        input.get('code')?.startsWith('riosoma-test-') ||
        (input.get('grant_type') === 'refresh_token' && !refresh.delete(renewal ?? ''))
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const access = randomBytes(24).toString('hex');
      const next = randomBytes(24).toString('hex');
      issued.add(access);
      issued.add(next);
      refresh.add(next);
      res.end(JSON.stringify({ access_token: access, refresh_token: next, expires_in: 60 }));
      return;
    }
    if (url.pathname === '/connections') {
      res.end(
        JSON.stringify([
          ...Array.from({ length: organizations }, (_, i) => ({
            tenantId: `organization-${i + 1}`,
            tenantName: `Company ${i + 1}`,
            tenantType: 'ORGANISATION',
          })),
          { tenantId: 'personal', tenantName: 'Personal', tenantType: 'PERSONAL' },
        ]),
      );
      return;
    }
    if (url.pathname.startsWith('/api.xro/2.0/')) {
      if (req.headers['xero-tenant-id'] === refusedOrganization) {
        res.writeHead(403);
        res.end('{}');
      } else res.end(JSON.stringify({ [url.pathname.split('/').at(-1)!]: [] }));
      return;
    }
    if (sandbox && req.headers['x-identity-host'] === 'accounts.platform.intuit.com') {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        sub: 'accounting-person',
        givenName: 'Example',
        familyName: 'Person',
        email: 'person@example.test',
      }),
    );
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  kit = await startTestPostgres();
  server = await startServer(kit, 'accounting_accounts', {
    baseUrl: base,
    automationsAllowPrivateHosts: true,
    oauthApps: { xero: { clientId, clientSecret: secret }, quickbooks: { clientId, clientSecret: secret } },
  });
  for (const provider of [xero, quickbooks])
    registerOAuthProvider({ ...provider, tokenUrl: `${origin}/token` });
}, 90_000);
beforeEach(() => {
  organizations = 1;
  refused = false;
  sandbox = false;
  basicValid = true;
  refusedOrganization = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input));
    if (url.host === 'api.xero.com' || url.host.endsWith('accounts.platform.intuit.com'))
      return realFetch(`${origin}${url.pathname}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-identity-host': url.host },
      });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  await kit?.stop();
  listener?.closeAllConnections();
  if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
});

function actor(): Actor {
  return {
    orgId: server.owner.info.org.id,
    userId: server.owner.userId,
    sessionId: '',
    kind: 'owner',
    adminRoles: [],
    csrfToken: server.owner.info.csrfToken,
  };
}
async function connect(provider: ConnectedProvider, company: string | null = 'company/one') {
  const start = await server.app.inject({
    url: `/api/oauth/start/${provider}`,
    headers: server.owner.headers,
  });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  expect(authorize.origin + authorize.pathname).toBe(
    provider === 'xero' ? xero.authorizeUrl : quickbooks.authorizeUrl,
  );
  expect(authorize.searchParams.get('scope')).toBe(provider === 'xero' ? xero.scope : quickbooks.scope);
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  callback.searchParams.set('code', 'accounting-code');
  if (provider === 'quickbooks' && company !== null) callback.searchParams.set('realmId', company);
  return server.app.inject({ url: callback.pathname + callback.search, headers: server.owner.headers });
}
async function account(provider: ConnectedProvider) {
  const response = await server.app.inject({ url: '/api/connections', headers: server.owner.headers });
  expect([...issued, secret].some((value) => response.body.includes(value))).toBe(false);
  return ConnectionsView.parse(response.json()).providers.find((entry) => entry.provider === provider)!
    .account!;
}

for (const provider of ['xero', 'quickbooks'] as const)
  describe(`${provider} connected accounts`, () => {
    it('accepts valid admin credentials using the required client authentication', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/admin/integrations/${provider}/test`,
        headers: server.owner.headers,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, messageKey: 'drives.test.ok' });
      expect(basicValid).toBe(true);
    });

    it('connects and preserves rotating credentials through successive runs', async () => {
      const response = await connect(provider);
      expect(new URL(String(response.headers.location), base).searchParams.get('connected')).toBe(provider);
      const connected = await account(provider);
      expect(connected.id).toBeTruthy();
      const first = await driveAccess(server.ctx, actor(), provider, connected.id);
      const second = await driveAccess(server.ctx, actor(), provider, connected.id);
      expect(first.accessToken === second.accessToken).toBe(false);
      expect(basicValid).toBe(true);
      if (provider === 'quickbooks') expect(second.accountValues).toEqual({ realmId: 'company/one' });
      else expect(second.settingChoices?.tenantId).toEqual([{ value: 'organization-1', label: 'Company 1' }]);
      const context = await appConnectionContext(server.ctx, server.owner.info.org.id, {
        connection: {
          kind: 'app',
          app: provider,
          settings: {
            connectionId: connected.id!,
            ...(provider === 'xero' ? { tenantId: 'organization-1' } : {}),
          },
        },
        secrets: {},
      });
      expect(typeof context.secrets.token).toBe('string');
      if (provider === 'quickbooks') expect(context.accountValues).toEqual({ realmId: 'company/one' });
    });
    it('marks a refused grant for reconnection and keeps credentials out of responses', async () => {
      await connect(provider);
      const connected = await account(provider);
      refused = true;
      await expect(driveAccess(server.ctx, actor(), provider, connected.id)).rejects.toMatchObject({
        messageKey: 'drives.reconnect',
      });
      expect((await account(provider)).needsReconnect).toBe(true);
    });
  });

describe('accounting account values', () => {
  it('preserves the connected account when a Xero organization refuses a source test', async () => {
    organizations = 2;
    await connect('xero');
    const connected = await account('xero');
    const preset = APP_PRESETS.find((entry) => entry.catalog.id === 'xero')!;
    const connector = createAppConnector(
      restConnectorOptions(server.config, async () => [{ address: '127.0.0.1', family: 4 }]),
      [
        {
          ...preset,
          target: {
            ...preset.target,
            address: `${origin.replace('127.0.0.1', 'localhost')}/api.xro/2.0`,
            requestsPerSecond: 100,
          },
        },
      ],
    );
    const context = (tenantId: string) =>
      appConnectionContext(server.ctx, server.owner.info.org.id, {
        connection: {
          kind: 'app',
          app: 'xero',
          settings: { connectionId: connected.id!, tenantId },
        },
        secrets: {},
      });
    expect((await connector.test(await context('organization-1'))).ok).toBe(true);
    refusedOrganization = 'organization-2';
    const result = await connector.test(await context(refusedOrganization));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.objectNotAllowed');
    expect((await account('xero')).needsReconnect).toBe(false);
    expect((await connector.test(await context('organization-1'))).ok).toBe(true);
  });

  it.each([1, 3])('offers exactly %i Xero organizations and validates the saved selection', async (count) => {
    organizations = count;
    await connect('xero');
    const connected = await account('xero');
    expect(connected.settingChoices?.tenantId).toEqual(
      Array.from({ length: count }, (_, i) => ({
        value: `organization-${i + 1}`,
        label: `Company ${i + 1}`,
      })),
    );
    const draft = {
      kind: 'app' as const,
      app: 'xero',
      settings: { connectionId: connected.id!, tenantId: `organization-${count}` },
    };
    expect(await ownAppConnection(server.ctx, actor(), draft)).toMatchObject(draft);
    await expect(
      ownAppConnection(server.ctx, actor(), {
        ...draft,
        settings: { ...draft.settings, tenantId: 'personal' },
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.app.settingInvalid' });
  });
  it('finds sandbox identities after production refuses the account', async () => {
    sandbox = true;
    await connect('quickbooks');
    expect(await account('quickbooks')).toMatchObject({
      name: 'Example Person',
      email: 'person@example.test',
    });
  });
  it('requires a company in the QuickBooks callback', async () => {
    const response = await connect('quickbooks', null);
    expect(new URL(String(response.headers.location), base).searchParams.get('connectError')).toBe(
      'drives.connect.failed',
    );
  });
  it('replaces the connection when the same person chooses another QuickBooks company', async () => {
    await connect('quickbooks', 'first-company');
    const first = await account('quickbooks');
    await connect('quickbooks', 'second-company');
    const second = await account('quickbooks');
    expect(first.id === second.id).toBe(false);
    await expect(
      appConnectionContext(server.ctx, server.owner.info.org.id, {
        connection: { kind: 'app', app: 'quickbooks', settings: { connectionId: first.id! } },
        secrets: {},
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.app.reconnect' });
  });
  it('does not add a database migration for organization choices', async () => {
    await connect('xero');
    const rows = await query<{ sealed_tokens: string }>(
      server.pool,
      sql`SELECT sealed_tokens FROM ${ident(server.schemas.app, 'oauth_connections')} WHERE provider = 'xero'`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.sealed_tokens.includes('organization-1')).toBe(false);
  });
});

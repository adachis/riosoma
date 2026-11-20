import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SsoProvider, SsoTestResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import {
  routeFetch,
  routeProviderRequests,
  startTestProvider,
  type TestProvider,
} from '../../test/oidc-provider.js';

const BASE = 'https://riosoma.example.test';
const realFetch = globalThis.fetch;
let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function setup() {
  const server = await startServer(kit, 'ssoadmin', { baseUrl: `${BASE}/` });
  cleanups.push(() => server.close());
  const idp = await startTestProvider({ path: '/realms/acme' });
  cleanups.push(() => idp.close());
  const microsoft = await startTestProvider({
    origin: 'https://login.microsoftonline.com',
    microsoftTenant: '11111111-2222-3333-4444-555555555555',
    advertisePkce: false,
  });
  cleanups.push(() => microsoft.close());
  routeProviderRequests([idp, microsoft]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch([idp, microsoft], realFetch));
  return { server, idp, microsoft };
}

function call(
  server: ServerFixture,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  who: SignedIn | null = server.owner,
) {
  return server.app.inject({
    method,
    url,
    headers: who ? who.headers : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function create(server: ServerFixture, idp: TestProvider, overrides: Record<string, unknown> = {}) {
  return call(server, 'POST', '/api/admin/sso', {
    kind: 'oidc',
    name: 'Acme',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    ...overrides,
  });
}

function fieldsOf(response: LightMyRequestResponse): Record<string, string> | undefined {
  return response.json<{ error: { fields?: Record<string, string> } }>().error.fields;
}

describe('single sign-on administration', () => {
  it('fills in the issuers Riosoma knows and never returns a secret', async () => {
    const { server, idp } = await setup();
    const google = await create(server, idp, { kind: 'google', name: 'Google', issuer: 'https://evil.test' });
    expect(google.statusCode).toBe(200);
    expect(google.headers['cache-control']).toBe('no-store');
    const created = google.json<SsoProvider>();
    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9A-Za-z]{16}$/),
      kind: 'google',
      name: 'Google',
      issuer: 'https://accounts.google.com',
      tenant: null,
      clientId: idp.clientId,
      hasSecret: true,
      allowedDomains: [],
      autoCreate: false,
      linkByEmail: true,
      enabled: true,
      redirectUri: `${BASE}/api/auth/sso/callback`,
      createdAt: expect.any(String),
      identities: 0,
    });

    const anyAccount = await create(server, idp, { kind: 'microsoft', name: 'Microsoft', tenant: ' ' });
    expect(anyAccount.json<SsoProvider>()).toMatchObject({
      issuer: 'https://login.microsoftonline.com/organizations/v2.0',
      tenant: null,
    });
    const oneTenant = await create(server, idp, {
      kind: 'microsoft',
      name: 'Contoso',
      tenant: 'contoso.onmicrosoft.com',
    });
    expect(oneTenant.json<SsoProvider>()).toMatchObject({
      issuer: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
      tenant: 'contoso.onmicrosoft.com',
    });
    const generic = await create(server, idp, {
      allowedDomains: ['Example.org', 'example.org', 'acme.test'],
      autoCreate: true,
      linkByEmail: false,
      enabled: false,
    });
    expect(generic.json<SsoProvider>()).toMatchObject({
      kind: 'oidc',
      issuer: idp.issuer,
      tenant: null,
      allowedDomains: ['example.org', 'acme.test'],
      autoCreate: true,
      linkByEmail: false,
      enabled: false,
    });

    const listed = await call(server, 'GET', '/api/admin/sso');
    expect(listed.json<SsoProvider[]>().map((provider) => provider.name)).toEqual([
      'Google',
      'Microsoft',
      'Contoso',
      'Acme',
    ]);
    const edited = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      name: 'Google Workspace',
      clientSecret: 'a replacement secret',
      enabled: false,
    });
    expect(edited.json<SsoProvider>()).toMatchObject({
      name: 'Google Workspace',
      enabled: false,
      hasSecret: true,
    });

    for (const response of [google, anyAccount, oneTenant, generic, listed, edited]) {
      expect(response.body).not.toContain(idp.clientSecret);
      expect(response.body).not.toContain('a replacement secret');
      expect(response.body).not.toContain('rio1.');
      expect(response.body).not.toContain('rio2.');
      expect(response.body).not.toContain('riov.');
    }
    const stored = await query<{ sealed_secret: string }>(
      server.pool,
      sql`SELECT sealed_secret FROM ${ident(server.schemas.app, 'sso_providers')}`,
    );
    for (const row of stored.rows) {
      expect(row.sealed_secret).toMatch(/^rio2\./);
      expect(row.sealed_secret).not.toContain(idp.clientSecret);
    }
  });

  it('is for owners and admins with the Security role', async () => {
    const { server, idp } = await setup();
    const created = (await create(server, idp)).json<SsoProvider>();
    const member = await server.addMember();
    const routes = [
      ['GET', '/api/admin/sso', undefined],
      ['POST', '/api/admin/sso', { kind: 'google', name: 'Google', clientId: 'id', clientSecret: 'secret' }],
      ['PATCH', `/api/admin/sso/${created.id}`, { name: 'Renamed' }],
      ['POST', '/api/admin/sso/test', { issuer: idp.issuer }],
      ['DELETE', `/api/admin/sso/${created.id}`, undefined],
    ] as const;
    const roles = ident(server.schemas.app, 'memberships');
    for (const adminRoles of [[], ['people'], ['data_sources', 'ai']]) {
      await query(
        server.pool,
        sql`UPDATE ${roles} SET admin_roles = ${adminRoles}::text[] WHERE user_id = ${member.userId}`,
      );
      for (const [method, url, payload] of routes) {
        const response = await call(server, method, url, payload, member);
        expect(response.statusCode, `${method} ${url} with ${adminRoles.join()}`).toBe(403);
        expect(response.json().error.messageKey).toBe('errors.adminOnly');
      }
    }
    for (const [method, url, payload] of routes) {
      expect((await call(server, method, url, payload, null)).statusCode).toBe(401);
    }
    await query(
      server.pool,
      sql`UPDATE ${roles} SET admin_roles = ARRAY['security'] WHERE user_id = ${member.userId}`,
    );
    for (const [method, url, payload] of routes) {
      const response = await call(server, method, url, payload, member);
      // Adding a provider decides who vouches for the organization's people, which is the owner's.
      if (method === 'POST' && url === '/api/admin/sso') {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.messageKey).toBe('sso.ownerOnly');
      } else expect(response.statusCode, `${method} ${url}`).toBeLessThan(300);
    }
    // State-changing requests still need the session's CSRF token.
    const forged = await server.app.inject({
      method: 'POST',
      url: '/api/admin/sso',
      headers: { cookie: member.headers.cookie },
      payload: { kind: 'google', name: 'Google', clientId: 'id', clientSecret: 'secret' },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.messageKey).toBe('errors.csrfMismatch');
  });

  it('leaves what a provider trusts to the owner', async () => {
    const { server, idp } = await setup();
    const created = (await create(server, idp, { linkByEmail: false })).json<SsoProvider>();
    const entra = (
      await create(server, idp, { kind: 'microsoft', name: 'Microsoft', tenant: 'contoso.onmicrosoft.com' })
    ).json<SsoProvider>();
    const admin = await server.addMember();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['security'] WHERE user_id = ${admin.userId}`,
    );
    const url = `/api/admin/sso/${created.id}`;
    const secret = ['a', 'replacement', 'secret'].join(' ');
    const stored = async () =>
      (
        await query(
          server.pool,
          sql`SELECT issuer, tenant, client_id, sealed_secret, link_by_email FROM ${ident(server.schemas.app, 'sso_providers')} ORDER BY id`,
        )
      ).rows;
    const before = await stored();
    // An issuer, tenant, or client of their own, or linking by email, would let them vouch for anyone.
    for (const [target, payload] of [
      [url, { issuer: 'https://elsewhere.example.test', clientSecret: secret }],
      [url, { clientId: 'another-client' }],
      [url, { clientSecret: secret }],
      [url, { linkByEmail: true }],
      [`/api/admin/sso/${entra.id}`, { tenant: 'fabrikam.onmicrosoft.com' }],
    ] as const) {
      const refused = await call(server, 'PATCH', target, payload, admin);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(403);
      expect(refused.json().error.messageKey).toBe('sso.ownerOnly');
    }
    expect(await stored()).toEqual(before);
    // The rest stays with the Security role, and so does a form that sends back what is stored.
    const kept = await call(
      server,
      'PATCH',
      url,
      {
        name: 'Renamed',
        issuer: idp.issuer,
        clientId: idp.clientId,
        linkByEmail: false,
        allowedDomains: ['example.test'],
        autoCreate: true,
        enabled: false,
      },
      admin,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json<SsoProvider>()).toMatchObject({
      name: 'Renamed',
      allowedDomains: ['example.test'],
      autoCreate: true,
      enabled: false,
    });
    expect(
      (await call(server, 'PATCH', url, { linkByEmail: true, clientId: 'another-client' })).statusCode,
    ).toBe(200);
    // Turning linking off only narrows what the provider reaches.
    const narrowed = await call(server, 'PATCH', url, { linkByEmail: false }, admin);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json<SsoProvider>().linkByEmail).toBe(false);
  });

  it('checks issuers and tenants', async () => {
    const { server, idp } = await setup();
    const missing = await create(server, idp, { issuer: undefined });
    expect(missing.statusCode).toBe(422);
    expect(fieldsOf(missing)).toEqual({ issuer: 'validation.invalid_type' });
    const plain = await create(server, idp, { issuer: 'http://idp.example.test' });
    expect(fieldsOf(plain)).toEqual({ issuer: 'sso.test.https' });
    for (const issuer of ['https://idp.example.test/?realm=x', 'https://user:pass@idp.example.test']) {
      const response = await create(server, idp, { issuer });
      expect(fieldsOf(response), issuer).toEqual({ issuer: 'validation.invalid_format' });
    }
    const tenant = await create(server, idp, { kind: 'microsoft', tenant: '../../evil' });
    expect(fieldsOf(tenant)).toEqual({ tenant: 'validation.invalid_format' });
    const domain = await create(server, idp, { allowedDomains: ['not a domain'] });
    expect(fieldsOf(domain)).toEqual({ 'allowedDomains.0': 'validation.invalid_format' });

    const microsoft = (
      await create(server, idp, { kind: 'microsoft', tenant: 'contoso.com' })
    ).json<SsoProvider>();
    const retenanted = await call(server, 'PATCH', `/api/admin/sso/${microsoft.id}`, { tenant: '' });
    expect(retenanted.json<SsoProvider>()).toMatchObject({
      issuer: 'https://login.microsoftonline.com/organizations/v2.0',
      tenant: null,
    });
    const unknown = await call(server, 'PATCH', '/api/admin/sso/AAAAAAAAAAAAAAAA', { name: 'Nobody' });
    expect(unknown.statusCode).toBe(404);
  });

  it('asks for the secret again before sending it to a new issuer', async () => {
    const { server, idp } = await setup();
    const created = (await create(server, idp)).json<SsoProvider>();
    const moved = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      issuer: 'https://collector.example.test',
    });
    expect(moved.statusCode).toBe(422);
    expect(fieldsOf(moved)).toEqual({ clientSecret: 'sso.secret.reenter' });
    const withSecret = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      issuer: 'https://collector.example.test',
      clientSecret: 'the secret for the new issuer',
    });
    expect(withSecret.json<SsoProvider>().issuer).toBe('https://collector.example.test');
    // The same issuer, or any other change, keeps the stored secret.
    const renamed = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      issuer: 'https://collector.example.test',
      name: 'Collector',
    });
    expect(renamed.statusCode).toBe(200);
  });

  it('deletes a provider with the identities that used it', async () => {
    const { server, idp } = await setup();
    const kept = (await create(server, idp, { name: 'Kept' })).json<SsoProvider>();
    const doomed = (await create(server, idp, { name: 'Doomed' })).json<SsoProvider>();
    const identities = ident(server.schemas.app, 'sso_identities');
    await query(
      server.pool,
      sql`INSERT INTO ${identities} (issuer, subject, user_id, provider_id)
      VALUES (${idp.issuer}, 'one', ${server.owner.userId}, ${doomed.id}),
        (${idp.issuer}, 'two', ${server.owner.userId}, ${kept.id})`,
    );
    const listed = (await call(server, 'GET', '/api/admin/sso')).json<SsoProvider[]>();
    expect(listed.map((provider) => provider.identities)).toEqual([1, 1]);
    const deleted = await call(server, 'DELETE', `/api/admin/sso/${doomed.id}`);
    expect(deleted.statusCode).toBe(204);
    const left = await query<{ subject: string }>(server.pool, sql`SELECT subject FROM ${identities}`);
    expect(left.rows).toEqual([{ subject: 'two' }]);
    expect((await call(server, 'DELETE', `/api/admin/sso/${doomed.id}`)).statusCode).toBe(404);
    expect((await call(server, 'GET', '/api/admin/sso')).json<SsoProvider[]>().map((p) => p.name)).toEqual([
      'Kept',
    ]);
  });

  it('tests an issuer’s discovery document', async () => {
    const { server, idp, microsoft } = await setup();
    const test = async (issuer: string) =>
      (await call(server, 'POST', '/api/admin/sso/test', { issuer })).json<SsoTestResult>();
    expect(await test(idp.issuer)).toEqual({
      ok: true,
      discovered: { issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize`, pkce: true },
    });
    // Microsoft's multi-tenant document names a template issuer and doesn't list PKCE.
    expect(await test(microsoft.issuer)).toEqual({
      ok: true,
      discovered: {
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        authorizationEndpoint: `${microsoft.issuer}/authorize`,
        pkce: false,
      },
    });
    expect(await test(`${idp.issuer}/`)).toEqual({
      ok: false,
      messageKey: 'sso.test.issuer',
      discovered: { issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize`, pkce: true },
    });
    expect(await test(`${idp.origin}/realms/missing`)).toEqual({ ok: false, messageKey: 'sso.test.invalid' });
    expect(await test('http://idp.example.test')).toEqual({ ok: false, messageKey: 'sso.test.https' });
    expect(await test('https://127.0.0.1:1')).toEqual({ ok: false, messageKey: 'sso.test.unreachable' });
    const invalid = await call(server, 'POST', '/api/admin/sso/test', { issuer: 'not a url' });
    expect(invalid.statusCode).toBe(422);
  });
});

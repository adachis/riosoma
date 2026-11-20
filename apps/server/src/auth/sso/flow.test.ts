import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type SessionInfo, type SsoButton, type SsoProvider } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import {
  routeFetch,
  routeProviderRequests,
  startTestProvider,
  type ProviderOptions,
  type Tampering,
  type TestProvider,
} from '../../test/oidc-provider.js';
import { attemptKey } from '../attempts.js';
import { safeNext } from './flow.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { fakeVault } from '../../credentials/http.test-support.js';
import { VaultProfile } from '../../credentials/settings.js';

const BASE = 'https://riosoma.example.test';
const CALLBACK = `${BASE}/api/auth/sso/callback`;
const PASSWORD = 'a long test password';
const TENANT = '11111111-2222-3333-4444-555555555555';
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

async function setup(
  options: ProviderOptions = { path: '/realms/acme' },
  overrides: Parameters<typeof startServer>[2] = {},
) {
  const idp = await startTestProvider(options);
  cleanups.push(() => idp.close());
  routeProviderRequests([idp]);
  const server = await startServer(kit, 'ssoflow', { baseUrl: `${BASE}/`, ...overrides });
  cleanups.push(() => server.close());
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch([idp], realFetch));
  return { server, idp };
}

async function addProvider(
  server: ServerFixture,
  idp: TestProvider,
  overrides: Record<string, unknown> = {},
): Promise<SsoProvider> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/sso',
    headers: server.owner.headers,
    payload: {
      kind: 'oidc',
      name: 'Acme',
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<SsoProvider>();
}

function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookieHeader(response: LightMyRequestResponse, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

async function begin(server: ServerFixture, provider: SsoProvider, next?: string) {
  const response = await server.app.inject({
    url: `/api/auth/sso/${provider.id}/start${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`,
  });
  expect(response.statusCode).toBe(302);
  const location = new URL(String(response.headers.location), BASE);
  const cookie = cookieHeader(response, 'rio_sso')?.split(';')[0] ?? '';
  return { response, location, cookie };
}

function finish(server: ServerFixture, callback: URL, cookie: string, remoteAddress = '127.0.0.1') {
  return server.app.inject({
    url: `${callback.pathname}${callback.search}`,
    headers: cookie ? { cookie } : {},
    remoteAddress,
  });
}

async function signInThrough(server: ServerFixture, idp: TestProvider, provider: SsoProvider, next?: string) {
  const { location, cookie } = await begin(server, provider, next);
  return finish(server, await idp.authorize(location.href), cookie);
}

/** The message key a refused sign-in carries back to the sign-in page. */
function failureOf(response: LightMyRequestResponse): string | null {
  expect(response.statusCode).toBe(302);
  const location = new URL(String(response.headers.location), BASE);
  expect(location.pathname).toBe('/sign-in');
  expect(cookieHeader(response, 'rio_session')).toBeUndefined();
  return location.searchParams.get('error');
}

function sessionCookie(response: LightMyRequestResponse): string {
  const header = cookieHeader(response, 'rio_session');
  expect(header).toBeDefined();
  return header!.split(';')[0]!;
}

async function sessionOf(server: ServerFixture, response: LightMyRequestResponse): Promise<SessionInfo> {
  const resolved = await server.app.inject({
    url: '/api/auth/session',
    headers: { cookie: sessionCookie(response) },
  });
  expect(resolved.statusCode).toBe(200);
  return resolved.json<SessionInfo>();
}

function identities(server: ServerFixture) {
  return query<{
    issuer: string;
    subject: string;
    user_id: string;
    provider_id: string;
    email: string | null;
  }>(
    server.pool,
    sql`SELECT issuer, subject, user_id, provider_id, email FROM ${ident(server.schemas.app, 'sso_identities')}
    ORDER BY created_at`,
  );
}

it('accepts a sharing invitation through the matching provider and opens the shared item', async () => {
  const { server, idp } = await setup();
  const provider = await addProvider(server, idp, {
    allowedDomains: ['example.test'],
    autoCreate: false,
    linkByEmail: false,
  });
  const databaseId = newId('database');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Shared projects',
      table: {
        id: newId('table'),
        name: 'Tasks',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const shared = await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: server.owner.headers,
    payload: {
      id: newId('command'),
      action: {
        kind: 'share.invite',
        resource: { kind: 'database', id: databaseId },
        email: 'new@example.test',
        role: 'reader',
      },
    },
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const token = new URL(shared.json().invitationLink as string).hash.slice('#token='.length);
  const preview = await server.app.inject({ url: `/api/auth/invitations/${token}` });
  expect(preview.json()).toMatchObject({ sso: { id: provider.id }, destination: `/${databaseId}` });
  const invitedCookie = cookieHeader(preview, 'rio_invitation')!.split(';')[0]!;
  const start = await server.app.inject({
    url: `/api/auth/sso/${provider.id}/start?next=${encodeURIComponent(`/${databaseId}`)}`,
    headers: { cookie: invitedCookie },
  });
  expect(start.statusCode, start.body).toBe(302);
  idp.person = { sub: randomUUID(), email: 'NEW@EXAMPLE.TEST', email_verified: true, name: 'New person' };
  const callback = await idp.authorize(String(start.headers.location));
  const finished = await finish(server, callback, cookieHeader(start, 'rio_sso')!.split(';')[0]!);
  expect(finished.headers.location).toBe(`/${databaseId}`);
  const info = await sessionOf(server, finished);
  expect(info).toMatchObject({ user: { email: 'new@example.test' }, membership: { kind: 'guest' } });
  const grants = await query(
    server.pool,
    sql`SELECT role FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${databaseId} AND principal_id = ${info.user.id}`,
  );
  expect(grants.rows).toEqual([{ role: 'reader' }]);
  expect((await server.app.inject({ url: `/api/auth/invitations/${token}` })).statusCode).toBe(404);
});

describe('single sign-on', () => {
  it('lists only the enabled providers, and nothing secret, for the sign-in page', async () => {
    const { server, idp } = await setup();
    const shown = await addProvider(server, idp, { name: 'Acme single sign-on' });
    await addProvider(server, idp, { name: 'Hidden', enabled: false });
    const response = await server.app.inject({ url: '/api/auth/sso' });
    expect(response.statusCode).toBe(200);
    expect(response.json<SsoButton[]>()).toEqual([
      { id: shown.id, kind: 'oidc', name: 'Acme single sign-on' },
    ]);
  });

  it('signs a person in through the provider and remembers who they are', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner-at-acme', email: server.owner.email.toUpperCase(), email_verified: true };
    const { response, location, cookie } = await begin(server, provider, '/settings/people?tab=1#top');

    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer}/authorize`);
    const request = location.searchParams;
    expect(request.get('client_id')).toBe(idp.clientId);
    expect(request.get('redirect_uri')).toBe(CALLBACK);
    expect(request.get('response_type')).toBe('code');
    expect(request.get('scope')).toBe('openid email profile');
    expect(request.get('code_challenge_method')).toBe('S256');
    expect(request.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(request.get('nonce')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(response.headers['cache-control']).toBe('no-store');
    const flow = cookieHeader(response, 'rio_sso')!;
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600'])
      expect(flow).toContain(attribute);
    // Sealed: the browser holds the flow but can't read or change it.
    expect(flow).not.toContain(request.get('state')!);
    expect(flow).not.toContain(request.get('nonce')!);

    const callback = await idp.authorize(location.href);
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    const done = await finish(server, callback, cookie);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/settings/people?tab=1#top');
    expect(cookieHeader(done, 'rio_sso')).toMatch(/^rio_sso=;.*Expires=Thu, 01 Jan 1970/);
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
    expect((await identities(server)).rows).toEqual([
      {
        issuer: idp.issuer,
        subject: 'owner-at-acme',
        user_id: server.owner.userId,
        provider_id: provider.id,
        email: server.owner.email,
      },
    ]);

    // From now on the issuer and subject decide, whatever the provider says the address is.
    idp.person = { sub: 'owner-at-acme', email: 'someone.else@example.test', email_verified: false };
    const again = await signInThrough(server, idp, provider);
    expect(again.headers.location).toBe('/');
    expect((await sessionOf(server, again)).user.id).toBe(server.owner.userId);
    const events = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'auth.%' AND metadata ? 'providerId' ORDER BY id`,
    );
    expect(events.rows.map((event) => event.action)).toEqual([
      'auth.sso.linked',
      'auth.sign_in',
      'auth.sign_in',
    ]);
    expect(events.rows.at(-1)?.metadata).toMatchObject({ method: 'sso', providerId: provider.id });
    expect(JSON.stringify(events.rows)).not.toContain(server.owner.email);
  });

  it('opens the same session a password does', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    const viaSso = await signInThrough(server, idp, provider);
    const viaPassword = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: { email: server.owner.email, password: PASSWORD },
    });
    const shape = (header: string) =>
      header
        .replace(/^rio_session=[A-Za-z0-9_-]{43}/, 'rio_session=token')
        .replace(/Expires=[^;]+/, 'Expires');
    expect(shape(cookieHeader(viaSso, 'rio_session')!)).toBe(
      shape(cookieHeader(viaPassword, 'rio_session')!),
    );
    const fromSso = await sessionOf(server, viaSso);
    const fromPassword = await sessionOf(server, viaPassword);
    expect({ ...fromSso, csrfToken: '' }).toEqual({ ...fromPassword, csrfToken: '' });
    // Thirty days of elapsed time, so a lifetime that crosses a daylight saving change keeps its length.
    const sessions = await query<{ user_id: string; thirty_days: boolean; user_agent: string | null }>(
      server.pool,
      sql`SELECT user_id, date_trunc('minute', expires_at) = date_trunc('minute', created_at + interval '720 hours') AS thirty_days,
        user_agent FROM ${ident(server.schemas.app, 'sessions')} ORDER BY created_at DESC LIMIT 2`,
    );
    expect(sessions.rows[0]).toEqual(sessions.rows[1]);
    expect(sessions.rows[0]?.thirty_days).toBe(true);
  });

  it('discovers each provider once an hour, and again after an edit', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    await begin(server, provider);
    await begin(server, provider);
    expect(idp.requests.discovery).toBe(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
    await begin(server, provider);
    clock.mockRestore();
    expect(idp.requests.discovery).toBe(2);
    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { clientSecret: idp.clientSecret },
    });
    await begin(server, provider);
    expect(idp.requests.discovery).toBe(3);
  });

  it.each([0, 1])(
    'fails closed after the vault cache expires with a %s second lifetime',
    async (cacheSeconds) => {
      let unavailable = false;
      const entries = new Map<string, string>();
      const vault = await fakeVault((call) => {
        if (unavailable) return { status: 503 };
        if (call.method === 'POST') entries.set(call.path, (call.body.data as { value: string }).value);
        return { body: { data: { data: { value: entries.get(call.path) } } } };
      });
      cleanups.push(() => vault.close());
      const { server, idp } = await setup(undefined, {
        credentialPollMs: 0,
        credentials: {
          cacheSeconds,
          profiles: [
            VaultProfile.parse({
              id: 'primary',
              kind: 'vault',
              endpoint: vault.endpoint,
              auth: { kind: 'token', token: randomBytes(24).toString('hex') },
            }),
          ],
        },
      });
      const move = await server.app.inject({
        method: 'POST',
        url: '/api/admin/credentials/commands',
        headers: server.owner.headers,
        payload: { id: randomUUID(), kind: 'move', profile: 'primary', revision: 0 },
      });
      expect(move.statusCode).toBe(200);
      const provider = await addProvider(server, idp);
      idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
      const started = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
      expect((await sessionOf(server, await signInThrough(server, idp, provider))).user.id).toBe(
        server.owner.userId,
      );
      if (cacheSeconds > 0) {
        unavailable = true;
        const calls = vault.calls.length;
        expect((await sessionOf(server, await signInThrough(server, idp, provider))).user.id).toBe(
          server.owner.userId,
        );
        expect(vault.calls).toHaveLength(calls);
        unavailable = false;
      }
      const pending = await begin(server, provider);
      const callback = await idp.authorize(pending.location.href);
      unavailable = true;
      clock.mockReturnValue(started + cacheSeconds * 1000 + 1);
      const calls = vault.calls.length;
      const grants = idp.requests.token;
      try {
        expect(failureOf(await finish(server, callback, pending.cookie))).toBe('sso.unavailable');
        expect(vault.calls).toHaveLength(calls + 1);
        expect(failureOf((await begin(server, provider)).response)).toBe('sso.unavailable');
        expect(vault.calls).toHaveLength(calls + 2);
        expect(idp.requests.token).toBe(grants);
        expect(idp.requests.discovery).toBe(1);
      } finally {
        clock.mockRestore();
      }
      unavailable = false;
      expect((await sessionOf(server, await signInThrough(server, idp, provider))).user.id).toBe(
        server.owner.userId,
      );
    },
  );

  it('refuses a missing, mismatched, forged, or stale state', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    const first = await begin(server, provider);
    const second = await begin(server, provider);
    const callback = await idp.authorize(first.location.href);
    expect(failureOf(await finish(server, callback, ''))).toBe('sso.state');
    expect(failureOf(await finish(server, callback, second.cookie))).toBe('sso.state');
    expect(failureOf(await finish(server, callback, `rio_sso=${first.cookie.slice(8, -4)}AAAA`))).toBe(
      'sso.state',
    );
    const stateless = new URL(callback);
    stateless.searchParams.delete('state');
    expect(failureOf(await finish(server, stateless, first.cookie))).toBe('sso.state');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    expect(failureOf(await finish(server, callback, first.cookie))).toBe('sso.state');
    clock.mockRestore();
    expect(idp.requests.token).toBe(0);
    // The untouched flow still works.
    const done = await finish(server, callback, first.cookie);
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
  });

  it('refuses a replayed callback and a replayed or wrong nonce', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    const first = await begin(server, provider);
    const callback = await idp.authorize(first.location.href);
    expect((await finish(server, callback, first.cookie)).headers.location).toBe('/');
    // Even with the old cookie kept back, the code has been spent.
    expect(failureOf(await finish(server, callback, first.cookie))).toBe('sso.token');

    const later = await begin(server, provider);
    idp.tamper = { nonce: first.location.searchParams.get('nonce')! };
    expect(failureOf(await finish(server, await idp.authorize(later.location.href), later.cookie))).toBe(
      'sso.token',
    );
    const wrong = await begin(server, provider);
    idp.tamper = { nonce: 'not-the-nonce-this-flow-sent' };
    expect(failureOf(await finish(server, await idp.authorize(wrong.location.href), wrong.cookie))).toBe(
      'sso.token',
    );
  });

  it.each<[string, () => Tampering]>([
    ['another audience', () => ({ aud: 'someone-elses-client' })],
    ['another issuer', () => ({ iss: 'https://impostor.example.test/realms/acme' })],
    ['an expired token', () => ({ exp: Math.floor(Date.now() / 1000) - 600 })],
    ['a signature from an unpublished key', () => ({ foreignKey: true })],
  ])('refuses %s', async (_label, tamper) => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    idp.tamper = tamper();
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.token');
    expect((await identities(server)).rows).toEqual([]);
  });

  it('says so when the person declines, without asking for tokens', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.authorizeError = 'access_denied';
    const { location, cookie } = await begin(server, provider, '/settings/sso');
    const callback = await idp.authorize(location.href);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    const response = await finish(server, callback, cookie);
    expect(failureOf(response)).toBe('sso.denied');
    // The way back keeps the page the person was headed for.
    expect(new URL(String(response.headers.location), BASE).searchParams.get('next')).toBe('/settings/sso');
    expect(idp.requests.token).toBe(0);
  });

  it.each<[unknown, string]>([
    ['/settings/people?tab=1#top', '/settings/people?tab=1#top'],
    ['/%2F%2Fevil.example.test', '/%2F%2Fevil.example.test'],
    ['https://evil.example.test/', '/'],
    ['//evil.example.test/', '/'],
    ['/\\evil.example.test', '/'],
    ['/\tevil', '/'],
    ['/ok\r\nLocation: https://evil.example.test', '/'],
    ['settings', '/'],
    ['/api/auth/sign-out', '/'],
    ['/api', '/'],
    [`/${'a'.repeat(2048)}`, '/'],
    [['/one', '/two'], '/'],
    [undefined, '/'],
  ])('keeps next %j to %s', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it('sends people only to paths on this server afterward', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    const away = await signInThrough(server, idp, provider, 'https://evil.example.test/steal');
    expect(away.headers.location).toBe('/');
    const home = await signInThrough(server, idp, provider, '//evil.example.test');
    expect(home.headers.location).toBe('/');
  });

  it('links a first sign-in only to a verified address, and only when the provider allows it', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    const member = await server.addMember();
    idp.person = { sub: 'member-1', email: member.email, email_verified: false };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    idp.person = { sub: 'member-1', email: member.email };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    idp.person = { sub: 'member-1', email: member.email, email_verified: 'true' };
    const linked = await signInThrough(server, idp, provider);
    expect((await sessionOf(server, linked)).user.id).toBe(member.userId);

    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { linkByEmail: false },
    });
    const other = await server.addMember();
    idp.person = { sub: 'member-2', email: other.email, email_verified: true };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    expect((await identities(server)).rows.map((row) => row.subject)).toEqual(['member-1']);
  });

  it('creates members only for verified addresses in allowed domains', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp, {
      autoCreate: true,
      allowedDomains: ['example.org'],
      linkByEmail: false,
    });
    const users = ident(server.schemas.app, 'users');
    const count = async () =>
      (await query<{ count: number }>(server.pool, sql`SELECT count(*)::int AS count FROM ${users}`)).rows[0]
        ?.count;
    const before = await count();
    idp.person = { sub: 'new-1', email: 'new@example.org', email_verified: false };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    idp.person = { sub: 'new-2', email: 'new@elsewhere.example', email_verified: true };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    idp.person = { sub: 'new-3', email: 'new@sub.example.org', email_verified: true };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    expect(await count()).toBe(before);

    idp.person = { sub: 'new-4', email: 'New@Example.org', email_verified: true, name: '  New Person  ' };
    const created = await signInThrough(server, idp, provider);
    const session = await sessionOf(server, created);
    expect(session.user).toMatchObject({ email: 'new@example.org', name: 'New Person' });
    expect(session.membership).toEqual({ kind: 'member', adminRoles: [] });
    expect(session.org.id).toBe(server.owner.info.org.id);

    // An address someone already has is never given a second account.
    const existing = await server.addMember();
    await query(
      server.pool,
      sql`UPDATE ${users} SET email = 'taken@example.org' WHERE id = ${existing.userId}`,
    );
    idp.person = { sub: 'new-5', email: 'taken@example.org', email_verified: true };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    expect(await count()).toBe((before ?? 0) + 2);
  });

  it('refuses deactivated people', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    const known = await server.addMember();
    idp.person = { sub: 'known', email: known.email, email_verified: true };
    await signInThrough(server, idp, provider);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: `/api/org/members/${known.userId}/status`,
          headers: server.owner.headers,
          payload: { deactivated: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.deactivated');

    const unlinked = await server.addMember();
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: `/api/org/members/${unlinked.userId}/status`,
          headers: server.owner.headers,
          payload: { deactivated: true },
        })
      ).statusCode,
    ).toBe(200);
    idp.person = { sub: 'unlinked', email: unlinked.email, email_verified: true };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.deactivated');
  });

  it('checks a multi-tenant Microsoft token against its own tenant', async () => {
    const { server, idp } = await setup({
      origin: 'https://login.microsoftonline.com',
      microsoftTenant: TENANT,
      advertisePkce: false,
    });
    const provider = await addProvider(server, idp, {
      kind: 'microsoft',
      name: 'Microsoft',
      issuer: undefined,
    });
    expect(provider.issuer).toBe('https://login.microsoftonline.com/organizations/v2.0');
    // Entra ID never sends email_verified, so an address alone links nothing.
    idp.person = { sub: 'entra-owner', email: server.owner.email };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
    // Its xms_edov claim says the tenant owns the address's domain.
    idp.person = { sub: 'entra-owner', email: server.owner.email, xms_edov: true };
    const done = await signInThrough(server, idp, provider);
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
    expect((await identities(server)).rows[0]?.issuer).toBe(
      `https://login.microsoftonline.com/${TENANT}/v2.0`,
    );

    idp.tamper = { iss: 'https://login.microsoftonline.com/99999999-8888-7777-6666-555555555555/v2.0' };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.token');
    idp.tamper = { claims: { tid: undefined } };
    expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.token');
  });

  it('counts failures toward the limit it shares with password sign-in', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { sub: 'owner', email: server.owner.email, email_verified: true };
    const attempts = ident(server.schemas.app, 'auth_attempts');
    const key = attemptKey('ip', '198.51.100.7');
    const counted = async () =>
      (
        await query<{ count: number }>(
          server.pool,
          sql`SELECT count(*)::int AS count FROM ${attempts} WHERE key = ${key}`,
        )
      ).rows[0]?.count;

    const pending = await begin(server, provider);
    const callback = await idp.authorize(pending.location.href);
    expect(failureOf(await finish(server, callback, '', '198.51.100.7'))).toBe('sso.state');
    expect(await counted()).toBe(1);
    // A provider that has gone away is nobody's mistake, so it doesn't count.
    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { enabled: false },
    });
    expect(failureOf(await finish(server, callback, pending.cookie, '198.51.100.7'))).toBe('sso.unavailable');
    expect(await counted()).toBe(1);

    await query(
      server.pool,
      sql`INSERT INTO ${attempts} (key, at) SELECT ${key}, clock_timestamp() FROM generate_series(1, 99)`,
    );
    const locked = await server.app.inject({
      url: `/api/auth/sso/${provider.id}/start`,
      remoteAddress: '198.51.100.7',
    });
    expect(failureOf(locked)).toBe('sso.locked');
    const password = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      remoteAddress: '198.51.100.7',
      payload: { email: server.owner.email, password: PASSWORD },
    });
    expect(password.statusCode).toBe(429);
    // Another address is unaffected.
    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { enabled: true },
    });
    const elsewhere = await signInThrough(server, idp, provider);
    expect((await sessionOf(server, elsewhere)).user.id).toBe(server.owner.userId);
  });

  it('refuses providers that are off, missing, or unreachable', async () => {
    const { server, idp } = await setup();
    const off = await addProvider(server, idp, { enabled: false });
    const start = (id: string) => server.app.inject({ url: `/api/auth/sso/${id}/start` });
    expect(failureOf(await start(off.id))).toBe('sso.unavailable');
    expect(failureOf(await start('AAAAAAAAAAAAAAAA'))).toBe('sso.unavailable');
    expect(failureOf(await start('not-an-id'))).toBe('sso.unavailable');
    const down = await addProvider(server, idp, { issuer: 'https://127.0.0.1:1/realms/gone' });
    expect(failureOf(await start(down.id))).toBe('sso.unavailable');
  });
});

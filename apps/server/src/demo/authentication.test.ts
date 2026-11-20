import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { newId, type SsoProvider } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { PERSISTENT_FORMAT, startTestIdp } from '../test/saml-idp.js';
import {
  routeFetch,
  routeProviderRequests,
  startTestProvider,
  type TestProvider,
} from '../test/oidc-provider.js';
import { tokenHash } from '../auth/database.js';
import { seal } from '../secrets.js';
import { demoRoutes } from './routes.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let oidc: TestProvider;
let demoCookie: string;
let linkedSaml: InjectOptions;
let invitationCookie: string;
const requests: Record<string, InjectOptions> = {};
const token = randomBytes(32).toString('base64url');
const credentialId = randomBytes(32).toString('base64url');
const realFetch = globalThis.fetch;

const cookieOf = (response: { headers: { 'set-cookie'?: string | string[] } }, name: string) =>
  [response.headers['set-cookie']]
    .flat()
    .find((cookie) => cookie?.startsWith(`${name}=`))
    ?.split(';')[0] ?? '';

beforeAll(async () => {
  kit = await startTestPostgres();
  oidc = await startTestProvider();
  routeProviderRequests([oidc]);
  server = await startServer(kit, 'demoauth');
  member = await server.addMember();
  oidc.person = { sub: randomBytes(16).toString('hex'), email: member.email, email_verified: true };
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch([oidc], realFetch));
  server.config.baseUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  const saml = startTestIdp();
  async function provider(payload: object) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/admin/sso',
      headers: server.owner.headers,
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SsoProvider>();
  }
  const samlProvider = await provider({
    kind: 'saml',
    name: 'Demo federation',
    linkByEmail: true,
    saml: {
      entityId: saml.entityId,
      ssoUrl: saml.ssoUrl,
      certificates: [saml.certificate],
      verifiesEmails: true,
    },
  });
  const oidcProvider = await provider({
    kind: 'oidc',
    name: 'Demo identity',
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    linkByEmail: true,
  });
  const samlStart = await server.app.inject(`/api/auth/saml/${samlProvider.id}/start`);
  expect(samlStart.statusCode, samlStart.body).toBe(302);
  const assertion = saml.answer(await saml.read(samlStart.headers.location!), {
    person: { nameId: member.email },
  });
  const subject = randomBytes(16).toString('hex');
  const linkedStart = await server.app.inject(`/api/auth/saml/${samlProvider.id}/start`);
  const linkedAssertion = saml.answer(await saml.read(linkedStart.headers.location!), {
    person: {
      nameId: subject,
      nameIdFormat: PERSISTENT_FORMAT,
      attributes: { email: `${randomBytes(8).toString('hex')}@example.test` },
    },
  });
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".sso_identities
    (issuer, subject, user_id, provider_id, email) VALUES ($1, $2, $3, $4, $5)`,
    [
      `saml:${member.info.org.id}:${samlProvider.issuer}`,
      subject,
      member.userId,
      samlProvider.id,
      member.email,
    ],
  );
  linkedSaml = {
    method: 'POST',
    url: `/api/auth/saml/${samlProvider.id}/acs`,
    headers: {
      cookie: cookieOf(linkedStart, 'rio_saml'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ SAMLResponse: linkedAssertion }).toString(),
  };
  const oidcStart = await server.app.inject(`/api/auth/sso/${oidcProvider.id}/start`);
  expect(oidcStart.statusCode, oidcStart.body).toBe(302);
  const callback = await oidc.authorize(oidcStart.headers.location!);
  const nextStart = await server.app.inject(`/api/auth/sso/${oidcProvider.id}/start`);
  const headCallback = await oidc.authorize(nextStart.headers.location!);
  requests['HEAD /api/auth/sso/callback'] = {
    url: headCallback.pathname + headCallback.search,
    headers: { cookie: cookieOf(nextStart, 'rio_sso') },
  };
  const pending = `rio_second_step=${seal(
    server.config.secretKey,
    JSON.stringify({
      id: randomBytes(32).toString('base64url'),
      userId: member.userId,
      stage: 'verify',
      method: 'password',
      expires: Date.now() + 600_000,
    }),
    'riosoma:second-step',
  )}`;
  const invitation = `rio_invitation=${seal(
    server.config.secretKey,
    JSON.stringify({ token, expires: Date.now() + 600_000 }),
    'riosoma:invitation',
  )}`;
  invitationCookie = invitation;
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".login_tokens (id, user_id, email, purpose, token_hash, expires_at)
    VALUES ($1, $2, $3, 'magic_link', $4, now() + interval '1 hour')`,
    [newId('token'), member.userId, member.email, tokenHash(token)],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".invitations (id, org_id, email, token_hash, invited_by, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
    [newId('invitation'), member.info.org.id, member.email, tokenHash(token), server.owner.userId],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".passkeys (id, user_id, name, credential_id, public_key, user_handle)
    VALUES ($1, $2, 'Existing key', $3, $4, $2)`,
    [newId('passkey'), member.userId, credentialId, randomBytes(32)],
  );
  // Expired attempts expose cleanup writes that would otherwise be invisible in an empty fixture.
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".auth_attempts (key, at) VALUES ($1, now() - interval '2 days')`,
    [randomBytes(32).toString('hex')],
  );
  requests['GET /api/auth/invitations/:token'] = { url: `/api/auth/invitations/${token}` };
  requests['POST /api/auth/invitations/accept'] = {
    url: '/api/auth/invitations/accept',
    payload: { token, name: 'Demo member' },
  };
  for (const path of ['sign-in', 'link', 'password-reset', 'passkey/options'])
    requests[`POST /api/auth/${path}`] = {
      url: `/api/auth/${path}`,
      payload: { email: member.email.toUpperCase(), password: 'a long test password' },
    };
  for (const path of ['link/redeem', 'password-reset/redeem'])
    requests[`POST /api/auth/${path}`] = {
      url: `/api/auth/${path}`,
      payload: { token, password: 'a changed test password' },
    };
  requests['POST /api/auth/passkey'] = {
    url: '/api/auth/passkey',
    payload: { response: { id: credentialId } },
  };
  for (const route of [
    'GET /api/auth/second-step',
    'DELETE /api/auth/second-step',
    'POST /api/auth/second-step',
    'POST /api/auth/second-step/options',
    'POST /api/auth/second-step/passkeys/options',
    'POST /api/auth/second-step/passkeys',
    'POST /api/auth/second-step/authenticator',
    'POST /api/auth/second-step/authenticator/confirm',
  ])
    requests[route] = {
      url: route.slice(route.indexOf(' ') + 1),
      headers: { cookie: pending },
      payload: route.startsWith('POST') ? { method: 'authenticator', code: '000000' } : undefined,
    };
  requests['GET /api/auth/saml/:providerId/start'] = {
    url: `/api/auth/saml/${samlProvider.id}/start`,
    headers: { cookie: invitation },
  };
  requests['GET /api/auth/sso/:providerId/start'] = {
    url: `/api/auth/sso/${oidcProvider.id}/start`,
    headers: { cookie: invitation },
  };
  requests['POST /api/auth/saml/:providerId/acs'] = {
    url: `/api/auth/saml/${samlProvider.id}/acs`,
    headers: { cookie: cookieOf(samlStart, 'rio_saml'), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ SAMLResponse: assertion }).toString(),
  };
  requests['GET /api/auth/sso/callback'] = {
    url: callback.pathname + callback.search,
    headers: { cookie: cookieOf(oidcStart, 'rio_sso') },
  };
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  const session = await server.app.inject('/api/auth/session');
  expect(session.statusCode, session.body).toBe(200);
  demoCookie = cookieOf(session, 'rio_demo');
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  await oidc?.close();
  await kit?.stop();
});

async function snapshot() {
  const tables = await server.pool.query<{ schema: string; name: string }>(
    `SELECT schemaname AS schema, tablename AS name
    FROM pg_tables WHERE schemaname = ANY($1::text[]) ORDER BY schemaname, tablename`,
    [Object.values(server.schemas)],
  );
  const state: Record<string, unknown> = {};
  for (const table of tables.rows)
    state[`${table.schema}.${table.name}`] = (
      await server.pool.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(row_to_json(r)::text, E'\\n' ORDER BY row_to_json(r)::text), '')) AS checksum
      FROM "${table.schema}"."${table.name}" r`)
    ).rows[0];
  return state;
}

it('enumerates every public authentication and recovery route and changes no rows for the reserved member with or without a demo cookie', async () => {
  // Discovery and branding have no account target.  Session creation deliberately allocates a demo session.
  // Sign-out requires an existing session and is already covered by the demo route corpus.
  const exceptions = new Set([
    'GET /api/auth/methods',
    'GET /api/auth/password-reset',
    'GET /api/auth/sso',
    'GET /api/auth/saml/:providerId/metadata',
    'GET /api/auth/logo/:key',
    'GET /api/auth/session',
    'POST /api/auth/sign-out',
  ]);
  const routes = [...new Set(demoRoutes(server.app))].filter((route) =>
    / \/(?:api\/auth\/|scim\/v2\/)/.test(route),
  );
  const send = vi.fn(async () => undefined);
  server.ctx.mailer = { send };
  for (const route of routes) {
    const [method, path] = route.split(' ') as [string, string];
    const normalized = `${method === 'HEAD' ? 'GET' : method} ${path}`;
    if (exceptions.has(normalized)) continue;
    const fixture: InjectOptions | undefined = path.startsWith('/scim/')
      ? {
          url: path.replace(':resourceId', member.userId).replace('*', 'unknown'),
          payload: ['POST', 'PUT', 'PATCH'].includes(method) ? { userName: member.email } : undefined,
        }
      : (requests[route] ?? requests[normalized]);
    expect(fixture, `Authentication route needs a fixture or a named exception: ${route}`).toBeDefined();
    for (const cookie of ['', demoCookie]) {
      const before = await snapshot();
      const response = await server.app.inject({
        ...fixture,
        method: method as InjectOptions['method'],
        headers: {
          ...fixture!.headers,
          cookie: [fixture!.headers?.cookie, cookie].filter(Boolean).join('; '),
        },
      });
      expect.soft(response.statusCode, `${route}: ${response.body}`).toBe(403);
      if (method !== 'HEAD') expect.soft(response.body, route).toContain('demo.readOnly');
      expect.soft(await snapshot(), `${route}, demo cookie: ${Boolean(cookie)}`).toEqual(before);
    }
  }
  expect(send).not.toHaveBeenCalled();
}, 60_000);

it('refuses a linked SAML identity even when its provider reports a different email before recording any state', async () => {
  for (const cookie of ['', demoCookie]) {
    const before = await snapshot();
    const response = await server.app.inject({
      ...linkedSaml,
      headers: {
        ...linkedSaml.headers,
        cookie: [linkedSaml.headers?.cookie, cookie].filter(Boolean).join('; '),
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.messageKey).toBe('demo.readOnly');
    expect(await snapshot()).toEqual(before);
  }
});

it('preserves operator sign-in when a browser carries a reserved invitation from an earlier visit', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    headers: { cookie: invitationCookie },
    payload: { email: server.owner.email, password: 'a long test password' },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().demo).toBeUndefined();
});

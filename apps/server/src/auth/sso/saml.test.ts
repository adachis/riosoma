import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, SsoButton, SsoProvider } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import {
  escapeXml,
  PERSISTENT_FORMAT,
  startTestIdp,
  TRANSIENT_FORMAT,
  type Answer,
  type AuthnRequest,
  type TestIdp,
} from '../../test/saml-idp.js';
import { attemptKey } from '../attempts.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = 'a long test password';
const MINUTE = 60_000;
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
  const server = await startServer(kit, 'samlflow', { baseUrl: `${BASE}/` });
  cleanups.push(() => server.close());
  const idp = startTestIdp();
  return { server, idp };
}

async function addProvider(
  server: ServerFixture,
  idp: TestIdp,
  overrides: Record<string, unknown> = {},
  saml: Record<string, unknown> = {},
): Promise<SsoProvider> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/sso',
    headers: server.owner.headers,
    payload: {
      kind: 'saml',
      name: 'Acme',
      saml: {
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        certificates: [idp.certificate],
        verifiesEmails: true,
        ...saml,
      },
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SsoProvider>();
}

function acsUrl(provider: SsoProvider): string {
  return `${BASE}/api/auth/saml/${provider.id}/acs`;
}

function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookieHeader(response: LightMyRequestResponse, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

interface Started {
  response: LightMyRequestResponse;
  location: URL;
  /** `rio_saml=…`, the way the browser sends it back */
  cookie: string;
  request: AuthnRequest;
}

async function begin(
  server: ServerFixture,
  idp: TestIdp,
  provider: SsoProvider,
  next?: string,
  remoteAddress = '127.0.0.1',
): Promise<Started> {
  const response = await server.app.inject({
    url: `/api/auth/saml/${provider.id}/start${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`,
    remoteAddress,
  });
  expect(response.statusCode, response.body).toBe(302);
  const location = new URL(String(response.headers.location));
  const cookie = cookieHeader(response, 'rio_saml')?.split(';')[0] ?? '';
  return { response, location, cookie, request: await idp.read(location.href) };
}

/** Posts an answer to a provider's Assertion Consumer Service, as the browser would. */
function post(
  server: ServerFixture,
  provider: SsoProvider,
  samlResponse: string,
  cookie: string,
  remoteAddress = '127.0.0.1',
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/auth/saml/${provider.id}/acs`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: '' }).toString(),
    remoteAddress,
  });
}

async function signInThrough(
  server: ServerFixture,
  idp: TestIdp,
  provider: SsoProvider,
  answer: Answer = {},
  next?: string,
) {
  const started = await begin(server, idp, provider, next);
  return post(server, provider, idp.answer(started.request, answer), started.cookie);
}

/** The message key a refused sign-in carries back to the sign-in page. */
function failureOf(response: LightMyRequestResponse): string | null {
  expect([302, 303]).toContain(response.statusCode);
  const location = new URL(String(response.headers.location), BASE);
  expect(location.pathname).toBe('/sign-in');
  expect(cookieHeader(response, 'rio_session')).toBeUndefined();
  return location.searchParams.get('error');
}

function sessionCookie(response: LightMyRequestResponse): string {
  const header = cookieHeader(response, 'rio_session');
  expect(header, `status ${response.statusCode} to ${String(response.headers.location)}`).toBeDefined();
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

function sessionCount(server: ServerFixture) {
  return query<{ count: number }>(
    server.pool,
    sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.app, 'sessions')}`,
  ).then((result) => result.rows[0]?.count ?? 0);
}

/** The signed assertion's XML, cut out of a signed response. */
function assertionOf(xml: string): string {
  const start = xml.indexOf('<saml:Assertion ');
  const end = xml.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length;
  return xml.slice(start, end);
}

/** A copy of an assertion that says what an attacker wants, with the real signature's markup kept. */
function forged(assertion: string, id: string, nameId: string): string {
  return assertion
    .replace(/ID="[^"]+"/, `ID="${id}"`)
    .replace(/<saml:NameID([^>]*)>[^<]*<\/saml:NameID>/, `<saml:NameID$1>${escapeXml(nameId)}</saml:NameID>`);
}

describe('SAML single sign-on', () => {
  it('signs a person in through the identity provider and remembers who they are', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    const listed = await server.app.inject({ url: '/api/auth/sso' });
    expect(listed.json<SsoButton[]>()).toEqual([{ id: provider.id, kind: 'saml', name: 'Acme' }]);

    const started = await begin(server, idp, provider, '/settings/people?tab=1#top');
    const { response, location, request } = started;
    expect(`${location.origin}${location.pathname}`).toBe(idp.ssoUrl);
    expect(request.destination).toBe(idp.ssoUrl);
    expect(request.acsUrl).toBe(acsUrl(provider));
    expect(request.issuer).toBe(`${BASE}/api/auth/saml/${provider.id}/metadata`);
    expect(request.id).toMatch(/^_[0-9a-f]{40}$/);
    // Nothing but the request rides along, and it lets the identity provider choose how to
    // identify people and how they sign in.
    expect([...request.parameters.keys()]).toEqual([]);
    expect(request.xml).not.toContain('Format=');
    expect(request.xml).not.toContain('RequestedAuthnContext');
    expect(response.headers['cache-control']).toBe('no-store');
    const flow = cookieHeader(response, 'rio_saml')!;
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Path=/', 'Max-Age=600'])
      expect(flow).toContain(attribute);
    // Sealed: the browser carries the request's ID but can't read or change it.
    expect(flow).not.toContain(request.id);

    idp.person = { nameId: server.owner.email.toUpperCase() };
    const done = await post(server, provider, idp.answer(request), started.cookie);
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/settings/people?tab=1#top');
    expect(cookieHeader(done, 'rio_saml')).toMatch(/^rio_saml=;.*Expires=Thu, 01 Jan 1970/);
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
    expect((await identities(server)).rows).toEqual([
      {
        issuer: `saml:${server.owner.info.org.id}:${idp.entityId}`,
        subject: server.owner.email.toUpperCase(),
        user_id: server.owner.userId,
        provider_id: provider.id,
        email: server.owner.email,
      },
    ]);

    // From now on the entity ID and NameID decide, whatever address the assertion carries.
    idp.person = {
      nameId: server.owner.email.toUpperCase(),
      attributes: { email: 'someone.else@example.test' },
    };
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

  it('takes a signed assertion, a signed response, or both', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { nameId: server.owner.email };
    for (const sign of ['assertion', 'response', 'both'] as const) {
      const done = await signInThrough(server, idp, provider, { sign });
      expect((await sessionOf(server, done)).user.id, sign).toBe(server.owner.userId);
    }
  });

  it('reads an issuer the identity provider wrote across lines', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { nameId: server.owner.email };
    const done = await signInThrough(server, idp, provider, {
      sign: 'both',
      shape: (xml) => xml.replaceAll(`<saml:Issuer>${idp.entityId}<`, `<saml:Issuer>\n  ${idp.entityId}\n<`),
    });
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
  });

  it('skips the second step, as other single sign-on does', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    const policy = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/mfa/policy',
      headers: server.owner.headers,
      payload: { policy: 'everyone' },
    });
    expect(policy.statusCode).toBe(200);
    const password = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: { email: server.owner.email, password: PASSWORD },
    });
    expect(cookieHeader(password, 'rio_session')).toBeUndefined();
    idp.person = { nameId: server.owner.email };
    const done = await signInThrough(server, idp, provider);
    expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
  });

  describe('signatures', () => {
    it('refuses an unsigned answer', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const sessions = await sessionCount(server);
      expect(failureOf(await signInThrough(server, idp, provider, { sign: 'none' }))).toBe('sso.token');
      expect(await sessionCount(server)).toBe(sessions);
    });

    it('refuses a key it was never given, even with that key’s own certificate attached', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      for (const sign of ['assertion', 'response', 'both'] as const) {
        const started = await begin(server, idp, provider);
        const xml = idp.answerXml(started.request, { sign, foreignKey: true });
        expect(xml).toContain('<X509Certificate>');
        const response = await post(server, provider, Buffer.from(xml).toString('base64'), started.cookie);
        expect(failureOf(response), sign).toBe('sso.token');
      }
      expect((await identities(server)).rows).toEqual([]);
    });

    it('refuses an answer changed after signing', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      const retarget = (xml: string) => xml.replace(member.email, server.owner.email);
      expect(failureOf(await signInThrough(server, idp, provider, { tamper: retarget }))).toBe('sso.token');
      expect(
        failureOf(await signInThrough(server, idp, provider, { sign: 'response', tamper: retarget })),
      ).toBe('sso.token');
    });

    it('refuses a response whose own signature fails, even when the assertion’s holds', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const response = await signInThrough(server, idp, provider, {
        sign: 'both',
        tamper: (xml) =>
          xml.replace(/(<samlp:Response [^>]*IssueInstant=")[^"]+/, '$12001-01-01T00:00:00.000Z'),
      });
      expect(failureOf(response)).toBe('sso.token');
    });

    it('refuses a second assertion slipped in beside the signed one', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) => {
          const signed = assertionOf(xml);
          const evil = forged(signed, '_evil', server.owner.email).replace(
            /<Signature xmlns[\s\S]*?<\/Signature>/,
            '',
          );
          return xml.replace(signed, `${evil}${signed}`);
        },
      });
      expect(failureOf(response)).toBe('sso.token');
      expect((await identities(server)).rows).toEqual([]);
    });

    it('refuses a signed assertion wrapped inside a forged one', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) => {
          const signed = assertionOf(xml);
          // The forgery keeps the real signature, which still names the original assertion.
          const evil = forged(signed, '_evil', server.owner.email).replace(
            '</saml:Assertion>',
            `<saml:Advice>${signed}</saml:Advice></saml:Assertion>`,
          );
          return xml.replace(signed, evil);
        },
      });
      expect(failureOf(response)).toBe('sso.token');
    });

    it('refuses a forged assertion that borrows the signed one’s ID', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) => {
          const signed = assertionOf(xml);
          const id = /ID="([^"]+)"/.exec(signed)![1]!;
          const evil = forged(signed, id, server.owner.email);
          return xml.replace(signed, `<samlp:Extensions>${signed}</samlp:Extensions>${evil}`);
        },
      });
      expect(failureOf(response)).toBe('sso.token');
    });

    it('refuses a signed response wrapped inside a forged one', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      const response = await signInThrough(server, idp, provider, {
        sign: 'response',
        tamper: (xml) => {
          const signature = /<Signature xmlns[\s\S]*?<\/Signature>/.exec(xml)![0];
          const evil = forged(assertionOf(xml), '_evil', server.owner.email);
          const outside = xml
            .slice(0, xml.indexOf('<saml:Issuer>'))
            .replace(/ ID="[^"]+"/, ' ID="_evilResponse"');
          const issuer = /<saml:Issuer>[^<]*<\/saml:Issuer>/.exec(xml)![0];
          const status = /<samlp:Status>[\s\S]*?<\/samlp:Status>/.exec(xml)![0];
          return `${outside}${issuer}${signature}${status}${evil}<samlp:Extensions>${xml}</samlp:Extensions></samlp:Response>`;
        },
      });
      expect(failureOf(response)).toBe('sso.token');
    });

    it('reads the NameID the signature covers, whole, even with a comment hidden in it', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      // The attacker's own account at the identity provider, with an address that starts like the owner's.
      const own = `${server.owner.email}.attacker.test`;
      idp.person = { nameId: own };
      const sessions = await sessionCount(server);
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) => xml.replace(own, `${server.owner.email}<!---->.attacker.test`),
      });
      // The signature still holds, because comments aren't signed, but the name is the whole one.
      expect(failureOf(response)).toBe('sso.noAccount');
      expect(await sessionCount(server)).toBe(sessions);
    });

    it('never reads an external entity', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const directory = mkdtempSync(join(tmpdir(), 'rio-saml-'));
      cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
      const secret = join(directory, 'secret.txt');
      writeFileSync(secret, 'the contents of a private file');
      idp.person = { nameId: 'xxe@example.test' };
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) =>
          `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file://${secret}">]>${xml.replace(
            'xxe@example.test',
            '&xxe;',
          )}`,
      });
      expect(failureOf(response)).toBe('sso.token');
      expect(JSON.stringify(response.headers)).not.toContain('private file');
      expect((await identities(server)).rows).toEqual([]);
    });

    it('refuses any document type declaration, even one that changes nothing', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const sessions = await sessionCount(server);
      // The signature doesn't cover a declaration, so only refusing them all keeps entities out.
      const response = await signInThrough(server, idp, provider, {
        tamper: (xml) => `<?xml version="1.0"?><!DOCTYPE samlp:Response>${xml}`,
      });
      expect(failureOf(response)).toBe('sso.token');
      expect(await sessionCount(server)).toBe(sessions);
    });
  });

  describe('where the answer is for', () => {
    it.each<[string, (provider: SsoProvider, idp: TestIdp) => Answer]>([
      ['another audience', () => ({ audience: 'https://someone-else.example.test/saml' })],
      ['another destination', () => ({ destination: 'https://someone-else.example.test/acs' })],
      ['no destination', () => ({ destination: null })],
      ['another recipient', () => ({ recipient: 'https://someone-else.example.test/acs' })],
      ['another issuer, signed with the configured key', () => ({ issuer: 'https://impostor.example.test' })],
      [
        'an assertion from another issuer inside the right response',
        () => ({
          shape: (xml) =>
            xml.replace(/(<saml:Assertion [^>]*><saml:Issuer>)[^<]*/, '$1https://impostor.example.test'),
        }),
      ],
      [
        'a response issuer that isn’t the assertion’s',
        (_provider, idp) => ({
          tamper: (xml) =>
            xml.replace(
              `<saml:Issuer>${idp.entityId}</saml:Issuer><samlp:Status>`,
              '<saml:Issuer>https://impostor.example.test</saml:Issuer><samlp:Status>',
            ),
        }),
      ],
      [
        'an assertion issued more than three minutes from now',
        () => ({
          issuedAt: new Date(Date.now() + 4 * MINUTE),
          notBefore: new Date(Date.now() - MINUTE),
          notOnOrAfter: new Date(Date.now() + 9 * MINUTE),
        }),
      ],
      [
        'a subject confirmed some other way than as the bearer',
        () => ({
          shape: (xml) =>
            xml.replace(
              'urn:oasis:names:tc:SAML:2.0:cm:bearer',
              'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
            ),
        }),
      ],
      [
        'a NameID that changes every time',
        () => ({ person: { nameId: 'opaque-1', nameIdFormat: TRANSIENT_FORMAT } }),
      ],
      [
        'an assertion issued more than ten minutes ago, allowing for clock skew',
        () => ({
          issuedAt: new Date(Date.now() - 15 * MINUTE),
          notOnOrAfter: new Date(Date.now() + 5 * MINUTE),
        }),
      ],
    ])('refuses %s', async (_label, answer) => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      expect(failureOf(await signInThrough(server, idp, provider, answer(provider, idp)))).toBe('sso.token');
      expect((await identities(server)).rows).toEqual([]);
    });

    it('allows three minutes of clock skew and no more', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const now = Date.now();
      const expired = (minutes: number) => ({
        issuedAt: new Date(now - (minutes + 5) * MINUTE),
        notBefore: new Date(now - (minutes + 5) * MINUTE),
        notOnOrAfter: new Date(now - minutes * MINUTE),
      });
      const early = (minutes: number) => ({
        issuedAt: new Date(now + minutes * MINUTE),
        notBefore: new Date(now + minutes * MINUTE),
        notOnOrAfter: new Date(now + (minutes + 5) * MINUTE),
      });
      expect(failureOf(await signInThrough(server, idp, provider, expired(4)))).toBe('sso.token');
      expect(failureOf(await signInThrough(server, idp, provider, early(4)))).toBe('sso.token');
      for (const answer of [expired(2), early(2)]) {
        const done = await signInThrough(server, idp, provider, answer);
        expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
      }
    });

    it('says the provider declined when its answer isn’t a success', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const response = await signInThrough(
        server,
        idp,
        provider,
        {
          sign: 'none',
          status: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
          shape: (xml) => xml.replace(/<saml:Assertion [\s\S]*<\/saml:Assertion>/, ''),
        },
        '/settings/sso',
      );
      expect(failureOf(response)).toBe('sso.denied');
      expect(new URL(String(response.headers.location), BASE).searchParams.get('next')).toBe('/settings/sso');
    });
  });

  describe('binding the answer to this browser', () => {
    it('refuses an answer to a request another browser started', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const mine = await begin(server, idp, provider);
      const theirs = await begin(server, idp, provider);
      const answer = idp.answer(mine.request);
      expect(failureOf(await post(server, provider, answer, theirs.cookie))).toBe('sso.state');
      expect(failureOf(await post(server, provider, answer, ''))).toBe('sso.state');
      expect(
        failureOf(await post(server, provider, answer, `rio_saml=${mine.cookie.slice(9, -4)}AAAA`)),
      ).toBe('sso.state');
      // The untouched flow still works.
      const done = await post(server, provider, answer, mine.cookie);
      expect((await sessionOf(server, done)).user.id).toBe(server.owner.userId);
    });

    it('refuses an answer nobody asked for, or one whose signed part names another request', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      for (const answer of [
        { inResponseTo: null, subjectInResponseTo: null },
        { subjectInResponseTo: null },
        { subjectInResponseTo: '_0000000000000000000000000000000000000000' },
      ]) {
        const started = await begin(server, idp, provider);
        const response = await post(server, provider, idp.answer(started.request, answer), started.cookie);
        expect(failureOf(response), JSON.stringify(answer)).toBe('sso.state');
      }
      expect((await identities(server)).rows).toEqual([]);
    });

    it('refuses an answer after ten minutes, or at another provider’s address', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const other = await addProvider(server, idp, { name: 'Other' });
      idp.person = { nameId: server.owner.email };
      const started = await begin(server, idp, provider);
      const answer = idp.answer(started.request);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * MINUTE);
      expect(failureOf(await post(server, provider, answer, started.cookie))).toBe('sso.state');
      clock.mockRestore();
      expect(failureOf(await post(server, other, answer, started.cookie))).toBe('sso.state');
    });

    it('refuses a replayed assertion, even from a browser holding the original cookie', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      idp.person = { nameId: server.owner.email };
      const started = await begin(server, idp, provider);
      const answer = idp.answer(started.request);
      const first = await post(server, provider, answer, started.cookie);
      expect((await sessionOf(server, first)).user.id).toBe(server.owner.userId);
      const sessions = await sessionCount(server);
      expect(failureOf(await post(server, provider, answer, started.cookie))).toBe('sso.token');
      // A fresh answer that reuses the assertion's ID is the same assertion.
      const assertionId = /<saml:Assertion ID="([^"]+)"/.exec(
        Buffer.from(answer, 'base64').toString('utf8'),
      )![1]!;
      const again = await begin(server, idp, provider);
      expect(
        failureOf(await post(server, provider, idp.answer(again.request, { assertionId }), again.cookie)),
      ).toBe('sso.token');
      expect(await sessionCount(server)).toBe(sessions);
      // The ID is kept until the assertion could no longer be accepted anyway.
      const kept = await query<{ expires_at: Date }>(
        server.pool,
        sql`SELECT expires_at FROM ${ident(server.schemas.app, 'saml_assertions')} WHERE assertion_id = ${assertionId}`,
      );
      expect(kept.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 10 * MINUTE);
    });
  });

  describe('accounts', () => {
    it('links a first sign-in only when the identity provider verifies addresses and linking is on', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp, {}, { verifiesEmails: false });
      const member = await server.addMember();
      idp.person = { nameId: member.email };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');

      await server.app.inject({
        method: 'PATCH',
        url: `/api/admin/sso/${provider.id}`,
        headers: server.owner.headers,
        payload: { saml: { verifiesEmails: true } },
      });
      // A NameID that isn't an address says nothing about email, but the attribute does.
      idp.person = { nameId: 'id-1', nameIdFormat: PERSISTENT_FORMAT };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
      idp.person = {
        nameId: 'id-1',
        nameIdFormat: PERSISTENT_FORMAT,
        attributes: { 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': member.email },
      };
      const linked = await signInThrough(server, idp, provider);
      expect((await sessionOf(server, linked)).user.id).toBe(member.userId);

      await server.app.inject({
        method: 'PATCH',
        url: `/api/admin/sso/${provider.id}`,
        headers: server.owner.headers,
        payload: { linkByEmail: false },
      });
      const other = await server.addMember();
      idp.person = { nameId: other.email };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
      expect((await identities(server)).rows.map((row) => row.subject)).toEqual(['id-1']);
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
        (await query<{ count: number }>(server.pool, sql`SELECT count(*)::int AS count FROM ${users}`))
          .rows[0]?.count;
      const before = await count();
      idp.person = { nameId: 'new@elsewhere.example' };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
      idp.person = { nameId: 'new@sub.example.org' };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
      expect(await count()).toBe(before);

      idp.person = {
        nameId: 'u-42',
        nameIdFormat: PERSISTENT_FORMAT,
        attributes: { Email: ['New@Example.org', 'second@example.org'], givenName: 'New', sn: 'Person' },
      };
      const created = await signInThrough(server, idp, provider);
      const session = await sessionOf(server, created);
      expect(session.user).toMatchObject({ email: 'new@example.org', name: 'New Person' });
      expect(session.membership).toEqual({ kind: 'member', adminRoles: [] });
      expect(session.org.id).toBe(server.owner.info.org.id);

      await server.app.inject({
        method: 'PATCH',
        url: `/api/admin/sso/${provider.id}`,
        headers: server.owner.headers,
        payload: { saml: { verifiesEmails: false } },
      });
      idp.person = { nameId: 'later@example.org' };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.noAccount');
      expect(await count()).toBe((before ?? 0) + 1);
    });

    it('keys people by the identity provider’s entity ID as well as the NameID', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const member = await server.addMember();
      idp.person = {
        nameId: 'shared-id',
        nameIdFormat: PERSISTENT_FORMAT,
        attributes: { email: member.email },
      };
      expect((await sessionOf(server, await signInThrough(server, idp, provider))).user.id).toBe(
        member.userId,
      );

      // Another identity provider that happens to use the same NameID is someone else entirely.
      const elsewhere = startTestIdp();
      const second = await addProvider(server, elsewhere, { name: 'Elsewhere', linkByEmail: false });
      elsewhere.person = { nameId: 'shared-id', nameIdFormat: PERSISTENT_FORMAT };
      expect(failureOf(await signInThrough(server, elsewhere, second))).toBe('sso.noAccount');
    });

    it('refuses deactivated people', async () => {
      const { server, idp } = await setup();
      const provider = await addProvider(server, idp);
      const known = await server.addMember();
      idp.person = { nameId: known.email };
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
      idp.person = { nameId: unlinked.email };
      expect(failureOf(await signInThrough(server, idp, provider))).toBe('sso.deactivated');
    });
  });

  it('counts failures toward the limit it shares with password sign-in', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp);
    idp.person = { nameId: server.owner.email };
    const attempts = ident(server.schemas.app, 'auth_attempts');
    const address = '198.51.100.7';
    const key = attemptKey('ip', address);
    const counted = async () =>
      (
        await query<{ count: number }>(
          server.pool,
          sql`SELECT count(*)::int AS count FROM ${attempts} WHERE key = ${key}`,
        )
      ).rows[0]?.count;

    const pending = await begin(server, idp, provider, undefined, address);
    const answer = idp.answer(pending.request);
    expect(failureOf(await post(server, provider, answer, '', address))).toBe('sso.state');
    expect(await counted()).toBe(1);
    // A provider that has gone away is nobody's mistake, so it doesn't count.
    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { enabled: false },
    });
    expect(failureOf(await post(server, provider, answer, pending.cookie, address))).toBe('sso.unavailable');
    expect(await counted()).toBe(1);

    await query(
      server.pool,
      sql`INSERT INTO ${attempts} (key, at) SELECT ${key}, clock_timestamp() FROM generate_series(1, 99)`,
    );
    await server.app.inject({
      method: 'PATCH',
      url: `/api/admin/sso/${provider.id}`,
      headers: server.owner.headers,
      payload: { enabled: true },
    });
    const locked = await server.app.inject({
      url: `/api/auth/saml/${provider.id}/start`,
      remoteAddress: address,
    });
    expect(failureOf(locked)).toBe('sso.locked');
    const fresh = await begin(server, idp, provider);
    expect(failureOf(await post(server, provider, idp.answer(fresh.request), fresh.cookie, address))).toBe(
      'sso.locked',
    );
    const password = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      remoteAddress: address,
      payload: { email: server.owner.email, password: PASSWORD },
    });
    expect(password.statusCode).toBe(429);
    // Another address is unaffected.
    const elsewhere = await signInThrough(server, idp, provider);
    expect((await sessionOf(server, elsewhere)).user.id).toBe(server.owner.userId);
  });

  it('refuses providers that are off or missing, and keeps each protocol to its own routes', async () => {
    const { server, idp } = await setup();
    const off = await addProvider(server, idp, { enabled: false });
    const on = await addProvider(server, idp, { name: 'On' });
    const start = (id: string, protocol = 'saml') =>
      server.app.inject({ url: `/api/auth/${protocol}/${id}/start` });
    expect(failureOf(await start(off.id))).toBe('sso.unavailable');
    expect(failureOf(await start('AAAAAAAAAAAAAAAA'))).toBe('sso.unavailable');
    expect(failureOf(await start('not-an-id'))).toBe('sso.unavailable');
    expect(failureOf(await start(on.id, 'sso'))).toBe('sso.unavailable');
    const google = await server.app.inject({
      method: 'POST',
      url: '/api/admin/sso',
      headers: server.owner.headers,
      payload: { kind: 'google', name: 'Google', clientId: 'id', clientSecret: 'secret' },
    });
    expect(failureOf(await start(google.json<SsoProvider>().id))).toBe('sso.unavailable');
    const empty = await server.app.inject({
      method: 'POST',
      url: `/api/auth/saml/${on.id}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'RelayState=x',
    });
    expect(failureOf(empty)).toBe('sso.state');
  });

  it('serves Riosoma’s metadata for each SAML provider', async () => {
    const { server, idp } = await setup();
    const provider = await addProvider(server, idp, { enabled: false });
    const response = await server.app.inject({ url: `/api/auth/saml/${provider.id}/metadata` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/samlmetadata+xml; charset=utf-8');
    expect(response.body).toBe(provider.saml?.serviceProvider.metadata);
    expect(response.body).toContain(`entityID="${BASE}/api/auth/saml/${provider.id}/metadata"`);
    expect(response.body).toContain(
      `Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl(provider)}"`,
    );
    expect((await server.app.inject({ url: '/api/auth/saml/AAAAAAAAAAAAAAAA/metadata' })).statusCode).toBe(
      404,
    );
    expect((await server.app.inject({ url: '/api/auth/saml/nope/metadata' })).statusCode).toBe(404);
  });
});

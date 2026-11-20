import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SessionInfo,
  type MfaOverview,
  type Passkey,
  type PasskeyAdded,
  type SecondStepRequired,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  FLAGS,
  TestAuthenticator,
  type CreationOptions,
  type RequestOptions,
} from '../../test/authenticator.js';
import { Browser } from '../../test/browser.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { attemptKey } from '../attempts.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = 'a long test password';
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

async function setup(baseUrl = `${BASE}/`) {
  const server = await startServer(kit, 'passkeys', { baseUrl });
  cleanups.push(() => server.close());
  return server;
}

async function signIn(server: ServerFixture, email = server.owner.email, browser = new Browser(server.app)) {
  const response = await browser.post('/api/auth/sign-in', { email, password: PASSWORD });
  expect(response.statusCode).toBe(200);
  return { browser, response };
}

async function creation(browser: Browser): Promise<CreationOptions> {
  const response = await browser.post('/api/me/mfa/passkeys/options');
  expect(response.statusCode).toBe(200);
  return response.json<CreationOptions>();
}

async function addPasskey(
  browser: Browser,
  authenticator = new TestAuthenticator(BASE),
  name = 'Laptop',
  proof?: unknown,
) {
  const response = await browser.post('/api/me/mfa/passkeys', {
    name,
    response: authenticator.register(await creation(browser)),
    ...(proof ? { proof } : {}),
  });
  expect(response.statusCode).toBe(200);
  return { authenticator, added: response.json<PasskeyAdded>() };
}

/** A passkey's answer proving it's you, for a change that takes a fresh second step. */
async function passkeyProof(browser: Browser, authenticator: TestAuthenticator) {
  const response = await browser.post('/api/me/mfa/proof/options');
  expect(response.statusCode).toBe(200);
  return { method: 'passkey', response: authenticator.answer(response.json<RequestOptions>()) };
}

async function signInOptions(browser: Browser): Promise<RequestOptions> {
  const response = await browser.post('/api/auth/passkey/options');
  expect(response.statusCode).toBe(200);
  return response.json<RequestOptions>();
}

function passkeySignIn(browser: Browser, answer: unknown) {
  return browser.post('/api/auth/passkey', { response: answer });
}

async function events(server: ServerFixture, action: string) {
  const result = await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = ${action}
    ORDER BY id`,
  );
  return result.rows;
}

describe('adding passkeys', () => {
  it('registers a passkey bound to this server, and offers recovery codes with the first', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const options = await creation(browser);
    expect(options.rp.id).toBe('riosoma.example.test');
    const raw = options as unknown as {
      authenticatorSelection: { residentKey: string; userVerification: string };
      user: { name: string };
    };
    expect(raw.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(raw.user.name).toBe(server.owner.email);
    expect(browser.cookie('rio_webauthn')).toBeDefined();

    const authenticator = new TestAuthenticator(BASE, { synced: true });
    const added = await browser.post('/api/me/mfa/passkeys', {
      name: '  Laptop  ',
      response: authenticator.register(options),
    });
    expect(added.statusCode).toBe(200);
    const body = added.json<PasskeyAdded>();
    expect(body.passkey).toMatchObject({ name: 'Laptop', synced: true, lastUsedAt: null });
    expect(body.passkey.id).toMatch(/^pky[0-9A-Za-z]{14}$/);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(browser.cookie('rio_webauthn')).toBeUndefined();

    // A second passkey adds no new codes, and the same authenticator can't be added twice.
    const proof = await passkeyProof(browser, authenticator);
    const second = await addPasskey(browser, new TestAuthenticator(BASE), 'Phone', proof);
    expect(second.added.recoveryCodes).toBeNull();
    const again = await browser.post('/api/me/mfa/passkeys', {
      name: 'Again',
      response: authenticator.register(await creation(browser)),
      proof: { method: 'recovery', code: body.recoveryCodes![0] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.messageKey).toBe('mfa.passkey.duplicate');

    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.passkeys.map((passkey) => passkey.name)).toEqual(['Laptop', 'Phone']);
    expect(overview.recoveryCodes.remaining).toBe(10);
    expect(overview.passkeysAvailable).toBe(true);
    const stored = await query<{ public_key: Buffer; user_handle: string }>(
      server.pool,
      sql`SELECT public_key, user_handle FROM ${ident(server.schemas.app, 'passkeys')}`,
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]!.user_handle).toBe(authenticator.userHandle);
    expect((await events(server, 'auth.passkey.added')).length).toBe(2);
  });

  it('signs in with a passkey alone, and only with a real answer', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator } = await addPasskey(browser);

    const visitor = new Browser(server.app);
    const options = await signInOptions(visitor);
    expect(options.rpId).toBe('riosoma.example.test');
    expect((options as { allowCredentials?: unknown[] }).allowCredentials).toBeUndefined();
    const signedIn = await passkeySignIn(visitor, authenticator.answer(options));
    expect(signedIn.statusCode).toBe(200);
    expect(SessionInfo.parse(signedIn.json()).user.email).toBe(server.owner.email);
    expect(visitor.cookie('rio_session')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await visitor.get('/api/auth/session')).statusCode).toBe(200);
    const [event] = await events(server, 'auth.sign_in').then((rows) => rows.slice(-1));
    expect(event!.metadata).toMatchObject({ method: 'passkey' });
  });
});

describe('refusing passkey answers', () => {
  async function ready() {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator } = await addPasskey(browser);
    return { server, browser, authenticator };
  }

  async function refused(server: ServerFixture, answer: (options: RequestOptions) => unknown) {
    const visitor = new Browser(server.app);
    const options = await signInOptions(visitor);
    const response = await passkeySignIn(visitor, answer(options));
    expect(visitor.cookie('rio_session')).toBeUndefined();
    return response;
  }

  it('refuses another origin, another relying party, and a missing user verification', async () => {
    const { server, authenticator } = await ready();
    for (const tamper of [
      { origin: 'https://evil.example.test' },
      { origin: 'http://riosoma.example.test' },
      { rpId: 'evil.example.test' },
      { flags: FLAGS.userPresent },
      { type: 'webauthn.create' },
    ]) {
      const response = await refused(server, (options) => authenticator.answer(options, tamper));
      expect(response.statusCode).toBe(401);
      expect(response.json().error.messageKey).toBe('mfa.passkey.failed');
    }
    expect((await events(server, 'auth.sign_in_failed')).map((event) => event.metadata.reason)).toEqual(
      Array(5).fill('passkey'),
    );
    // The same passkey, answering properly, still gets in.
    const visitor = new Browser(server.app);
    expect(
      (await passkeySignIn(visitor, authenticator.answer(await signInOptions(visitor)))).statusCode,
    ).toBe(200);
  });

  it('refuses registration from another origin or relying party, or without user verification', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    for (const tamper of [
      { origin: 'https://evil.example.test' },
      { rpId: 'evil.example.test' },
      { flags: FLAGS.userPresent | FLAGS.attestedCredential },
    ]) {
      const response = await browser.post('/api/me/mfa/passkeys', {
        name: 'Laptop',
        response: new TestAuthenticator(BASE).register(await creation(browser), tamper),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.messageKey).toBe('mfa.passkey.failed');
    }
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys).toEqual([]);
    expect(await events(server, 'auth.passkey.refused')).toHaveLength(3);
    await addPasskey(browser);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys).toHaveLength(1);
  });

  it('refuses a replayed challenge, even from a copy of the cookie', async () => {
    const { server, authenticator } = await ready();
    const visitor = new Browser(server.app);
    const options = await signInOptions(visitor);
    const answer = authenticator.answer(options);
    const thief = visitor.copy();
    expect((await passkeySignIn(visitor, answer)).statusCode).toBe(200);
    // The browser forgot the challenge, and the copy finds it spent.
    const noCookie = await passkeySignIn(visitor, answer);
    expect(noCookie.statusCode).toBe(400);
    expect(noCookie.json().error.messageKey).toBe('mfa.challenge.expired');
    const replayed = await passkeySignIn(thief, answer);
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json().error.messageKey).toBe('mfa.challenge.expired');
    expect(thief.cookie('rio_session')).toBeUndefined();
    const refusals = await events(server, 'auth.passkey.challenge_refused');
    expect(refusals.map((event) => event.metadata.purpose)).toEqual(['sign-in', 'sign-in']);
  });

  it('lets only one of two answers to the same challenge through', async () => {
    const { server, authenticator } = await ready();
    const visitor = new Browser(server.app);
    const options = await signInOptions(visitor);
    const other = visitor.copy();
    const results = await Promise.all([
      passkeySignIn(visitor, authenticator.answer(options)),
      passkeySignIn(other, authenticator.answer(options)),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 400]);
  });

  it('refuses an expired challenge', async () => {
    const { server, authenticator } = await ready();
    const visitor = new Browser(server.app);
    const options = await signInOptions(visitor);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1_000);
    const response = await passkeySignIn(visitor, authenticator.answer(options));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.messageKey).toBe('mfa.challenge.expired');
  });

  it('refuses a challenge from another browser, or one given for something else', async () => {
    const { server, browser, authenticator } = await ready();
    const first = new Browser(server.app);
    const options = await signInOptions(first);
    const second = new Browser(server.app);
    const elsewhere = await passkeySignIn(second, authenticator.answer(options));
    expect(elsewhere.statusCode).toBe(400);
    // A challenge given for adding a passkey won't sign anyone in.
    const registration = await creation(browser);
    const mixed = await passkeySignIn(
      browser,
      authenticator.answer({ challenge: registration.challenge, rpId: registration.rp.id }),
    );
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.messageKey).toBe('mfa.challenge.expired');
  });

  it('insists a reported signature counter climbs', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator } = await addPasskey(browser, new TestAuthenticator(BASE, { counter: 5 }));
    const first = new Browser(server.app);
    expect((await passkeySignIn(first, authenticator.answer(await signInOptions(first)))).statusCode).toBe(
      200,
    );
    const stored = await query<{ sign_count: string }>(
      server.pool,
      sql`SELECT sign_count FROM ${ident(server.schemas.app, 'passkeys')}`,
    );
    expect(Number(stored.rows[0]!.sign_count)).toBe(6);
    for (const counter of [6, 3, 0]) {
      const visitor = new Browser(server.app);
      const response = await passkeySignIn(
        visitor,
        authenticator.answer(await signInOptions(visitor), { counter }),
      );
      expect(response.statusCode).toBe(401);
    }
    const next = new Browser(server.app);
    expect((await passkeySignIn(next, authenticator.answer(await signInOptions(next)))).statusCode).toBe(200);
  });

  it('accepts a passkey that never counts, as synced passkeys do', async () => {
    const { server, authenticator } = await ready();
    for (let i = 0; i < 2; i++) {
      const visitor = new Browser(server.app);
      expect(
        (await passkeySignIn(visitor, authenticator.answer(await signInOptions(visitor)))).statusCode,
      ).toBe(200);
    }
  });

  it('refuses unknown passkeys, a borrowed user handle, and deactivated people', async () => {
    const { server, authenticator } = await ready();
    const stranger = new TestAuthenticator(BASE);
    stranger.userHandle = authenticator.userHandle;
    expect((await refused(server, (options) => stranger.answer(options))).statusCode).toBe(401);
    const response = await refused(server, (options) =>
      authenticator.answer(options, { userHandle: 'AAAA' }),
    );
    expect(response.statusCode).toBe(401);
    const otherOwner = await server.addMember();
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: `/api/org/members/${otherOwner.userId}/role`,
          headers: server.owner.headers,
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: `/api/org/members/${server.owner.userId}/status`,
          headers: otherOwner.headers,
          payload: { deactivated: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await refused(server, (options) => authenticator.answer(options))).statusCode).toBe(401);
  });

  it('counts failed passkey sign-ins against the address', async () => {
    const { server, authenticator } = await ready();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'auth_attempts')} (key)
      SELECT ${attemptKey('ip', '127.0.0.1')} FROM generate_series(1, 99)`,
    );
    expect(
      (await refused(server, (options) => authenticator.answer(options, { rpId: 'evil.example.test' })))
        .statusCode,
    ).toBe(401);
    const locked = await refused(server, (options) => authenticator.answer(options));
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.messageKey).toBe('mfa.locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('turns passkeys off when the public address is not secure', async () => {
    const server = await setup('http://192.0.2.10:8080/');
    expect((await server.app.inject({ url: '/api/auth/methods' })).json().passkey).toBe(false);
    const response = await new Browser(server.app).post('/api/auth/passkey/options');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.messageKey).toBe('mfa.passkey.unavailable');
    const { browser } = await signIn(server);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeysAvailable).toBe(false);
  });
});

describe('managing passkeys', () => {
  it('lists, renames, and removes only your own passkeys', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const laptop = await addPasskey(browser, new TestAuthenticator(BASE), 'Laptop');
    const proof = await passkeyProof(browser, laptop.authenticator);
    const { added } = await addPasskey(browser, new TestAuthenticator(BASE), 'Phone', proof);
    const renamed = await browser.patch(`/api/me/mfa/passkeys/${added.passkey.id}`, { name: 'Work phone' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Passkey>().name).toBe('Work phone');
    expect(
      (await browser.patch(`/api/me/mfa/passkeys/${added.passkey.id}`, { name: '   ' })).statusCode,
    ).toBe(422);

    const member = await server.addMember();
    const theirs = new Browser(server.app);
    theirs.setCookie('rio_session', member.headers.cookie.split('=')[1]!);
    theirs.csrf = member.headers['x-csrf-token'];
    expect(
      (await theirs.patch(`/api/me/mfa/passkeys/${added.passkey.id}`, { name: 'Mine' })).statusCode,
    ).toBe(404);
    expect((await theirs.delete(`/api/me/mfa/passkeys/${added.passkey.id}`)).statusCode).toBe(404);

    // Another passkey remains, so this one goes without a fresh second step.
    expect((await browser.delete(`/api/me/mfa/passkeys/${added.passkey.id}`)).statusCode).toBe(204);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys.map((p) => p.name)).toEqual([
      'Laptop',
    ]);
    expect((await events(server, 'auth.passkey.renamed')).length).toBe(1);
    expect((await events(server, 'auth.passkey.removed')).length).toBe(1);
  });

  it('needs a fresh second step to remove the last one, and then drops the recovery codes', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator, added } = await addPasskey(browser);
    const url = `/api/me/mfa/passkeys/${added.passkey.id}`;
    const bare = await browser.delete(url);
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys).toHaveLength(1);

    const options = await browser.post('/api/me/mfa/proof/options');
    expect(options.statusCode).toBe(200);
    const request = options.json<RequestOptions & { allowCredentials: Array<{ id: string }> }>();
    expect(request.allowCredentials.map((entry) => entry.id)).toEqual([authenticator.id]);
    const removed = await browser.delete(url, {
      proof: { method: 'passkey', response: authenticator.answer(request) },
    });
    expect(removed.statusCode).toBe(204);
    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.passkeys).toEqual([]);
    expect(overview.recoveryCodes.remaining).toBe(0);
    expect((await events(server, 'auth.passkey.removed'))[0]!.metadata).toMatchObject({ proof: 'passkey' });
  });

  it('accepts a recovery code as the fresh second step, once', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { added } = await addPasskey(browser);
    const code = added.recoveryCodes![0]!;
    const url = `/api/me/mfa/passkeys/${added.passkey.id}`;
    const wrong = await browser.delete(url, { proof: { method: 'recovery', code: 'aaaaa-bbbbb' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    expect(
      (await browser.delete(url, { proof: { method: 'recovery', code: code.toUpperCase() } })).statusCode,
    ).toBe(204);
  });

  it('binds a proof challenge to the session that asked for it', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator, added } = await addPasskey(browser);
    const options = (await browser.post('/api/me/mfa/proof/options')).json<RequestOptions>();
    // The same person's other session, carried into this browser, isn't the one the challenge was for.
    const other = new Browser(server.app);
    expect((await passkeySignIn(other, authenticator.answer(await signInOptions(other)))).statusCode).toBe(
      200,
    );
    browser.setCookie('rio_session', other.cookie('rio_session')!);
    browser.csrf = other.csrf;
    const response = await browser.delete(`/api/me/mfa/passkeys/${added.passkey.id}`, {
      proof: { method: 'passkey', response: authenticator.answer(options) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.messageKey).toBe('mfa.challenge.expired');
  });

  it('keeps passkey routes behind a session and its CSRF token', async () => {
    const server = await setup();
    const anonymous = new Browser(server.app);
    expect((await anonymous.get('/api/me/mfa')).statusCode).toBe(401);
    expect((await anonymous.post('/api/me/mfa/passkeys/options')).statusCode).toBe(401);
    const { browser } = await signIn(server);
    browser.csrf = 'wrong';
    const response = await browser.post('/api/me/mfa/passkeys/options');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.messageKey).toBe('errors.csrfMismatch');
  });

  it('sends a password sign-in with a passkey on to the second step', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator } = await addPasskey(browser);
    const visitor = new Browser(server.app);
    const first = await visitor.post('/api/auth/sign-in', { email: server.owner.email, password: PASSWORD });
    expect(first.statusCode).toBe(200);
    expect(first.json<SecondStepRequired>().secondStep).toMatchObject({
      stage: 'verify',
      methods: ['passkey', 'recovery'],
      email: server.owner.email,
    });
    expect(visitor.cookie('rio_session')).toBeUndefined();
    const options = await visitor.post('/api/auth/second-step/options');
    const request = options.json<RequestOptions & { allowCredentials: Array<{ id: string }> }>();
    expect(request.allowCredentials.map((entry) => entry.id)).toEqual([authenticator.id]);
    const done = await visitor.post('/api/auth/second-step', {
      method: 'passkey',
      response: authenticator.answer(request),
    });
    expect(done.statusCode).toBe(200);
    expect(SessionInfo.parse(done.json()).user.email).toBe(server.owner.email);
    expect(visitor.cookie('rio_second_step')).toBeUndefined();
    const [event] = (await events(server, 'auth.sign_in')).slice(-1);
    expect(event!.metadata).toMatchObject({ method: 'password', secondStep: 'passkey' });
  });
});

describe('adding a passkey beside another second step', () => {
  it('takes a fresh second step, checked with the new passkey', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator, added } = await addPasskey(browser);
    const codes = added.recoveryCodes!;
    const attempt = async (proof?: unknown) =>
      browser.post('/api/me/mfa/passkeys', {
        name: 'Phone',
        response: new TestAuthenticator(BASE).register(await creation(browser)),
        ...(proof ? { proof } : {}),
      });
    const bare = await attempt();
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    const wrong = await attempt({ method: 'recovery', code: 'aaaaa-bbbbb' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    // Another person's passkey proves nothing about this one.
    const stranger = new TestAuthenticator(BASE);
    stranger.userHandle = authenticator.userHandle;
    const borrowed = await attempt(await passkeyProof(browser, stranger));
    expect(borrowed.statusCode).toBe(403);
    expect(borrowed.json().error.messageKey).toBe('mfa.passkey.failed');
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys).toHaveLength(1);
    const failed = await events(server, 'auth.second_step.failed');
    expect(failed.map((event) => event.metadata.method)).toEqual(['recovery', 'passkey']);

    // A recovery code proves it once.  A passkey's answer comes with the new passkey's own.
    expect((await attempt({ method: 'recovery', code: codes[0] })).statusCode).toBe(200);
    expect((await attempt({ method: 'recovery', code: codes[0] })).statusCode).toBe(403);
    expect((await attempt(await passkeyProof(browser, authenticator))).statusCode).toBe(200);
    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.passkeys).toHaveLength(3);
    expect(overview.recoveryCodes.remaining).toBe(9);
    const addedEvents = await events(server, 'auth.passkey.added');
    expect(addedEvents.map((event) => event.metadata.proof)).toEqual([undefined, 'recovery', 'passkey']);
  });

  it('keeps the proof’s challenge apart from the new passkey’s', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const { authenticator } = await addPasskey(browser);
    const proof = await passkeyProof(browser, authenticator);
    const registration = await creation(browser);
    const proofChallenge = browser.cookie('rio_webauthn_proof')!;
    expect(proofChallenge).toBeDefined();
    expect(browser.cookie('rio_webauthn')).toBeDefined();
    // The proof's sealed challenge in the new passkey's place is refused, and so is the reverse.
    browser.setCookie('rio_webauthn', proofChallenge);
    const swapped = await browser.post('/api/me/mfa/passkeys', {
      name: 'Phone',
      response: new TestAuthenticator(BASE).register(registration),
      proof,
    });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json().error.messageKey).toBe('mfa.challenge.expired');
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys).toHaveLength(1);
  });
});

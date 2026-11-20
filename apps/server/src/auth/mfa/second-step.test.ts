import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  SessionInfo,
  type AuthenticatorConfirmed,
  type AuthenticatorSetup,
  type MfaOverview,
  type PasskeyAdded,
  type RecoveryCodes,
  type SecondStepRequired,
  type SecondStepStatus,
  type TokenCreated,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { Mailer, MailMessage } from '../../mail/index.js';
import { TestAuthenticator, type CreationOptions, type RequestOptions } from '../../test/authenticator.js';
import { Browser } from '../../test/browser.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { attemptKey } from '../attempts.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = 'a long test password';
const STEP = 30_000;
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

/** The server's clock, held still so codes are predictable: always the middle of a time step. */
let now = 0;
function holdClock(): void {
  now = Math.floor(Date.now() / STEP) * STEP + STEP / 2;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
}

/** The code an authenticator app would show, some steps from now. */
function code(secret: string, steps = 0): Promise<string> {
  return generate({ secret, epoch: Math.floor(now / 1000) + steps * 30 });
}

class MemoryMailer implements Mailer {
  messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }
}

async function setup() {
  const server = await startServer(kit, 'secondstep', { baseUrl: `${BASE}/` });
  cleanups.push(() => server.close());
  holdClock();
  return server;
}

async function signIn(server: ServerFixture, email = server.owner.email, browser = new Browser(server.app)) {
  const response = await browser.post('/api/auth/sign-in', { email, password: PASSWORD });
  expect(response.statusCode).toBe(200);
  return { browser, response };
}

/** Turns on an authenticator app for the owner, then moves the clock on so the next code is new. */
async function withAuthenticator(server: ServerFixture) {
  const { browser } = await signIn(server);
  const started = await browser.post('/api/me/mfa/authenticator');
  expect(started.statusCode).toBe(200);
  const { secret } = started.json<AuthenticatorSetup>();
  const confirmed = await browser.post('/api/me/mfa/authenticator/confirm', { code: await code(secret) });
  expect(confirmed.statusCode).toBe(200);
  now += 10 * STEP;
  return { browser, secret, recoveryCodes: confirmed.json<AuthenticatorConfirmed>().recoveryCodes! };
}

/** A password sign-in that stops at the second step. */
async function pending(server: ServerFixture, browser = new Browser(server.app)) {
  const { response } = await signIn(server, server.owner.email, browser);
  expect(response.json<SecondStepRequired>().secondStep.stage).toBe('verify');
  expect(browser.cookie('rio_second_step')).toBeDefined();
  expect(browser.cookie('rio_session')).toBeUndefined();
  return browser;
}

function finish(browser: Browser, proof: unknown) {
  return browser.post('/api/auth/second-step', proof);
}

async function events(server: ServerFixture) {
  const result = await query<{ action: string; actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT action, actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} ORDER BY id`,
  );
  return result.rows;
}

describe('authenticator apps', () => {
  it('sets up with a sealed secret and an otpauth address, and turns on with a code', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const started = await browser.post('/api/me/mfa/authenticator');
    expect(started.statusCode).toBe(200);
    const { secret, uri } = started.json<AuthenticatorSetup>();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const address = new URL(uri);
    expect(address.protocol).toBe('otpauth:');
    expect(address.searchParams.get('secret')).toBe(secret);
    expect(address.searchParams.get('issuer')).toBe('Riosoma');
    expect(decodeURIComponent(address.pathname)).toContain(server.owner.email);
    const stored = await query<{ sealed_secret: string; confirmed_at: Date | null }>(
      server.pool,
      sql`SELECT sealed_secret, confirmed_at FROM ${ident(server.schemas.app, 'authenticator_secrets')}`,
    );
    expect(stored.rows[0]!.sealed_secret).toMatch(/^rio1\./);
    expect(stored.rows[0]!.sealed_secret).not.toContain(secret);
    expect(stored.rows[0]!.confirmed_at).toBeNull();
    // Not on until confirmed: a sign-in still needs nothing more.
    expect((await signIn(server)).response.json<SessionInfo>().csrfToken).toBeDefined();

    // Starting over replaces the unconfirmed secret.
    const again = (await browser.post('/api/me/mfa/authenticator')).json<AuthenticatorSetup>();
    expect(again.secret).not.toBe(secret);
    const stale = await browser.post('/api/me/mfa/authenticator/confirm', { code: await code(secret) });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.messageKey).toBe('mfa.code.invalid');

    const confirmed = await browser.post('/api/me/mfa/authenticator/confirm', {
      code: ` ${(await code(again.secret)).replace(/(\d{3})/, '$1 ')} `,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<AuthenticatorConfirmed>().recoveryCodes).toHaveLength(10);
    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.authenticator.enabled).toBe(true);
    expect(overview.recoveryCodes.remaining).toBe(10);
    const actions = (await events(server)).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.authenticator.started',
        'auth.authenticator.enabled',
        'auth.recovery_codes.generated',
      ]),
    );
  });

  it('turns off only with a fresh second step', async () => {
    const server = await setup();
    const { browser, secret } = await withAuthenticator(server);
    const bare = await browser.delete('/api/me/mfa/authenticator');
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    const wrong = await browser.delete('/api/me/mfa/authenticator', {
      proof: { method: 'authenticator', code: await code(secret, 5) },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    const off = await browser.delete('/api/me/mfa/authenticator', {
      proof: { method: 'authenticator', code: await code(secret) },
    });
    expect(off.statusCode).toBe(204);
    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.authenticator.enabled).toBe(false);
    expect(overview.recoveryCodes.remaining).toBe(0);
    const disabled = (await events(server)).find((event) => event.action === 'auth.authenticator.disabled');
    expect(disabled!.metadata).toEqual({ proof: 'authenticator' });
    // With no second step left, a password is enough again.
    expect(SessionInfo.safeParse((await signIn(server)).response.json()).success).toBe(true);
  });
});

describe('the second step after a password', () => {
  it('opens nothing but the second-step routes until it passes', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const browser = await pending(server);
    const state = (await browser.get('/api/auth/second-step')).json<SecondStepStatus>();
    expect(state.secondStep).toMatchObject({
      stage: 'verify',
      methods: ['authenticator', 'recovery'],
      email: server.owner.email,
    });
    for (const [method, url] of [
      ['GET', '/api/auth/session'],
      ['GET', '/api/databases'],
      ['GET', '/api/me/mfa'],
      ['POST', '/api/me/mfa/recovery-codes'],
      ['POST', '/api/me/mfa/authenticator'],
      ['GET', '/api/admin/mfa/policy'],
      ['GET', '/api/tokens'],
    ] as const) {
      expect((await browser.send(method, url)).statusCode).toBe(401);
    }
    // The pending cookie is no session, whatever it's called.
    const forged = browser.copy();
    forged.setCookie('rio_session', browser.cookie('rio_second_step')!);
    expect((await forged.get('/api/auth/session')).statusCode).toBe(401);

    const done = await finish(browser, { method: 'authenticator', code: await code(secret) });
    expect(done.statusCode).toBe(200);
    const session = SessionInfo.parse(done.json());
    expect(session.user.email).toBe(server.owner.email);
    expect(browser.cookie('rio_second_step')).toBeUndefined();
    expect((await browser.get('/api/auth/session')).statusCode).toBe(200);
    expect((await browser.get('/api/me/mfa')).statusCode).toBe(200);
    expect((await browser.get('/api/auth/second-step')).json<SecondStepStatus>().secondStep).toBeNull();
  });

  it('takes a code from one step either side of now, and each step once', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const attempt = async (steps: number) =>
      finish(await pending(server), { method: 'authenticator', code: await code(secret, steps) });
    for (const steps of [-2, 2]) {
      const refused = await attempt(steps);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error.messageKey).toBe('mfa.code.invalid');
    }
    expect((await attempt(-1)).statusCode).toBe(200);
    expect((await attempt(-1)).statusCode).toBe(401);
    expect((await attempt(0)).statusCode).toBe(200);
    expect((await attempt(1)).statusCode).toBe(200);
    // Every step in reach is used, including the current one.
    expect((await attempt(0)).statusCode).toBe(401);
    expect((await attempt(1)).statusCode).toBe(401);
    now += STEP;
    expect((await attempt(1)).statusCode).toBe(200);
  });

  it('counts wrong codes toward the lockout passwords share, which a right password does not reset', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const browser = await pending(server);
    for (let i = 0; i < 9; i++)
      expect(
        (await finish(browser, { method: 'authenticator', code: await code(secret, 4) })).statusCode,
      ).toBe(401);
    // Signing in again with the right password leaves the count alone.
    const again = await pending(server);
    expect((await finish(again, { method: 'authenticator', code: await code(secret, 4) })).statusCode).toBe(
      401,
    );
    const locked = await finish(again, { method: 'authenticator', code: await code(secret) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatchObject({ code: 'rate_limited', messageKey: 'mfa.locked' });
    expect(Number(locked.headers['retry-after'])).toBe(locked.json().error.params.retryAfterSeconds);
    // The password is locked out along with the codes.
    const password = await new Browser(server.app).post('/api/auth/sign-in', {
      email: server.owner.email,
      password: PASSWORD,
    });
    expect(password.statusCode).toBe(429);
    const failed = (await events(server)).filter((event) => event.action === 'auth.second_step.failed');
    expect(failed.map((event) => event.metadata.reason)).toEqual([...Array(10).fill('invalid'), 'locked']);
  });

  it('shares the per-address limit with every other sign-in', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const ip = '203.0.113.20';
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'auth_attempts')} (key)
      SELECT ${attemptKey('ip', ip)} FROM generate_series(1, 99)`,
    );
    const browser = await pending(server, new Browser(server.app, ip));
    expect((await finish(browser, { method: 'authenticator', code: await code(secret, 3) })).statusCode).toBe(
      401,
    );
    expect((await finish(browser, { method: 'authenticator', code: await code(secret) })).statusCode).toBe(
      429,
    );
  });

  it('takes each recovery code once, however it is typed', async () => {
    const server = await setup();
    const { recoveryCodes } = await withAuthenticator(server);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const entry of recoveryCodes) expect(entry).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
    const [first, second] = recoveryCodes as [string, string];
    expect((await finish(await pending(server), { method: 'recovery', code: first })).statusCode).toBe(200);
    const reused = await finish(await pending(server), { method: 'recovery', code: first });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.messageKey).toBe('mfa.code.invalid');
    const typed = ` ${second.toUpperCase().replace('-', ' ')} `;
    expect((await finish(await pending(server), { method: 'recovery', code: typed })).statusCode).toBe(200);
    const stored = await query<{ code_hash: string; used_at: Date | null }>(
      server.pool,
      sql`SELECT code_hash, used_at FROM ${ident(server.schemas.app, 'recovery_codes')}`,
    );
    expect(stored.rows).toHaveLength(10);
    expect(stored.rows.filter((row) => row.used_at)).toHaveLength(2);
    for (const row of stored.rows) expect(row.code_hash).toMatch(/^\$argon2id\$/);
    const used = (await events(server)).filter((event) => event.action === 'auth.recovery_code.used');
    expect(used.map((event) => event.metadata.remaining)).toEqual([9, 8]);
  });

  it('replaces the whole set of recovery codes when they are made again', async () => {
    const server = await setup();
    const { browser, secret, recoveryCodes } = await withAuthenticator(server);
    const made = await browser.post('/api/me/mfa/recovery-codes', {
      proof: { method: 'authenticator', code: await code(secret) },
    });
    expect(made.statusCode).toBe(200);
    const fresh = made.json<RecoveryCodes>().codes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((entry) => recoveryCodes.includes(entry))).toBe(false);
    expect(
      (await finish(await pending(server), { method: 'recovery', code: recoveryCodes[2]! })).statusCode,
    ).toBe(401);
    expect((await finish(await pending(server), { method: 'recovery', code: fresh[0]! })).statusCode).toBe(
      200,
    );
  });

  it('refuses recovery codes to someone without a second step', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const response = await browser.post('/api/me/mfa/recovery-codes');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.messageKey).toBe('mfa.recovery.noSecondStep');
  });

  it('expires after ten minutes', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const browser = await pending(server);
    now += 10 * 60_000 + 1_000;
    const late = await finish(browser, { method: 'authenticator', code: await code(secret) });
    expect(late.statusCode).toBe(401);
    expect(late.json().error.messageKey).toBe('mfa.pending.expired');
    expect((await browser.get('/api/auth/second-step')).json<SecondStepStatus>().secondStep).toBeNull();
  });

  it('finishes once, and a canceled one stays canceled', async () => {
    const server = await setup();
    const { secret } = await withAuthenticator(server);
    const browser = await pending(server);
    const copy = browser.copy();
    expect((await finish(browser, { method: 'authenticator', code: await code(secret) })).statusCode).toBe(
      200,
    );
    const replayed = await finish(copy, { method: 'authenticator', code: await code(secret, 1) });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().error.messageKey).toBe('mfa.pending.expired');

    const abandoned = await pending(server);
    const kept = abandoned.copy();
    expect((await abandoned.delete('/api/auth/second-step')).statusCode).toBe(204);
    expect(abandoned.cookie('rio_second_step')).toBeUndefined();
    const after = await finish(kept, { method: 'authenticator', code: await code(secret, 1) });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.messageKey).toBe('mfa.pending.expired');
    expect((await events(server)).some((event) => event.action === 'auth.second_step.canceled')).toBe(true);
  });

  it('refuses a pending state that was altered or sealed for something else', async () => {
    const server = await setup();
    await withAuthenticator(server);
    const browser = await pending(server);
    const value = browser.cookie('rio_second_step')!;
    browser.setCookie('rio_second_step', `${value.slice(0, -4)}AAAA`);
    expect((await browser.get('/api/auth/second-step')).json<SecondStepStatus>().secondStep).toBeNull();
    const response = await finish(browser, { method: 'recovery', code: 'aaaaa-bbbbb' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.messageKey).toBe('mfa.pending.expired');
  });

  it('also follows an emailed sign-in link', async () => {
    const server = await setup();
    const mailer = new MemoryMailer();
    server.ctx.mailer = mailer;
    const { secret } = await withAuthenticator(server);
    const browser = new Browser(server.app);
    expect((await browser.post('/api/auth/link', { email: server.owner.email })).statusCode).toBe(202);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(mailer.messages[0]!.text)![1]!;
    const redeemed = await browser.post('/api/auth/link/redeem', { token });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json<SecondStepRequired>().secondStep.stage).toBe('verify');
    expect(browser.cookie('rio_session')).toBeUndefined();
    const done = await finish(browser, { method: 'authenticator', code: await code(secret) });
    expect(done.statusCode).toBe(200);
    const signIn = (await events(server)).filter((event) => event.action === 'auth.sign_in').at(-1);
    expect(signIn!.metadata).toMatchObject({ method: 'link', secondStep: 'authenticator' });
  });

  it('records every step without codes, secrets, or cookies', async () => {
    const server = await setup();
    const { browser, secret, recoveryCodes } = await withAuthenticator(server);
    const waiting = await pending(server);
    const pendingCookie = waiting.cookie('rio_second_step')!;
    const wrong = await code(secret, 7);
    await finish(waiting, { method: 'authenticator', code: wrong });
    const right = await code(secret);
    await finish(waiting, { method: 'authenticator', code: right });
    await finish(await pending(server), { method: 'recovery', code: recoveryCodes[0]! });
    const proofCode = await code(secret, 1);
    const made = (
      await browser.post('/api/me/mfa/recovery-codes', {
        proof: { method: 'authenticator', code: proofCode },
      })
    ).json<RecoveryCodes>().codes;
    const all = await events(server);
    const actions = all.map((event) => event.action);
    for (const action of [
      'auth.second_step.required',
      'auth.second_step.failed',
      'auth.sign_in',
      'auth.recovery_code.used',
      'auth.recovery_codes.generated',
    ])
      expect(actions).toContain(action);
    const serialized = JSON.stringify(all);
    for (const secretValue of [
      secret,
      wrong,
      right,
      proofCode,
      ...recoveryCodes,
      ...made,
      pendingCookie,
      browser.cookie('rio_session')!,
    ])
      expect(serialized).not.toContain(secretValue);
  });
});

describe('changes that take a fresh second step', () => {
  it('makes new recovery codes only with one, each time', async () => {
    const server = await setup();
    const { browser, secret, recoveryCodes } = await withAuthenticator(server);
    const renew = (proof?: unknown) =>
      browser.post('/api/me/mfa/recovery-codes', proof === undefined ? undefined : { proof });
    const bare = await renew();
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    const wrong = await renew({ method: 'authenticator', code: await code(secret, 5) });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    // The codes from before still work, one of them as the proof itself.
    const made = await renew({ method: 'recovery', code: recoveryCodes[0] });
    expect(made.statusCode).toBe(200);
    const fresh = made.json<RecoveryCodes>().codes;
    expect(fresh.some((entry) => recoveryCodes.includes(entry))).toBe(false);
    // An app code proves it once.
    expect((await renew({ method: 'authenticator', code: await code(secret) })).statusCode).toBe(200);
    expect((await renew({ method: 'authenticator', code: await code(secret) })).statusCode).toBe(403);
    const all = await events(server);
    const generated = all.filter((event) => event.action === 'auth.recovery_codes.generated');
    expect(generated.slice(1).map((event) => event.metadata)).toEqual([
      { count: 10, proof: 'recovery' },
      { count: 10, proof: 'authenticator' },
    ]);
    const failed = all.filter((event) => event.action === 'auth.second_step.failed');
    expect(failed.map((event) => event.metadata.method)).toEqual(['authenticator', 'authenticator']);
  });

  it('turns on an app beside a passkey only with one, and keeps it when the new code is wrong', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const options = (await browser.post('/api/me/mfa/passkeys/options')).json<CreationOptions>();
    const added = await browser.post('/api/me/mfa/passkeys', {
      name: 'Laptop',
      response: new TestAuthenticator(BASE).register(options),
    });
    const codes = added.json<PasskeyAdded>().recoveryCodes!;
    const { secret } = (await browser.post('/api/me/mfa/authenticator')).json<AuthenticatorSetup>();
    const confirm = (body: object) => browser.post('/api/me/mfa/authenticator/confirm', body);
    const bare = await confirm({ code: await code(secret) });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    const wrongProof = await confirm({
      code: await code(secret),
      proof: { method: 'recovery', code: 'aaaaa-bbbbb' },
    });
    expect(wrongProof.statusCode).toBe(403);
    expect(wrongProof.json().error.messageKey).toBe('mfa.code.invalid');
    expect(wrongProof.json().error.fields).toBeUndefined();
    // A wrong code from the new app is told apart, and the recovery code sent with it is still unused.
    const wrongCode = await confirm({
      code: await code(secret, 5),
      proof: { method: 'recovery', code: codes[0] },
    });
    expect(wrongCode.statusCode).toBe(403);
    expect(wrongCode.json().error.fields).toEqual({ code: 'mfa.code.invalid' });
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>()).toMatchObject({
      authenticator: { enabled: false },
      recoveryCodes: { remaining: 10 },
    });
    const done = await confirm({ code: await code(secret), proof: { method: 'recovery', code: codes[0] } });
    expect(done.statusCode).toBe(200);
    expect(done.json<AuthenticatorConfirmed>().recoveryCodes).toBeNull();
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>()).toMatchObject({
      authenticator: { enabled: true },
      recoveryCodes: { remaining: 9 },
    });
    const all = await events(server);
    expect(all.find((event) => event.action === 'auth.authenticator.enabled')!.metadata).toEqual({
      proof: 'recovery',
    });
    const failed = all.filter((event) => event.action === 'auth.second_step.failed');
    expect(failed.map((event) => event.metadata.method)).toEqual(['recovery', 'authenticator']);
    // The recovery code was used once, by the change that went through.
    const used = all.filter((event) => event.action === 'auth.recovery_code.used');
    expect(used.map((event) => event.metadata.remaining)).toEqual([9]);
  });

  it('replaces the app only with one, and the app that was on works until then', async () => {
    const server = await setup();
    const { browser, secret, recoveryCodes } = await withAuthenticator(server);
    const started = await browser.post('/api/me/mfa/authenticator');
    expect(started.statusCode).toBe(200);
    const next = started.json<AuthenticatorSetup>().secret;
    expect(next).not.toBe(secret);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().authenticator.enabled).toBe(true);
    // The app that's on still signs in while its replacement waits.
    const signedIn = await finish(await pending(server), {
      method: 'authenticator',
      code: await code(secret),
    });
    expect(signedIn.statusCode).toBe(200);
    const confirm = (body: object) => browser.post('/api/me/mfa/authenticator/confirm', body);
    const bare = await confirm({ code: await code(next) });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    // A code from the new app can't stand in for one from the app it replaces.
    const own = await confirm({
      code: await code(next),
      proof: { method: 'authenticator', code: await code(next) },
    });
    expect(own.statusCode).toBe(403);
    expect(own.json().error.fields).toBeUndefined();
    const replaced = await confirm({
      code: await code(next),
      proof: { method: 'authenticator', code: await code(secret, 1) },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<AuthenticatorConfirmed>().recoveryCodes).toBeNull();
    // Now only the new app works, beside the same recovery codes.
    now += 10 * STEP;
    const old = await finish(await pending(server), { method: 'authenticator', code: await code(secret) });
    expect(old.statusCode).toBe(401);
    const fresh = await finish(await pending(server), { method: 'authenticator', code: await code(next) });
    expect(fresh.statusCode).toBe(200);
    expect(
      (await finish(await pending(server), { method: 'recovery', code: recoveryCodes[1]! })).statusCode,
    ).toBe(200);
    const all = await events(server);
    const starts = all.filter((event) => event.action === 'auth.authenticator.started');
    expect(starts.map((event) => event.metadata)).toEqual([{}, { replacing: true }]);
    expect(all.find((event) => event.action === 'auth.authenticator.replaced')!.metadata).toEqual({
      proof: 'authenticator',
    });
  });

  it('lets a session alone add no way in and take none away', async () => {
    const server = await setup();
    const { browser, secret } = await withAuthenticator(server);
    // Anyone holding a copy of the session cookie, without the person's app or passkey.
    const thief = browser.copy();
    const refused = [
      await thief.post('/api/me/mfa/recovery-codes'),
      await thief.delete('/api/me/mfa/authenticator'),
    ];
    const next = (await thief.post('/api/me/mfa/authenticator')).json<AuthenticatorSetup>().secret;
    refused.push(await thief.post('/api/me/mfa/authenticator/confirm', { code: await code(next) }));
    const options = (await thief.post('/api/me/mfa/passkeys/options')).json<CreationOptions>();
    refused.push(
      await thief.post('/api/me/mfa/passkeys', {
        name: 'Mine',
        response: new TestAuthenticator(BASE).register(options),
      }),
    );
    refused.push(
      await thief.post('/api/tokens', { name: 'Mine', scopes: ['data.records:read'], databases: 'all' }),
    );
    for (const response of refused) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.messageKey).toBe('mfa.proof.required');
    }
    expect((await browser.get('/api/tokens')).json()).toEqual([]);
    const overview = (await browser.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview.passkeys).toEqual([]);
    expect(overview.authenticator.enabled).toBe(true);
    expect(overview.recoveryCodes.remaining).toBe(10);
    // The person's own app still works, and the waiting replacement never took over.
    const signedIn = await finish(await pending(server), {
      method: 'authenticator',
      code: await code(secret),
    });
    expect(signedIn.statusCode).toBe(200);
    const stolen = await finish(await pending(server), {
      method: 'authenticator',
      code: await code(next, 1),
    });
    expect(stolen.statusCode).toBe(401);
  });
});

describe('personal access tokens', () => {
  const TOKEN = {
    name: 'Nightly sync',
    scopes: ['data.records:read', 'schema.bases:read'],
    databases: 'all',
  };

  async function tokens(server: ServerFixture) {
    const result = await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'api_tokens')} ORDER BY created_at`,
    );
    return result.rows;
  }

  it('are made as before by someone without a second step', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const made = await browser.post('/api/tokens', TOKEN);
    expect(made.statusCode).toBe(200);
    expect(made.json<TokenCreated>().token).toMatch(/^rio_pat_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
    const created = (await events(server)).filter((event) => event.action === 'auth.token.created');
    expect(created.map((event) => event.metadata)).toEqual([{ tokenId: made.json<TokenCreated>().id }]);
  });

  it('take a fresh second step, used up with the token itself', async () => {
    const server = await setup();
    const { browser, secret, recoveryCodes } = await withAuthenticator(server);
    const create = (body: object = {}) => browser.post('/api/tokens', { ...TOKEN, ...body });
    const bare = await create();
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.messageKey).toBe('mfa.proof.required');
    const wrong = await create({ proof: { method: 'authenticator', code: await code(secret, 5) } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    expect(await tokens(server)).toEqual([]);

    const proof = { method: 'authenticator', code: await code(secret) };
    const made = await create({ proof });
    expect(made.statusCode).toBe(200);
    const token = made.json<TokenCreated>();
    expect(
      (
        await server.app.inject({
          url: '/api/v1/databases',
          headers: { authorization: `Bearer ${token.token}` },
        })
      ).statusCode,
    ).toBe(200);
    // Each proof makes one token.
    const again = await create({ proof });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.messageKey).toBe('mfa.code.invalid');
    expect((await create({ proof: { method: 'recovery', code: recoveryCodes[0] } })).statusCode).toBe(200);
    expect((await create({ proof: { method: 'recovery', code: recoveryCodes[0] } })).statusCode).toBe(403);
    expect(await tokens(server)).toHaveLength(2);

    const all = await events(server);
    const created = all.filter((event) => event.action === 'auth.token.created');
    expect(created.map((event) => event.metadata.proof)).toEqual(['authenticator', 'recovery']);
    const failed = all.filter((event) => event.action === 'auth.second_step.failed');
    expect(failed.map((event) => event.metadata.method)).toEqual([
      'authenticator',
      'authenticator',
      'recovery',
    ]);
    const serialized = JSON.stringify(all);
    for (const value of [token.token, proof.code, recoveryCodes[0]!]) expect(serialized).not.toContain(value);
  });

  it('keep the proof when the token itself is refused', async () => {
    const server = await setup();
    const { browser, recoveryCodes } = await withAuthenticator(server);
    const proof = { method: 'recovery', code: recoveryCodes[0] };
    // A database this person can't open, which the token route refuses after the proof is used.
    const refused = await browser.post('/api/tokens', { ...TOKEN, databases: [newId('database')], proof });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.messageKey).toBe('errors.tokenDatabase');
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().recoveryCodes.remaining).toBe(10);
    expect((await browser.post('/api/tokens', { ...TOKEN, proof })).statusCode).toBe(200);
  });

  it('take a passkey as the proof, and count wrong proofs toward the lockout', async () => {
    const server = await setup();
    const { browser } = await signIn(server);
    const authenticator = new TestAuthenticator(BASE);
    const options = (await browser.post('/api/me/mfa/passkeys/options')).json<CreationOptions>();
    expect(
      (
        await browser.post('/api/me/mfa/passkeys', {
          name: 'Laptop',
          response: authenticator.register(options),
        })
      ).statusCode,
    ).toBe(200);
    const proofOptions = (await browser.post('/api/me/mfa/proof/options')).json<RequestOptions>();
    const made = await browser.post('/api/tokens', {
      ...TOKEN,
      proof: { method: 'passkey', response: authenticator.answer(proofOptions) },
    });
    expect(made.statusCode).toBe(200);
    // Nine earlier failures for this account, then a wrong proof, lock out the next try.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'auth_attempts')} (key)
      SELECT ${attemptKey('email', server.owner.email)} FROM generate_series(1, 9)`,
    );
    const wrong = await browser.post('/api/tokens', {
      ...TOKEN,
      proof: { method: 'recovery', code: 'aaaaa-bbbbb' },
    });
    expect(wrong.statusCode).toBe(403);
    const next = (await browser.post('/api/me/mfa/proof/options')).json<RequestOptions>();
    const locked = await browser.post('/api/tokens', {
      ...TOKEN,
      proof: { method: 'passkey', response: authenticator.answer(next) },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.messageKey).toBe('mfa.locked');
    expect(await tokens(server)).toHaveLength(1);
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionInfo, type DatabaseProfile } from '@riosoma/contracts';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp, type AppContext } from '../app.js';
import { loadConfig, readStored, type RuntimeConfig } from '../config.js';
import { NO_SESSIONS } from '../http/policy.js';
import type { Mailer, MailMessage } from '../mail/index.js';
import { MIGRATIONS } from '../migrations/index.js';
import { SetupState } from '../setup/state.js';
import { useMainAuthority } from '../test/fixture.js';
import { attemptKey } from './attempts.js';
import { tokenHash } from './database.js';
import * as passwords from './passwords.js';

const OWNER = {
  orgName: 'Test organization',
  name: 'Owner',
  email: 'owner@example.test',
  password: 'a long test password',
};
const SCHEMAS = { app: 'auth_app', data: 'auth_data', audit: 'auth_audit' };
const APP = '"auth_app"';
const AUDIT = '"auth_audit"';
let kit: TestPostgres;
const cleanups: Array<() => Promise<void> | void> = [];

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

class MemoryMailer implements Mailer {
  messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }
}

async function instance(config: RuntimeConfig, mailer?: Mailer | null) {
  const pool = createPool(config.database!);
  const setup = new SetupState(config.configDir, undefined);
  await setup.refresh(pool, config.database!.schemas.app);
  const ctx: AppContext = { config, pool, setup, sessions: NO_SESSIONS, mailer };
  const app = await buildApp(ctx);
  useMainAuthority(app, config);
  cleanups.push(async () => {
    await app.close();
    await pool.end();
  });
  return { app, ctx, pool };
}

async function fixture(
  options: { owner?: boolean; mailer?: Mailer | null; config?: Partial<RuntimeConfig> } = {},
) {
  const database = await kit.createDatabase('auth');
  cleanups.push(() => database.drop());
  const configDir = mkdtempSync(join(tmpdir(), 'rio-auth-'));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  const profile: DatabaseProfile = { ...database.profile, schemas: SCHEMAS };
  const config = {
    ...loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_DATABASE_PROFILE: JSON.stringify(profile),
      NODE_ENV: 'production',
    }),
    logLevel: 'silent',
    ...options.config,
  };
  const migrationPool = createPool(profile);
  try {
    await migrate(migrationPool, profile.schemas, MIGRATIONS);
  } finally {
    await migrationPool.end();
  }
  const result = await instance(config, options.mailer);
  const setupToken = result.ctx.setup.currentToken!;
  const owner = options.owner === false ? null : await createOwner(result.app, setupToken);
  if (owner) expect(owner.statusCode).toBe(200);
  return { ...result, config, setupToken, owner };
}

function createOwner(app: FastifyInstance, setupToken: string) {
  return app.inject({
    method: 'POST',
    url: '/api/setup/owner',
    headers: { 'x-setup-token': setupToken },
    payload: OWNER,
  });
}

function cookie(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  expect(typeof header).toBe('string');
  return String(header).split(';')[0]!;
}

function sessionHeaders(response: LightMyRequestResponse) {
  return { cookie: cookie(response), 'x-csrf-token': response.json<SessionInfo>().csrfToken };
}

function signIn(app: FastifyInstance, password = OWNER.password, email = OWNER.email, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email, password }, headers });
}

async function requestLink(app: FastifyInstance, email = OWNER.email, headers = {}) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/link', payload: { email }, headers });
  expect(response.statusCode).toBe(202);
  expect(response.body).toBe('');
  return response;
}

function messageToken(message: MailMessage): string {
  const match = message.text.match(/#token=([A-Za-z0-9_-]{43})/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function redeem(app: FastifyInstance, token: string) {
  return app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { token } });
}

describe('owner setup', () => {
  it('creates one owner transactionally, signs in, and clears the persisted setup token', async () => {
    const { app, ctx, pool, setupToken } = await fixture({ owner: false });
    expect(readStored(ctx.config.configDir).setupToken).toBe(setupToken);
    const results = await Promise.all([createOwner(app, setupToken), createOwner(app, setupToken)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const success = results.find((r) => r.statusCode === 200)!;
    expect(SessionInfo.parse(success.json())).toMatchObject({
      user: { email: OWNER.email, locale: 'en-US' },
      membership: { kind: 'owner', adminRoles: [] },
      org: { settings: { defaultTheme: { theme: 'nature', scheme: 'grove' } } },
    });
    expect(ctx.setup.stage).toBe('ready');
    expect(ctx.setup.currentToken).toBeNull();
    expect(ctx.setup.verify(setupToken)).toBe(false);
    expect(readStored(ctx.config.configDir).setupToken).toBeUndefined();
    for (const table of ['orgs', 'users', 'memberships', 'sessions']) {
      expect((await pool.query(`SELECT * FROM ${APP}.${table}`)).rowCount).toBe(1);
    }
    const user = (await pool.query(`SELECT * FROM ${APP}.users`)).rows[0];
    expect(user.id).toMatch(/^usr[A-Za-z0-9]{14}$/);
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.verifyPassword(OWNER.password, user.password_hash)).toBe(true);
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(success) } })).statusCode,
    ).toBe(200);
    expect((await createOwner(app, setupToken)).json().error.messageKey).toBe('setup.owner.alreadyCreated');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup/unlock',
          headers: { 'x-setup-token': setupToken },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('also creates one owner across two app instances', async () => {
    const first = await fixture({ owner: false });
    const second = await instance({ ...first.config });
    const results = await Promise.all([
      createOwner(first.app, first.setupToken),
      createOwner(second.app, first.setupToken),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await first.pool.query(`SELECT * FROM ${APP}.orgs`)).rowCount).toBe(1);
    expect(first.ctx.setup.currentToken).toBeNull();
    expect(second.ctx.setup.currentToken).toBeNull();
  });

  it('requires the database stage, the setup token, and a valid owner body', async () => {
    const { app, ctx, setupToken } = await fixture({ owner: false });
    expect((await app.inject({ method: 'POST', url: '/api/setup/owner', payload: OWNER })).statusCode).toBe(
      403,
    );
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      headers: { 'x-setup-token': setupToken },
      payload: { ...OWNER, password: 'short' },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.fields.password).toBe('validation.too_small');
    await ctx.setup.refresh(null, SCHEMAS.app);
    const missingDatabase = await createOwner(app, setupToken);
    expect(missingDatabase.statusCode).toBe(409);
    expect(missingDatabase.json().error.messageKey).toBe('setup.database.required');
  });
});

describe('password sign-in and sessions', () => {
  it('sets an HTTP cookie, stores only its hash, and resolves the membership', async () => {
    const { app, pool } = await fixture();
    const response = await signIn(app, OWNER.password, '  OWNER@example.test  ');
    expect(response.statusCode).toBe(200);
    const info = SessionInfo.parse(response.json());
    const header = String(response.headers['set-cookie']);
    expect(header).toMatch(/^rio_session=[A-Za-z0-9_-]{43};/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Secure');
    expect(header).not.toContain('Domain=');
    expect(response.headers['cache-control']).toBe('no-store');
    const raw = cookie(response).split('=')[1]!;
    const sessions = await pool.query(`SELECT * FROM ${APP}.sessions WHERE token_hash = $1`, [
      tokenHash(raw),
    ]);
    expect(sessions.rowCount).toBe(1);
    expect(sessions.rows[0].id).toMatch(/^ses[A-Za-z0-9]{14}$/);
    expect(sessions.rows[0].token_hash).not.toBe(raw);
    expect(sessions.rows[0].csrf_token).toBe(info.csrfToken);
    const resolved = await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(response) } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual(info);
  });

  it('uses the host cookie only for trusted HTTPS requests', async () => {
    const { app } = await fixture({ config: { trustProxy: 'loopback' } });
    const headers = { 'x-forwarded-proto': 'https' };
    const response = await signIn(app, OWNER.password, OWNER.email, headers);
    expect(String(response.headers['set-cookie'])).toMatch(/^__Host-rio_session=/);
    expect(String(response.headers['set-cookie'])).toContain('Secure');
    const session = await app.inject({
      url: '/api/auth/session',
      headers: { ...headers, cookie: cookie(response) },
    });
    expect(session.statusCode).toBe(200);
    const downgraded = await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(response) } });
    expect(downgraded.statusCode).toBe(401);
    const untrusted = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      remoteAddress: '203.0.113.10',
      headers,
      payload: { email: OWNER.email, password: OWNER.password },
    });
    expect(String(untrusted.headers['set-cookie'])).toMatch(/^rio_session=/);
  });

  it('gives wrong passwords and unknown emails identical answers and verifies both hashes', async () => {
    const { app } = await fixture();
    const verification = vi.spyOn(passwords, 'verifyPassword');
    const wrong = await signIn(app, 'wrong password');
    const missing = await signIn(app, 'wrong password', 'missing@example.test');
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json()).toEqual(missing.json());
    expect(wrong.json().error).toMatchObject({ code: 'unauthenticated', messageKey: 'auth.signIn.invalid' });
    expect(verification).toHaveBeenCalledTimes(2);
    expect(verification.mock.calls[1]).toEqual(['wrong password', null]);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('requires CSRF for sign-out and revokes the old cookie', async () => {
    const { app, pool, owner } = await fixture();
    for (const csrf of [undefined, 'wrong']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: {
          cookie: cookie(owner!),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.messageKey).toBe('errors.csrfMismatch');
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: sessionHeaders(owner!),
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(String(response.headers['set-cookie'])).toContain('rio_session=;');
    expect(String(response.headers['set-cookie'])).toContain('Expires=Thu, 01 Jan 1970');
    expect((await pool.query(`SELECT revoked_at FROM ${APP}.sessions`)).rows[0].revoked_at).toBeInstanceOf(
      Date,
    );
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(owner!) } })).statusCode,
    ).toBe(401);
  });

  it('refreshes activity no more than once every five minutes', async () => {
    const { app, pool, owner } = await fixture();
    await pool.query(`UPDATE ${APP}.sessions SET last_seen_at = clock_timestamp() - interval '6 minutes'`);
    const before = (await pool.query(`SELECT last_seen_at FROM ${APP}.sessions`)).rows[0].last_seen_at;
    await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(owner!) } });
    const refreshed = (await pool.query(`SELECT last_seen_at FROM ${APP}.sessions`)).rows[0].last_seen_at;
    expect(refreshed.getTime()).toBeGreaterThan(before.getTime());
    await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(owner!) } });
    expect((await pool.query(`SELECT last_seen_at FROM ${APP}.sessions`)).rows[0].last_seen_at).toEqual(
      refreshed,
    );
  });

  it.each([
    ["last_seen_at = clock_timestamp() - interval '8 days'", {}],
    ["created_at = clock_timestamp() - interval '31 days'", {}],
    ["expires_at = clock_timestamp() - interval '1 second'", {}],
    ["last_seen_at = clock_timestamp() - interval '2 days'", { sessionIdleDays: 1 }],
    ["created_at = clock_timestamp() - interval '3 days'", { sessionMaxDays: 2 }],
  ])('rejects expired sessions: %s', async (assignment, config) => {
    const { app, pool, owner } = await fixture({ config });
    await pool.query(`UPDATE ${APP}.sessions SET ${assignment}`);
    const response = await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(owner!) } });
    expect(response.statusCode).toBe(401);
  });

  it('deactivated users lose existing sessions and cannot sign in', async () => {
    const mailer = new MemoryMailer();
    const { app, pool, owner } = await fixture({ mailer });
    await requestLink(app);
    await pool.query(`UPDATE ${APP}.users SET deactivated_at = clock_timestamp()`);
    expect((await signIn(app)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(owner!) } })).statusCode,
    ).toBe(401);
    expect((await redeem(app, messageToken(mailer.messages[0]!))).statusCode).toBe(401);
    await requestLink(app);
    expect(mailer.messages).toHaveLength(1);
  });

  it('honors owner and member admin policies through the real resolver', async () => {
    const { app, pool, owner } = await fixture({ owner: false });
    expect(owner).toBeNull();
    app.get(
      '/api/test/admin',
      { config: { policy: { kind: 'admin', area: 'people', scope: 'organization' } } },
      async () => ({}),
    );
    const signedIn = await createOwner(app, app.ctx.setup.currentToken!);
    const headers = { cookie: cookie(signedIn) };
    expect((await app.inject({ url: '/api/test/admin', headers })).statusCode).toBe(200);
    await pool.query(`UPDATE ${APP}.memberships SET kind = $1`, ['member']);
    expect((await app.inject({ url: '/api/test/admin', headers })).statusCode).toBe(403);
    await pool.query(`UPDATE ${APP}.memberships SET admin_roles = $1`, [['people']]);
    expect((await app.inject({ url: '/api/test/admin', headers })).statusCode).toBe(200);
  });
});

describe('database-backed lockouts', () => {
  it('locks after ten failures, skips verification, and survives a new app instance', async () => {
    const { app, config } = await fixture();
    for (let i = 0; i < 10; i++) expect((await signIn(app, 'wrong')).statusCode).toBe(401);
    const verification = vi.spyOn(passwords, 'verifyPassword');
    const locked = await signIn(app);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatchObject({ code: 'rate_limited', messageKey: 'auth.signIn.locked' });
    expect(locked.json().error.params.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.json().error.params.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(Number(locked.headers['retry-after'])).toBe(locked.json().error.params.retryAfterSeconds);
    const restarted = await instance({ ...config });
    expect((await signIn(restarted.app)).statusCode).toBe(429);
    expect(verification).not.toHaveBeenCalled();
  });

  it('serializes concurrent attempts across replicas at the email limit', async () => {
    const first = await fixture({ config: { trustProxy: 'loopback' } });
    const second = await instance({ ...first.config });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        signIn(i % 2 ? first.app : second.app, 'wrong', OWNER.email, {
          'x-forwarded-for': `203.0.113.${i + 1}`,
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(2);
  });

  it('locks an IP at 100 failures regardless of email', async () => {
    const { app, pool } = await fixture({ config: { trustProxy: 'loopback' } });
    const ip = '203.0.113.9';
    const key = attemptKey('ip', ip);
    await pool.query(`INSERT INTO ${APP}.auth_attempts (key) SELECT $1 FROM generate_series(1, 99)`, [key]);
    expect((await signIn(app, 'wrong', OWNER.email, { 'x-forwarded-for': ip })).statusCode).toBe(401);
    expect((await signIn(app, 'wrong', 'different@example.test', { 'x-forwarded-for': ip })).statusCode).toBe(
      429,
    );
    expect(
      (await signIn(app, OWNER.password, OWNER.email, { 'x-forwarded-for': '203.0.113.10' })).statusCode,
    ).toBe(200);
  });

  it('clears email failures on success, expires the window, and prunes old rows', async () => {
    const { app, pool } = await fixture();
    await signIn(app, 'wrong');
    expect((await signIn(app)).statusCode).toBe(200);
    const emailKey = attemptKey('email', OWNER.email);
    expect((await pool.query(`SELECT * FROM ${APP}.auth_attempts WHERE key = $1`, [emailKey])).rowCount).toBe(
      0,
    );
    expect((await pool.query(`SELECT * FROM ${APP}.auth_attempts WHERE key LIKE 'ip:%'`)).rowCount).toBe(1);
    await pool.query(
      `INSERT INTO ${APP}.auth_attempts (key, at)
      SELECT $1, clock_timestamp() - interval '16 minutes' FROM generate_series(1, 10)`,
      [emailKey],
    );
    await pool.query(
      `INSERT INTO ${APP}.auth_attempts (key, at) VALUES ($1, clock_timestamp() - interval '2 days')`,
      ['old'],
    );
    expect((await signIn(app)).statusCode).toBe(200);
    expect((await pool.query(`SELECT * FROM ${APP}.auth_attempts WHERE key = $1`, ['old'])).rowCount).toBe(0);
  });
});

describe('one-time sign-in links', () => {
  it('puts a safe return address in the email so another browser can continue', async () => {
    const mailer = new MemoryMailer();
    const { app } = await fixture({ mailer, config: { baseUrl: 'https://database.example.test/' } });
    const next = '/settings/appearance?theme=nature#colors';
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      payload: { email: OWNER.email, next },
    });
    expect(response.statusCode).toBe(202);
    const link = new URL(mailer.messages[0]!.text.match(/https:\/\/\S+\/sign-in\/link[^\s]*/)![0]);
    expect(link.searchParams.get('next')).toBe(next);
    expect(link.hash).toMatch(/^#token=/);
  });

  it.each(['https://example.test', '//example.test', '/\\example.test', '/api/auth/session'])(
    'leaves unsafe return address %j out of sign-in mail',
    async (next) => {
      const mailer = new MemoryMailer();
      const { app } = await fixture({ mailer, config: { baseUrl: 'https://database.example.test/' } });
      await app.inject({ method: 'POST', url: '/api/auth/link', payload: { email: OWNER.email, next } });
      const link = new URL(mailer.messages[0]!.text.match(/https:\/\/\S+\/sign-in\/link[^\s]*/)![0]);
      expect(link.searchParams.has('next')).toBe(false);
    },
  );

  it('reports unavailable mail and keeps link request responses empty', async () => {
    const { app } = await fixture();
    expect((await app.inject({ url: '/api/auth/methods' })).json()).toEqual({
      password: true,
      link: false,
      passkey: true,
    });
    await requestLink(app);
    await requestLink(app, 'missing@example.test');
  });

  it('sends a localized fragment link, stores only the hash, and redeems once', async () => {
    const mailer = new MemoryMailer();
    const { app, pool } = await fixture({ mailer, config: { baseUrl: 'https://database.example.test/' } });
    expect((await app.inject({ url: '/api/auth/methods' })).json().link).toBe(true);
    await pool.query(`UPDATE ${APP}.users SET locale = $1`, ['fr-FR']);
    await requestLink(app);
    const message = mailer.messages[0]!;
    expect(message.to).toBe(OWNER.email);
    expect(message.subject).toBe('Sign in to Riosoma');
    expect(message.text).toContain('https://database.example.test/sign-in/link#token=');
    expect(message.text).toContain('15 minutes');
    expect(message.text).toContain('ignore it');
    expect(message.html).toContain('<a href="https://database.example.test/sign-in/link#token=');
    const token = messageToken(message);
    const row = (await pool.query(`SELECT * FROM ${APP}.login_tokens`)).rows[0];
    expect(row.token_hash).toBe(tokenHash(token));
    expect(row.token_hash).not.toBe(token);
    expect(row.id).toMatch(/^tok[A-Za-z0-9]{14}$/);
    expect(row.purpose).toBe('magic_link');
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThanOrEqual(900_000);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeLessThan(901_000);
    const responses = await Promise.all([redeem(app, token), redeem(app, token)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const signedIn = responses.find((r) => r.statusCode === 200)!;
    expect(SessionInfo.safeParse(signedIn.json()).success).toBe(true);
    expect(
      (await app.inject({ url: '/api/auth/session', headers: { cookie: cookie(signedIn) } })).statusCode,
    ).toBe(200);
    expect((await redeem(app, token)).json().error.messageKey).toBe('auth.link.invalid');
  });

  it('never builds a link from the Host header, rejects expired or unknown tokens, and enforces purpose', async () => {
    const mailer = new MemoryMailer();
    const { app, pool, ctx } = await fixture({ mailer });
    // Setup captured the address the owner used; a forged Host later changes nothing.
    expect(ctx.config.baseUrl).toBe('http://localhost:80');
    // A host no organization added as a custom domain is the main app, as it always was.
    await requestLink(app, OWNER.email, { host: 'attacker.example.test', 'x-forwarded-proto': 'https' });
    expect(mailer.messages[0]!.text).toContain('http://localhost:80/sign-in/link#token=');
    expect(mailer.messages[0]!.text).not.toContain('attacker.example.test');
    expect(mailer.messages[0]!.html).not.toContain('attacker.example.test');
    const token = messageToken(mailer.messages[0]!);
    await pool.query(`UPDATE ${APP}.login_tokens SET purpose = $1`, ['recover']);
    expect((await redeem(app, token)).statusCode).toBe(401);
    await pool.query(
      `UPDATE ${APP}.login_tokens SET purpose = $1, expires_at = clock_timestamp() - interval '1 second'`,
      ['magic_link'],
    );
    const expired = await redeem(app, token);
    const unknown = await redeem(app, randomBytes(32).toString('base64url'));
    expect(expired.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(expired.json()).toEqual(unknown.json());
    expect(expired.json().error.messageKey).toBe('auth.link.invalid');
  });

  it('clears password failures after a successful link sign-in', async () => {
    const mailer = new MemoryMailer();
    const { app, pool } = await fixture({ mailer });
    const emailKey = attemptKey('email', OWNER.email);
    await pool.query(`INSERT INTO ${APP}.auth_attempts (key) SELECT $1 FROM generate_series(1, 10)`, [
      emailKey,
    ]);
    expect((await signIn(app)).statusCode).toBe(429);
    await requestLink(app);
    expect((await redeem(app, messageToken(mailer.messages[0]!))).statusCode).toBe(200);
    expect((await pool.query(`SELECT * FROM ${APP}.auth_attempts WHERE key = $1`, [emailKey])).rowCount).toBe(
      0,
    );
    expect((await signIn(app)).statusCode).toBe(200);
  });

  it('returns 202 without sending for unknown emails and silently caps five requests per hour', async () => {
    const mailer = new MemoryMailer();
    const first = await fixture({ mailer });
    await requestLink(first.app, 'missing@example.test');
    expect(mailer.messages).toHaveLength(0);
    const second = await instance({ ...first.config }, mailer);
    await Promise.all(Array.from({ length: 7 }, (_, i) => requestLink(i % 2 ? first.app : second.app)));
    expect(mailer.messages).toHaveLength(5);
    expect((await first.pool.query(`SELECT * FROM ${APP}.login_tokens`)).rowCount).toBe(5);
    await first.pool.query(`UPDATE ${APP}.auth_attempts SET at = clock_timestamp() - interval '61 minutes'`);
    await requestLink(first.app);
    expect(mailer.messages).toHaveLength(6);
  });

  it('offers links only when both mail and a trusted address exist', async () => {
    const mailer = new MemoryMailer();
    const { app, ctx } = await fixture({ mailer, owner: false });
    expect((await app.inject({ url: '/api/auth/methods' })).json()).toEqual({
      password: true,
      link: false,
      passkey: false,
    });
    ctx.config.baseUrl = 'https://riosoma.example.test';
    expect((await app.inject({ url: '/api/auth/methods' })).json()).toEqual({
      password: true,
      link: true,
      passkey: true,
    });
  });

  it('keeps provider failures out of the public response', async () => {
    const mailer: Mailer = {
      send: async () => {
        throw new Error('delivery failed');
      },
    };
    const { app } = await fixture({ mailer });
    await requestLink(app);
    await requestLink(app, 'missing@example.test');
  });
});

describe('preferences, validation, and audit events', () => {
  it('merges and validates preferences, including concurrent updates and locale', async () => {
    const { app, pool, owner } = await fixture();
    const headers = sessionHeaders(owner!);
    const update = (payload: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/me/preferences', headers, payload: payload as object });
    expect((await update({ theme: 'nature', sounds: false })).json()).toEqual({
      theme: 'nature',
      sounds: false,
    });
    await Promise.all([update({ motion: 'reduce' }), update({ recordLayout: 'panel', locale: 'en-US' })]);
    const merged = await update({ scheme: 'grove' });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toEqual({
      theme: 'nature',
      scheme: 'grove',
      sounds: false,
      motion: 'reduce',
      recordLayout: 'panel',
      locale: 'en-US',
    });
    const invalid = await update({ motion: 'sometimes', theme: 'INVALID', sounds: 'yes' });
    expect(invalid.statusCode).toBe(422);
    expect(Object.keys(invalid.json().error.fields).sort()).toEqual(['motion', 'sounds', 'theme']);
    expect((await update({})).json()).toEqual(merged.json());
    await update({ locale: 'fr-FR' });
    expect((await pool.query(`SELECT locale FROM ${APP}.users`)).rows[0].locale).toBe('fr-FR');
    const session = await app.inject({ url: '/api/auth/session', headers });
    expect(session.json().preferences.locale).toBe('fr-FR');
    expect(session.json().user.locale).toBe('fr-FR');
    await update({ recordLayout: 'panel' });
    await update({ recordLayout: 'card' });
    expect((await update({ recordLayout: 'page' })).statusCode).toBe(422);
    const layouts = await pool.query(
      `SELECT actor_id, metadata FROM ${AUDIT}.events WHERE action = 'auth.record_layout.updated' ORDER BY id`,
    );
    expect(layouts.rows.map((event) => event.metadata)).toEqual([
      { from: 'card', to: 'panel' },
      { from: 'panel', to: 'card' },
    ]);
    expect(layouts.rows.every((event) => event.actor_id === session.json().user.id)).toBe(true);
  });

  it('keeps the level the owner chose while setting up, and none when they keep Standard', async () => {
    const chose = await fixture({ owner: false });
    const created = await chose.app.inject({
      method: 'POST',
      url: '/api/setup/owner',
      headers: { 'x-setup-token': chose.setupToken },
      payload: { ...OWNER, level: 'advanced' },
    });
    expect(created.statusCode).toBe(200);
    expect(SessionInfo.parse(created.json()).preferences).toEqual({ level: 'advanced' });

    const kept = await fixture();
    expect(SessionInfo.parse(kept.owner!.json()).preferences).toEqual({});
  });

  it('validates all public auth bodies with field-level translation keys', async () => {
    const { app } = await fixture();
    for (const [url, payload, field] of [
      ['/api/auth/sign-in', { email: 'invalid', password: 'x' }, 'email'],
      ['/api/auth/link', { email: '' }, 'email'],
      ['/api/auth/link/redeem', { token: 'short' }, 'token'],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.fields[field]).toMatch(/^validation\./);
    }
  });

  it('records every event without passwords, typed emails, or bearer tokens', async () => {
    const mailer = new MemoryMailer();
    const { app, pool, owner } = await fixture({ mailer, config: { trustProxy: 'loopback' } });
    await signIn(app, 'private failed password', 'typed@example.test', { 'x-forwarded-for': '203.0.113.17' });
    const signedIn = await signIn(app, OWNER.password, OWNER.email, { 'x-forwarded-for': '203.0.113.18' });
    await requestLink(app);
    const token = messageToken(mailer.messages[0]!);
    await redeem(app, token);
    await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: sessionHeaders(owner!) });
    const events = (await pool.query(`SELECT * FROM ${AUDIT}.events ORDER BY id`)).rows;
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'setup.owner_created',
        'auth.sign_in',
        'auth.sign_in_failed',
        'auth.sign_out',
        'auth.link_requested',
        'auth.link_redeemed',
      ]),
    );
    expect(events.find((event) => event.action === 'auth.sign_in_failed').metadata).toEqual({
      reason: 'invalid_credentials',
      ip: '203.0.113.17',
    });
    expect(
      events.some((event) => event.action === 'auth.sign_in' && event.metadata.ip === '203.0.113.18'),
    ).toBe(true);
    const serialized = JSON.stringify(events);
    for (const secret of [
      OWNER.password,
      OWNER.email,
      'typed@example.test',
      'private failed password',
      token,
      cookie(signedIn).split('=')[1]!,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

it('ignores private-network forwarded addresses for throttling, cookies, and audit events by default', async () => {
  const { app, pool, config } = await fixture();
  expect(config.trustProxy).toBe(false);
  const ip = '10.1.2.3';
  const send = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      remoteAddress: ip,
      headers: { 'x-forwarded-for': '198.51.100.2', 'x-forwarded-proto': 'https' },
      payload: { email: OWNER.email, password },
    });
  const signedIn = await send(OWNER.password);
  expect(String(signedIn.headers['set-cookie'])).toMatch(/^rio_session=/);
  await pool.query(`INSERT INTO ${APP}.auth_attempts (key) SELECT $1 FROM generate_series(1, 99)`, [
    attemptKey('ip', ip),
  ]);
  expect((await send('wrong')).statusCode).toBe(401);
  expect((await send('wrong')).statusCode).toBe(429);
  const events = await pool.query(
    `SELECT metadata FROM ${AUDIT}.events WHERE action = 'auth.sign_in_failed'`,
  );
  expect(events.rows.some((event) => event.metadata.ip === ip)).toBe(true);
  expect(events.rows.some((event) => event.metadata.ip === '198.51.100.2')).toBe(false);
});

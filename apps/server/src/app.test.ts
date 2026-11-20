import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { createPool, migrate } from '@riosoma/db';
import { buildApp, type AppContext } from './app.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { NO_SESSIONS } from './http/policy.js';
import { SetupState } from './setup/state.js';
import { MIGRATIONS } from './migrations/index.js';

const TOKEN = 'setup-token-for-tests-0123456789';

let kit: TestPostgres;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

afterAll(async () => {
  await kit?.stop();
});

async function makeApp(): Promise<{ app: FastifyInstance; ctx: AppContext; configDir: string }> {
  const configDir = mkdtempSync(join(tmpdir(), 'rio-config-'));
  const config: RuntimeConfig = {
    demoMode: false,
    demoAddressLimit: 10,
    demoSessionLimit: 1000,
    port: 0,
    host: '127.0.0.1',
    baseUrl: undefined,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    smtpUrl: undefined,
    smtpAllowPlaintext: false,
    dbQueryTimeoutMs: 30_000,
    mailFrom: undefined,
    configDir,
    secretKey: randomBytes(32),
    database: null,
    databaseFromEnv: false,
    setupTokenFromEnv: TOKEN,
    logLevel: 'silent',
    webDir: undefined,
    themesDir: undefined,
    trustProxy: 'loopback',
    production: true,
  };
  const setup = new SetupState(configDir, TOKEN);
  await setup.refresh(null, 'rio_app');
  const ctx: AppContext = { config, pool: null, setup, sessions: NO_SESSIONS };
  const app = await buildApp(ctx);
  cleanups.push(async () => {
    await app.close();
    await ctx.pool?.end();
    rmSync(configDir, { recursive: true, force: true });
  });
  return { app, ctx, configDir };
}

describe('server basics', () => {
  it('answers health and readiness', async () => {
    const { app } = await makeApp();
    const health = await app.inject({ url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    const ready = await app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'setup_required' });
  });

  it('serves custom code in an opaque document without relaxing the app policy', async () => {
    const { app } = await makeApp();
    const frame = await app.inject({ url: '/api/interfaces/code-frame' });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-type']).toContain('text/html');
    const policy = String(frame.headers['content-security-policy']);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
      'sandbox allow-scripts',
    ])
      expect(policy).toContain(directive);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).not.toContain('allow-popups');
    expect(policy).not.toContain('allow-top-navigation');
    expect(frame.headers['set-cookie']).toBeUndefined();
    expect(frame.headers['cache-control']).toBe('no-store');
    const appPage = await app.inject({ url: '/healthz' });
    expect(appPage.headers['content-security-policy']).not.toContain("'unsafe-inline'");
  });

  it('sends security headers', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    expect(res.headers['content-security-policy']).toContain("require-trusted-types-for 'script'");
    expect(String(res.headers['content-security-policy']).split(';')).toContain(
      'trusted-types rio-sanitizer rio-html rio-script-url',
    );
    expect(res.headers['content-security-policy-report-only']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows the realtime socket on its own host only, whatever the Host header says', async () => {
    const { app } = await makeApp();
    const plain = await app.inject({ url: '/healthz', headers: { host: 'riosoma.example:8443' } });
    expect(plain.headers['content-security-policy']).toContain('ws://riosoma.example:8443');
    expect(plain.headers['content-security-policy']).toContain('wss://riosoma.example:8443');
    const crafted = await app.inject({
      url: '/healthz',
      headers: { host: "evil.example; script-src 'unsafe-inline'" },
    });
    expect(crafted.statusCode).toBe(200);
    const policy = String(crafted.headers['content-security-policy']);
    expect(policy).not.toContain('evil.example');
    expect(policy).not.toContain("'unsafe-inline'");
  });

  it('serves theme stylesheets and manifests', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/themes/nature/theme.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.json()).toMatchObject({ id: 'nature', defaultScheme: 'grove' });
    // Paths that climb out of the themes folder never reach files beside it.
    for (const url of [
      '/themes/../package.json',
      '/themes/..%2Fpackage.json',
      '/themes/%2e%2e/package.json',
    ]) {
      const escaped = await app.inject({ url });
      expect(escaped.body).not.toContain('"@riosoma/server"');
      expect(escaped.body).not.toContain('"packageManager"');
    }
  });

  it('answers unknown API paths with a translatable error', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true },
    });
  });

  it('refuses to start when an API route has no access policy', async () => {
    const { app } = await makeApp();
    await expect(
      app.register(async (child) => {
        child.get('/api/open', async () => ({ open: true }));
      }),
    ).rejects.toThrow(/no access policy/);
  });

  it('refuses to start when an Airtable-compatible API route has no access policy', async () => {
    const { app } = await makeApp();
    await expect(
      app.register(async (child) => {
        child.get('/v0/meta/open', async () => ({ open: true }));
      }),
    ).rejects.toThrow(/GET \/v0\/meta\/open has no access policy/);
  });
});

describe('first-run setup', () => {
  it('reports the database stage without a token', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/api/setup/status' });
    expect(res.json()).toEqual({ stage: 'database', databaseManaged: false });
  });

  it('requires the setup token', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/setup/unlock' })).statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/setup/unlock',
      headers: { 'x-setup-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.messageKey).toBe('errors.setupTokenInvalid');
    const right = await app.inject({
      method: 'POST',
      url: '/api/setup/unlock',
      headers: { 'x-setup-token': TOKEN },
    });
    expect(right.statusCode).toBe(204);
  });

  it('returns field-level keys for an invalid profile', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/database/test',
      headers: { 'x-setup-token': TOKEN },
      payload: { host: '', database: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toMatchObject({
      host: 'validation.too_small',
      user: 'validation.invalid_type',
    });
  });

  it('explains a connection that fails', async () => {
    const { app } = await makeApp();
    const db = await kit.createDatabase('setup');
    cleanups.unshift(() => db.drop());
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/database/test',
      headers: { 'x-setup-token': TOKEN },
      payload: { ...db.profile, database: 'does_not_exist' },
    });
    expect(res.statusCode).toBe(200);
    const { report } = res.json();
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({
      step: 'database',
      status: 'fail',
      fixKey: 'setup.fix.createDatabase',
    });
  });

  it('connects, migrates, stores the profile sealed, and moves on to the owner step', async () => {
    const { app, ctx, configDir } = await makeApp();
    const db = await kit.createDatabase('setup');
    cleanups.unshift(() => db.drop());
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/database',
      headers: { 'x-setup-token': TOKEN },
      payload: db.profile,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ report: { ok: true }, stage: 'owner' });
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);

    const tables = await ctx.pool!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'rio_app' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toContain('users');

    // The stored profile survives a restart and never sits in the file as plain text.
    const reloaded = loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_SECRET_KEY: ctx.config.secretKey.toString('base64'),
    });
    expect(reloaded.database).toMatchObject({ host: db.profile.host, database: db.profile.database });
    expect(() =>
      loadConfig({ RIOSOMA_CONFIG_DIR: configDir, RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64') }),
    ).toThrow(/different secret key/);

    const again = await app.inject({
      method: 'POST',
      url: '/api/setup/database',
      headers: { 'x-setup-token': TOKEN },
      payload: db.profile,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.messageKey).toBe('setup.database.alreadyConfigured');
  });

  it.each([
    { kind: 'changed', messageKey: 'server.startup.migrationChanged' },
    { kind: 'newer', messageKey: 'server.startup.databaseNewer' },
  ])('explains a $kind migration during database setup', async ({ kind, messageKey }) => {
    const { app, ctx } = await makeApp();
    const database = await kit.createDatabase('setup_migration_failure');
    cleanups.unshift(() => database.drop());
    const pool = createPool(database.profile);
    try {
      await migrate(pool, database.profile.schemas, MIGRATIONS);
      if (kind === 'changed') {
        await pool.query(
          "UPDATE rio_app.schema_migrations SET checksum = 'old' WHERE id = '0083_automation_steps'",
        );
      } else {
        await pool.query(
          "INSERT INTO rio_app.schema_migrations (id, checksum) VALUES ('9999_future', 'future')",
        );
      }
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/database',
        headers: { 'x-setup-token': TOKEN },
        payload: database.profile,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({ code: 'unavailable', messageKey });
      expect(response.body).not.toContain(database.profile.database);
      expect(ctx.pool).toBeNull();
      expect(ctx.setup.stage).toBe('database');
    } finally {
      await pool.end();
    }
  });

  it('keeps the audit log append-only', async () => {
    const { app, ctx } = await makeApp();
    const db = await kit.createDatabase('audit');
    cleanups.unshift(() => db.drop());
    await app.inject({
      method: 'POST',
      url: '/api/setup/database',
      headers: { 'x-setup-token': TOKEN },
      payload: db.profile,
    });
    const pool = ctx.pool!;
    await pool.query(`INSERT INTO rio_audit.events (action) VALUES ('test.event')`);
    await expect(pool.query(`UPDATE rio_audit.events SET action = 'changed'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM rio_audit.events`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE rio_audit.events`)).rejects.toThrow(/append-only/);
  });
});

describe('sealed secrets', () => {
  it('round-trips, binds the purpose, and rejects a truncated tag', async () => {
    const { seal, unseal } = await import('./secrets.js');
    const key = randomBytes(32);
    const sealed = seal(key, 'hello', 'purpose-a');
    expect(unseal(key, sealed, 'purpose-a')).toBe('hello');
    expect(() => unseal(key, sealed, 'purpose-b')).toThrow();
    const raw = Buffer.from(sealed.slice(5), 'base64url');
    // Keep the IV, cut the tag to 4 bytes, keep the ciphertext.
    const truncated = 'rio1.' + Buffer.concat([raw.subarray(0, 16), raw.subarray(28)]).toString('base64url');
    expect(() => unseal(key, truncated, 'purpose-a')).toThrow();
  });
});

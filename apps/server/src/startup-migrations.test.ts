import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DatabaseProfile } from '@riosoma/contracts';
import { NewerDatabaseError } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp, type AppContext } from './app.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { wakeLibraryIndexing } from './data/library-index.js';
import { NO_SESSIONS } from './http/policy.js';
import { SetupState } from './setup/state.js';
import { openDatabase } from './startup-database.js';

/** The advisory lock `migrate` in packages/db takes before it changes anything. */
const MIGRATION_LOCK = 725_119_331;
/** Every background poll the configuration can shorten, so each ticks many times while migrations wait. */
const FAST = 25;

let kit: TestPostgres;

beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);

afterAll(async () => {
  await kit?.stop();
});

type Phase = 'held' | 'migrating' | 'open';

/** The text of a query as node-postgres receives it, from a string or a query config. */
function textOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'text' in input) return String(input.text);
  return '';
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('keeps background jobs off app tables until migrations have been applied', async () => {
  const database = await kit.createDatabase('boot');
  const configDir = mkdtempSync(join(tmpdir(), 'rio-boot-'));
  const schemas = { app: 'boot_app', data: 'boot_data', audit: 'boot_audit' };
  const profile: DatabaseProfile = { ...database.profile, schemas };
  const config: RuntimeConfig = {
    ...loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_ARCHIVE_WORK_DIR: join(configDir, 'archives'),
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_DATABASE_PROFILE: JSON.stringify(profile),
      NODE_ENV: 'production',
    }),
    logLevel: 'silent',
    libraryIndexPollMs: FAST,
    embeddingsPollMs: FAST,
    aiFieldsPollMs: FAST,
    automationsPollMs: FAST,
    outboundSyncPollMs: FAST,
    reportsPollMs: FAST,
    routinesPollMs: FAST,
    webhooksPollMs: FAST,
  };

  // Holding the migration lock freezes a fresh install at its very first migration step, for as
  // long as the test needs, so every background poll gets many chances to run meanwhile.
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  let blocking = true;

  let phase: Phase = 'held';
  const queries: Array<{ phase: Phase; text: string }> = [];
  const send = pg.Client.prototype.query;
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    if (this !== blocker) queries.push({ phase, text: textOf(args[0]) });
    return (send as (...input: unknown[]) => unknown).apply(this, args);
  } as never);

  const ctx: AppContext = {
    config,
    pool: null,
    setup: new SetupState(configDir, undefined),
    sessions: NO_SESSIONS,
    mailer: null,
  };
  const app = await buildApp(ctx);
  const warn = vi.spyOn(app.log, 'warn');
  const opening = openDatabase(app, ctx).then(
    () => 'opened',
    (error: unknown) => error,
  );
  try {
    // The migration runner is now connected and waiting on the lock this test holds.
    await until(async () => {
      const waiting = await blocker.query<{ count: string }>(
        `SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND classid = 0 AND objid = $1`,
        [MIGRATION_LOCK],
      );
      return Number(waiting.rows[0]!.count) > 0;
    }, 'the migration runner to wait on its lock');
    wakeLibraryIndexing(app);
    await new Promise((resolve) => setTimeout(resolve, 40 * FAST));

    const held = queries.filter((query) => query.phase === 'held');
    // The runner itself has reached its lock, which proves the window was real.
    expect(held.some((query) => query.text.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(held.filter((query) => query.text.includes('knowledge_index_jobs'))).toEqual([]);
    // No background job reads or writes any of Riosoma's own tables before they exist.
    expect(held.filter((query) => /"?boot_(app|data|audit)"?\s*\.\s*"?\w/.test(query.text))).toEqual([]);

    phase = 'migrating';
    await blocker.query('ROLLBACK');
    blocking = false;
    expect(await opening).toBe('opened');
    phase = 'open';

    // Once migrations are in, the indexer runs as usual.
    wakeLibraryIndexing(app);
    await until(
      () => queries.some((query) => query.phase === 'open' && query.text.includes('knowledge_index_jobs')),
      'the knowledge indexer to poll its queue',
      5_000,
    );
    const missing = warn.mock.calls
      .map(([fields]) => (fields as { err?: { message?: unknown } } | undefined)?.err?.message)
      .filter((message) => /does not exist/.test(String(message)));
    expect(missing).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    if (blocking) await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await opening;
    await app.close();
    await ctx.closeDatabase?.();
    await database.drop();
    rmSync(configDir, { recursive: true, force: true });
  }
}, 120_000);

it('closes the database without publishing its pool when migrations reject a newer database', async () => {
  const database = await kit.createDatabase('future');
  const configDir = mkdtempSync(join(tmpdir(), 'rio-future-'));
  const schemas = { app: 'future_app', data: 'future_data', audit: 'future_audit' };
  const profile: DatabaseProfile = { ...database.profile, schemas };
  const config = loadConfig({
    RIOSOMA_CONFIG_DIR: configDir,
    RIOSOMA_ARCHIVE_WORK_DIR: join(configDir, 'archives'),
    RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
    RIOSOMA_DATABASE_PROFILE: JSON.stringify(profile),
    NODE_ENV: 'production',
  });
  config.logLevel = 'silent';
  const ctx: AppContext = {
    config,
    pool: null,
    closeDatabase: null,
    setup: new SetupState(configDir, undefined),
    sessions: NO_SESSIONS,
    mailer: null,
  };
  const app = await buildApp(ctx);
  const seed = new pg.Client({ connectionString: database.url });
  await seed.connect();
  try {
    await seed.query(`CREATE SCHEMA "future_app"`);
    await seed.query(`CREATE TABLE "future_app".schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await seed.query(`INSERT INTO "future_app".schema_migrations (id, checksum) VALUES ($1, $2)`, [
      '9999_from_the_future',
      '0'.repeat(64),
    ]);
    const end = vi.spyOn(pg.Pool.prototype, 'end');
    try {
      await expect(openDatabase(app, ctx)).rejects.toBeInstanceOf(NewerDatabaseError);
      expect(ctx.pool).toBeNull();
      expect(ctx.closeDatabase).toBeNull();
      expect(end).toHaveBeenCalledOnce();
    } finally {
      end.mockRestore();
    }
  } finally {
    await seed.end();
    await app.close();
    await ctx.closeDatabase?.();
    await database.drop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

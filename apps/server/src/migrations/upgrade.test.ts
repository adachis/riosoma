import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SetupState } from '../setup/state.js';
import { NO_SESSIONS } from '../http/policy.js';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate, type Migration } from '@riosoma/db';
import { NOTIFICATION_KINDS, newId } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from './index.js';
import { m0133 } from './0133_notification_kinds.js';

let kit: TestPostgres;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterAll(async () => {
  await kit?.stop();
});

it('runs the full migration set again without applying anything or throwing', async () => {
  const database = await kit.createDatabase('migration_repeat');
  const pool = createPool(database.profile);
  try {
    const first = await migrate(pool, database.profile.schemas, MIGRATIONS);
    expect(first.applied).toEqual(MIGRATIONS.map((migration) => migration.id).sort());
    expect(first.alreadyApplied).toBe(0);
    await expect(migrate(pool, database.profile.schemas, MIGRATIONS)).resolves.toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.length,
    });
  } finally {
    await pool.end();
    await database.drop();
  }
});

it('upgrades expiry defaults to elapsed time across daylight-saving changes', async () => {
  const database = await kit.createDatabase('expiry_upgrade');
  const pool = createPool(database.profile);
  try {
    await migrate(
      pool,
      database.profile.schemas,
      MIGRATIONS.filter((entry) => entry.id !== '0150_elapsed_expiry'),
    );
    expect((await migrate(pool, database.profile.schemas, MIGRATIONS)).applied).toEqual([
      '0150_elapsed_expiry',
    ]);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const zone of ['America/Los_Angeles', 'UTC']) {
        await db.query("SELECT set_config('TimeZone', $1, true)", [zone]);
        for (const [table, days] of [
          ['sso_domain_verifications', 1],
          ['organization_archives', 7],
          ['rio_routine_approvals', 7],
        ] as const) {
          const defaults = await db.query<{ expression: string }>(
            `SELECT pg_get_expr(adbin, adrelid) AS expression FROM pg_attrdef
             JOIN pg_attribute ON attrelid = adrelid AND attnum = adnum
             WHERE adrelid = $1::regclass AND attname = 'expires_at'`,
            [`"${database.profile.schemas.app}".${table}`],
          );
          // Evaluate the installed default with its database clock pinned before each DST change.
          const expression = defaults.rows[0]!.expression.replace(
            /(?:clock_timestamp|now)\(\)/g,
            '$1::timestamptz',
          );
          for (const now of ['2026-03-07T20:00:00.000Z', '2026-10-31T19:00:00.000Z']) {
            const result = await db.query<{ expires_at: Date }>(`SELECT (${expression}) AS expires_at`, [
              now,
            ]);
            expect(result.rows[0]!.expires_at.getTime() - Date.parse(now), `${table} in ${zone}`).toBe(
              days * 86_400_000,
            );
          }
        }
      }
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  } finally {
    await pool.end();
    await database.drop();
  }
});

it('adds demo session fields after shipped migrations and preserves existing real sessions', async () => {
  const database = await kit.createDatabase('demo_upgrade');
  const pool = createPool(database.profile);
  const app = `"${database.profile.schemas.app}"`;
  const userId = newId('user');
  const sessionId = newId('session');
  try {
    await migrate(
      pool,
      database.profile.schemas,
      MIGRATIONS.filter((entry) => entry.id !== '0134_demo_sessions'),
    );
    await pool.query(`INSERT INTO ${app}.users (id, email) VALUES ($1, $2)`, [
      userId,
      `${randomBytes(8).toString('hex')}@invalid`,
    ]);
    await pool.query(
      `INSERT INTO ${app}.sessions (id, user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
      [sessionId, userId, randomBytes(32).toString('hex'), randomBytes(32).toString('base64url')],
    );
    const shipped = await pool.query(`SELECT id, checksum FROM ${app}.schema_migrations ORDER BY id`);
    expect((await migrate(pool, database.profile.schemas, MIGRATIONS)).applied).toEqual([
      '0134_demo_sessions',
    ]);
    const session = await pool.query(`SELECT id, demo, demo_address FROM ${app}.sessions WHERE id = $1`, [
      sessionId,
    ]);
    expect(session.rows).toEqual([{ id: sessionId, demo: false, demo_address: null }]);
    const remaining = await pool.query(
      `SELECT id, checksum FROM ${app}.schema_migrations WHERE id <> '0134_demo_sessions' ORDER BY id`,
    );
    expect(remaining.rows).toEqual(shipped.rows);
  } finally {
    await pool.end();
    await database.drop();
  }
});

it('adds missing notification kinds without dropping a kind from a later migration', async () => {
  const database = await kit.createDatabase('notification_arrival');
  const pool = createPool(database.profile);
  const app = `"${database.profile.schemas.app}"`;
  const added = ['calendarEventKept', 'vaultUnavailable', 'automationNotification'];
  const existing = [...NOTIFICATION_KINDS.filter((kind) => !added.includes(kind)), 'futureNotification'];
  const future: Migration = {
    id: '9999_future_notifications',
    sql: `ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
      ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check
        CHECK (kind IN (${existing.map((kind) => `'${kind}'`).join(', ')}));`,
  };
  try {
    await migrate(pool, database.profile.schemas, [
      ...MIGRATIONS.filter((migration) => migration.id !== m0133.id),
      future,
    ]);
    const migrations = [...MIGRATIONS, future];
    expect((await migrate(pool, database.profile.schemas, migrations)).applied).toEqual([m0133.id]);
    await pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ('org', 'Organization');
      INSERT INTO ${app}.users (id, email) VALUES ('user', 'user@example.test');`);
    for (const kind of [...existing, ...added]) {
      await pool.query(
        `INSERT INTO ${app}.notifications (id, org_id, recipient_id, kind, subject_id, target)
          VALUES ($1, 'org', 'user', $1, 'subject', '{}')`,
        [kind],
      );
    }
    await expect(
      pool.query(
        `INSERT INTO ${app}.notifications (id, org_id, recipient_id, kind, subject_id, target)
          VALUES ('invalid', 'org', 'user', 'invalid', 'subject', '{}')`,
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_kind_check' });
    await expect(migrate(pool, database.profile.schemas, migrations)).resolves.toEqual({
      applied: [],
      alreadyApplied: migrations.length,
    });
  } finally {
    await pool.end();
    await database.drop();
  }
});

it('reports a changed shipped migration at error level when the server starts', async () => {
  const database = await kit.createDatabase('migration_startup');
  const pool = createPool(database.profile);
  const configDir = mkdtempSync(join(tmpdir(), 'rio-migration-startup-'));
  try {
    await migrate(pool, database.profile.schemas, MIGRATIONS);
    await pool.query(
      `UPDATE "${database.profile.schemas.app}".schema_migrations SET checksum = $1 WHERE id = $2`,
      ['previous-checksum', '0083_automation_steps'],
    );
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        RIOSOMA_CONFIG_DIR: configDir,
        RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
        RIOSOMA_DATABASE_PROFILE: JSON.stringify(database.profile),
        RIOSOMA_LOG_LEVEL: 'debug',
      },
    }).then(
      () => {
        throw new Error('Expected startup failure');
      },
      (error) => error as { code: number; stdout: string; stderr: string },
    );
    expect(result.code).toBe(1);
    const failure = JSON.parse(
      result.stderr
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .at(-1)!,
    );
    expect(failure).toEqual({
      level: 50,
      code: 'startup_failed',
      messageKey: 'server.startup.migrationChanged',
      message:
        'A migration changed after it was applied.  Restore the shipped migration and add a new migration instead.',
      migrationId: '0083_automation_steps',
    });
    for (const value of [database.profile.database, 'previous-checksum', 'ALTER TABLE', 'CREATE TABLE']) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  } finally {
    await pool.end();
    await database.drop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

it('upgrades the shipped schema to ingest storage and starts with ordinary legacy tables', async () => {
  const database = await kit.createDatabase('ingest_upgrade');
  const pool = createPool(database.profile);
  const appSchema = `"${database.profile.schemas.app}"`;
  const configDir = mkdtempSync(join(tmpdir(), 'rio-ingest-upgrade-'));
  try {
    // 0138 shipped before 0137, so a real database held everything through 0138 except 0137.
    // Nothing numbered after that existed yet, and a later migration may build on 0137.
    await migrate(
      pool,
      database.profile.schemas,
      MIGRATIONS.filter((entry) => entry.id !== '0137_ingest_tables' && entry.id < '0139'),
    );
    await pool.query(`INSERT INTO ${appSchema}.orgs (id, name) VALUES ('legacy-org', 'Legacy');
      INSERT INTO ${appSchema}.databases (id, org_id, name) VALUES ('legacy-db', 'legacy-org', 'Legacy');
      INSERT INTO ${appSchema}.tables (id, org_id, database_id, name, primary_field_id, position)
        VALUES ('legacy-table', 'legacy-org', 'legacy-db', 'Legacy', 'legacy-field', 0)`);
    const shipped = await pool.query(`SELECT id, checksum FROM ${appSchema}.schema_migrations ORDER BY id`);
    const applied = (await migrate(pool, database.profile.schemas, MIGRATIONS)).applied;
    expect(applied[0]).toBe('0137_ingest_tables');
    expect(applied.slice(1).every((id) => id >= '0139')).toBe(true);
    expect(
      (await pool.query(`SELECT ingest FROM ${appSchema}.tables WHERE id = 'legacy-table'`)).rows,
    ).toEqual([{ ingest: null }]);
    expect(
      (
        await pool.query(
          `SELECT id, checksum FROM ${appSchema}.schema_migrations WHERE id = ANY($1) ORDER BY id`,
          [shipped.rows.map((row: { id: string }) => row.id)],
        )
      ).rows,
    ).toEqual(shipped.rows);
    const config = {
      ...loadConfig({
        RIOSOMA_CONFIG_DIR: configDir,
        RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
        RIOSOMA_DATABASE_PROFILE: JSON.stringify(database.profile),
        NODE_ENV: 'production',
      }),
      logLevel: 'silent' as const,
      embeddingsPollMs: 0,
      libraryIndexPollMs: 0,
    };
    const setup = new SetupState(configDir, undefined);
    await setup.refresh(pool, database.profile.schemas.app);
    const server = await buildApp({ config, pool, setup, sessions: NO_SESSIONS, mailer: null });
    try {
      await expect(server.ready()).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  } finally {
    await pool.end();
    await database.drop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

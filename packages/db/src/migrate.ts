import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Queryable } from './sql.js';
export { setClientDeadline } from './deadlines.js';
import { SCHEMA_NAME, type DatabaseProfile } from '@riosoma/contracts';
import {
  MIGRATION_DEADLINES,
  poolDeadlines,
  queryDeadlines,
  setClientDeadline,
  type QueryDeadlines,
} from './deadlines.js';

/**
 * Forward-only migrations.  Each migration runs in its own transaction under a transaction-scoped
 * advisory lock, so two instances booting at once never apply the same migration twice, and a
 * transaction pooler (which can't hold session locks) is fine.  Applied migrations are recorded
 * with a checksum; editing one after it shipped is refused rather than silently ignored.
 */
export interface Migration {
  /** Sortable and permanent: `0001_initial`, `0002_sessions`, ... */
  id: string;
  /** SQL with `{{app}}`, `{{data}}`, and `{{audit}}` placeholders for the configured schema names */
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export type MigrationFailureKey =
  | 'server.startup.migrationChanged'
  | 'server.startup.databaseNewer'
  | 'server.startup.migrationStatementFailed';

/** Only these fields may cross the logging boundary, never a driver's message or query. */
export class MigrationError extends Error {
  constructor(
    readonly migrationId: string,
    readonly messageKey: MigrationFailureKey,
    options?: ErrorOptions,
  ) {
    super(messageKey, options);
    this.name = 'MigrationError';
  }
}

export class ChangedMigrationError extends MigrationError {
  constructor(migrationId: string) {
    super(migrationId, 'server.startup.migrationChanged');
    this.name = 'ChangedMigrationError';
    this.message = `Migration ${migrationId} changed after it was applied; add a new migration instead`;
  }
}

export class NewerDatabaseError extends MigrationError {
  constructor(migrationId: string = '') {
    super(migrationId, 'server.startup.databaseNewer');
    this.name = 'NewerDatabaseError';
  }
}

const LOCK_KEY = 725_119_331; // Constant advisory-lock key for Riosoma migrations.

export function renderSql(sql: string, schemas: DatabaseProfile['schemas']): string {
  for (const name of Object.values(schemas)) {
    if (!SCHEMA_NAME.test(name)) throw new Error(`Invalid schema name: ${name}`);
  }
  return sql
    .replaceAll('{{app}}', `"${schemas.app}"`)
    .replaceAll('{{data}}', `"${schemas.data}"`)
    .replaceAll('{{audit}}', `"${schemas.audit}"`);
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function migrate(
  pool: pg.Pool,
  schemas: DatabaseProfile['schemas'],
  migrations: Migration[],
): Promise<MigrationResult> {
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const m of ordered) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`);
    seen.add(m.id);
  }
  const app = `"${schemas.app}"`;
  const checkKnown = async (client: pg.PoolClient) => {
    const result = await client.query<{ id: string }>(`SELECT id FROM ${app}.schema_migrations`);
    const unknown = result.rows.filter((row) => !seen.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (unknown[0]) throw new NewerDatabaseError(unknown[0].id);
  };
  await withTransaction(
    pool,
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${app}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${app}.schema_migrations (
         id text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
      );
      await checkKnown(client);
    },
    MIGRATION_DEADLINES,
  );

  const applied: string[] = [];
  let alreadyApplied = 0;
  for (const m of ordered) {
    const sql = renderSql(m.sql, schemas);
    const sum = checksum(m.sql);
    const done = await withTransaction(
      pool,
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        await checkKnown(client);
        const existing = await client.query<{ checksum: string }>(
          `SELECT checksum FROM ${app}.schema_migrations WHERE id = $1`,
          [m.id],
        );
        const row = existing.rows[0];
        if (row) {
          if (row.checksum !== sum) {
            throw new ChangedMigrationError(m.id);
          }
          return false;
        }
        await client.query(sql);
        await client.query(`INSERT INTO ${app}.schema_migrations (id, checksum) VALUES ($1, $2)`, [
          m.id,
          sum,
        ]);
        return true;
      },
      MIGRATION_DEADLINES,
    ).catch((cause: unknown) => {
      if (cause instanceof MigrationError) throw cause;
      throw new MigrationError(m.id, 'server.startup.migrationStatementFailed', { cause });
    });
    if (done) applied.push(m.id);
    else alreadyApplied += 1;
  }
  return { applied, alreadyApplied };
}

const committedWork = new WeakMap<Queryable, Array<() => void>>();

/** Register background work only for a transaction whose commit this layer owns. */
export function afterCommit(client: Queryable, work: () => void): void {
  committedWork.get(client)?.push(work);
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  deadlines: QueryDeadlines = poolDeadlines(pool),
): Promise<T> {
  deadlines = queryDeadlines(deadlines);
  const client = await pool.connect();
  let failed = false;
  let committed = false;
  const callbacks: Array<() => void> = [];
  committedWork.set(client, callbacks);
  setClientDeadline(client, deadlines.queryTimeoutMs);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${deadlines.statementTimeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${deadlines.lockTimeoutMs}`);
    const result = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    setClientDeadline(client, undefined);
    client.release(failed);
    committedWork.delete(client);
    if (committed) for (const callback of callbacks) queueMicrotask(callback);
  }
}

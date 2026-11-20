import { refuseDemo } from '../demo/boundary.js';
import { performance } from 'node:perf_hooks';
import { AppError, type SqlResult, type SqlRunRequest } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import pg from 'pg';
import { auditEvent } from '../auth/database.js';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from '../data/context.js';
import { rewriteSql, quoteName } from './guard.js';
import { forgetQueryRole, queryRole } from './role.js';
import { sqlAccess } from './store.js';

const DATE = 1082;
const DATE_ARRAY = 1182;
const TEXT_ARRAY: number = 1009;
/**
 * Dates as PostgreSQL writes them, `YYYY-MM-DD`, as the grid shows them.  The driver would read
 * each as midnight in the server's time zone, which is the day before in UTC east of Greenwich.
 */
const resultTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === DATE) return (value: string) => value;
    if (oid === DATE_ARRAY) return pg.types.getTypeParser(TEXT_ARRAY, format);
    return pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser,
};

function runError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: string }).code;
  if (code === '57014') return new AppError('validation_failed', 'sql.run.stopped');
  if (code === '42703') return new AppError('validation_failed', 'sql.run.column');
  // PostgreSQL detail and hints can contain physical names and hidden values.
  return new AppError('validation_failed', 'sql.run.failed');
}

/**
 * Runs one editor query.  The query's transaction holds a connection of `sqlPool`, never of the
 * app's `pool`, which keeps the short bookkeeping around it.
 */
export async function runSql(
  pool: pg.Pool,
  sqlPool: pg.Pool,
  schemas: DataSchemas,
  actor: Actor,
  databaseId: string,
  input: SqlRunRequest,
): Promise<SqlResult> {
  refuseDemo(actor);
  await sqlAccess(pool, schemas, actor, databaseId);
  const role = await queryRole(pool, schemas);
  const recorded = await query(
    pool,
    sql`INSERT INTO ${ident(schemas.app, 'sql_history')} (id, database_id, user_id, query)
    VALUES (${input.id}, ${databaseId}, ${actor.userId}, ${input.query}) ON CONFLICT (id) DO NOTHING`,
  );
  // Clients choose run IDs, so one already in use belongs to an earlier run, perhaps someone else's.
  if (!recorded.rowCount) throw new AppError('conflict', 'sql.run.duplicate');
  const start = performance.now();
  let output: SqlResult | undefined;
  let failure: AppError | undefined;
  let scopeKey = '';
  let connected = false;
  try {
    output = await withTransaction(
      sqlPool,
      async (db) => {
        connected = true;
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await db.query("SELECT set_config('application_name', $1, true)", [`rio_sql:${input.id}`]);
        const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const active = await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'sql_history')} SET backend_pid = ${pid}
        WHERE id = ${input.id} AND NOT canceled RETURNING id`,
        );
        if (!active.rowCount) throw new AppError('validation_failed', 'sql.run.stopped');
        try {
          const access = await sqlAccess(db, schemas, actor, databaseId);
          scopeKey = access.scopeKey;
          const rewritten = await rewriteSql(input.query, access.sources);
          await db.query(`SET LOCAL statement_timeout = ${access.settings.timeoutMs}`);
          await db.query("SET LOCAL search_path = ''");
          await db.query('SET LOCAL standard_conforming_strings = on');
          await db.query("SET LOCAL datestyle = 'ISO'");
          const canceled = await query<{ canceled: boolean }>(
            pool,
            sql`SELECT canceled FROM ${ident(schemas.app, 'sql_history')} WHERE id = ${input.id}`,
          );
          if (canceled.rows[0]?.canceled !== false)
            throw new AppError('validation_failed', 'sql.run.stopped');
          // The scope already filters every table, so the query runs as a role that can only read.
          if (role.active)
            await db.query(`SET LOCAL ROLE ${quoteName(role.role)}`).catch((error: unknown) => {
              forgetQueryRole(pool);
              throw error;
            });
          const result = await db.query<unknown[]>({
            text: `SELECT * FROM (${rewritten}) AS result LIMIT ${access.settings.rowCap + 1}`,
            rowMode: 'array',
            types: resultTypes,
          });
          const rows = result.rows.slice(0, access.settings.rowCap);
          if (Buffer.byteLength(JSON.stringify(rows)) > 32 * 1024 * 1024)
            throw new AppError('validation_failed', 'sql.run.size');
          return {
            id: input.id,
            columns: result.fields.map((field) => field.name),
            rows,
            rowCount: rows.length,
            durationMs: 0,
            capped: result.rows.length > access.settings.rowCap,
          };
        } finally {
          await query(
            pool,
            sql`UPDATE ${ident(schemas.app, 'sql_history')} SET backend_pid = NULL WHERE id = ${input.id}`,
          );
        }
      },
      {
        // The client deadline must allow the largest administrator query timeout to finish first.
        queryTimeoutMs: 121_000,
        statementTimeoutMs: 30_000,
        lockTimeoutMs: 10_000,
      },
    );
  } catch (error) {
    // Without a connection before the wait ran out, every SQL connection was busy with other runs.
    failure = connected ? runError(error) : new AppError('unavailable', 'sql.run.busy');
  }
  // Coarse durations make a query's timing a poorer count of the records a rule hides.
  const durationMs = Math.round((performance.now() - start) / 100) * 100;
  if (output) output.durationMs = durationMs;
  await withTransaction(pool, async (db) => {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'sql_history')} SET backend_pid = NULL,
      row_count = ${output?.rowCount ?? 0}, duration_ms = ${durationMs}, error = ${failure?.messageKey ?? null},
      result = ${output ? JSON.stringify(output) : null}::jsonb, scope_key = ${scopeKey} WHERE id = ${input.id}`,
    );
    await auditEvent(db, quoteName(schemas.audit), 'databases.sql.executed', actor, {
      databaseId,
      query: input.query,
      rowCount: output?.rowCount ?? 0,
      durationMs,
      error: failure?.messageKey ?? null,
    });
    await query(
      db,
      sql`DELETE FROM ${ident(schemas.app, 'sql_history')} WHERE database_id = ${databaseId}
      AND user_id = ${actor.userId} AND backend_pid IS NULL AND id NOT IN
      (SELECT id FROM ${ident(schemas.app, 'sql_history')} WHERE database_id = ${databaseId} AND user_id = ${actor.userId} ORDER BY created_at DESC LIMIT 50)`,
    );
  });
  if (failure) throw failure;
  return output!;
}

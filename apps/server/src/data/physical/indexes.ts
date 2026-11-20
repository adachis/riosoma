import type pg from 'pg';
import { compile, ident, query, sql, setClientDeadline, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import type { ReadContext, StoredField } from '../types.js';
import { SYSTEM } from './columns.js';
import { sortExpression } from './sorts.js';

async function indexState(db: Queryable, dataSchema: string, tableId: string, name: string) {
  const result = await query<{ valid: boolean; building: boolean }>(
    db,
    sql`
    SELECT i.indisvalid AS valid,
      EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid) AS building
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = ${dataSchema} AND t.relname = ${tableId} AND c.relname = ${name}`,
  );
  return result.rows[0];
}

function lacksPrivilege(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}

function concurrentCollision(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '42P07' || error.code === '23505')
  );
}

const sourceBuilds = new WeakMap<pg.Pool, Map<string, Promise<void>>>();

/** Readers use ordinary lookups until the optional index finishes building. */
export function buildSourceChoiceIndex(pool: pg.Pool, schemas: DataSchemas, tableId: string): Promise<void> {
  let active = sourceBuilds.get(pool);
  if (!active) sourceBuilds.set(pool, (active = new Map()));
  const key = `${schemas.data}:${tableId}`;
  const pending = active.get(key);
  if (pending) return pending;
  const building = sourceChoiceIndex(pool, schemas, tableId).finally(() => active.delete(key));
  active.set(key, building);
  return building;
}

async function sourceChoiceIndex(pool: pg.Pool, schemas: DataSchemas, tableId: string): Promise<void> {
  const name = `${tableId}_choice`;
  const key = `${schemas.data}:${name}`;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await query<{ locked: boolean }>(
      client,
      sql`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`,
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return;
    const existing = await indexState(client, schemas.data, tableId, name);
    if (existing?.valid || existing?.building) return;
    setClientDeadline(client, 600_000);
    await client.query("SET statement_timeout = '10min'");
    await client.query("SET lock_timeout = '10min'");
    if (existing) await query(client, sql`DROP INDEX CONCURRENTLY IF EXISTS ${ident(schemas.data, name)}`);
    await query(
      client,
      sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)} ON ${ident(schemas.data, tableId)}
      (${ident(schemas.data, 'source_choice_id')}(__id))`,
    );
  } finally {
    if (locked)
      await query(client, sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`).catch(() => undefined);
    await client.query('RESET statement_timeout').catch(() => undefined);
    await client.query('RESET lock_timeout').catch(() => undefined);
    setClientDeadline(client, undefined);
    client.release();
  }
}

export async function ensureIndex(
  pool: pg.Pool,
  schemas: DataSchemas,
  tableId: string,
  field: StoredField,
  ctx: ReadContext,
): Promise<'created' | 'exists' | 'skipped'> {
  // Index expressions cannot contain subqueries, and utility DDL cannot bind choice arrays.
  if (
    ['link', 'lookup', 'rollup', 'count', 'formula', 'attachment', 'button', 'changeLog'].includes(
      field.type,
    ) ||
    field.type === 'user' ||
    field.type === 'createdBy' ||
    field.type === 'lastModifiedBy' ||
    field.type === 'singleSelect' ||
    field.type === 'multipleSelect'
  )
    return 'skipped';
  const name = `rio_${tableId}_${field.id}`;
  const client = await pool.connect();
  // Only one caller, in any replica, may work on an index at a time.  Without this, a second caller
  // can see a build in progress as an invalid index and drop it out from under the first.
  const locked = await query<{ locked: boolean }>(
    client,
    sql`SELECT pg_try_advisory_lock(hashtextextended(${name}, 0)) AS locked`,
  ).catch((error: unknown) => {
    client.release();
    throw error;
  });
  if (!locked.rows[0]?.locked) {
    client.release();
    return 'skipped';
  }
  try {
    const table = await query<{ rows: number }>(
      client,
      sql`
      SELECT c.reltuples AS rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemas.data} AND c.relname = ${tableId}`,
    );
    if (!table.rows[0] || table.rows[0].rows < 50_000) return 'skipped';
    const existing = await indexState(client, schemas.data, tableId, name);
    // An in-progress concurrent build is invalid until its final validation completes.
    if (existing && !existing.valid && existing.building) return 'skipped';
    if (existing && !existing.valid) {
      await query(client, sql`DROP INDEX CONCURRENTLY IF EXISTS ${ident(schemas.data, name)}`);
    }
    // Plain-column sorts can already have a usable index maintained outside the advisor.
    // Match the tie breaker, direction, collation, and predicate before avoiding a duplicate.
    if (
      !existing?.valid &&
      compile(sortExpression(field, ctx, schemas.data, schemas.app)).text ===
        compile(sql`${ident(field.columnName)}`).text
    ) {
      const matching = await query<{ available: boolean }>(
        client,
        sql`SELECT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_class ix ON ix.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ix.relam
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
        JOIN pg_attribute r ON r.attrelid = t.oid AND r.attnum = i.indkey[1]
        WHERE n.nspname = ${schemas.data} AND t.relname = ${tableId}
          AND am.amname = 'btree' AND i.indisvalid AND i.indnkeyatts >= 2
          AND a.attname = ${field.columnName} AND r.attname = ${SYSTEM.rid}
          AND i.indoption[0] = 0 AND i.indoption[1] = 0
          AND i.indcollation[0] = a.attcollation
          AND (i.indpred IS NULL OR pg_get_expr(i.indpred, i.indrelid) = '(__deleted_at IS NULL)')
      ) AS available`,
      );
      if (matching.rows[0]?.available) return 'exists';
    }
    let created = false;
    if (!existing?.valid) {
      try {
        await query(
          client,
          sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)}
          ON ${ident(schemas.data, tableId)} ((${sortExpression(field, ctx, schemas.data, schemas.app)}),
            ${ident(SYSTEM.rid)}) WHERE ${ident(SYSTEM.deletedAt)} IS NULL`,
        );
        created = true;
      } catch (error) {
        const failed = await indexState(client, schemas.data, tableId, name);
        if (failed?.building) return 'skipped';
        if (failed && !failed.valid) {
          await query(client, sql`DROP INDEX CONCURRENTLY IF EXISTS ${ident(schemas.data, name)}`);
        }
        if (!failed?.valid || !concurrentCollision(error)) throw error;
      }
      if (!(await indexState(client, schemas.data, tableId, name))?.valid) return 'skipped';
    }
    await query(
      client,
      sql`INSERT INTO ${ident(schemas.app, 'data_indexes')}
      (index_name, table_id, field_ids) VALUES (${name}, ${tableId}, ${[field.id]}::text[])
      ON CONFLICT (index_name) DO UPDATE SET last_used_at = now()`,
    );
    return created ? 'created' : 'exists';
  } catch (error) {
    if (lacksPrivilege(error)) return 'skipped';
    throw error;
  } finally {
    await query(client, sql`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`).catch(() => undefined);
    client.release();
  }
}

export async function dropFieldIndexes(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  fieldId: string,
): Promise<void> {
  const result = await query<{ index_name: string }>(
    db,
    sql`
    SELECT index_name FROM ${ident(schemas.app, 'data_indexes')}
    WHERE table_id = ${tableId} AND ${fieldId} = ANY(field_ids)`,
  );
  const names = new Set(result.rows.map((r) => r.index_name));
  // A process may have stopped after building the index but before recording it.
  names.add(`rio_${tableId}_${fieldId}`);
  for (const name of names) {
    await query(db, sql`DROP INDEX IF EXISTS ${ident(schemas.data, name)}`);
  }
  await query(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'data_indexes')}
    WHERE table_id = ${tableId} AND ${fieldId} = ANY(field_ids)`,
  );
}

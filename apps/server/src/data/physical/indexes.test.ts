import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ident, query, sql } from '@riosoma/db';
import { dropFieldIndexes, ensureIndex } from './indexes.js';
import { compileOrder } from './sorts.js';
import { ctx, field, fixture, schemas, type Fixture } from './order.test-helpers.js';

let kit: Fixture;
beforeAll(async () => {
  kit = await fixture();
}, 60_000);
afterAll(async () => {
  await kit?.close();
});

async function catalogIndex(name: string) {
  const result = await query<{ valid: boolean; definition: string }>(
    kit.pool,
    sql`
    SELECT i.indisvalid AS valid, pg_get_indexdef(c.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid WHERE n.nspname = ${schemas.data} AND c.relname = ${name}`,
  );
  return result.rows[0];
}

describe('index advisor', () => {
  it('reuses an equivalent external sort index while rejecting restricted membership and reversed ties', async () => {
    const f = field('number');
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(f.columnName)})
      SELECT 'rec' || n, n FROM generate_series(1, 50000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    await query(
      kit.pool,
      sql`CREATE INDEX ${ident(`${table}_reverse`)} ON ${ident(schemas.data, table)}
      (${ident(f.columnName)}, __rid DESC) WHERE __deleted_at IS NULL`,
    );
    await query(
      kit.pool,
      sql`CREATE INDEX ${ident(`${table}_restricted`)} ON ${ident(schemas.data, table)}
      (${ident(f.columnName)}, __rid) WHERE __deleted_at IS NULL AND ${ident(f.columnName)} > 100`,
    );
    expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('created');
    await dropFieldIndexes(kit.pool, schemas, table, f.id);
    await query(
      kit.pool,
      sql`CREATE INDEX ${ident(`${table}_external`)} ON ${ident(schemas.data, table)}
      (${ident(f.columnName)}, __rid) WHERE __deleted_at IS NULL`,
    );
    expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('exists');
    expect(await catalogIndex(`rio_${table}_${f.id}`)).toBeUndefined();
    expect((await catalogIndex(`${table}_external`))?.valid).toBe(true);
  });

  it('creates matching partial indexes, records them, and is idempotent', async () => {
    const text = field('text');
    const number = field('number');
    const checkbox = field('checkbox');
    const date = field('date', { includeTime: true });
    const fields = [text, number, checkbox, date];
    const table = await kit.table(fields);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)}
      (__id, ${ident(text.columnName)}, ${ident(number.columnName)}, ${ident(checkbox.columnName)}, ${ident(date.columnName)})
      SELECT ${'rec'} || n, ${'Item '} || (50001 - n), n, n % 2 = 0,
        ${'2024-01-01T00:00:00Z'}::timestamptz + n * interval '1 second'
      FROM generate_series(1, 50000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    for (const f of fields) {
      const name = `rio_${table}_${f.id}`;
      expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('created');
      expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('exists');
      expect((await catalogIndex(name))?.valid).toBe(true);
      expect((await catalogIndex(name))?.definition).toContain('WHERE (__deleted_at IS NULL)');
      const plan = await query<{ 'QUERY PLAN': string }>(
        kit.pool,
        sql`EXPLAIN SELECT __rid
        FROM ${ident(schemas.data, table)} WHERE __deleted_at IS NULL
        ORDER BY ${compileOrder([{ fieldId: f.id, direction: 'asc' }], new Map([[f.id, f]]), ctx, schemas.data, schemas.app)} LIMIT 50`,
      );
      const explanation = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(explanation).toContain(name);
      expect(explanation).not.toContain('Sort');
    }
    const metadata = await query<{ field_ids: string[] }>(
      kit.pool,
      sql`SELECT field_ids
      FROM ${ident(schemas.app, 'data_indexes')} WHERE table_id = ${table}`,
    );
    expect(metadata.rows.map((r) => r.field_ids[0]).sort()).toEqual(fields.map((f) => f.id).sort());
    await dropFieldIndexes(kit.pool, schemas, table, text.id);
    await dropFieldIndexes(kit.pool, schemas, table, text.id);
    expect(await catalogIndex(`rio_${table}_${text.id}`)).toBeUndefined();
    expect((await catalogIndex(`rio_${table}_${number.id}`))?.valid).toBe(true);
    const remaining = await query(
      kit.pool,
      sql`SELECT * FROM ${ident(schemas.app, 'data_indexes')}
      WHERE table_id = ${table} AND ${text.id} = ANY(field_ids)`,
    );
    expect(remaining.rowCount).toBe(0);
  });

  it('skips small tables and expressions that cannot be indexed', async () => {
    const f = field('text');
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id)
      SELECT ${'rec'} || n FROM generate_series(1, 49999) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('skipped');
    expect(await catalogIndex(`rio_${table}_${f.id}`)).toBeUndefined();
    for (const type of ['singleSelect', 'multipleSelect', 'createdBy', 'lastModifiedBy'] as const) {
      expect(await ensureIndex(kit.pool, schemas, table, field(type), ctx)).toBe('skipped');
    }
  });

  it("does not remove another caller's active concurrent build", async () => {
    const f = field('number');
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(f.columnName)})
      SELECT ${'rec'} || n, n FROM generate_series(1, 50000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    const results = await Promise.all([
      ensureIndex(kit.pool, schemas, table, f, ctx),
      ensureIndex(kit.pool, schemas, table, f, ctx),
    ]);
    expect(results).toContain('created');
    expect((await catalogIndex(`rio_${table}_${f.id}`))?.valid).toBe(true);
    expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('exists');
  });

  it('returns skipped without leaking its client when the role lacks ownership', async () => {
    const f = field('number');
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id)
      SELECT ${'rec'} || n FROM generate_series(1, 50000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    const role = `reader_${table}`;
    await query(kit.pool, sql`CREATE ROLE ${ident(role)} NOLOGIN`);
    await query(
      kit.pool,
      sql`GRANT USAGE ON SCHEMA ${ident(schemas.data)}, ${ident(schemas.app)} TO ${ident(role)}`,
    );
    await query(kit.pool, sql`GRANT SELECT ON ${ident(schemas.data, table)} TO ${ident(role)}`);
    const pool = new pg.Pool({ connectionString: kit.url, options: `-c role=${role}`, max: 1 });
    try {
      expect(await ensureIndex(pool, schemas, table, f, ctx)).toBe('skipped');
      expect(await ensureIndex(pool, schemas, table, f, ctx)).toBe('skipped');
      expect(pool.idleCount).toBe(1);
      expect(await catalogIndex(`rio_${table}_${f.id}`)).toBeUndefined();
    } finally {
      await pool.end();
      await query(kit.pool, sql`DROP OWNED BY ${ident(role)}`);
      await query(kit.pool, sql`DROP ROLE ${ident(role)}`);
    }
  });

  it('removes invalid indexes left by failed concurrent builds and can retry', async () => {
    const f = field('text');
    const table = await kit.table([f]);
    const name = `rio_${table}_${f.id}`;
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(f.columnName)})
      SELECT ${'rec'} || n, CASE WHEN n = 1
        THEN (SELECT string_agg(md5(s::text), '') FROM generate_series(1, 300) s) ELSE ${'small'} END
      FROM generate_series(1, 50000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    await expect(ensureIndex(kit.pool, schemas, table, f, ctx)).rejects.toMatchObject({ code: '54000' });
    expect(await catalogIndex(name)).toBeUndefined();
    await query(
      kit.pool,
      sql`UPDATE ${ident(schemas.data, table)} SET ${ident(f.columnName)} = ${'small'} WHERE __rid = 1`,
    );
    expect(await ensureIndex(kit.pool, schemas, table, f, ctx)).toBe('created');
    expect((await catalogIndex(name))?.valid).toBe(true);
  });
});

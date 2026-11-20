import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilterGroup, Sort } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { compileFilter } from './filters.js';
import { firstOrderedRids, matchingIds, orderedRids, ridsForIds, touchesView } from './order.js';
import { compileOrder } from './sorts.js';
import {
  choiceIds,
  condition,
  ctx,
  field,
  fixture,
  group,
  schemas,
  userIds,
  type Fixture,
} from './order.test-helpers.js';

let kit: Fixture;
beforeAll(async () => {
  kit = await fixture();
}, 60_000);
afterAll(async () => {
  await kit?.close();
});

describe('view order', () => {
  it('stays in order when Postgres plans the scan in parallel', async () => {
    const text = field('text');
    const fields = new Map([[text.id, text]]);
    const table = await kit.table([text]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(text.columnName)})
      SELECT ${'rec'} || n, md5(n::text) FROM generate_series(1, 200000) n`,
    );
    await query(kit.pool, sql`ANALYZE ${ident(schemas.data, table)}`);
    const client = await kit.pool.connect();
    try {
      // Make parallel plans as cheap as possible, so the planner uses them wherever it can.
      await client.query('SET max_parallel_workers_per_gather = 4');
      await client.query('SET parallel_setup_cost = 0');
      await client.query('SET parallel_tuple_cost = 0');
      await client.query('SET min_parallel_table_scan_size = 0');
      const view = { filter: null, sorts: [{ fieldId: text.id, direction: 'desc' as const }] };
      const rids = await orderedRids(client, schemas, table, fields, view, sql`TRUE`, ctx);
      const plain = await query<{ __rid: string }>(
        client,
        sql`SELECT __rid FROM ${ident(schemas.data, table)} WHERE __deleted_at IS NULL
        ORDER BY ${compileOrder(view.sorts, fields, ctx, schemas.data, schemas.app)}`,
      );
      const plan = await query<{ 'QUERY PLAN': string }>(
        client,
        sql`EXPLAIN SELECT __rid FROM ${ident(schemas.data, table)} WHERE __deleted_at IS NULL
        ORDER BY ${compileOrder(view.sorts, fields, ctx, schemas.data, schemas.app)}`,
      );
      // The check means something only if the planner really went parallel.
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/Gather/);
      expect(rids.length).toBe(200000);
      expect(Array.from(rids)).toEqual(plain.rows.map((r) => Number(r.__rid)));
    } finally {
      client.release();
    }
  }, 60_000);

  it('matches a plain ordered SELECT on 10,000 random rows', async () => {
    const text = field('text');
    const number = field('number');
    const person = field('createdBy');
    const select = field('singleSelect', {
      choices: choiceIds.map((id) => ({ id, name: id, color: 'gray' })),
    });
    const fields = new Map([text, number, person, select].map((f) => [f.id, f]));
    const table = await kit.table([...fields.values()]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)}
      (__id, __created_by, __deleted_at, ${ident(text.columnName)}, ${ident(number.columnName)}, ${ident(select.columnName)})
      SELECT ${'rec'} || n, (${userIds}::text[])[1 + n % 3],
        CASE WHEN n % 19 = 0 THEN now() END,
        CASE WHEN n % 13 <> 0 THEN ${'Item '} || floor(random() * 100)::text END,
        CASE WHEN n % 17 <> 0 THEN floor(random() * 30) END,
        (${choiceIds}::text[])[1 + n % 4]
      FROM generate_series(1, 10000) n`,
    );
    const cases: { filter: FilterGroup | null; sorts: Sort[] }[] = [
      { filter: null, sorts: [] },
      { filter: null, sorts: [{ fieldId: text.id, direction: 'asc' }] },
      {
        filter: group(condition(number, 'gte', 10)),
        sorts: [
          { fieldId: text.id, direction: 'desc' },
          { fieldId: number.id, direction: 'asc' },
        ],
      },
      {
        filter: {
          conjunction: 'or',
          conditions: [condition(text, 'contains', '2'), condition(number, 'neq', 5)],
        },
        sorts: [{ fieldId: number.id, direction: 'desc' }],
      },
      {
        filter: group(condition(select, 'isNoneOf', [choiceIds[0]])),
        sorts: [
          { fieldId: person.id, direction: 'asc' },
          { fieldId: select.id, direction: 'desc' },
        ],
      },
    ];
    const scope = sql`__rid % 7 <> 0 OR __rid = 7`;
    for (const view of cases) {
      const plain = await query<{ __rid: string }>(
        kit.pool,
        sql`SELECT __rid FROM ${ident(schemas.data, table)}
        WHERE __deleted_at IS NULL AND (${scope}) AND ${compileFilter(view.filter, fields, ctx)}
        ORDER BY ${compileOrder(view.sorts, fields, ctx, schemas.data, schemas.app)}`,
      );
      const ordered = await orderedRids(kit.pool, schemas, table, fields, view, scope, ctx);
      expect(ordered).toBeInstanceOf(Float64Array);
      expect([...ordered]).toEqual(plain.rows.map((r) => Number(r.__rid)));
    }
  });

  it('filters changed IDs by membership and scope and maps active row numbers', async () => {
    const f = field('number');
    const fields = new Map([[f.id, f]]);
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(f.columnName)}, __deleted_at)
      SELECT ${'rec'} || n, n, CASE WHEN n = 4 THEN now() END FROM generate_series(1, 5) n`,
    );
    const ids = ['rec1', 'rec2', 'rec3', 'rec4', 'rec5', 'missing', 'rec3'];
    expect(
      await matchingIds(
        kit.pool,
        schemas,
        table,
        fields,
        group(condition(f, 'gte', 2)),
        sql`__rid < 5`,
        ids,
        ctx,
      ),
    ).toEqual(new Set(['rec2', 'rec3']));
    expect(await matchingIds(kit.pool, schemas, table, fields, null, sql`TRUE`, [], ctx)).toEqual(new Set());
    expect(await ridsForIds(kit.pool, schemas.data, table, ids)).toEqual(
      new Map([
        ['rec1', 1],
        ['rec2', 2],
        ['rec3', 3],
        ['rec5', 5],
      ]),
    );
    expect(await ridsForIds(kit.pool, schemas.data, table, [])).toEqual(new Map());
    expect(await orderedRids(kit.pool, schemas, table, fields, { sorts: [] }, sql`FALSE`, ctx)).toEqual(
      new Float64Array(),
    );
  });

  it('decodes row numbers beyond 32 bits and rejects precision loss', async () => {
    const table = await kit.table();
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__rid, __id)
      VALUES (${4294967297}, ${'a'}), (${Number.MAX_SAFE_INTEGER}, ${'b'})`,
    );
    expect([
      ...(await orderedRids(kit.pool, schemas, table, new Map(), { sorts: [] }, sql`TRUE`, ctx)),
    ]).toEqual([4294967297, Number.MAX_SAFE_INTEGER]);
    expect(
      await firstOrderedRids(kit.pool, schemas, table, new Map(), { sorts: [] }, sql`TRUE`, ctx, 1),
    ).toEqual({ total: 2, rids: [4294967297] });
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__rid, __id) VALUES (${'9007199254740993'}::bigint, ${'c'})`,
    );
    await expect(
      orderedRids(kit.pool, schemas, table, new Map(), { sorts: [] }, sql`TRUE`, ctx),
    ).rejects.toThrow(RangeError);
    await expect(
      firstOrderedRids(kit.pool, schemas, table, new Map(), { sorts: [] }, sql`TRUE`, ctx, 3),
    ).rejects.toThrow(RangeError);
    await expect(ridsForIds(kit.pool, schemas.data, table, ['c'])).rejects.toThrow(RangeError);
  });

  it('counts the exact filtered membership while reading only a sorted prefix, including ties and blanks', async () => {
    const f = field('number');
    const fields = new Map([[f.id, f]]);
    const table = await kit.table([f]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)}
      (__id, ${ident(f.columnName)}, __deleted_at, __source_gone)
      VALUES ('a', 2, NULL, false), ('b', 1, NULL, false), ('c', 1, NULL, false),
        ('d', NULL, NULL, false), ('e', 0, now(), false), ('f', 0, NULL, true), ('g', 0, NULL, false)`,
    );
    const view = {
      sorts: [{ fieldId: f.id, direction: 'asc' as const }],
      filter: group(condition(f, 'neq', 2)),
    };
    const predicate = sql`__id <> ${'g'}`;
    const all = await orderedRids(kit.pool, schemas, table, fields, view, predicate, ctx);
    for (const limit of [0, 1, 2, 10]) {
      expect(await firstOrderedRids(kit.pool, schemas, table, fields, view, predicate, ctx, limit)).toEqual({
        total: all.length,
        rids: Array.from(all.subarray(0, limit)),
      });
    }
    expect(await firstOrderedRids(kit.pool, schemas, table, fields, view, sql`FALSE`, ctx, 10)).toEqual({
      total: 0,
      rids: [],
    });
  });

  it('detects nested membership and sort dependencies with a single-use iterable', () => {
    const a = field('text');
    const b = field('number');
    const view = {
      filter: group(group(condition(a, 'is', 'A'))),
      sorts: [{ fieldId: b.id, direction: 'asc' as const }],
    };
    expect(touchesView(view, [a.id])).toEqual({ membership: true, order: false });
    expect(touchesView(view, [b.id])).toEqual({ membership: false, order: true });
    expect(touchesView(view, new Set([a.id, b.id]).values())).toEqual({ membership: true, order: true });
    expect(touchesView(view, ['other'])).toEqual({ membership: false, order: false });
    expect(touchesView({ sorts: [] }, [a.id])).toEqual({ membership: false, order: false });
  });

  it('orders 200,000 rows by unindexed text within three seconds', async () => {
    const f = field('text');
    const table = await kit.table([f]);
    const fields = new Map([[f.id, f]]);
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id, ${ident(f.columnName)})
      SELECT ${'rec'} || n, ${'Item '} || (200001 - n) FROM generate_series(1, 200000) n`,
    );
    const start = performance.now();
    const rids = await orderedRids(
      kit.pool,
      schemas,
      table,
      fields,
      { sorts: [{ fieldId: f.id, direction: 'asc' }] },
      sql`TRUE`,
      ctx,
    );
    const elapsed = performance.now() - start;
    expect(rids.length).toBe(200_000);
    expect(rids[0]).toBe(200_000);
    expect(rids[199_999]).toBe(1);
    expect(elapsed).toBeLessThan(3_000);
  }, 15_000);

  it('aggregates one million rows without filters or sorts', async () => {
    const table = await kit.table();
    await query(
      kit.pool,
      sql`INSERT INTO ${ident(schemas.data, table)} (__id)
      SELECT ${'rec'} || n FROM generate_series(1, 1000000) n`,
    );
    const start = performance.now();
    const rids = await orderedRids(kit.pool, schemas, table, new Map(), { sorts: [] }, sql`TRUE`, ctx);
    expect(rids.length).toBe(1_000_000);
    expect(rids[0]).toBe(1);
    expect(rids[999_999]).toBe(1_000_000);
    expect(performance.now() - start).toBeLessThan(3_000);
  }, 20_000);
});

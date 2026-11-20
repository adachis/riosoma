import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkCellValue, FieldSpec, LIMITS, newId, type CellValue } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import type { StoredField } from '../types.js';
import { columnRef, jsonValueExpr, selectExpr } from './columns.js';
import {
  CONVERSION_BATCH_SIZE,
  convertColumn,
  previewConversion,
  planLinkConversion,
  type ConversionOptions,
} from './convert.js';
import { convertLinks } from './convert-links.js';
import { createRecordTable } from './ddl.js';

let kit: TestPostgres;
let server: ServerFixture;
const options: ConversionOptions = { dateOrder: 'mdy', timeZone: 'America/Los_Angeles' };
const sizes = [50, 200_000];
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'conversion_scale');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function field(spec: unknown, tableId = newId('table')): StoredField {
  const id = newId('field');
  return {
    id,
    tableId,
    columnName: id,
    name: 'Value',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    ...FieldSpec.parse(spec),
  };
}

function observe(db: Queryable) {
  const statements: string[] = [];
  let maximum = 0;
  const original = db.query;
  const spy = vi.spyOn(db, 'query').mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (typeof args[0] === 'string') statements.push(args[0]);
        if (!(result instanceof Promise)) return result;
        return result.then((value: pg.QueryResult) => {
          maximum = Math.max(maximum, value.rows.length);
          expect(value.rows.length).toBeLessThanOrEqual(CONVERSION_BATCH_SIZE);
          return value;
        });
      },
    }),
  );
  return { statements, maximum: () => maximum, restore: () => spy.mockRestore() };
}

async function seed(db: Queryable, source: StoredField, count: number, values: CellValue[]) {
  await createRecordTable(db, server.schemas.data, source.tableId, [source]);
  await query(
    db,
    sql`
    INSERT INTO ${ident(server.schemas.data, source.tableId)} (__rid, __id, __deleted_at, ${ident(source.columnName)})
    SELECT 9007199254740992::bigint + n * 2, 'rec' || lpad(n::text, 14, '0'),
      CASE WHEN n % 17 = 0 THEN now() ELSE NULL END,
      ${jsonValueExpr(source, sql`${JSON.stringify(values)}::jsonb -> ((n - 1) % ${values.length})::int`)}
    FROM generate_series(1, ${count}) n`,
  );
}

function comparable(target: StoredField) {
  if (target.type !== 'singleSelect') return selectExpr(target);
  const names = Object.fromEntries(target.options.choices.map((choice) => [choice.id, choice.name]));
  return sql`${JSON.stringify(names)}::jsonb ->> ${columnRef(target)}`;
}

const cases = [
  {
    name: 'text to number',
    from: { type: 'text' },
    to: { type: 'number' },
    values: ['1,234.50', 'invalid', null, '-2.5', '$12'],
    direct: false,
  },
  {
    name: 'number to text',
    from: { type: 'number' },
    to: { type: 'text' },
    values: [12.5, 0, null, -1e-7, 1e21],
    direct: true,
  },
  {
    name: 'text to date',
    from: { type: 'text' },
    to: { type: 'date', options: { includeTime: true } },
    values: ['2024-03-10', '02/29/2024', '2023-02-29', '2024-03-01T03:02:03+02:00', null],
    direct: false,
  },
  {
    name: 'text to single select',
    from: { type: 'text' },
    to: { type: 'singleSelect' },
    values: ['First', ' SECOND ', 'first', ' ', null],
    direct: false,
  },
  {
    name: 'dates to text',
    from: { type: 'date', options: { includeTime: true } },
    to: { type: 'text' },
    values: [
      '2024-03-10T09:30:00Z',
      '2024-03-10T10:30:00Z',
      null,
      '2024-11-03T08:30:00Z',
      '2024-11-03T09:30:00Z',
    ],
    direct: true,
  },
] satisfies Array<{ name: string; from: unknown; to: unknown; values: CellValue[]; direct: boolean }>;

describe('conversion batches', () => {
  it.each(cases)(
    '$name agrees on 50 and 200,000 records',
    async ({ from, to: input, values, direct }) => {
      let expected: unknown[] = [];
      let baseline: Awaited<ReturnType<typeof previewConversion>> | undefined;
      for (const count of sizes) {
        const source = field(from);
        await seed(server.pool, source, count, values);
        const poolReads = observe(server.pool);
        const to = FieldSpec.parse(input);
        const preview = await previewConversion(
          server.pool,
          server.schemas.data,
          source.tableId,
          source,
          to,
          options,
        );
        expect(poolReads.maximum()).toBe(Math.min(count, CONVERSION_BATCH_SIZE));
        expect(poolReads.statements.some((statement) => /\bOFFSET\b/i.test(statement))).toBe(false);
        poolReads.restore();
        if (!baseline) baseline = preview;
        expect(preview).toEqual({
          ...baseline,
          total: (baseline.total * count) / 50,
          converted: (baseline.converted * count) / 50,
          emptied: (baseline.emptied * count) / 50,
        });
        const db = await server.pool.connect();
        try {
          await query(db, sql`BEGIN`);
          const writes = observe(db);
          const converted = await convertColumn(
            db,
            server.schemas.data,
            source.tableId,
            source,
            to,
            'converted',
            options,
          );
          expect(converted.emptied).toBe(preview.emptied);
          const updates = writes.statements.filter((statement) =>
            /UPDATE .* SET "converted"/s.test(statement),
          );
          expect(updates).toHaveLength(direct ? 1 : Math.ceil(count / CONVERSION_BATCH_SIZE));
          if (direct)
            expect(writes.statements.some((statement) => /ORDER BY __rid LIMIT/.test(statement))).toBe(false);
          writes.restore();
          const target = {
            ...source,
            ...to,
            options: converted.options,
            columnName: 'converted',
          } as StoredField;
          if (count === 50) {
            const sample = await query<{ value: unknown }>(
              db,
              sql`SELECT ${comparable(target)} AS value
            FROM ${ident(server.schemas.data, source.tableId)} ORDER BY __rid`,
            );
            expected = sample.rows.map((row) => row.value);
          }
          const differences = await query<{ count: string }>(
            db,
            sql`
          SELECT count(*)::text AS count FROM ${ident(server.schemas.data, source.tableId)}
          WHERE to_jsonb(${comparable(target)}) IS DISTINCT FROM NULLIF(${JSON.stringify(expected)}::jsonb
            -> (((__rid - 9007199254740992::bigint) / 2 - 1) % 50)::int, 'null'::jsonb)
          OR ${columnRef(source)} IS DISTINCT FROM ${jsonValueExpr(
            source,
            sql`${JSON.stringify(values)}::jsonb
            -> (((__rid - 9007199254740992::bigint) / 2 - 1) % ${values.length})::int`,
          )}`,
          );
          expect(differences.rows[0]!.count).toBe('0');
          await query(db, sql`COMMIT`);
        } finally {
          vi.restoreAllMocks();
          db.release();
        }
      }
    },
    120_000,
  );

  it('discovers late choices before DDL and keeps their identities across batches', async () => {
    const source = field({ type: 'text' });
    await seed(server.pool, source, 6_001, ['First']);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, source.tableId)}
      SET ${ident(source.columnName)} = 'Second' WHERE __rid > 9007199254750992::bigint`,
    );
    const to = FieldSpec.parse({ type: 'singleSelect' });
    const preview = await previewConversion(
      server.pool,
      server.schemas.data,
      source.tableId,
      source,
      to,
      options,
    );
    expect(preview).toMatchObject({ total: 6_001, converted: 6_001, newChoices: ['First', 'Second'] });
    const db = await server.pool.connect();
    try {
      await query(db, sql`BEGIN`);
      const result = await convertColumn(
        db,
        server.schemas.data,
        source.tableId,
        source,
        to,
        'converted',
        options,
      );
      const parsed = FieldSpec.parse({ type: 'singleSelect', options: result.options });
      if (parsed.type !== 'singleSelect') throw new Error('Expected select');
      expect(parsed.options.choices.map((choice) => choice.name)).toEqual(['First', 'Second']);
      const late = await query<{ value: string }>(
        db,
        sql`SELECT converted AS value
        FROM ${ident(server.schemas.data, source.tableId)} ORDER BY __rid DESC LIMIT 1`,
      );
      expect(late.rows[0]!.value).toBe(parsed.options.choices[1]!.id);
      await query(db, sql`ROLLBACK`);
      await query(db, sql`BEGIN`);
      await query(
        db,
        sql`UPDATE ${ident(server.schemas.data, source.tableId)}
        SET ${ident(source.columnName)} = __rid::text WHERE __rid > 9007199254750992::bigint`,
      );
      await expect(
        convertColumn(db, server.schemas.data, source.tableId, source, to, 'converted', options),
      ).rejects.toMatchObject({ messageKey: 'data.field.tooManyChoices' });
      const columns = await query(
        db,
        sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${server.schemas.data} AND table_name = ${source.tableId} AND column_name = 'converted'`,
      );
      expect(columns.rows).toEqual([]);
      await query(db, sql`ROLLBACK`);
    } finally {
      await query(db, sql`ROLLBACK`);
      db.release();
    }
  });

  it.each(['text', 'longText', 'email', 'url', 'phone'] as const)(
    'keeps JavaScript normalization and length rules for %s SQL updates',
    async (type) => {
      const values = [
        'a\r\nb\rc\nd',
        '\u00a0test@example.test\ufeff',
        '\u2003https://example.test\u2003',
        'bad @example.test',
        '😀'.repeat(LIMITS.textLength / 2),
        '😀'.repeat(LIMITS.textLength / 2 + 1),
        null,
      ];
      const source = field({ type: 'longText' });
      await seed(server.pool, source, values.length, values);
      const to = FieldSpec.parse({ type });
      const preview = await previewConversion(
        server.pool,
        server.schemas.data,
        source.tableId,
        source,
        to,
        options,
      );
      const db = await server.pool.connect();
      try {
        await query(db, sql`BEGIN`);
        const converted = await convertColumn(
          db,
          server.schemas.data,
          source.tableId,
          source,
          to,
          'converted',
          options,
        );
        expect(converted.emptied).toBe(preview.emptied);
        const target = { ...source, ...to, columnName: 'converted' };
        const rows = await query<{ original: string | null; value: string | null }>(
          db,
          sql`
          SELECT ${columnRef(source)} AS original, ${columnRef(target)} AS value
          FROM ${ident(server.schemas.data, source.tableId)} ORDER BY __rid`,
        );
        expect(rows.rows.map((row) => row.value)).toEqual(
          rows.rows.map((row) => {
            const result = checkCellValue(target, row.original);
            return result.ok ? result.value : null;
          }),
        );
        await query(db, sql`ROLLBACK`);
      } finally {
        db.release();
      }
    },
  );

  it('keeps name order, empty names, duplicate precedence, trimming, and single-link limits', async () => {
    const source = field({ type: 'text' });
    const primary = field({ type: 'text' });
    await seed(server.pool, source, 5, [
      ' SECOND, first, Second',
      'Missing',
      null,
      '\u2003first\ufeff',
      'first, SECOND',
    ]);
    await seed(server.pool, primary, 5, [null, 'First', 'FIRST', 'Second', 'Second']);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, primary.tableId)} SET __deleted_at = now()
      WHERE __id = 'rec00000000000004'`,
    );
    const to = FieldSpec.parse({ type: 'link', options: { linkedTableId: primary.tableId } });
    if (to.type !== 'link') throw new Error('Expected link');
    const context = { ...options, linkedPrimary: primary };
    const ids: string[][] = [];
    for await (const batch of planLinkConversion(
      server.pool,
      server.schemas.data,
      source.tableId,
      source,
      to,
      context,
    ))
      ids.push(...batch.map((cell) => cell.ids));
    expect(ids).toEqual([
      ['rec00000000000005', 'rec00000000000002'],
      [],
      ['rec00000000000001'],
      ['rec00000000000002'],
      ['rec00000000000002', 'rec00000000000005'],
    ]);
    const single = { ...to, options: { ...to.options, prefersSingle: true } };
    expect(
      await previewConversion(server.pool, server.schemas.data, source.tableId, source, single, context),
    ).toMatchObject({
      total: 4,
      converted: 1,
      emptied: 3,
      samples: [' SECOND, first, Second', 'Missing', 'first, SECOND'],
    });
  });

  it('matches links in SQL and converts back to names on 50 and 200,000 records', async () => {
    let baseline: Awaited<ReturnType<typeof previewConversion>> | undefined;
    for (const count of sizes) {
      const db = await server.pool.connect();
      try {
        await query(db, sql`BEGIN`);
        const source = field({ type: 'text' });
        const primary = field({ type: 'text' });
        await createRecordTable(db, server.schemas.data, source.tableId, [source]);
        await createRecordTable(db, server.schemas.data, primary.tableId, [primary]);
        await query(
          db,
          sql`INSERT INTO ${ident(server.schemas.data, primary.tableId)} (__id, ${ident(primary.columnName)})
          SELECT 'rec' || lpad(n::text, 14, '0'), 'Name ' || ((n - 1) / 2)::text FROM generate_series(1, ${count}) n`,
        );
        await query(
          db,
          sql`INSERT INTO ${ident(server.schemas.data, source.tableId)} (__id, ${ident(source.columnName)})
          SELECT 'rec' || lpad(n::text, 14, '0'), CASE WHEN n % 5 = 0 THEN NULL
            WHEN n % 5 = 1 THEN 'Missing' ELSE '  nAME ' || ((n - 1) / 2)::text || ', name ' || ((n - 1) / 2)::text END
          FROM generate_series(1, ${count}) n`,
        );
        await query(db, sql`ANALYZE ${ident(server.schemas.data, source.tableId)}`);
        await query(db, sql`ANALYZE ${ident(server.schemas.data, primary.tableId)}`);
        const to = FieldSpec.parse({ type: 'link', options: { linkedTableId: primary.tableId } });
        if (to.type !== 'link') throw new Error('Expected link');
        const target: StoredField = {
          ...source,
          ...to,
          relation: {
            dataSchema: server.schemas.data,
            linkId: newId('field'),
            side: 'left',
            linkedTableId: primary.tableId,
            inverseFieldId: newId('field'),
            primary,
          },
        };
        const junction = ident(server.schemas.data, `lnk_${target.relation!.linkId}`);
        await query(
          db,
          sql`CREATE TABLE ${junction} (left_rid bigint, right_rid bigint,
          left_pos double precision, right_pos double precision, PRIMARY KEY (left_rid, right_rid))`,
        );
        await query(db, sql`CREATE INDEX ON ${junction} (right_rid)`);
        const watched = observe(db);
        const context = { ...options, linkedPrimary: primary };
        const preview = await previewConversion(db, server.schemas.data, source.tableId, source, to, context);
        if (!baseline) baseline = preview;
        expect(preview).toEqual({
          ...baseline,
          total: (count * 4) / 5,
          converted: (count * 3) / 5,
          emptied: count / 5,
        });
        const changes = await convertLinks(
          db,
          server.schemas.data,
          source,
          target,
          to,
          context,
          server.owner.userId,
        );
        let sourceEvents = 0;
        for await (const change of changes) {
          expect(change.records.length).toBeLessThanOrEqual(1000);
          if (change.fieldId === target.id) sourceEvents += change.records.length;
        }
        expect(sourceEvents).toBe(count);
        const text = FieldSpec.parse({ type: 'text' });
        const backPreview = await previewConversion(
          db,
          server.schemas.data,
          source.tableId,
          target,
          text,
          options,
        );
        expect(backPreview).toMatchObject({ total: (count * 3) / 5, converted: (count * 3) / 5, emptied: 0 });
        expect(
          (await convertColumn(db, server.schemas.data, source.tableId, target, text, 'converted', options))
            .emptied,
        ).toBe(0);
        expect(watched.maximum()).toBe(Math.min(count, CONVERSION_BATCH_SIZE));
        expect(
          watched.statements
            .filter((statement) => statement.includes('AS name'))
            .every((statement) => statement.includes('IN (SELECT name FROM tokens)')),
        ).toBe(true);
        watched.restore();
        const wrong = await query<{ count: string }>(
          db,
          sql`
          SELECT count(*)::text AS count FROM ${ident(server.schemas.data, source.tableId)} source
          WHERE converted IS DISTINCT FROM CASE WHEN __rid % 5 IN (0, 1) THEN NULL ELSE 'Name ' || ((__rid - 1) / 2)::text END
          OR EXISTS (SELECT 1 FROM ${junction} edge WHERE edge.left_rid = source.__rid
            AND (edge.right_rid <> ((source.__rid - 1) / 2) * 2 + 1 OR edge.left_pos <> 0))`,
        );
        expect(wrong.rows[0]!.count).toBe('0');
        await query(db, sql`ROLLBACK`);
      } finally {
        vi.restoreAllMocks();
        await query(db, sql`ROLLBACK`);
        db.release();
      }
    }
  }, 180_000);
});

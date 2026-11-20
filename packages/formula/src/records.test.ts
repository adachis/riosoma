import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  check,
  describe,
  evaluate,
  parse,
  resolve,
  type Ast,
  type FormulaField,
  type FormulaRecord,
} from './index.js';
import { compileSql, type SqlContext } from './sql.js';

const fields: FormulaField[] = [
  { id: 'n', name: 'Number', type: 'number', tableId: 'own', tableName: 'Orders' },
  { id: 't', name: 'Group', type: 'text', tableId: 'own', tableName: 'Orders' },
  { id: 'prices', name: 'Prices', type: 'lookup', valueType: { array: 'number' } },
  { id: 'amount', name: 'Amount', type: 'number', tableId: 'other', tableName: 'Sales Leads' },
  { id: 'key', name: 'Key', type: 'text', tableId: 'other', tableName: 'Sales Leads' },
  {
    id: 'labels',
    name: 'Labels',
    type: 'lookup',
    valueType: { array: 'text' },
    tableId: 'own',
    tableName: 'Orders',
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'lookup',
    valueType: { array: 'text' },
    tableId: 'other',
    tableName: 'Sales Leads',
  },
  { id: 'email', name: 'Email', type: 'text', tableId: 'other', tableName: 'Sales Leads' },
];
const row = (id: string, values: FormulaRecord['values']): FormulaRecord => ({
  id,
  values,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
});
const own = [
  row('a', { n: 5, t: 'a', labels: ['x', 2, false] }),
  row('b', { n: 10, t: 'a', labels: [] }),
  row('c', { n: 10, t: 'a' }),
  row('d', { n: null, t: 'b' }),
];
const lookupRows = [
  row('a', { prices: [5], t: 'a' }),
  row('b', { prices: [10], t: 'a' }),
  row('c', { prices: [15, 20], t: 'a' }),
  row('d', { prices: [], t: 'b' }),
  row('e', { prices: null, t: 'b' }),
  row('f', { t: 'b' }),
  row('g', { prices: [0], t: 'b' }),
  row('h', { prices: [10], t: 'a' }),
];
const other = [
  row('a', { amount: 5, key: 'a', email: 'first', tags: ['x', 2, false] }),
  row('b', { amount: 10, key: 'a', email: 'second' }),
  row('c', { amount: 15, key: 'A', email: 'third' }),
  row('d', { amount: null, key: null, email: null }),
  row('e', { amount: 0, key: '>5', email: 'comparison' }),
  row('f', { amount: 2, key: '*', email: 'literal star' }),
  row('g', { amount: 3, key: 'İ', email: 'dotted letter' }),
  row('h', { amount: 4, key: 'ΟΣ', email: 'sigma' }),
  row('i', { amount: 6, key: '😀', email: 'symbol' }),
  row('j', { amount: 8, key: '', email: 'empty text' }),
  row('k', { amount: 1e308, key: 'overflow', email: 'large first' }),
  row('l', { amount: 1e308, key: 'overflow', email: 'large last' }),
];
let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('cross_formula');
  pool = createPool(database.profile);
  for (const [name, rows] of [
    ['own', own],
    ['other', other],
    ['lookup_windows', lookupRows],
  ] as const) {
    await query(pool, sql`CREATE TABLE ${ident(name)} (id text, created timestamptz, values jsonb)`);
    for (const record of rows)
      await query(
        pool,
        sql`INSERT INTO ${ident(name)} VALUES
      (${record.id}, ${record.createdAt}::timestamptz, ${JSON.stringify(record.values)}::jsonb)`,
      );
  }
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await database?.drop();
  await kit?.stop();
});

function astOf(source: string): Ast {
  const parsed = parse(source);
  if ('error' in parsed) throw new Error(JSON.stringify(parsed));
  const resolved = resolve(parsed.ast, fields, undefined, 'own');
  if ('error' in resolved) throw new Error(JSON.stringify(resolved));
  expect(check(resolved.ast)).toHaveProperty('type');
  return resolved.ast;
}
function context(alias = 'r', table = 'own', depth = 0): SqlContext {
  return {
    now: '2024-01-01T00:00:00.000Z',
    timeZone: 'UTC',
    records: own,
    tables: new Map([['other', other]]),
    columnRef: (field) =>
      field.type === 'lookup'
        ? sql`${ident(alias, 'values')} -> ${field.id}`
        : field.type === 'number'
          ? sql`(${ident(alias, 'values')} ->> ${field.id})::double precision`
          : sql`${ident(alias, 'values')} ->> ${field.id}`,
    systemRef: (key) => sql`${ident(alias, key === 'id' ? 'id' : 'created')}`,
    recordSource: (requested) => {
      const name = `s${depth}`;
      return {
        from: sql`${ident(requested ?? table)} AS ${ident(name)}`,
        where: sql`TRUE`,
        context: context(name, requested ?? table, depth + 1),
      };
    },
  };
}

it.each([
  "SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Key], {Group})",
  'COUNTIFS(\'Sales Leads\'[Amount], ">5", \'Sales Leads\'[Key], "a")',
  "AVERAGEIFS('Sales Leads'[Amount], 'Sales Leads'[Amount], \">\" & {Number})",
  "MAXIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"*\")",
  "MINIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"<>Done\")",
  "SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"missing\")",
  "COUNTIFS('Sales Leads'[Key], BLANK())",
  "COUNTIFS('Sales Leads'[Key], 5)",
  'COUNTIFS(\'Sales Leads\'[Key], "~*")',
  "XLOOKUP({Group}, 'Sales Leads'[Key], 'Sales Leads'[Email])",
  "XLOOKUP({Group}, 'Sales Leads'[Key], 'Sales Leads'[Email], \"missing\", 0, -1)",
  "XLOOKUP(9, 'Sales Leads'[Amount], 'Sales Leads'[Email], \"missing\", -1)",
  "XLOOKUP(9, 'Sales Leads'[Amount], 'Sales Leads'[Email], \"missing\", 1)",
  'XLOOKUP("?", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing", 2)',
  "XLOOKUP(BLANK(), 'Sales Leads'[Key], 'Sales Leads'[Email], \"missing\")",
  "XLOOKUP(5, 'Sales Leads'[Amount], 'Sales Leads'[Tags])",
  'XLOOKUP("*", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing", 2)',
  'XLOOKUP(">5", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing", 2)',
  'XLOOKUP("b", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing", -1)',
  'XLOOKUP("i̇", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing")',
  'XLOOKUP("a", \'Sales Leads\'[Key], \'Sales Leads\'[Email], "missing", BLANK())',
  'COUNTIFS(\'Sales Leads\'[Key], "i̇")',
  'COUNTIFS(\'Sales Leads\'[Key], "ΟΣ")',
  'COUNTIFS(\'Sales Leads\'[Key], "😀")',
  'COUNTIFS(\'Sales Leads\'[Key], "?")',
  'COUNTIFS(\'Sales Leads\'[Amount], "4.0000000000000001")',
  'COUNTIFS(\'Sales Leads\'[Amount], "1e-9999")',
  'COUNTIFS(\'Sales Leads\'[Amount], "<1e9999")',
  "SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Key], ERROR())",
  "AVERAGEIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"missing\")",
  'NEXT({Labels})',
  'PREVIOUS({Labels})',
  'RUNNINGCOUNT({Labels})',
  'RANK(IF({Number} = 10, ERROR(), {Number}))',
  'PREVIOUS(IF({Number} = 10, ERROR(), {Number}))',
  'NEXT(IF({Number} = 10, ERROR(), {Number}))',
  'RUNNINGSUM(IF({Number} = 10, ERROR(), {Number}))',
  'RUNNINGCOUNT(IF({Number} = 10, ERROR(), {Number}))',
  'PREVIOUS({Number}, BLANK(), {Group})',
  'RANK({Number})',
  'RANK({Number}, 1, {Group})',
  'PREVIOUS({Number})',
  'NEXT({Number})',
  'PREVIOUS({Number} * 2, {Number}, {Group})',
  'NEXT({Group}, {Number})',
  "SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"overflow\")",
  "AVERAGEIFS('Sales Leads'[Amount], 'Sales Leads'[Key], \"overflow\")",
  'RUNNINGSUM(1e308)',
  'RUNNINGSUM({Number})',
  'RUNNINGSUM({Number}, {Number}, {Group})',
  'RUNNINGCOUNT()',
  'RUNNINGCOUNT({Number}, {Number}, {Group})',
])('agrees between SQL and JavaScript for %s', async (source) => {
  const ast = astOf(source),
    ctx = context();
  const expression = compileSql(ast, fields, ctx);
  expect(expression).not.toBeNull();
  const result = await query<{ id: string; value: unknown }>(
    pool,
    sql`SELECT r.id, ${expression!} AS value FROM own r ORDER BY id`,
  );
  for (let i = 0; i < own.length; i++)
    expect(result.rows[i]!.value, source).toEqual(evaluate(ast, own[i]!, ctx));
});

it('stores structured references by both IDs and displays renamed tables and fields', () => {
  const ast = astOf("SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Key], {Group})");
  const stored = describe(
    ast,
    fields.map((field) => ({ ...field, name: field.id, tableName: field.tableId })),
  );
  expect(stored).toBe('SUMIFS(other[amount], other[key], {t})');
  expect(
    describe(
      ast,
      fields.map((field) => ({ ...field, tableName: 'New name' })),
    ),
  ).toContain("'New name'[Amount]");
});

it.each([
  'RUNNINGSUM({Prices})',
  'RUNNINGSUM({Prices}, BLANK(), {Group})',
  'RANK({Prices})',
  'RANK({Prices}, 1, {Group})',
  'PREVIOUS({Prices})',
  'NEXT({Prices})',
  'RUNNINGCOUNT({Prices})',
])('preserves lookup operand semantics in %s', async (source) => {
  const ast = astOf(source);
  const ctx = { ...context('r', 'lookup_windows'), records: lookupRows };
  const expression = compileSql(ast, fields, ctx);
  expect(expression).not.toBeNull();
  const result = await query<{ id: string; value: unknown }>(
    pool,
    sql`SELECT r.id, ${expression!} AS value FROM lookup_windows r ORDER BY id`,
  );
  for (let i = 0; i < lookupRows.length; i++)
    expect(result.rows[i]!.value, `${source} for ${lookupRows[i]!.id}`).toEqual(
      evaluate(ast, lookupRows[i]!, ctx),
    );
  if (source === 'RUNNINGSUM({Prices})')
    expect(result.rows.slice(0, 3).map((row) => row.value)).toEqual([
      5,
      15,
      { error: '#ERROR!', messageKey: 'formula.list.several' },
    ]);
});

it('rejects ranges from different tables and incomplete criteria pairs', () => {
  for (const source of [
    "SUMIFS('Sales Leads'[Amount], Orders[Number], 1)",
    "COUNTIFS('Sales Leads'[Key], \"a\", 'Sales Leads'[Amount])",
  ]) {
    const parsed = parse(source);
    if ('error' in parsed) throw new Error(JSON.stringify(parsed));
    const resolved = resolve(parsed.ast, fields);
    if ('error' in resolved) throw new Error(JSON.stringify(resolved));
    expect(check(resolved.ast)).toHaveProperty('error');
  }
});

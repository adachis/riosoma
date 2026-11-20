import { afterAll, beforeAll, expect, it } from 'vitest';
import { compile, createPool, ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { NamedFunctionDefinition } from '@riosoma/contracts';
import {
  check,
  evaluate,
  isError,
  parse,
  resolve,
  type Ast,
  type ErrorValue,
  type FormulaField,
  type FormulaRecord,
  type FormulaValue,
} from './index.js';
import { caseTables } from './casing.js';
import { compileSql, type SqlContext } from './sql.js';

const fields: FormulaField[] = [
  { id: 'n', name: 'N', type: 'number' },
  { id: 't', name: 'T', type: 'text' },
  { id: 'b', name: 'B', type: 'checkbox' },
  { id: 'd', name: 'D', type: 'date' },
  { id: 'dt', name: 'DT', type: 'date', options: { includeTime: true } },
  { id: 'range', name: 'R', type: 'dateRange' },
  { id: 'ranget', name: 'RT', type: 'dateRange', options: { includeTime: true } },
  { id: 'c', name: 'C', type: 'currency' },
  { id: 'p', name: 'P', type: 'percent' },
  { id: 'du', name: 'DU', type: 'duration' },
  { id: 'ra', name: 'RA', type: 'rating' },
  { id: 'an', name: 'AN', type: 'autoNumber' },
  { id: 'e', name: 'E', type: 'number' },
  { id: 'u', name: 'U', type: 'user' },
  { id: 'at', name: 'AT', type: 'attachment' },
  // Lookups, each a list of what its linked records hold.
  { id: 'lk', name: 'LK', type: 'lookup', valueType: { array: 'number' } },
  { id: 'lt', name: 'LT', type: 'lookup', valueType: { array: 'text' } },
  { id: 'lb', name: 'LB', type: 'lookup', valueType: { array: 'boolean' } },
  { id: 'ld', name: 'LD', type: 'lookup', valueType: { array: 'date' } },
  { id: 'ldt', name: 'LDT', type: 'lookup', valueType: { array: 'datetime' } },
  // A link reads as its linked records' names, and choices by name.
  { id: 'lnk', name: 'LNK', type: 'link' },
  { id: 'ss', name: 'SS', type: 'singleSelect', options: { choices: [] } },
  { id: 'ms', name: 'MS', type: 'multipleSelect', options: { choices: [] } },
];
const LOOKUPS = ['lk', 'lt', 'lb', 'ld', 'ldt'];
const context: SqlContext = {
  now: '2024-03-10T09:30:45.123Z',
  timeZone: 'UTC',
  columnRef: (field) => sql`${ident('r', field.id)}`,
  systemRef: (key) => sql`${ident('r', key)}`,
};
function astOf(source: string, functions?: readonly NamedFunctionDefinition[]): Ast {
  const parsed = parse(source);
  if ('error' in parsed) throw new Error(JSON.stringify({ source, ...parsed }));
  const resolved = resolve(parsed.ast, fields, undefined, undefined, functions);
  if ('error' in resolved) throw new Error(JSON.stringify({ source, ...resolved }));
  expect(check(resolved.ast), source).toHaveProperty('type');
  return resolved.ast;
}
let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('formula');
  // The number test sends a few thousand values through one query, which can outlast the default
  // 30 seconds while every package's tests run at once.  Its own test allows 120 seconds.
  pool = createPool(database.profile, { queryTimeoutMs: 110_000, statementTimeoutMs: 110_000 });
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await database?.drop();
  await kit?.stop();
});

async function assertAgreement(
  source: string,
  rows: FormulaRecord[],
  ctx = context,
  functions?: readonly NamedFunctionDefinition[],
): Promise<void> {
  const ast = astOf(source, functions),
    expression = compileSql(ast, fields, ctx);
  expect(expression, source).not.toBeNull();
  if (!expression) throw new Error(source);
  // An error value reaches SQL through its own column, as a server passes a lookup's or rollup's error.
  const data = rows.map((row) => ({
    ...Object.fromEntries(
      Object.entries(row.values).map(([id, value]): [string, unknown] =>
        isError(value) ? [`${id}_error`, value] : [id, value],
      ),
    ),
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const statement = sql`SELECT r.id, ${expression} AS actual FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb)
    AS r(id text, n numeric, t text, b boolean, d date, dt timestamptz, range jsonb, ranget jsonb,
      c double precision, p double precision, du double precision, ra smallint, an bigint,
      e double precision, e_error jsonb, lk jsonb, lk_error jsonb, lt jsonb, lt_error jsonb, lb jsonb,
      lb_error jsonb, ld jsonb, ld_error jsonb, ldt jsonb, ldt_error jsonb, lnk jsonb, lnk_error jsonb,
      ss text, ms text[], ${ident('createdAt')} timestamptz, ${ident('updatedAt')} timestamptz)`;
  let results: { id: string; actual: FormulaValue }[];
  try {
    results = (await query<{ id: string; actual: FormulaValue }>(pool, statement)).rows;
  } catch (error) {
    throw new Error(JSON.stringify({ source, rows, cause: String(error) }), { cause: error });
  }
  expect(results).toHaveLength(rows.length);
  for (let i = 0; i < rows.length; i++) {
    expect(
      results[i]!.actual,
      JSON.stringify({ formula: source, record: rows[i], zone: ctx.timeZone }),
    ).toEqual(evaluate(ast, rows[i]!, ctx));
  }
}
function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
const rng = random(0x5eed2024);
const integer = (max: number) => Math.floor(rng() * max);
function pick<T>(items: readonly T[]): T {
  return items[integer(items.length)]!;
}
type Kind = 'number' | 'text' | 'boolean' | 'date' | 'datetime';
const kinds: Kind[] = ['number', 'text', 'boolean', 'date', 'datetime'];
function formula(kind: Kind, depth: number): string {
  if (depth === 0 || rng() < 0.2) {
    switch (kind) {
      case 'number':
        return pick(['{N}', String(integer(100) - 50), String((integer(100) - 50) / 10), 'BLANK()']);
      case 'text':
        return pick(['{T}', '""', '"a"', '" 😀 "', 'BLANK()']);
      case 'boolean':
        return pick(['{B}', 'TRUE()', 'FALSE()', 'BLANK()']);
      case 'date':
        return pick(['{D}', 'TODAY()', 'BLANK()']);
      case 'datetime':
        return pick(['{DT}', 'NOW()', 'CREATED_TIME()', 'LAST_MODIFIED_TIME()', 'BLANK()']);
    }
  }
  const sub = (type = kind) => formula(type, depth - 1);
  if (rng() < 0.18) return `IF(${sub('boolean')},${sub()},${sub()})`;
  switch (kind) {
    case 'number': {
      switch (integer(10)) {
        case 0:
          return `(${sub()} ${pick(['+', '-', '*', '/'])} ${sub()})`;
        case 1:
          return `${pick(['ABS', 'INT'])}(${sub()})`;
        case 2:
          return `${pick(['SUM', 'AVERAGE', 'MAX', 'MIN'])}(${sub()},${sub()})`;
        case 3:
          return `LEN(${sub('text')})`;
        case 4:
          return `${pick(['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'])}(${sub(pick(['date', 'datetime']))})`;
        case 5:
          return `DATETIME_DIFF(${sub('datetime')},${sub('datetime')},"${pick(['days', 'seconds', 'hours', 'milliseconds'])}")`;
        case 6:
          return `${pick(['COUNT', 'COUNTA', 'COUNTALL'])}(${sub(pick(kinds))},${sub('number')},BLANK())`;
        case 7:
          return `${pick(['FIND', 'SEARCH'])}(${sub('text')},${sub('text')}${rng() < 0.5 ? `,${sub()}` : ''})`;
        case 8:
          return `ROUND(${sub()},${integer(7) - 3})`;
        default:
          return `SWITCH(${sub('boolean')},TRUE(),${sub()},${sub()})`;
      }
    }
    case 'text':
      return pick([
        () => `(${sub()} & ${sub()})`,
        () => `CONCATENATE(${sub()},${sub('boolean')})`,
        () => `TRIM(${sub()})`,
        () => `SUBSTITUTE(${sub()},"a","xy")`,
        () => `REPT(${sub()},${integer(4)})`,
        () => `DATESTR(${sub('datetime')})`,
        () => `TIMESTR(${sub('date')})`,
        () => `T(${sub('number')})`,
        () => `${pick(['LOWER', 'UPPER'])}(${sub()})`,
      ])();
    case 'boolean': {
      if (rng() < 0.45) {
        const type = pick(kinds),
          operator = type === 'text' ? pick(['=', '!=']) : pick(['=', '<>', '<', '<=', '>', '>=']);
        return `(${sub(type)} ${operator} ${sub(type)})`;
      }
      return pick([
        () => `${pick(['AND', 'OR', 'XOR'])}(${sub()},${sub()})`,
        () => `NOT(${sub()})`,
        () => `(${sub()} ${pick(['&&', '||'])} ${sub()})`,
        () => `ISERROR(${sub('number')})`,
        () => `${pick(['IS_BEFORE', 'IS_AFTER'])}(${sub('datetime')},${sub('date')})`,
        () => `IS_SAME(${sub('datetime')},${sub('datetime')},"${pick(['day', 'month', 'second'])}")`,
      ])();
    }
    case 'date':
      return `IF(${sub('boolean')},${sub()},${sub()})`;
    case 'datetime':
      return `DATEADD(${sub(pick(['date', 'datetime']))},${integer(20) - 10},"${pick(['day', 'month', 'hour', 'year'])}")`;
  }
}
function records(count: number): FormulaRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const instant = new Date(
      Date.UTC(
        2020 + integer(8),
        integer(12),
        1 + integer(28),
        integer(24),
        integer(60),
        integer(60),
        integer(1000),
      ),
    ).toISOString();
    return {
      id: `rec${i}`,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: instant,
      values: {
        n: rng() < 0.25 ? null : (integer(2000) - 1000) / 10,
        t:
          rng() < 0.25
            ? null
            : pick([
                'abc',
                'AbC',
                '',
                ' a  b ',
                '😀',
                "'; SELECT 1; --",
                'éßİ',
                '\t\u00a0x\uFEFF',
                'ΌΣΟΣ ΑΣ',
                "Σ'Σ.ﬁ",
                '𐐀a𐐨B',
              ]),
        b: pick([null, true, false]),
        d: rng() < 0.25 ? null : instant.slice(0, 10),
        dt: rng() < 0.25 ? null : instant,
      },
    };
  });
}
it('agrees on 2,000 seeded depth-four formulas × 20 independently generated records', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    let source: string;
    do {
      source = formula(kinds[i % kinds.length]!, 4);
    } while (seen.has(source));
    seen.add(source);
    await assertAgreement(source, records(20));
  }
  expect(seen.size).toBe(2000);
}, 120_000);

it('agrees on named functions across seeded types, nested calls, lazy branches, and lookup lists', async () => {
  const functions: NamedFunctionDefinition[] = [
    { name: 'IDENTITY', parameters: ['value'], body: 'value' },
    { name: 'SCALE', parameters: ['value', 'factor'], body: 'value * factor' },
    {
      name: 'CHOOSE',
      parameters: ['condition', 'yes', 'no'],
      body: 'IF(condition, IDENTITY(yes), IDENTITY(no))',
    },
    {
      name: 'SAFE_DIVIDE',
      parameters: ['value', 'divisor'],
      body: 'IF(divisor = 0, BLANK(), value / divisor)',
    },
    { name: 'BOTH', parameters: ['values'], body: 'SUM(values) + values' },
    { name: 'RECOVER', parameters: ['value'], body: 'IF(ISERROR(value * 1), SUM(value), value * 1)' },
    { name: 'LABEL', parameters: ['value'], body: '"Value: " & value' },
  ];
  for (let i = 0; i < 100; i++) {
    const kind = kinds[i % kinds.length]!;
    await assertAgreement(
      `CHOOSE({B}, IDENTITY(${formula(kind, 3)}), IDENTITY(${formula(kind, 3)}))`,
      records(20),
      context,
      functions,
    );
  }
  const rows = records(20).map((row, i) => ({
    ...row,
    values: { ...row.values, lk: [[], [2], [2, 3]][i % 3]!, n: [null, 0, 1, -1, Number.MAX_VALUE][i % 5]! },
  }));
  for (const source of [
    'SCALE({N}, 2)',
    'SAFE_DIVIDE({N}, 0)',
    'SAFE_DIVIDE({N}, 2)',
    'CHOOSE(TRUE(), 7, ERROR())',
    'CHOOSE(FALSE(), ERROR(), {N})',
    'IDENTITY({LK})',
    'BOTH({LK})',
    'RECOVER({LK})',
    'LABEL({N})',
    'LABEL({T})',
    'IDENTITY({DT})',
    'ISERROR(SCALE({N}, 2))',
  ])
    await assertAgreement(source, rows, { ...context, arrayResult: true }, functions);
});

it('agrees on fixed blank, error, Unicode, and lazy branch regressions', async () => {
  const rows = records(20);
  for (const source of [
    '{N}/0',
    'IF(ISERROR({N}/0),7,{N}/0)',
    'IF(FALSE(),ERROR(),{N})',
    'IF(TRUE(),{N},ERROR())',
    'AND(FALSE(),ERROR())',
    'OR(TRUE(),ERROR())',
    'SWITCH({B},TRUE(),{N},ERROR())',
    'BLANK()=BLANK()',
    '{N}!=BLANK()',
    '{T}=BLANK()',
    '{B}=BLANK()',
    'LEN({T})',
    'TRIM({T})',
    'REPT({T},-1)',
    'T({N})',
    '({N}+.1)*.2',
    'YEAR({DT})',
    'WEEKDAY({D},"Monday")',
    'WEEKNUM({DT})',
    'DATETIME_DIFF({DT},NOW(),"milliseconds")',
    'DATEADD({D},1,"month")',
    'IS_SAME({D},{DT},"year")',
    'CREATED_TIME()',
    'LAST_MODIFIED_TIME()',
    'RECORD_ID()',
  ])
    await assertAgreement(source, rows);
  for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Apia']) {
    for (const source of [
      'TODAY()',
      'YEAR({DT})',
      'HOUR({DT})',
      'DATESTR({DT})',
      'IS_BEFORE({D},{DT})',
      'DATETIME_DIFF({DT},NOW(),"day")',
    ])
      await assertAgreement(source, rows, { ...context, timeZone: zone });
  }
});

it('parameterizes literals and delegates unsupported expressions to JavaScript', () => {
  const attack = "'; DROP TABLE records; --";
  const expression = compileSql(astOf(`{T} & ${JSON.stringify(attack)}`), fields, context)!;
  const compiled = compile(expression);
  expect(compiled.text).not.toContain(attack);
  expect(compiled.values).toContain(attack);
  for (const source of [
    'REGEX_MATCH({T},"x")',
    'DATETIME_FORMAT({DT},"LL")',
    'MID({T},1,2)',
    'ROUND({N},{N})',
    'DATEADD({DT},{N},"day")',
    '{U} & "x"',
    '"x" & {AT}',
    'COUNTALL({U})',
  ])
    expect(compileSql(astOf(source), fields, context), source).toBeNull();
  expect(compileSql(astOf('{N}'), fields, { ...context, columnRef: () => null })).toBeNull();
  expect(compileSql(astOf('NOW()'), fields, { ...context, timeZone: 'invalid/zone' })).toBeNull();
});

it('preserves floating point overflow, underflow, and signed zero behavior', async () => {
  const row = records(1)[0]!;
  const rows = [
    0,
    -0,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    1e-300,
    1e300,
    null,
  ].map((n, i) => ({ ...row, id: `rec${i}`, values: { ...row.values, n } }));
  for (const source of [
    '{N}*2',
    '{N}/2',
    '{N}*{N}',
    '{N}/1e300',
    '{N}+{N}',
    'ISERROR({N}*{N})',
    'IF(ISERROR({N}*{N}),0,{N}*{N})',
  ])
    await assertAgreement(source, rows);
});

it('compares days and instants in the supplied zone', async () => {
  const row = records(1)[0]!;
  const rows = [{ ...row, values: { ...row.values, d: '2024-03-10', dt: '2024-03-10T04:00:00.000Z' } }];
  for (const source of ['{D} < {DT}', '{D} = {DT}', 'IS_BEFORE({D},{DT})'])
    await assertAgreement(source, rows, { ...context, timeZone: 'America/Los_Angeles' });
});

it('applies text output limits using UTF-16 length', async () => {
  const row = records(1)[0]!;
  await assertAgreement('REPT({T},600000)', [{ ...row, values: { ...row.values, t: '😀' } }]);
});

it('normalizes physical system timestamps to contract millisecond precision', async () => {
  const row = records(1)[0]!;
  row.createdAt = String(context.now);
  await assertAgreement('CREATED_TIME() = NOW()', [row], {
    ...context,
    systemRef: () => sql`${'2024-03-10T09:30:45.123456Z'}::timestamptz`,
  });
  expect(compileSql(astOf('DATEADD({DT},.0001,"second")'), fields, context)).toBeNull();
});

it('agrees on the ends of date ranges, and leaves the whole range to JavaScript', async () => {
  const row = records(1)[0]!;
  const rows = [
    {
      ...row,
      values: {
        ...row.values,
        range: { start: '2024-02-27', end: '2024-03-02' },
        ranget: { start: '2024-03-10T09:00:00.123Z', end: '2024-03-11T01:30:00.000Z' },
      },
    },
    { ...row, values: { ...row.values, range: null, ranget: null } },
  ];
  for (const source of [
    'START({R})',
    'END({R})',
    'DATETIME_DIFF(END({R}),START({R}),"days")',
    'START({RT})',
    'END({RT})',
    'IS_BEFORE(START({RT}),END({RT}))',
    'IF(START({R}),"set","empty")',
  ])
    await assertAgreement(source, rows);
  expect(compileSql(astOf('{R}'), fields, context)).toBeNull();
  expect(compileSql(astOf('START(IF(TRUE(),{R},{R}))'), fields, context)).toBeNull();
});

/** Numbers as number-like fields and arithmetic produce them, including every layout `String()` uses. */
const NUMBERS = [
  0,
  -0,
  1,
  -1,
  12.5,
  -12.5,
  0.25,
  5400,
  0.1 + 0.2,
  1 / 3,
  -2 / 3,
  4.35,
  0.07,
  99.99,
  100,
  1234.5678,
  1e15,
  1e16,
  2 ** 53,
  123456789012345680000,
  1e21,
  -1e21,
  7.5e22,
  1e300,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  0.000001,
  0.0000012345,
  1e-7,
  -1.5e-7,
  5e-324,
  2.2250738585072014e-308,
];
function numberRecords(): FormulaRecord[] {
  const base = records(1)[0]!;
  return NUMBERS.map((value, i) => ({
    ...base,
    id: `num${i}`,
    values: {
      ...base.values,
      n: NUMBERS[(i + 7) % NUMBERS.length]!,
      c: value,
      p: NUMBERS[(i + 3) % NUMBERS.length]!,
      du: i % 5 === 0 ? null : NUMBERS[(i + 11) % NUMBERS.length]!,
      ra: i % 6 === 0 ? null : (i % 10) + 1,
      an: [1, 42, 2 ** 53 - 1, 7][i % 4]!,
    },
  }));
}

it('reads currency, percent, duration, rating, and auto number fields as numbers', async () => {
  const rows = numberRecords();
  for (const source of [
    '"BUG-" & {AN}',
    '"$" & {C}',
    '{P} & ""',
    'CONCATENATE({C}, " ", {P}, " ", {DU}, " ", {RA}, " ", {AN})',
    'T({C})',
    'T({AN})',
    '{C} * 2',
    '{P} * 100 & "%"',
    '{DU} / 60',
    '{RA} + {AN}',
    'IF({RA} > 3, "good", "bad")',
    'MAX({C}, {P}, {RA})',
    'SUM({C}, {DU}, {AN})',
    '{C} = {P}',
    '{C} < {DU}',
    'ISERROR({C} / {P})',
    '"#" & ({AN} + 1)',
    '-{C} & ""',
    '{N} & ""',
    '({N} / 3) & "|" & ({C} * {P})',
    'CONCATENATE({N} / 7, {B}, {C} - {P})',
    'LEN({C} & "")',
    'TRIM(" " & {C} & " ")',
    'SUBSTITUTE({C} & "", ".", ",")',
    'REPT({RA} & "", 2)',
    'IF({B}, {C}, {P}) & ""',
    'SWITCH({RA}, 1, {C}, 2, {P}, {DU}) & "!"',
    'COUNT({C}, {DU}, {RA})',
  ])
    await assertAgreement(source, rows);
});

it('joins numbers with text the way JavaScript writes them, over generated formulas', async () => {
  const next = random(0x6e756d62);
  const choose = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const operand = (depth: number): string => {
    if (depth === 0 || next() < 0.3)
      return choose(['{N}', '{C}', '{P}', '{DU}', '{RA}', '{AN}', String(choose(NUMBERS)), '0.5']);
    const a = operand(depth - 1),
      b = operand(depth - 1);
    return choose([`(${a} + ${b})`, `(${a} - ${b})`, `(${a} * ${b})`, `(${a} / ${b})`, `-${a}`, `ABS(${a})`]);
  };
  const rows = numberRecords();
  const seen = new Set<string>();
  while (seen.size < 150) {
    const source = choose([
      () => `${operand(2)} & ""`,
      () => `CONCATENATE(${operand(2)}, "|", ${operand(1)})`,
      () => `"x" & ${operand(3)} & "y"`,
    ])();
    if (seen.has(source)) continue;
    seen.add(source);
    await assertAgreement(source, rows);
  }
}, 120_000);

it('writes every kind of number as JavaScript does', async () => {
  const bits = new DataView(new ArrayBuffer(8));
  const fromBits = (high: number, low: number) => {
    bits.setUint32(0, high >>> 0);
    bits.setUint32(4, low >>> 0);
    return bits.getFloat64(0);
  };
  const step = (value: number, by: bigint) => {
    bits.setFloat64(0, value);
    bits.setBigUint64(0, bits.getBigUint64(0) + by);
    return bits.getFloat64(0);
  };
  const next = random(0x746578);
  const values = new Set<number>();
  // Any number at all, spread evenly over every exponent.
  while (values.size < 1500) {
    const value = fromBits(next() * 2 ** 32, next() * 2 ** 32);
    if (Number.isFinite(value)) values.add(value);
  }
  // Powers of two and ten, whole multiples of large powers of ten, and their neighbors: where
  // halfway points are short and where the layout changes.
  const around = (value: number) => {
    for (const by of [-2n, -1n, 0n, 1n, 2n]) {
      const near = step(value, by);
      if (Number.isFinite(near) && near > 0) values.add(near).add(-near);
    }
  };
  for (let e = -1074; e <= 1023; e += 7) around(2 ** e);
  for (let e = -323; e <= 308; e++) around(Number(`1e${e}`));
  for (let e = 15; e <= 40; e++) for (let k = 1; k < 100; k += 3) around(Number(`${k}e${e}`));
  for (const value of [
    0.1,
    0.2,
    0.3,
    1 / 3,
    2 / 3,
    1e21,
    1e-6,
    1e-7,
    2 ** 53,
    2 ** 54,
    Number.MAX_VALUE,
    5e-324,
  ])
    around(value);
  const base = records(1)[0]!;
  const rows = [...values].map((c, i) => ({ ...base, id: `v${i}`, values: { ...base.values, c } }));
  await assertAgreement('{C} & ""', rows);
  await assertAgreement('CONCATENATE("(", -{C}, ")")', rows);
}, 120_000);

it('propagates error values that fields hand to formulas', async () => {
  const base = records(1)[0]!;
  const failed = { error: '#ERROR!' as const, messageKey: 'formula.runtime.divisionByZero' };
  const rows: FormulaRecord[] = [4, null, failed].map((e, i) => ({
    ...base,
    id: `err${i}`,
    values: { ...base.values, e, c: 2 },
  }));
  const errors: SqlContext = {
    ...context,
    errorRef: (field) => (field.id === 'e' ? sql`${ident('r', 'e_error')}` : null),
  };
  for (const source of [
    '{E}',
    '{E} + 1',
    'MAX(0, {C} - {E})',
    'ISERROR({E})',
    'IF(ISERROR({E}), 0, {E})',
    'IF(FALSE(), {E}, 1)',
    'IF({E} > 1, "big", "small")',
    'AND(FALSE(), {E})',
    'OR({E}, TRUE())',
    '"x" & {E}',
    'CONCATENATE({C}, {E})',
    'T({E})',
    'COUNT({E})',
    '{E} = 4',
    'SWITCH({C}, 2, {E}, 0)',
    'SWITCH({C}, 3, {E}, 0)',
  ])
    await assertAgreement(source, rows, errors);
});

/** Lookups hand their errors over through their own columns, as the server does. */
const lookupContext: SqlContext = {
  ...context,
  errorRef: (field) => (LOOKUPS.includes(field.id) ? sql`${ident('r', `${field.id}_error`)}` : null),
};
/** Numbers a lookup can hold, including ones whose sum overflows. */
const ITEMS = [0, 1, -1, 2.5, 0.1, 0.2, 1 / 3, 1e21, -7.25, 99.99, Number.MAX_VALUE, -Number.MAX_VALUE];
function lookupRecords(count: number, next: () => number): FormulaRecord[] {
  const choose = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const list = <T>(item: () => T): T[] | ErrorValue => {
    const size = choose([0, 0, 1, 1, 1, 1, 2, 3]);
    if (next() < 0.06) return { error: '#ERROR!', messageKey: 'formula.runtime.divisionByZero' };
    return Array.from({ length: size }, item);
  };
  return records(count).map((row, i) => ({
    ...row,
    id: `look${i}`,
    values: {
      ...row.values,
      c: choose([null, 2, -0.5, Number.MAX_VALUE]),
      lk: list(() => (next() < 0.05 ? null : choose(ITEMS))),
      lt: list(() => choose(['a', 'Ab', '', ' x ', '😀', 'Done'])),
      lb: list(() => choose([true, false])),
      ld: list(() => choose(['2024-03-10', '2023-12-31', '2024-02-29'])),
      ldt: list(() =>
        choose(['2024-03-10T09:30:45.123Z', '2024-03-09T23:59:59.999Z', '2020-01-01T00:00:00.000Z']),
      ),
    } as FormulaRecord['values'],
  }));
}

it('reads a lookup where one value belongs as that value, blank, or an error', async () => {
  const rows = lookupRecords(40, random(0x6c6f6f6b));
  for (const source of [
    '{LK} * 2',
    '{LK} * {N}',
    '{C} - {LK}',
    '-{LK}',
    'ABS({LK})',
    'INT({LK})',
    '{LK} > 1',
    '1 < {LK}',
    '{LK} = {N}',
    'IF({LK} > 0, "positive", "not")',
    'IF(ISERROR({LK} * 1), 0, {LK} * 1)',
    'SWITCH({LK}, 1, "one", 2.5, "two and a half", "other")',
    'SWITCH({LT}, "a", 1, "Done", 2, 0)',
    'LEN({LT})',
    'TRIM({LT})',
    '{LT} = "Done"',
    '{LT} != "a"',
    'SUBSTITUTE({LT}, "a", "b")',
    'REPT({LT}, 2)',
    'LEN({LT}) + {LK}',
    '{LB} = TRUE()',
    '{LB} + 1',
    '{LB} = {LK}',
    '{LD} < TODAY()',
    'YEAR({LD})',
    'DATESTR({LDT})',
    'HOUR({LDT})',
    'IS_BEFORE({LD}, {DT})',
    'DATETIME_DIFF({LDT}, {DT}, "days")',
    '{LDT} = NOW()',
    '{LD} = {D}',
    'WEEKDAY({LD})',
  ])
    await assertAgreement(source, rows, lookupContext);
});

it('flattens lookups in totals and counts, and joins them as text', async () => {
  const rows = lookupRecords(40, random(0x746f74));
  for (const source of [
    'SUM({LK})',
    'SUM({LK}, {N}, {LK})',
    'SUM({C}, {LK})',
    'SUM({LB})',
    'SUM({LK}, {LB}, 1)',
    'AVERAGE({LK})',
    'AVERAGE({LK}, {N})',
    'MAX({LK})',
    'MAX({LK}, 1)',
    'MIN({LK}, {N})',
    'MIN({LB})',
    'COUNT({LK})',
    'COUNT({LK}, {LT}, {N})',
    'COUNTA({LT})',
    'COUNTA({LK}, {LB})',
    'COUNTALL({LK})',
    'COUNTALL({LT}, {N})',
    'CONCATENATE({LT})',
    'CONCATENATE({LK}, "|", {LB}, "|", {LD}, "|", {LDT})',
    '{LK} & ""',
    '"x" & {LT} & "y"',
    'IF({LK}, "some", "none")',
    'AND({LT}, {LB})',
    'NOT({LD})',
    'ISERROR({LK})',
    'T({LT})',
    'SUM({LK}) / COUNT({LK})',
  ])
    await assertAgreement(source, rows, lookupContext);
});

it('agrees on generated formulas that read lookups as values and total them', async () => {
  const next = random(0x6c697374);
  const choose = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const number = (depth: number): string => {
    if (depth === 0 || next() < 0.25) return choose(['{LK}', '{N}', '{C}', '{LB}', '2', '0.5', 'BLANK()']);
    const a = number(depth - 1),
      b = number(depth - 1);
    return choose([
      `(${a} ${choose(['+', '-', '*', '/'])} ${b})`,
      `-${a}`,
      `${choose(['SUM', 'MAX', 'MIN', 'AVERAGE'])}(${a}, {LK})`,
      `${choose(['COUNT', 'COUNTA', 'COUNTALL'])}({${choose(['LK', 'LT', 'LB', 'LD'])}}, ${a})`,
      `IF(${a} ${choose(['<', '>', '='])} ${b}, ${a}, ${b})`,
      `LEN({LT})`,
      `IF(ISERROR(${a}), -1, ${a})`,
      `YEAR({LD})`,
    ]);
  };
  // Only formulas that check and compile count: an IF with a whole list in one branch does neither.
  const compiles = (source: string) => {
    const parsed = parse(source);
    const resolved = 'ast' in parsed ? resolve(parsed.ast, fields) : parsed;
    return 'ast' in resolved && 'type' in check(resolved.ast)
      ? compileSql(resolved.ast, fields, lookupContext) !== null
      : false;
  };
  const rows = lookupRecords(20, next);
  const seen = new Set<string>();
  let singles = 0;
  while (seen.size < 300) {
    const source = choose([
      () => number(3),
      () => `${number(2)} & "|" & {LT}`,
      () => `CONCATENATE({LK}, ${number(2)})`,
      () => `(${number(2)}) > {LK}`,
    ])();
    if (seen.has(source) || !compiles(source)) continue;
    seen.add(source);
    if ('oneValue' in check(astOf(source))) singles++;
    await assertAgreement(source, rows, lookupContext);
  }
  // Most of them read a lookup as one value somewhere.
  expect(singles).toBeGreaterThan(150);
}, 180_000);

it('sums lookups in order, with an error where the running total overflows', async () => {
  const base = records(1)[0]!;
  const max = Number.MAX_VALUE;
  const lists = [
    [max, max, -max],
    [max, -max, max],
    [max, -max],
    [-max, -max],
    [max / 2, max / 2],
    [max / 2, max / 2, Number.MIN_VALUE],
    [0.1, 0.2, 0.3],
    [0.3, 0.2, 0.1],
    [1e308, 1e308, -1e308],
    [1e-300, 1e-300],
    [Number.MIN_VALUE, -Number.MIN_VALUE, 1],
    [],
  ];
  const rows = lists.flatMap((lk, i) =>
    [null, 1, max, -max].map((c, j) => ({ ...base, id: `sum${i}_${j}`, values: { ...base.values, c, lk } })),
  );
  for (const source of [
    'SUM({LK})',
    'SUM({C}, {LK})',
    'SUM({LK}, {C})',
    'AVERAGE({C}, {LK})',
    'MAX({LK}, {C})',
  ])
    await assertAgreement(source, rows, lookupContext);
});

it('leaves lookups compared with each other, and list results, to JavaScript', () => {
  for (const source of [
    '{LK}',
    '{LK} = {LK}',
    '{LK} = BLANK()',
    'IF(TRUE(), {LK}, BLANK())',
    'ARRAYJOIN(IF(TRUE(), {LT}, {LT}))',
    'ARRAYCOMPACT({LK})',
  ])
    expect(compileSql(astOf(source), fields, lookupContext), source).toBeNull();
  // A list that isn't a lookup's, like a people field's names, never reaches SQL.
  expect(compileSql(astOf('{U} & ""'), fields, lookupContext)).toBeNull();
});

/** Choices by ID, with names that need care: commas, quotes, an apostrophe, and none at all. */
const CHOICES = new Map([
  ['choDone', 'Done'],
  ['choDoing', 'In progress'],
  ['choComma', 'Smith, Jones'],
  ['choQuote', 'Say "hi"'],
  ['choApostrophe', "O'Brien"],
  ['choEmpty', ''],
  ['choEmoji', '😀 Café'],
]);
/** Links and choices read by name.  A link's error arrives through its own column, as the server passes one. */
const namesContext: SqlContext = {
  ...context,
  choices: CHOICES,
  errorRef: (field) => (field.id === 'lnk' ? sql`${ident('r', 'lnk_error')}` : null),
};
/**
 * Linked records' names, as the server hands them over, including names with commas and quotes,
 * an empty name, a name a formula wrote, a name that looks like a number, and a record linked to
 * nothing.
 */
const LINK_NAMES: FormulaRecord['values'][string][] = [
  ['Forrester Legal Partners'],
  ['Smith, Jones & Co.', 'The "Best" Co'],
  ["O'Brien", ''],
  [],
  null,
  [''],
  ['420'],
  ['Forrester Legal Partners Order #420', '😀 Café'],
  ['Done', 'Done'],
  { error: '#ERROR!', messageKey: 'formula.link.unnamed' },
];
const CHOSEN = [
  [null, null],
  ['choDone', ['choDone']],
  ['choComma', ['choComma', 'choQuote']],
  ['choEmpty', ['choEmpty']],
  ['choApostrophe', ['choEmoji', 'choDone', 'choApostrophe']],
  // A choice that isn't one any more reads as blank.
  ['choGone', ['choGone', 'choDoing']],
  ['choQuote', []],
] as const;
function namedRecords(): FormulaRecord[] {
  const base = records(LINK_NAMES.length * CHOSEN.length);
  return base.map((row, i) => {
    const [ss, ms] = CHOSEN[i % CHOSEN.length]!;
    return {
      ...row,
      id: `named${i}`,
      values: {
        ...row.values,
        n: [420, null, 7.5][i % 3]!,
        t: ['Forrester Legal Partners', 'Done', '', null][i % 4]!,
        lnk: LINK_NAMES[Math.floor(i / CHOSEN.length)]!,
        ss,
        ms: ms as string[] | null,
      },
    };
  });
}

it('reads links as their linked records’ names, joined, counted, and compared', async () => {
  const rows = namedRecords();
  for (const source of [
    '{LNK} & " Order #" & {N}',
    '{LNK} & ""',
    '"(" & {LNK} & ")"',
    'CONCATENATE({LNK}, "|", {N})',
    'COUNTA({LNK})',
    'COUNTALL({LNK})',
    'COUNT({LNK})',
    'IF({LNK}, "linked", "none")',
    'NOT({LNK})',
    'AND({LNK}, TRUE())',
    // Where one value belongs, a link reads as its one name.
    '{LNK} = "Forrester Legal Partners"',
    '{LNK} != "Forrester Legal Partners"',
    '{LNK} = {T}',
    '{LNK} = ""',
    'LEN({LNK})',
    'TRIM({LNK})',
    'SUBSTITUTE({LNK}, ",", ";")',
    'SWITCH({LNK}, "420", 1, "", 2, "Forrester Legal Partners", 3, 0)',
    'IF({LNK} = "Done", "done", "not done")',
    'ISERROR({LNK} = "x")',
    'IF(ISERROR({LNK} & ""), "unnamed", {LNK} & "")',
  ])
    await assertAgreement(source, rows, namesContext);
});

it('reads single and multiple selects as their choices’ names', async () => {
  const rows = namedRecords();
  for (const source of [
    '{SS}',
    '{SS} & ""',
    '{SS} = "Done"',
    '{SS} != "Done"',
    '{SS} = ""',
    '{SS} = BLANK()',
    '{SS} = {T}',
    'LEN({SS})',
    'SWITCH({SS}, "Done", 1, "Smith, Jones", 2, "", 3, 0)',
    'IF({SS}, {SS}, "none")',
    '{MS} & ""',
    '"Tags: " & {MS}',
    'CONCATENATE({SS}, " / ", {MS})',
    'COUNTA({MS})',
    'COUNTALL({MS})',
    'IF({MS}, "tagged", "untagged")',
    'NOT({MS})',
    'LEN({MS} & "")',
    '({MS} & "") = "Smith, Jones, Say \\"hi\\""',
    '{LNK} & " is " & {SS} & " with " & {MS}',
  ])
    await assertAgreement(source, rows, namesContext);
});

it('leaves a link compared with a list, and list results, to JavaScript', () => {
  for (const source of ['{LNK}', '{MS}', 'ARRAYUNIQUE({MS})', '{LNK} = {MS}'])
    expect(compileSql(astOf(source), fields, namesContext), source).toBeNull();
  const [row] = namedRecords().filter(
    (row) => JSON.stringify(row.values.lnk) === '["Smith, Jones & Co.","The \\"Best\\" Co"]',
  );
  expect(evaluate(astOf('ARRAYJOIN({LNK}, "; ")'), row!, namesContext)).toBe(
    'Smith, Jones & Co.; The "Best" Co',
  );
  expect(evaluate(astOf('{LNK}'), row!, namesContext)).toEqual(['Smith, Jones & Co.', 'The "Best" Co']);
  expect(evaluate(astOf('{LNK} = "Smith, Jones & Co."'), row!, namesContext)).toMatchObject({
    messageKey: 'formula.list.several',
  });
});

it('reads links by the names a primary field formula gives them, in SQL as in JavaScript', async () => {
  // The linked table's primary field is a formula over two of its fields: the Product Catalog's pattern.
  const linkedFields: FormulaField[] = [
    { id: 'client', name: 'Client', type: 'text' },
    { id: 'number', name: 'Order Number', type: 'number' },
  ];
  const parsed = parse('{Client} & " Order #" & {Order Number}');
  if ('error' in parsed) throw new Error('unparsed');
  const resolved = resolve(parsed.ast, linkedFields);
  if ('error' in resolved) throw new Error('unresolved');
  const primary = resolved.ast;
  const linked: FormulaRecord[] = [
    ['recA', 'Forrester Legal Partners', 420],
    ['recB', 'Smith, Jones & Co.', 7.5],
    ['recC', 'Say "hi"', null],
    ['recD', null, null],
  ].map(([id, client, number]) => ({
    id: id as string,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    values: { client, number } as FormulaRecord['values'],
  }));
  const linkedData = linked.map((row) => ({ id: row.id, ...row.values }));
  const primarySql = compileSql(primary, linkedFields, {
    ...context,
    columnRef: (field) => sql`${ident('lr', field.id)}`,
  });
  expect(primarySql).not.toBeNull();
  // Each linked record's name is its primary field's text, in link order.
  const names = sql`(SELECT COALESCE(jsonb_agg(to_jsonb(COALESCE(${primarySql!} #>> '{}', '')) ORDER BY l.position), '[]'::jsonb)
    FROM jsonb_array_elements_text(r.lnk_ids) WITH ORDINALITY AS l(id, position)
    JOIN jsonb_to_recordset(${JSON.stringify(linkedData)}::jsonb) AS lr(id text, client text, number numeric)
      ON lr.id = l.id)`;
  const ctx: SqlContext = {
    ...namesContext,
    columnRef: (field) => (field.id === 'lnk' ? names : sql`${ident('r', field.id)}`),
    errorRef: () => null,
  };
  const nameOf = (id: string) => {
    const value = evaluate(
      primary,
      linked.find((row) => row.id === id)!,
      context,
    );
    return typeof value === 'string' ? value : '';
  };
  const links = [['recA'], ['recB', 'recA'], ['recC'], ['recD'], [], ['recA', 'recD', 'recB']];
  const base = records(1)[0]!;
  for (const source of [
    '{LNK} & ""',
    '"Billed to " & {LNK}',
    '{LNK} = "Forrester Legal Partners Order #420"',
    'COUNTA({LNK})',
    'LEN({LNK})',
  ]) {
    const ast = astOf(source);
    const expression = compileSql(ast, fields, ctx);
    expect(expression, source).not.toBeNull();
    const data = links.map((ids, i) => ({ id: `p${i}`, lnk_ids: ids }));
    const results = (
      await query<{ id: string; actual: FormulaValue }>(
        pool,
        sql`SELECT r.id, ${expression!} AS actual
          FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS r(id text, lnk_ids jsonb)`,
      )
    ).rows;
    links.forEach((ids, i) => {
      const record = { ...base, id: `p${i}`, values: { ...base.values, lnk: ids.map(nameOf) } };
      expect(results[i]!.actual, `${source} ${JSON.stringify(ids)}`).toEqual(
        evaluate(ast, record, namesContext),
      );
    });
  }
  expect(nameOf('recB')).toBe('Smith, Jones & Co. Order #7.5');
  expect(nameOf('recD')).toBe(' Order #');
});

/** Rows that each hold one text in `t`, and a number in `n` for starts and precisions. */
function textRows(texts: readonly (string | null)[], numbers: readonly (number | null)[] = [null]) {
  const base = records(1)[0]!;
  return texts.flatMap((t, i) =>
    numbers.map((n, j) => ({ ...base, id: `text${i}_${j}`, values: { ...base.values, t, n } })),
  );
}

it('lowers and uppercases every character that has a case as JavaScript does, final sigmas included', async () => {
  const tables = caseTables();
  expect(tables).not.toBeNull();
  // Every character a case table maps or the sigma rule reads, forty to a text.
  const chars = new Set<string>();
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp);
    if (
      char.toLowerCase() !== char ||
      char.toUpperCase() !== char ||
      /\p{Cased}|\p{Case_Ignorable}/u.test(char)
    )
      chars.add(char);
  }
  const all = [...chars];
  const texts: string[] = [];
  for (let i = 0; i < all.length; i += 40) texts.push(all.slice(i, i + 40).join(''));
  // A capital sigma after and before each of them, and at the ends of words.
  for (const char of all)
    texts.push(`${char}Σ`, `AΣ${char}`, `A${char}Σ ${char}`, `AΣ${char}B`, `a${char}${char}Σ${char}.`);
  texts.push('ΌΣΟΣ', 'ΑΣ.', 'Σ', 'ΣΣ ΣΣΣ', "Ο'Σ", 'İstanbul', 'straße', 'ŉ ǰ ΐ ﬁ', 'MiXeD ascii', '');
  const rows = textRows(texts);
  for (const source of ['LOWER({T})', 'UPPER({T})', 'LOWER(UPPER({T}))', 'LEN(LOWER({T}))'])
    await assertAgreement(source, rows);
}, 120_000);

it('finds text at UTF-16 positions, from a start, as JavaScript does', async () => {
  const texts = [
    'hello',
    'Hello hello',
    '😀a😀b',
    'a😀😀a',
    'İİi',
    'straße STRASSE',
    'ΌΣΟΣ',
    '',
    null,
    'aaa',
  ];
  const rows = textRows(texts, [null, -5, 0, 1, 2, 3, 4, 5, 6, 7, 1e300, 2.9]);
  for (const source of [
    'FIND("l", {T})',
    'FIND("lo", {T}, {N})',
    'FIND("", {T}, {N})',
    'FIND({T}, "Hello hello😀a😀b", {N})',
    'FIND("😀", {T}, {N})',
    'FIND("a", {T}, {N})',
    'FIND("zz", {T})',
    'FIND(BLANK(), {T}, {N})',
    'FIND("a", BLANK(), {N})',
    'SEARCH("HELLO", {T}, {N})',
    'SEARCH("i", {T}, {N})',
    'SEARCH("ss", {T}, {N})',
    'SEARCH("ς", {T}, {N})',
    'SEARCH("😀B", {T}, {N})',
    'SEARCH("", {T}, {N})',
    'SEARCH("nothing", {T})',
    'FIND("x", {T}, 1/0)',
    'FIND("e", {T}, {B})',
    'IF(FIND("l", {T}), "found", "not")',
  ])
    await assertAgreement(source, rows);
});

it('rounds as JavaScript does, ties toward positive infinity, and at the ends of the number line', async () => {
  const values = [
    ...NUMBERS,
    2.5,
    -2.5,
    0.5,
    -0.5,
    1.005,
    -1.005,
    2.675,
    0.49999999999999994,
    -0.49999999999999994,
    1234.5678,
    -1234.5678,
    2 ** 52 + 0.5,
    null,
  ];
  const base = records(1)[0]!;
  const rows = values.map((n, i) => ({
    ...base,
    id: `round${i}`,
    values: { ...base.values, n, b: i % 2 === 0 },
  }));
  for (const precision of [-309, -308, -300, -3, -1, 0, 1, 2, 3, 10, 300, 308, 309, 1.9, -1.9])
    await assertAgreement(`ROUND({N}, ${precision})`, rows);
  for (const source of ['ROUND({B}, 0)', 'ROUND(BLANK(), 2)', 'ROUND({N} / 0, 1)', 'ROUND({N}, 2) = {N}'])
    await assertAgreement(source, rows);
});

it('joins lookups, links, and multiple selects with ARRAYJOIN', async () => {
  const rows = lookupRecords(40, random(0x6a6f696e));
  for (const source of [
    'ARRAYJOIN({LK})',
    'ARRAYJOIN({LT}, "|")',
    'ARRAYJOIN({LB}, "")',
    'ARRAYJOIN({LD}, BLANK())',
    'ARRAYJOIN({LDT}, {T})',
    'ARRAYJOIN(BLANK(), "-")',
    'LEN(ARRAYJOIN({LT}))',
    'FIND("a", ARRAYJOIN({LT}))',
  ])
    await assertAgreement(source, rows, lookupContext);
  const named = namedRecords();
  for (const source of ['ARRAYJOIN({LNK}, "; ")', 'ARRAYJOIN({MS})', 'LOWER(ARRAYJOIN({MS}, " / "))'])
    await assertAgreement(source, named, namesContext);
});

import { expect, it } from 'vitest';
import { compile, sql } from '@riosoma/db';
import { NamedFunctionDefinition, type NamedFunctionDefinition as Definition } from '@riosoma/contracts';
import {
  check,
  evaluate,
  parse,
  prepareNamedFunctions,
  readsRecords,
  references,
  resolve,
  type Ast,
  type FormulaField,
  type FormulaRecord,
} from './index.js';
import { compileSql } from './sql.js';

const fields: FormulaField[] = [
  { id: 'n', name: 'Number', type: 'number' },
  { id: 't', name: 'Text', type: 'text' },
  { id: 'l', name: 'Lookup', type: 'lookup', valueType: { array: 'number' } },
  { id: 'remote', name: 'Amount', tableId: 'orders', tableName: 'Orders', type: 'number' },
];
const row: FormulaRecord = {
  id: 'rec1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  values: { n: 4, t: 'hello', l: [2] },
};
const context = { now: '2024-01-03T00:00:00.000Z', timeZone: 'UTC' };
const definitions: Definition[] = [
  { name: 'DOUBLE', parameters: ['value'], body: 'value * 2' },
  { name: 'QUADRUPLE', parameters: ['value'], body: 'DOUBLE(DOUBLE(value))' },
  { name: 'IDENTITY', parameters: ['value'], body: '{VALUE}' },
  {
    name: 'SAFE_DIVIDE',
    parameters: ['amount', 'divisor'],
    body: 'IF(divisor = 0, BLANK(), amount / divisor)',
  },
  { name: 'CHOOSE', parameters: ['condition', 'yes', 'no'], body: 'IF(condition, yes, no)' },
  { name: 'BOTH', parameters: ['value'], body: 'SUM(value) + value' },
  { name: 'RECOVER', parameters: ['value'], body: 'IF(ISERROR(value * 1), SUM(value), value * 1)' },
  { name: 'FIRST', parameters: [], body: 'RECORD_ID()' },
];
function parsed(source: string): Ast {
  const result = parse(source);
  if ('error' in result) throw new Error(JSON.stringify(result));
  return result.ast;
}
function resolved(source: string, functions = definitions): Ast {
  const result = resolve(parsed(source), fields, undefined, undefined, functions);
  if ('error' in result) throw new Error(JSON.stringify(result));
  return result.ast;
}
function problem(functions: Definition[], messageKey: string) {
  expect(prepareNamedFunctions(functions)).toMatchObject({ error: { messageKey } });
}

it('validates bounded identifiers and bodies without changing source offsets', () => {
  expect(NamedFunctionDefinition.parse({ name: 'A', parameters: [], body: '  1  ' }).body).toBe('  1  ');
  for (const change of [
    { name: 'has spaces' },
    { name: '1FIRST' },
    { name: 'A'.repeat(65) },
    { body: ' ' },
    { body: '1'.repeat(10001) },
    { parameters: Array(33).fill('x') },
  ])
    expect(
      NamedFunctionDefinition.safeParse({ name: 'A', parameters: [], body: '1', ...change }).success,
    ).toBe(false);
  problem(
    Array.from({ length: 101 }, (_, i) => ({ name: `F${i}`, parameters: [], body: '1' })),
    'formula.named.invalid',
  );
});

it('binds case-insensitive names, nests calls, and infers types at each invocation', () => {
  const ast = resolved('quadruple({Number})');
  expect(check(ast)).toEqual({ type: 'number' });
  expect(evaluate(ast, row, context)).toBe(16);
  expect(references(ast)).toEqual(['n']);
  expect(check(resolved('IDENTITY({Text})'))).toEqual({ type: 'text' });
  expect(check(resolved('IDENTITY({Number})'))).toEqual({ type: 'number' });
  expect(evaluate(resolved('FIRST()'), row, context)).toBe('rec1');
  expect(prepareNamedFunctions(definitions)).toHaveProperty(
    'names',
    definitions.map((definition) => definition.name),
  );
  expect(resolve(parsed('DOUBLE({Number})'), fields)).toHaveProperty('ast');
  expect(check((resolve(parsed('DOUBLE({Number})'), fields) as { ast: Ast }).ast)).toMatchObject({
    error: { messageKey: 'formula.function.unknown' },
  });
  expect(definitions[0]!.body).toBe('value * 2');
});

it('keeps lazy branches, blanks, errors, and lookup coercion local to each use', () => {
  expect(evaluate(resolved('CHOOSE(TRUE(), 7, ERROR())'), row, context)).toBe(7);
  expect(evaluate(resolved('SAFE_DIVIDE(ERROR(), 0)'), row, context)).toBeNull();
  expect(evaluate(resolved('SAFE_DIVIDE(8, 2)'), row, context)).toBe(4);
  expect(evaluate(resolved('DOUBLE(BLANK())'), row, context)).toBe(0);
  const ast = resolved('BOTH({Lookup})');
  expect(check(ast)).toEqual({ type: 'number', oneValue: ['l'] });
  expect(evaluate(ast, row, context)).toBe(4);
  expect(evaluate(ast, { ...row, values: { l: [] } }, context)).toBe(0);
  expect(evaluate(ast, { ...row, values: { l: [2, 3] } }, context)).toMatchObject({
    error: '#ERROR!',
    messageKey: 'formula.list.several',
  });
  const recovered = resolved('RECOVER({Lookup})');
  expect(check(recovered)).toEqual({ type: 'number', oneValue: ['l'] });
  expect(evaluate(recovered, { ...row, values: { l: [2, 3] } }, context)).toBe(5);
});

it('retains argument diagnostics, resolves all arguments, and prevents parameter capture', () => {
  expect(check(resolved('DOUBLE({Text})'))).toMatchObject({
    error: { messageKey: 'formula.type.argument', start: 7, end: 13 },
  });
  expect(resolve(parsed('DOUBLE({Missing})'), fields, undefined, undefined, definitions)).toMatchObject({
    error: { messageKey: 'formula.field.unknown' },
  });
  const ignore = [{ name: 'IGNORE', parameters: ['x'], body: '7' }];
  expect(resolve(parsed('IGNORE({Missing})'), fields, undefined, undefined, ignore)).toMatchObject({
    error: { messageKey: 'formula.field.unknown' },
  });
  expect(resolve(parsed('IGNORE({Number})'), fields, 'n', undefined, ignore)).toMatchObject({
    error: { messageKey: 'formula.field.circular' },
  });
  for (const body of ['Number + 1', '{Number}', 'Orders[Amount]'])
    problem([{ name: 'A', parameters: ['x'], body }], 'formula.named.parameter');
  problem([{ name: 'A', parameters: ['x'], body: 'MISSING(x)' }], 'formula.function.unknown');
  problem([{ name: 'A', parameters: ['x'], body: 'ABS(x, x)' }], 'formula.function.arity');
  expect(prepareNamedFunctions([{ name: 'A', parameters: [], body: '  1 + )' }])).toMatchObject({
    error: { messageKey: 'formula.syntax.unexpected', start: 6, end: 7 },
  });
});

it('rejects ambiguous registries and recursion even in unused or lazy branches', () => {
  for (const functions of [
    [{ name: 'sum', parameters: [], body: '1' }],
    [{ name: 'A', parameters: ['x', 'X'], body: 'x' }],
    [{ name: 'A', parameters: ['TRUE'], body: 'TRUE' }],
    [
      { name: 'A', parameters: [], body: '1' },
      { name: 'a', parameters: [], body: '2' },
    ],
  ])
    problem(functions, 'formula.named.invalid');
  problem([{ name: 'A', parameters: ['x'], body: 'IF(FALSE(), A(x), x)' }], 'formula.named.circular');
  problem(
    [
      { name: 'A', parameters: ['x'], body: 'B(x)' },
      { name: 'B', parameters: ['x'], body: 'A(x)' },
    ],
    'formula.named.circular',
  );
  expect(
    resolve(parsed('1'), fields, undefined, undefined, [{ name: 'A', parameters: [], body: 'A()' }]),
  ).toMatchObject({ error: { messageKey: 'formula.named.circular' } });
  expect(resolve(parsed('DOUBLE()'), fields, undefined, undefined, definitions)).toMatchObject({
    error: { messageKey: 'formula.function.arity', start: 0, end: 8 },
  });
  expect(resolve(parsed('FIRST(1)'), fields, undefined, undefined, definitions)).toMatchObject({
    error: { messageKey: 'formula.function.arity' },
  });
  problem(
    [
      { name: 'A', parameters: [], body: 'B(1)' },
      { name: 'B', parameters: [], body: '1' },
    ],
    'formula.function.arity',
  );
});

it('preserves table ranges, record reads, and field-only argument requirements', () => {
  const functions = [
    { name: 'TOTAL', parameters: ['range', 'criterion'], body: 'SUMIFS(range, range, criterion)' },
    { name: 'PRIOR', parameters: ['value'], body: 'PREVIOUS(value)' },
    { name: 'MODIFIED', parameters: ['value'], body: 'LAST_MODIFIED_TIME(value)' },
  ];
  const total = resolved('TOTAL(Orders[Amount], ">0")', functions);
  expect(check(total)).toEqual({ type: 'number' });
  expect(references(total)).toEqual(['remote']);
  expect(readsRecords(total)).toBe(true);
  expect(readsRecords(resolved('PRIOR({Number})', functions))).toBe(true);
  expect(check(resolved('MODIFIED(1)', functions))).toMatchObject({
    error: { messageKey: 'formula.type.fieldRequired' },
  });
});

it('bounds exponential expansion and deep bodies before either engine receives them', () => {
  const functions = [{ name: 'TWICE', parameters: ['x'], body: 'x + x' }];
  const source = 'TWICE('.repeat(15) + '1' + ')'.repeat(15);
  expect(resolve(parsed(source), [], undefined, undefined, functions)).toMatchObject({
    error: { messageKey: 'formula.runtime.limit' },
  });
  const deep = [{ name: 'DEEP', parameters: ['x'], body: Array(1000).fill('x').join('+') }];
  expect(resolve(parsed('DEEP(1)'), [], undefined, undefined, deep)).toMatchObject({
    error: { messageKey: 'formula.runtime.limit' },
  });
});

it('isolates registry snapshots and keeps SQL literals parameterized with fallback parity', () => {
  const input = [{ name: 'VALUE_OF', parameters: [], body: '1' }];
  const registry = prepareNamedFunctions(input);
  if ('error' in registry) throw new Error(JSON.stringify(registry));
  input[0]!.body = '2';
  const expanded = registry.expand(parsed('VALUE_OF()'));
  if ('error' in expanded) throw new Error(JSON.stringify(expanded));
  expect(evaluate(expanded.ast, row, context)).toBe(1);
  expect(evaluate(resolved('VALUE_OF()', input), row, context)).toBe(2);
  const attack = "'; DROP TABLE records; --";
  const expression = compileSql(resolved(`IDENTITY(${JSON.stringify(attack)})`), fields, {
    ...context,
    columnRef: () => sql`NULL`,
  });
  expect(expression).not.toBeNull();
  const compiled = compile(expression!);
  expect(compiled.text).not.toContain(attack);
  expect(compiled.values).toContain(attack);
  const unsupported = [{ name: 'MATCHES', parameters: ['text'], body: 'REGEX_MATCH(text, "x")' }];
  const ast = resolved('MATCHES({Text})', unsupported);
  expect(check(ast)).toEqual({ type: 'boolean' });
  expect(compileSql(ast, fields, { ...context, columnRef: () => sql`NULL` })).toBeNull();
  expect(evaluate(ast, row, context)).toBe(false);
  const list = resolved('IDENTITY({Lookup})');
  const sqlContext = { ...context, columnRef: () => sql`'[2]'::jsonb` };
  expect(compileSql(list, fields, sqlContext)).toBeNull();
  expect(compileSql(list, fields, { ...sqlContext, arrayResult: true })).not.toBeNull();
});

import { describe, expect, it } from 'vitest';
import { FieldMeta, NAMED_FUNCTION_LIMITS, NamedFunctionMeta, newId } from '@riosoma/contracts';
import { callersOf, testFunction } from './model';

const definition = NamedFunctionMeta.parse({
  id: newId('namedFunction'),
  databaseId: newId('database'),
  name: 'NET',
  parameters: ['amount', 'discount'],
  body: 'amount * (1 - discount)',
  description: '',
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '',
  updatedAt: '',
});

describe('draft named-function tests', () => {
  it('evaluates the draft with sample arguments and preserves lazy branches', () => {
    expect(testFunction(definition, [definition], definition.id, ['100', '0.2'], 'UTC')).toEqual({
      value: 80,
    });
    expect(
      testFunction(
        { ...definition, body: 'IF(amount = 0, 0, 1 / discount)' },
        [definition],
        definition.id,
        ['0', '0'],
        'UTC',
      ),
    ).toEqual({ value: 0 });
    expect(
      testFunction(
        { ...definition, body: 'amount * 3' },
        [definition],
        definition.id,
        ['4', 'BLANK()'],
        'UTC',
      ),
    ).toEqual({ value: 12 });
  });
  it('reports unknown parameters, sample syntax, type errors, and runtime errors', () => {
    for (const [body, args] of [
      ['missing + 1', ['1', '0']],
      ['amount', ['1, 2', '0']],
      ['LEFT(amount, discount)', ['1', '"bad"']],
      ['amount / discount', ['1', '0']],
    ] as const) {
      expect(testFunction({ ...definition, body }, [definition], definition.id, args, 'UTC')).toHaveProperty(
        'error.messageKey',
      );
    }
  });
  it.each([
    ['a long addition chain', Array.from({ length: 10_000 }, () => '1').join('+')],
    ['an oversized text literal', `"${'x'.repeat(NAMED_FUNCTION_LIMITS.bodyLength - 1)}"`],
    ['a deep addition chain within the size limit', Array.from({ length: 4_000 }, () => '1').join('+')],
    ['a deep unresolved field', `missing${'+1'.repeat(NAMED_FUNCTION_LIMITS.depth)}`],
    [
      'a sample beyond the parser depth limit',
      `${'('.repeat(NAMED_FUNCTION_LIMITS.depth)}1${')'.repeat(NAMED_FUNCTION_LIMITS.depth)}`,
    ],
  ])('reports the formula limit for %s before resolving samples', (_name, sample) => {
    expect(
      testFunction(
        { ...definition, name: 'IDENTITY', parameters: ['value'], body: 'value' },
        [],
        undefined,
        [sample],
        'UTC',
      ),
    ).toMatchObject({ error: { messageKey: 'formula.runtime.limit' } });
  });
  it('evaluates samples within the size and depth limits', () => {
    const identity = { ...definition, name: 'IDENTITY', parameters: ['value'], body: 'value' };
    const text = 'x'.repeat(NAMED_FUNCTION_LIMITS.bodyLength - 2);
    expect(testFunction(identity, [], undefined, [`"${text}"`], 'UTC')).toEqual({ value: text });
    const terms = NAMED_FUNCTION_LIMITS.depth - 1;
    expect(
      testFunction(identity, [], undefined, [Array.from({ length: terms }, () => '1').join('+')], 'UTC'),
    ).toEqual({ value: terms });
  });
  it('names indirect formula and function callers', () => {
    const wrapper = {
      ...definition,
      id: newId('namedFunction'),
      name: 'TOTAL',
      parameters: ['value'],
      body: 'NET(value, 0)',
    };
    const tableId = newId('table');
    const field = FieldMeta.parse({
      id: newId('field'),
      tableId,
      name: 'Total price',
      type: 'formula',
      options: { expression: 'TOTAL(12)' },
      description: '',
      position: 0,
      createdAt: '',
      updatedAt: '',
    });
    expect(callersOf(definition, [definition, wrapper], [field], [{ id: tableId, name: 'Orders' }])).toEqual({
      fields: ['Orders: Total price'],
      functions: ['TOTAL'],
    });
  });
});

import { describe, expect, it } from 'vitest';
import { generateCorpus } from '../corpus.js';
import { comparePairRows, PAIR_PROCESS_KEYS, sortPairDifferences, type PairOutputFormat } from './compare.js';
import { normalizePairValue, type PairFieldType } from './values.js';

const rows = (...values: Record<string, unknown>[]) => values.map((values) => ({ values }));
const output = (
  keys = ['value'],
  identity: string[] | null = null,
  type?: PairFieldType,
): PairOutputFormat => ({
  rowMeaning: '',
  identity,
  fields: keys.map((key) => ({ key, meaning: '', required: false, ...(type ? { type } : {}) })),
});

describe('exact pair comparison', () => {
  it.each<[PairFieldType, unknown, unknown, boolean]>([
    ['number', '1,200.50', '1200.5', true],
    ['number', '1200.5', '1200.50', true],
    ['number', '1.200,50', '1,200.50', true],
    ['number', '1,200', '1200', true],
    ['number', '1.20', '1.200', true],
    ['number', '1e3', '1000.00', true],
    ['number', '-0.000', 0, true],
    ['number', '(12.50)', '-12.5', true],
    ['number', '900719925474099312345.0100', '900719925474099312345.01', true],
    ['number', '900719925474099312345.01', '900719925474099312345.02', false],
    ['number', '1.000000000000000001', '1.000000000000000002', false],
    ['date', '2026-3-1', '2026/03/01', true],
    ['date', '03/01/2026', '2026-03-01', true],
    ['date', '31/03/2026', '2026-03-31', true],
    ['date', '2024-02-29', '02/29/2024', true],
    ['date', '2026-02-29', '2026-03-01', false],
    ['date', '2026-03-01', '2026-03-02', false],
    ['dateTime', '2026-03-01T09:00:00Z', '2026-03-01T01:00:00-08:00', true],
    ['dateTime', '2026-03-01T09:00Z', '2026-03-01T01:00:00-08:00', true],
    ['dateTime', '2026-03-01T09:00', '2026-03-01T09:00:00Z', true],
    ['dateTime', '2026-03-01T10:00+01:00', '2026-03-01T09:00:00Z', true],
    ['dateTime', '2026-03-01T09:00Z', '2026-03-01T09:00:00.000000000000000000Z', true],
    ['dateTime', '2026-03-01T09:00Z', '2026-03-01T09:00:00.000000000000000001Z', false],
    [
      'dateTime',
      '2026-03-01T09:00:00.000000000000000001Z',
      '2026-03-01T01:00:00.000000000000000001-08:00',
      true,
    ],
    ['dateTime', '2026-03-01T09:00Z', '2026-03-01T09:00:01Z', false],
    ['dateTime', '2026-03-01T24:00Z', '2026-03-02T00:00:00Z', false],
    ['dateTime', '2026-03-01T09:60Z', '2026-03-01T10:00:00Z', false],
    ['dateTime', '2026-02-30T09:00Z', '2026-03-02T09:00:00Z', false],
    ['dateTime', '2026-03-01T09:00.5Z', '2026-03-01T09:00:00.5Z', false],
    ['dateTime', '2026-03-01T09:00:00', '2026-03-01T09:00:00Z', true],
    ['dateTime', '2026-03-01T09:00:00.123456Z', '2026-03-01T01:00:00.1234560-08:00', true],
    ['dateTime', '1969-12-31T23:59:59.5Z', '1970-01-01T00:59:59.500+01:00', true],
    ['dateTime', '2026-03-01T09:00:00.123456Z', '2026-03-01T09:00:00.123457Z', false],
    ['dateTime', '2026-02-30T09:00:00Z', '2026-03-02T09:00:00Z', false],
    ['dateTime', '2026-03-01T24:00:00Z', '2026-03-02T00:00:00Z', false],
    ['text', ' Café ', 'Cafe\u0301', true],
    ['text', 'River ', 'River', true],
    ['text', 'River', 'river', false],
    ['text', 'a  b', 'a b', false],
    ['text', '', null, true],
    ['text', ' \t ', undefined, true],
    ['text', null, undefined, true],
    ['number', '', 0, false],
    ['number', null, '0.00', false],
    ['text', '', 'N/A', false],
    ['text', 'N/A', 'n/a', false],
    // An identifier is text: its leading zeros and its letters are part of it.
    ['text', '00123', '123', false],
    ['text', '00123', 123, false],
    ['text', '1e3', '1000', false],
    ['text', '7E10', '70000000000', false],
    ['text', '1.50', '1.5', false],
    ['text', '03/04/2026', '2026-03-04', false],
    ['text', 123, '123', true],
    ['number', '00123', '123', true],
    ['number', '12 apples', '12', false],
    ['boolean', true, 'true', true],
    ['boolean', 'Yes', true, true],
    ['boolean', false, 'no', true],
    ['boolean', true, false, false],
    ['boolean', false, null, false],
    ['date', '2026-03-01', '2026-03-01T00:00:00Z', false],
  ])('compares a %s field holding %j and %j with equality %s', (type, actual, expected, equal) => {
    const result = comparePairRows(
      rows({ value: actual }),
      rows({ value: expected }),
      output(['value'], null, type),
    );
    expect(result.passed).toBe(equal);
    expect(result.differences).toHaveLength(equal ? 0 : 1);
  });

  it('compares a field with no declared type as text', () => {
    const untyped = output();
    expect(comparePairRows(rows({ value: '00123' }), rows({ value: '123' }), untyped).passed).toBe(false);
    expect(comparePairRows(rows({ value: '1,200.50' }), rows({ value: '1200.5' }), untyped).passed).toBe(
      false,
    );
    expect(comparePairRows(rows({ value: ' Reel 7 ' }), rows({ value: 'Reel 7' }), untyped).passed).toBe(
      true,
    );
  });

  it('keeps identifiers with leading zeros apart when rows are matched by identity', () => {
    const format = output(['code', 'units'], ['code']);
    const result = comparePairRows(
      rows({ code: '0042', units: '7' }),
      rows({ code: '42', units: '7' }),
      format,
    );
    expect(result.passed).toBe(false);
    expect(result.differences.map((difference) => difference.kind).sort()).toEqual([
      'extra-row',
      'missing-row',
    ]);
  });

  it('matches composite identities regardless of row and identity-key order', () => {
    const expected = rows(
      { id: 'A', period: '2026-03-01', value: 1 },
      { id: 'B', period: '2026-03-01', value: 2 },
    );
    const actual = rows(
      { id: 'B', period: '03/01/2026', value: '2.0' },
      { id: ' A ', period: '2026-3-1', value: '1.0' },
    );
    const typed = (identity: string[]): PairOutputFormat => ({
      rowMeaning: '',
      identity,
      fields: [
        { key: 'id', meaning: '', required: true, type: 'text' },
        { key: 'period', meaning: '', required: true, type: 'date' },
        { key: 'value', meaning: '', required: false, type: 'number' },
      ],
    });
    expect(comparePairRows(actual, expected, typed(['period', 'id'])).passed).toBe(true);
    actual[1]!.values.value = '3';
    expect(comparePairRows(actual, expected, typed(['id', 'period'])).differences).toEqual([
      expect.objectContaining({
        kind: 'cell',
        identity: { id: 'A', period: '2026-03-01' },
        expectedPosition: 0,
        actualPosition: 1,
        key: 'value',
        expected: 1,
        actual: '3',
      }),
    ]);
  });

  it('matches by position without an identity and reports all missing and extra rows', () => {
    expect(
      comparePairRows(rows({ value: 2 }, { value: 1 }), rows({ value: 1 }, { value: 2 }), output())
        .differences,
    ).toHaveLength(2);
    expect(comparePairRows([], rows({ value: 1 }), output()).differences).toEqual([
      expect.objectContaining({
        kind: 'missing-row',
        key: null,
        expectedPosition: 0,
        actualPosition: null,
        expected: { value: 1 },
        actual: null,
      }),
    ]);
    expect(comparePairRows(rows({ value: 1 }), [], output()).differences).toEqual([
      expect.objectContaining({ kind: 'extra-row', expectedPosition: null, actualPosition: 0 }),
    ]);
  });

  it('reports identities only on either side without comparing unrelated rows', () => {
    const result = comparePairRows(
      rows({ id: 'B', value: 1 }),
      rows({ id: 'A', value: 1 }),
      output(['id', 'value'], ['id']),
    );
    expect(result.differences.map((difference) => difference.kind).sort()).toEqual([
      'extra-row',
      'missing-row',
    ]);
    expect(result.passed).toBe(false);
  });

  it('reports every repeated identity on both sides and preserves every row', () => {
    const repeated = rows({ id: ' A ', value: 1 }, { id: 'A', value: 2 }, { id: 'A', value: 3 });
    const result = comparePairRows(repeated, repeated, output(['id', 'value'], ['id']));
    expect(result.passed).toBe(false);
    expect(result.differences.map((difference) => difference.kind).sort()).toEqual([
      'duplicate-actual-identity',
      'duplicate-actual-identity',
      'duplicate-expected-identity',
      'duplicate-expected-identity',
    ]);
    expect(
      comparePairRows(repeated, repeated.slice(0, 1), output(['id', 'value'], ['id'])).differences.filter(
        (difference) => difference.kind === 'extra-row',
      ),
    ).toHaveLength(2);
  });

  it('ignores extra fields and all five process fields even when included in settings', () => {
    const actual = rows({
      value: 1,
      ignored: 2,
      ...Object.fromEntries(PAIR_PROCESS_KEYS.map((key) => [key, 'changed'])),
    });
    expect(comparePairRows(actual, rows({ value: 1 }), output(['value', ...PAIR_PROCESS_KEYS])).passed).toBe(
      true,
    );
    expect(comparePairRows(rows({}), rows({ value: null }), output()).passed).toBe(true);
  });

  it('treats inherited properties as missing fields, including identity keys', () => {
    const format = output(['toString', 'value'], ['toString']);
    expect(comparePairRows(rows({ value: 1 }), rows({ toString: null, value: 1 }), format).passed).toBe(true);
    expect(comparePairRows(rows({ toString: 'offered', value: 1 }), rows({ value: 1 }), format).passed).toBe(
      false,
    );
  });

  it('sorts independently of field insertion and difference discovery order without mutating input', () => {
    const actual = rows({ z: 'z', a: 'a' });
    const expected = rows({ a: 'A', z: 'Z' });
    const before = JSON.stringify({ actual, expected });
    const result = comparePairRows(actual, expected, output(['z', 'a']));
    expect(result).toEqual(comparePairRows(actual, expected, output(['a', 'z'])));
    expect(result.differences.map((difference) => difference.key)).toEqual(['a', 'z']);
    expect(sortPairDifferences(result.differences.toReversed())).toEqual(result.differences);
    expect(JSON.stringify({ actual, expected })).toBe(before);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(normalizePairValue({ b: 2, a: 1 })).toEqual(normalizePairValue({ a: 1, b: 2 }));
  });

  it('passes every generated set against itself and catches each single data-cell change exactly', () => {
    for (const seed of [19, 20, 31])
      for (const example of generateCorpus({ seed, size: 3 })) {
        const fields = [...new Set(example.expected.flatMap((row) => Object.keys(row.values)))];
        const format = output(fields);
        expect(comparePairRows(example.expected, example.expected, format).passed).toBe(true);
        example.expected.forEach((row, index) => {
          for (const key of Object.keys(row.values)) {
            const actual = structuredClone(example.expected);
            actual[index]!.values[key] = `${key}-changed-${index}`;
            const result = comparePairRows(actual, example.expected, format);
            expect(result.passed).toBe(false);
            expect(result.differences).toEqual([
              expect.objectContaining({
                kind: 'cell',
                expectedPosition: index,
                actualPosition: index,
                key,
                expected: row.values[key],
                actual: `${key}-changed-${index}`,
              }),
            ]);
          }
        });
      }
  });
});

import { describe, expect, it } from 'vitest';
import {
  conditionMatches,
  FieldMeta,
  matchesFilter,
  recordMatchesFilter,
  type CellValue,
  type FilterCondition,
  type RowData,
} from './index.js';

/**
 * Computed and relational fields.  The server's filter tests cover stored fields against SQL, and
 * a test beside them runs the same cases through `conditionMatches`.  These cover what those can't
 * build without linked tables: lookups, rollups, formulas, links, and attachments.
 */
const REQUIRED: Record<string, object> = {
  link: { linkedTableId: 'tbl00000000000002' },
  lookup: { linkFieldId: 'fld00000000000098', targetFieldId: 'fld00000000000099' },
  rollup: { linkFieldId: 'fld00000000000098', targetFieldId: 'fld00000000000099' },
  count: { linkFieldId: 'fld00000000000098' },
};

const meta = (type: string, options: object = {}): FieldMeta =>
  FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Field',
    description: '',
    position: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options: { ...REQUIRED[type], ...options },
  });

const context = {
  timeZone: 'America/Adak',
  now: new Date('2026-09-27T12:00:00Z'),
  linkedName: (id: string) => ({ rec00000000000001: 'Acme Books', rec00000000000002: 'Zenith' })[id],
  fileName: (id: string) => ({ att00000000000001: 'Invoice.PDF' })[id],
};

function matching(
  field: FieldMeta,
  values: CellValue[],
  operator: FilterCondition['operator'],
  value?: unknown,
) {
  const condition: FilterCondition = { id: 'c', fieldId: field.id, operator, value };
  return values.flatMap((cell, index) => (conditionMatches(field, cell, condition, context) ? [index] : []));
}

describe('lists of computed values', () => {
  const lookup = meta('lookup', { resultType: 'text' });
  const values: CellValue[] = [[], ['Alpha', 'beta'], ['gamma'], [12]];

  it('match when any item matches, and negative conditions when none does', () => {
    expect(matching(lookup, values, 'contains', 'ALP')).toEqual([1]);
    expect(matching(lookup, values, 'doesNotContain', 'alp')).toEqual([0, 2, 3]);
    expect(matching(lookup, values, 'is', 'BETA')).toEqual([1]);
    expect(matching(lookup, values, 'isNot', 'beta')).toEqual([0, 2, 3]);
    expect(matching(lookup, values, 'is', '12')).toEqual([3]);
    expect(matching(lookup, values, 'isEmpty')).toEqual([0]);
    expect(matching(lookup, values, 'isNotEmpty')).toEqual([1, 2, 3]);
  });

  it('compare numbers and days item by item', () => {
    const numbers = meta('lookup', { resultType: 'number' });
    expect(matching(numbers, [[], [1, 5], [2]], 'gt', 4)).toEqual([1]);
    expect(matching(numbers, [[], [1, 5], [2]], 'neq', 2)).toEqual([0, 1]);
    const days = meta('lookup', { resultType: 'date' });
    expect(matching(days, [['2026-09-26'], ['2026-09-27', '2026-10-01']], 'is', { mode: 'today' })).toEqual([
      1,
    ]);
  });

  it('treat a rollup that keeps unique values as a list', () => {
    const rollup = meta('rollup', { fn: 'arrayUnique', resultType: 'array' });
    expect(matching(rollup, [['a'], ['b'], []], 'contains', 'A')).toEqual([0]);
  });
});

describe('single computed values', () => {
  it('follow the result type of rollups, counts, and formulas', () => {
    expect(matching(meta('rollup', { resultType: 'number' }), [null, 3, 10], 'gte', 5)).toEqual([2]);
    expect(matching(meta('count'), [0, 2], 'eq', 0)).toEqual([0]);
    expect(matching(meta('formula', { resultType: 'boolean' }), [true, false, null], 'is', false)).toEqual([
      1, 2,
    ]);
    expect(matching(meta('formula', { resultType: 'text' }), ['Late', null, ''], 'isEmpty')).toEqual([1, 2]);
  });

  it('read formula moments in the formula’s own time zone', () => {
    const fixed = meta('formula', { resultType: 'datetime', timeZone: 'Pacific/Kiritimati' });
    const viewer = meta('formula', { resultType: 'datetime', timeZone: 'client' });
    // 2026-09-27T12:00Z is the 28th in Kiritimati and the 27th in Adak.
    expect(
      matching(fixed, ['2026-09-27T12:00:00.000Z'], 'is', { mode: 'exactDate', date: '2026-09-28' }),
    ).toEqual([0]);
    expect(
      matching(viewer, ['2026-09-27T12:00:00.000Z'], 'is', { mode: 'exactDate', date: '2026-09-27' }),
    ).toEqual([0]);
  });
});

describe('links and attachments', () => {
  it('search linked records by their display text', () => {
    const link = meta('link');
    const values: CellValue[] = [[], ['rec00000000000001'], ['rec00000000000002', 'rec00000000000003']];
    expect(matching(link, values, 'contains', 'books')).toEqual([1]);
    expect(matching(link, values, 'doesNotContain', 'books')).toEqual([0, 2]);
    // A record whose name hasn't loaded can't be read, so it doesn't match.
    expect(matching(link, values, 'contains', 'rec0000')).toEqual([]);
    expect(matching(link, values, 'hasAnyOf', ['rec00000000000003'])).toEqual([2]);
    expect(matching(link, values, 'hasNoneOf', ['rec00000000000003'])).toEqual([0, 1]);
    expect(matching(link, values, 'isEmpty')).toEqual([0]);
  });

  it('search attachments by file name', () => {
    const files = meta('attachment');
    const values: CellValue[] = [null, ['att00000000000001'], ['att00000000000002']];
    expect(matching(files, values, 'contains', 'invoice')).toEqual([1]);
    expect(matching(files, values, 'doesNotContain', 'invoice')).toEqual([0, 2]);
    expect(matching(files, values, 'isNotEmpty')).toEqual([1, 2]);
  });
});

describe('whole filters', () => {
  const number = meta('number');
  const fields = new Map([[number.id, number]]);
  const condition = (operator: FilterCondition['operator'], value?: unknown): FilterCondition => ({
    id: operator,
    fieldId: number.id,
    operator,
    value,
  });

  it('skip incomplete conditions and leave out groups with nothing usable', () => {
    const incomplete = {
      conjunction: 'or' as const,
      conditions: [condition('eq'), { conjunction: 'and' as const, conditions: [condition('gt')] }],
    };
    const admitted = (filter: typeof incomplete) =>
      [null, 1, 2].filter((value) => matchesFilter(filter, fields, () => value, context));
    expect(admitted(incomplete)).toEqual([null, 1, 2]);
    expect(admitted({ ...incomplete, conditions: [...incomplete.conditions, condition('eq', 2)] })).toEqual([
      2,
    ]);
    expect(matchesFilter(null, fields, () => null, context)).toBe(true);
  });

  it('read a record’s own values', () => {
    const row: RowData = {
      id: 'rec00000000000001',
      values: { [number.id]: 3 },
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z',
      createdBy: null,
      updatedBy: null,
    };
    const filter = { conjunction: 'and' as const, conditions: [condition('lt', 5), condition('gte', 3)] };
    expect(recordMatchesFilter(row, filter, fields, context)).toBe(true);
    expect(recordMatchesFilter(row, { ...filter, conditions: [condition('gt', 3)] }, fields, context)).toBe(
      false,
    );
  });
});

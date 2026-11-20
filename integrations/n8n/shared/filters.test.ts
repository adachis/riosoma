import { describe, expect, it } from 'vitest';
import { FIELDS, TABLE } from '../test/fake-riosoma';
import {
  canMatch,
  FilterProblem,
  hasChoice,
  matchCondition,
  resolveFilter,
  sameValue,
  toMatchValue,
} from './filters';

const ctx = { address: 'https://riosoma.example.com', timeZone: 'UTC' };

describe('resolveFilter', () => {
  it('names fields by ID for the API, from names, IDs, or a field key', () => {
    expect(
      resolveFilter(
        {
          conjunction: 'or',
          conditions: [
            { field: 'Name', operator: 'contains', value: 'box' },
            { fieldId: FIELDS.count.id, operator: 'gt', value: 3 },
            { conjunction: 'and', conditions: [{ fieldId: 'status', operator: 'is', value: 'Open' }] },
          ],
        },
        TABLE.fields,
      ),
    ).toEqual({
      conjunction: 'or',
      conditions: [
        { id: 'c0', fieldId: FIELDS.name.id, operator: 'contains', value: 'box' },
        { id: 'c1', fieldId: FIELDS.count.id, operator: 'gt', value: 3 },
        {
          conjunction: 'and',
          conditions: [{ id: 'c2', fieldId: FIELDS.status.id, operator: 'is', value: 'Open' }],
        },
      ],
    });
  });

  it('reads a day written as text for date conditions', () => {
    const group = resolveFilter(
      { conditions: [{ field: 'Due', operator: 'isBefore', value: '2026-10-15' }] },
      TABLE.fields,
    );
    expect(group.conditions[0]).toMatchObject({ value: { mode: 'exactDate', date: '2026-10-15' } });
  });

  it('refuses what Riosoma would quietly leave out', () => {
    const check = (condition: object) => () =>
      resolveFilter({ conjunction: 'and', conditions: [condition] }, TABLE.fields);
    expect(check({ field: 'Missing', operator: 'is', value: 'x' })).toThrow("doesn't have");
    expect(check({ field: 'Count', operator: 'contains', value: '3' })).toThrow('which takes eq, neq');
    expect(check({ field: 'Count', operator: 'eq', value: '3' })).toThrow('needs a value of another form');
    expect(check({ field: 'Done', operator: 'is', value: 'yes' })).toThrow(FilterProblem);
    expect(check({ field: 'Name', operator: 'is' })).toThrow(FilterProblem);
    expect(check({ field: 'Name', operator: 'isEmpty' })).not.toThrow();
    expect(() => resolveFilter([], TABLE.fields)).toThrow('A filter is a group');
  });

  it('follows a formula to its result type', () => {
    expect(
      resolveFilter({ conditions: [{ field: 'Total', operator: 'gte', value: 10 }] }, TABLE.fields)
        .conditions[0],
    ).toMatchObject({ fieldId: FIELDS.total.id, operator: 'gte' });
  });
});

describe('matching by a value', () => {
  it('matches on text, numbers, checkboxes, dates without times, and single selects', () => {
    expect(canMatch(FIELDS.name)).toBe(true);
    expect(canMatch(FIELDS.count)).toBe(true);
    expect(canMatch(FIELDS.due)).toBe(true);
    expect(canMatch(FIELDS.status)).toBe(true);
    expect(canMatch(FIELDS.related)).toBe(false);
    expect(canMatch(FIELDS.files)).toBe(false);
    expect(canMatch({ ...FIELDS.due, options: { includeTime: true } })).toBe(false);
  });

  it("writes the condition in each field family's form", () => {
    expect(matchCondition(FIELDS.count, toMatchValue(FIELDS.count, '12', ctx))).toMatchObject({
      operator: 'eq',
      value: 12,
    });
    expect(matchCondition(FIELDS.done, toMatchValue(FIELDS.done, 'true', ctx))).toMatchObject({
      operator: 'is',
      value: true,
    });
    expect(matchCondition(FIELDS.due, toMatchValue(FIELDS.due, '2026-10-15T09:00:00Z', ctx))).toMatchObject({
      operator: 'is',
      value: { mode: 'exactDate', date: '2026-10-15' },
    });
    expect(matchCondition(FIELDS.name, 'Crate')).toMatchObject({ operator: 'is', value: 'Crate' });
    expect(() => toMatchValue(FIELDS.name, '', ctx)).toThrow('needs a value');
  });

  it('compares values the way the server does', () => {
    expect(sameValue(FIELDS.name, 'CRATE', 'crate')).toBe(true);
    expect(sameValue(FIELDS.name, 'crate 2', 'crate')).toBe(false);
    expect(sameValue(FIELDS.count, 12, 12)).toBe(true);
    expect(sameValue(FIELDS.count, null, 0)).toBe(false);
    expect(sameValue(FIELDS.done, undefined, false)).toBe(true);
    expect(sameValue(FIELDS.status, ' open', 'Open')).toBe(true);
  });

  it('knows a single select option the field lacks', () => {
    expect(hasChoice(FIELDS.status, 'closed')).toBe(true);
    expect(hasChoice(FIELDS.status, 'Pending')).toBe(false);
    expect(hasChoice(FIELDS.name, 'anything')).toBe(true);
  });
});

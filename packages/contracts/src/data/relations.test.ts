import { describe, expect, it } from 'vitest';
import {
  cellValue,
  checkCellValue,
  checkCondition,
  FieldMeta,
  FieldSpec,
  idsOf,
  operatorsForField,
  RowsQuery,
  ViewConfig,
  VIEW_TYPES,
  type RowData,
} from './index.js';

const meta = (spec: unknown, id = 'fld00000000000001'): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name: 'F',
    description: '',
    position: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...(spec as object),
  });

const REC_A = 'rec0000000000000a';
const REC_B = 'rec0000000000000b';
const link = (prefersSingle = false) =>
  meta({ type: 'link', options: { linkedTableId: 'tbl00000000000002', prefersSingle } });

describe('relational field specs', () => {
  it('preserves link limits and allows at most three distinct detail fields', () => {
    const options = {
      linkedTableId: 'tbl00000000000002',
      limitToViewId: 'viw00000000000001',
      displayFieldIds: ['fld00000000000001', 'fld00000000000002', 'fld00000000000003'],
    };
    expect(FieldSpec.parse({ type: 'link', options }).options).toMatchObject(options);
    for (const displayFieldIds of [
      [...options.displayFieldIds, 'fld00000000000004'],
      [options.displayFieldIds[0], options.displayFieldIds[0]],
    ])
      expect(FieldSpec.safeParse({ type: 'link', options: { ...options, displayFieldIds } }).success).toBe(
        false,
      );
    const filter = {
      conjunction: 'and',
      conditions: [
        { id: 'same', fieldId: 'fld00000000000001', operator: 'is', currentFieldId: 'fld00000000000002' },
      ],
    };
    expect(
      FieldSpec.parse({ type: 'link', options: { linkedTableId: options.linkedTableId, filter } }).options,
    ).toMatchObject({ filter });
  });
  it('fill in defaults for links, lookups, rollups, and formulas', () => {
    expect(
      FieldSpec.parse({ type: 'link', options: { linkedTableId: 'tbl00000000000002' } }).options,
    ).toEqual({
      linkedTableId: 'tbl00000000000002',
      inverseFieldId: null,
      prefersSingle: false,
    });
    const rollup = FieldSpec.parse({
      type: 'rollup',
      options: { linkFieldId: 'fld00000000000001', targetFieldId: 'fld00000000000002' },
    });
    expect(rollup.options).toMatchObject({ fn: 'sum', resultType: 'number' });
    expect(FieldSpec.parse({ type: 'formula' }).options).toMatchObject({
      expression: '',
      resultType: 'text',
    });
  });

  it('require what a link, lookup, or count reads through', () => {
    expect(FieldSpec.safeParse({ type: 'link' }).success).toBe(false);
    expect(
      FieldSpec.safeParse({ type: 'lookup', options: { linkFieldId: 'fld00000000000001' } }).success,
    ).toBe(false);
    expect(FieldSpec.safeParse({ type: 'count', options: {} }).success).toBe(false);
  });
});

describe('link values', () => {
  it('keep record IDs in order without duplicates, and store an empty list as null', () => {
    expect(checkCellValue(link(), [REC_B, REC_A, REC_B])).toEqual({ ok: true, value: [REC_B, REC_A] });
    expect(checkCellValue(link(), [])).toEqual({ ok: true, value: null });
    expect(checkCellValue(link(), null)).toEqual({ ok: true, value: null });
  });

  it('refuse anything but record IDs, and more than one where the field prefers one', () => {
    expect(checkCellValue(link(), ['usr0000000000000a'])).toEqual({
      ok: false,
      messageKey: 'data.link.unknownRecord',
    });
    expect(checkCellValue(link(), REC_A)).toEqual({ ok: false, messageKey: 'data.link.notList' });
    expect(checkCellValue(link(true), [REC_A, REC_B])).toEqual({ ok: false, messageKey: 'data.link.single' });
    expect(checkCellValue(link(true), [REC_A])).toEqual({ ok: true, value: [REC_A] });
  });

  it('read as an empty list when a record has none', () => {
    const row: RowData = {
      id: REC_A,
      values: {},
      createdAt: '2026-09-27T00:00:00.000Z',
      createdBy: null,
      updatedAt: '2026-09-27T00:00:00.000Z',
      updatedBy: null,
    };
    expect(cellValue(row, link())).toEqual([]);
    expect(idsOf([REC_A, 3, true])).toEqual([REC_A]);
    expect(idsOf('text')).toEqual([]);
  });
});

describe('filters on relational fields', () => {
  it('offer link operators and follow a computed field’s result type', () => {
    expect(operatorsForField(link())).toContain('hasAnyOf');
    const formula = meta({ type: 'formula', options: { expression: '1', resultType: 'number' } });
    expect(operatorsForField(formula)).toContain('gt');
    const lookup = meta({
      type: 'lookup',
      options: { linkFieldId: 'fld00000000000002', targetFieldId: 'fld00000000000003', resultType: 'date' },
    });
    expect(operatorsForField(lookup)).toEqual(operatorsForField(meta({ type: 'date' })));
  });

  it('check link condition values by operator', () => {
    const field = link();
    const condition = (operator: string, value: unknown) =>
      ({ id: 'c1', fieldId: field.id, operator, value }) as Parameters<typeof checkCondition>[1];
    expect(checkCondition(field, condition('hasAnyOf', [REC_A]))).toMatchObject({ valid: true });
    expect(checkCondition(field, condition('hasAnyOf', ['not a record']))).toMatchObject({ valid: false });
    expect(checkCondition(field, condition('contains', 'Acme'))).toMatchObject({ valid: true });
    expect(checkCondition(field, condition('gt', 3))).toMatchObject({ valid: false });
  });
});

describe('everyday field types', () => {
  it('fill in defaults and refuse unknown currencies', () => {
    expect(FieldSpec.parse({ type: 'currency' }).options).toEqual({
      code: 'USD',
      precision: 2,
      allowNegative: true,
    });
    expect(FieldSpec.safeParse({ type: 'currency', options: { code: 'ZZZ' } }).success).toBe(false);
    expect(FieldSpec.parse({ type: 'rating' }).options).toMatchObject({ max: 5, icon: 'star' });
    expect(FieldSpec.parse({ type: 'duration' }).options).toEqual({ format: 'h:mm' });
  });

  it('check numbers, ratings, people, and files', () => {
    expect(checkCellValue(meta({ type: 'percent' }), 0.25)).toEqual({ ok: true, value: 0.25 });
    expect(checkCellValue(meta({ type: 'duration' }), -5)).toEqual({
      ok: false,
      messageKey: 'data.value.negative',
    });
    const rating = meta({ type: 'rating', options: { max: 3 } });
    expect(checkCellValue(rating, 0)).toEqual({ ok: true, value: null });
    expect(checkCellValue(rating, 4)).toEqual({ ok: false, messageKey: 'data.value.rating' });
    expect(checkCellValue(rating, 2.5)).toEqual({ ok: false, messageKey: 'data.value.notNumber' });
    const one = meta({ type: 'user' });
    const USER_A = 'usr0000000000000a';
    const USER_B = 'usr0000000000000b';
    expect(checkCellValue(one, [USER_A, USER_A])).toEqual({ ok: true, value: [USER_A] });
    expect(checkCellValue(one, [USER_A, USER_B])).toEqual({ ok: false, messageKey: 'data.user.single' });
    expect(
      checkCellValue(meta({ type: 'user', options: { allowMultiple: true } }), [USER_A, USER_B]),
    ).toEqual({
      ok: true,
      value: [USER_A, USER_B],
    });
    expect(checkCellValue(meta({ type: 'attachment' }), ['att0000000000000a'])).toEqual({
      ok: true,
      value: ['att0000000000000a'],
    });
    expect(checkCellValue(meta({ type: 'attachment' }), ['rec0000000000000a'])).toEqual({
      ok: false,
      messageKey: 'data.file.unknown',
    });
    expect(checkCellValue(meta({ type: 'autoNumber' }), 3)).toEqual({
      ok: false,
      messageKey: 'data.value.computed',
    });
  });

  it('filter numbers like numbers, people as lists, and files by name', () => {
    expect(operatorsForField(meta({ type: 'currency' }))).toContain('gte');
    expect(operatorsForField(meta({ type: 'user' }))).toContain('hasAllOf');
    expect(operatorsForField(meta({ type: 'attachment' }))).toEqual([
      'contains',
      'doesNotContain',
      'isEmpty',
      'isNotEmpty',
    ]);
  });
});

describe('view types', () => {
  it('give every view each type’s settings with defaults, so switching types loses nothing', () => {
    const config = ViewConfig.parse({ kanban: { stackFieldId: 'fld00000000000001' } });
    expect(config.kanban).toEqual({
      stackFieldId: 'fld00000000000001',
      stackOrder: [],
      hiddenStacks: [],
      hideEmptyStacks: false,
      coverFieldId: null,
      coverFit: 'crop',
    });
    expect(config.form.questions).toEqual([]);
    expect(config.calendar.range).toBe('month');
    expect(VIEW_TYPES).toContain('calendar');
  });

  it('read stacks and date ranges from a rows request', () => {
    expect(RowsQuery.parse({ stack: '', from: '2026-09-01', to: '2026-09-30' })).toMatchObject({
      stack: '',
      from: '2026-09-01',
    });
    expect(RowsQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { SchemaTableCreate } from '../api-v1.js';
import {
  checkCellValue,
  checkCondition,
  Command,
  FieldMeta,
  FieldSpec,
  FilterGroup,
  GridConfig,
  LIMITS,
  presenceColor,
  sameValue,
  TableCreate,
  visibleFieldIds,
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

it('accepts the table field limit in create commands and refuses one more field', () => {
  const fields = Array.from({ length: LIMITS.fieldsPerTable }, (_, index) => ({
    id: `fld${String(index).padStart(14, '0')}`,
    name: `Field ${index}`,
    type: 'text',
  }));
  const table = {
    id: 'tbl00000000000001',
    name: 'Wide',
    fields,
    view: { id: 'viw00000000000001', name: 'Grid' },
  };
  expect(TableCreate.safeParse(table).success).toBe(true);
  expect(SchemaTableCreate.safeParse({ name: table.name, fields }).success).toBe(true);
  const command = { id: 'cmd00000000000001', groupId: 'act00000000000001', kind: 'table.create', table };
  expect(Command.safeParse(command).success).toBe(true);
  expect(Command.safeParse({ ...command, table: { ...table, fields: [...fields, fields[0]] } }).success).toBe(
    false,
  );
  expect(SchemaTableCreate.safeParse({ name: table.name, fields: [...fields, fields[0]] }).success).toBe(
    false,
  );
});

describe('field specs', () => {
  it('fill in defaults for options left out', () => {
    expect(FieldSpec.parse({ type: 'number' })).toEqual({
      type: 'number',
      options: { precision: null, thousands: true, allowNegative: true },
    });
    expect(FieldSpec.parse({ type: 'date', options: { includeTime: true } }).options).toMatchObject({
      includeTime: true,
      timeZone: 'client',
    });
  });

  it('refuse unknown time zones and duplicate choices', () => {
    expect(FieldSpec.safeParse({ type: 'date', options: { timeZone: 'Mars/Olympus' } }).success).toBe(false);
    const choice = { id: 'cho00000000000001', name: 'A', color: 'red' };
    expect(
      FieldSpec.safeParse({ type: 'singleSelect', options: { choices: [choice, choice] } }).success,
    ).toBe(false);
  });
});

describe('checkCellValue', () => {
  const choices = [
    { id: 'cho00000000000001', name: 'Todo', color: 'gray' },
    { id: 'cho00000000000002', name: 'Done', color: 'green' },
  ];

  it('stores empty as null and keeps single-line text on one line', () => {
    const text = meta({ type: 'text' });
    expect(checkCellValue(text, '')).toEqual({ ok: true, value: null });
    expect(checkCellValue(text, 'a\r\nb')).toEqual({ ok: true, value: 'a b' });
    expect(checkCellValue(meta({ type: 'longText' }), 'a\r\nb')).toEqual({ ok: true, value: 'a\nb' });
  });

  it('checks numbers, dates, and choices', () => {
    expect(checkCellValue(meta({ type: 'number', options: { allowNegative: false } }), -1).ok).toBe(false);
    expect(checkCellValue(meta({ type: 'number' }), Number.NaN).ok).toBe(false);
    expect(checkCellValue(meta({ type: 'date' }), '2026-02-30').ok).toBe(false);
    expect(checkCellValue(meta({ type: 'date' }), '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(
      checkCellValue(meta({ type: 'date', options: { includeTime: true } }), '2026-09-27T10:00-07:00'),
    ).toEqual({ ok: true, value: '2026-09-27T17:00:00.000Z' });
    const multi = meta({ type: 'multipleSelect', options: { choices } });
    expect(checkCellValue(multi, ['cho00000000000002', 'cho00000000000002'])).toEqual({
      ok: true,
      value: ['cho00000000000002'],
    });
    expect(checkCellValue(multi, [])).toEqual({ ok: true, value: null });
    expect(checkCellValue(multi, ['cho0000000000000X']).ok).toBe(false);
  });

  it('refuses writes to computed fields', () => {
    expect(checkCellValue(meta({ type: 'createdTime' }), '2026-09-27T00:00:00Z')).toEqual({
      ok: false,
      messageKey: 'data.value.computed',
    });
  });

  it('treats the kinds of empty as the same value', () => {
    expect(sameValue(null, [])).toBe(true);
    expect(sameValue(false, null)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
  });
});

describe('filters', () => {
  it('ignore conditions still missing a value and reject operators the field lacks', () => {
    const num = meta({ type: 'number' });
    expect(checkCondition(num, { id: 'a', fieldId: num.id, operator: 'gt' })).toEqual({
      valid: true,
      usable: false,
    });
    expect(checkCondition(num, { id: 'a', fieldId: num.id, operator: 'gt', value: 3 })).toEqual({
      valid: true,
      usable: true,
    });
    expect(checkCondition(num, { id: 'a', fieldId: num.id, operator: 'contains', value: 'x' }).valid).toBe(
      false,
    );
  });

  it('limit nesting to three levels', () => {
    const leaf = { id: 'a', fieldId: 'fld00000000000001', operator: 'isEmpty' };
    const nest = (levels: number): unknown =>
      levels === 1
        ? { conjunction: 'and', conditions: [leaf] }
        : { conjunction: 'or', conditions: [nest(levels - 1)] };
    expect(FilterGroup.safeParse(nest(3)).success).toBe(true);
    expect(FilterGroup.safeParse(nest(4)).success).toBe(false);
  });
});

describe('views', () => {
  it('put the primary field first, then the saved order, then new fields, without hidden ones', () => {
    const fields = [
      { id: 'p', position: 1 },
      { id: 'a', position: 2 },
      { id: 'b', position: 3 },
      { id: 'c', position: 4 },
    ];
    const config = GridConfig.parse({});
    expect(
      visibleFieldIds({ ...config, fieldOrder: ['c', 'p', 'a'], hiddenFieldIds: ['a', 'p'] }, fields, 'p'),
    ).toEqual(['p', 'c', 'b']);
  });
});

describe('commands', () => {
  it('parse a record update and refuse an oversized one', () => {
    const cmd = {
      id: 'cmd00000000000001',
      groupId: 'act00000000000001',
      kind: 'record.update',
      tableId: 'tbl00000000000001',
      records: [{ id: 'rec00000000000001', values: { fld00000000000001: 'x' } }],
    };
    expect(Command.parse(cmd).kind).toBe('record.update');
    const big = { ...cmd, records: Array.from({ length: 1001 }, () => cmd.records[0]) };
    expect(Command.safeParse(big).success).toBe(false);
  });
});

it('gives each person the same presence color everywhere', () => {
  expect(presenceColor('usr00000000000001')).toBe(presenceColor('usr00000000000001'));
  expect(presenceColor('usr00000000000001')).not.toBe('gray');
});

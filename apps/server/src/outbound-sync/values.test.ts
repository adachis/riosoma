import { describe, expect, it } from 'vitest';
import { FIELD_TYPES, SYNC_OUT_VALUE_KINDS, type FieldType } from '@riosoma/contracts';
import type { FormatContext } from '../data/format.js';
import type { StoredField } from '../data/types.js';
import {
  buildColumnPlans,
  cellForField as cell,
  columnSignature,
  hashRow,
  planForField,
  valueKind,
} from './values.js';

/**
 * A plan and a cell for every field type, so a type can't be forgotten, and a stable hash that
 * changes only when a value or the mapping changes.
 */

function optionsFor(type: FieldType): Record<string, unknown> {
  switch (type) {
    case 'number':
    case 'percent':
      return { precision: 2 };
    case 'currency':
    case 'multiCurrency':
      return { code: 'USD', precision: 2 };
    case 'duration':
      return { format: 'h:mm' };
    case 'rating':
      return { max: 5, icon: 'star', color: 'yellow' };
    case 'singleSelect':
    case 'multipleSelect':
      return { choices: [{ id: 'cho00000000001', name: 'Open', color: 'green' }] };
    case 'date':
    case 'time':
      return { includeTime: false };
    case 'createdTime':
    case 'lastModifiedTime':
      return { includeTime: true };
    case 'longText':
      return { richText: false };
    case 'formula':
      return { expression: '1', resultType: 'text' };
    case 'rollup':
      return {
        fn: 'sum',
        resultType: 'number',
        linkFieldId: 'fld00000000001',
        targetFieldId: 'fld00000000002',
      };
    case 'count':
      return { linkFieldId: 'fld00000000003' };
    case 'button':
      return { label: 'Open', action: { kind: 'openUrl', urlTemplate: 'https://example.test' } };
    default:
      return {};
  }
}

function makeField(type: FieldType, overrides: Partial<StoredField> = {}): StoredField {
  return {
    id: 'fld00000000099',
    tableId: 't1',
    name: `A ${type} field`,
    description: '',
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    type,
    options: optionsFor(type),
    columnName: 'c_field',
    ...overrides,
  } as StoredField;
}

const ctx: FormatContext = {
  locale: 'en-US',
  timeZone: 'UTC',
  people: new Map(),
  files: new Map(),
  linked: new Map(),
};

describe('values', () => {
  it('maps every field type to a known value kind, with a plan', () => {
    const kinds = new Set<string>(SYNC_OUT_VALUE_KINDS);
    expect(FIELD_TYPES).toHaveLength(37);
    for (const type of FIELD_TYPES) {
      const field = makeField(type);
      const kind = valueKind(field);
      expect(kinds.has(kind), `${type} -> ${kind}`).toBe(true);
      const plan = planForField(field, { timeZone: 'UTC', locale: 'en-US' });
      expect(plan.kind).toBe(kind);
      expect(plan.name).toBe(field.name);
    }
  });

  it('carries the typed part a cell’s kind calls for', () => {
    const number = cell(makeField('number'), row({ fld00000000099: 42 }), map(makeField('number')), ctx);
    expect(number.number).toBe(42);
    const check = cell(makeField('checkbox'), row({ fld00000000099: true }), map(makeField('checkbox')), ctx);
    expect(check.boolean).toBe(true);
    const text = cell(makeField('text'), row({ fld00000000099: 'hello' }), map(makeField('text')), ctx);
    expect(text).toEqual({ text: 'hello' });
  });

  it('keeps a date without a time on its own day in every time zone', () => {
    const west = { ...ctx, timeZone: 'America/Los_Angeles' };
    for (const stored of ['2025-11-08', '2025-11-08T00:00:00.000Z']) {
      const day = cell(makeField('date'), row({ fld00000000099: stored }), map(makeField('date')), west);
      expect(day.date).toBe('2025-11-08');
    }
  });

  it('hashes the same values the same, and differently when a value or the mapping changes', () => {
    const cells = [{ text: 'a', number: 1 }, { text: 'b' }];
    const signature = columnSignature(
      [{ fieldId: 'f1', columnId: 'c1', columnType: 'singleLineText', write: 'typed', sent: true }],
      'key1',
    );
    expect(hashRow(signature, cells)).toBe(hashRow(signature, cells));
    expect(hashRow(signature, cells)).not.toBe(hashRow(signature, [{ text: 'a', number: 2 }, { text: 'b' }]));
    const other = columnSignature(
      [{ fieldId: 'f1', columnId: 'c2', columnType: 'singleLineText', write: 'typed', sent: true }],
      'key1',
    );
    expect(hashRow(signature, cells)).not.toBe(hashRow(other, cells));
    // The key column is part of the signature, so replacing it sends every row once.
    const movedKey = columnSignature(
      [{ fieldId: 'f1', columnId: 'c1', columnType: 'singleLineText', write: 'typed', sent: true }],
      'key2',
    );
    expect(hashRow(signature, cells)).not.toBe(hashRow(movedKey, cells));
  });

  it('makes the primary field’s plan primary, and falls back to the key column', () => {
    const name = makeField('text', { id: 'fldName', name: 'Name' });
    const amount = makeField('number', { id: 'fldAmount', name: 'Amount' });
    const withPrimary = buildColumnPlans([amount, name], 'fldName', { timeZone: 'UTC', locale: 'en-US' });
    expect(withPrimary.plans[0]!.fieldId).toBe('fldName');
    expect(withPrimary.plans[0]!.primary).toBe(true);
    expect(withPrimary.keyPlan.primary).toBe(false);

    // When the primary field isn't sent, the key column becomes the primary.
    const withoutPrimary = buildColumnPlans([amount], 'fldName', { timeZone: 'UTC', locale: 'en-US' });
    expect(withoutPrimary.plans.some((plan) => plan.primary)).toBe(false);
    expect(withoutPrimary.keyPlan.primary).toBe(true);
  });
});

function row(values: Record<string, unknown>) {
  return {
    id: 'rec00000000001',
    values,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: null,
  } as unknown as Parameters<typeof cell>[1];
}

function map(field: StoredField) {
  return new Map([[field.id, field]]);
}

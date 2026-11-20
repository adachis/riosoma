import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import { FieldMeta, type FieldType } from '@riosoma/contracts';
import { directionFamily, directionLabels } from './messages';

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

function field(type: FieldType, options: Record<string, unknown> = {}): FieldMeta {
  return FieldMeta.parse({
    id: 'fld00000000000000',
    tableId: 'tbl00000000000000',
    name: 'Field',
    type,
    position: 0,
    description: '',
    createdAt: '',
    updatedAt: '',
    options,
  });
}

/** The two direction labels a field shows, as a person reads them. */
function labels(meta: FieldMeta): [string, string] {
  const [asc, desc] = directionLabels[directionFamily(meta)];
  return [i18n._(asc), i18n._(desc)];
}

const link = { linkFieldId: 'fld00000000000001', targetFieldId: 'fld00000000000002' };

describe('sort direction labels by field type', () => {
  it('reads every numeric field as 1 → 9, not A → Z', () => {
    for (const type of ['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber'] as const)
      expect(labels(field(type))).toEqual(['1 → 9', '9 → 1']);
    expect(labels(field('count', { linkFieldId: link.linkFieldId }))).toEqual(['1 → 9', '9 → 1']);
  });

  it('reads dates as oldest or newest first', () => {
    for (const type of ['date', 'createdTime', 'lastModifiedTime', 'dateRange'] as const)
      expect(labels(field(type))).toEqual(['Oldest first', 'Newest first']);
  });

  it('reads checkboxes as unchecked or checked first', () => {
    expect(labels(field('checkbox'))).toEqual(['Unchecked first', 'Checked first']);
  });

  it('reads selects in their option order', () => {
    const choices = { choices: [{ id: 'cho00000000000001', name: 'Open', color: 'blue' }] };
    expect(labels(field('singleSelect', choices))).toEqual(['First → last', 'Last → first']);
    expect(labels(field('multipleSelect', choices))).toEqual(['First → last', 'Last → first']);
  });

  it('reads text and other fields as A → Z', () => {
    for (const type of ['text', 'longText', 'user', 'email', 'phone', 'url'] as const)
      expect(labels(field(type))).toEqual(['A → Z', 'Z → A']);
    expect(labels(field('link', { linkedTableId: 'tbl00000000000002' }))).toEqual(['A → Z', 'Z → A']);
  });

  it('follows the result type of formulas, lookups, and rollups', () => {
    expect(labels(field('formula', { expression: '1', resultType: 'number' }))).toEqual(['1 → 9', '9 → 1']);
    expect(labels(field('formula', { expression: '1', resultType: 'date' }))).toEqual([
      'Oldest first',
      'Newest first',
    ]);
    expect(labels(field('formula', { expression: '1', resultType: 'boolean' }))).toEqual([
      'Unchecked first',
      'Checked first',
    ]);
    expect(labels(field('formula', { expression: '1', resultType: 'text' }))).toEqual(['A → Z', 'Z → A']);
    expect(labels(field('lookup', { ...link, resultType: 'number' }))).toEqual(['1 → 9', '9 → 1']);
    expect(labels(field('rollup', { ...link, resultType: 'date' }))).toEqual([
      'Oldest first',
      'Newest first',
    ]);
  });
});

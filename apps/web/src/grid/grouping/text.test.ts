import { expect, it } from 'vitest';
import { FieldMeta } from '@riosoma/contracts';
import { i18n } from '../../i18n';
import { groupValueText } from './text';

it('names false and numeric values and keeps date buckets on their calendar day', () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const field = FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Value',
    description: '',
    type: 'checkbox',
    position: 0,
    createdAt: '',
    updatedAt: '',
  });
  const format = { locale: 'en-US', timeZone: 'America/Los_Angeles', collaborators: new Map() };
  const t = i18n._.bind(i18n);
  expect(groupValueText(field, false, format, t)).toBe('Unchecked');
  const lookup = FieldMeta.parse({
    ...field,
    id: 'fld00000000000002',
    type: 'lookup',
    options: { linkFieldId: 'fld00000000000003', targetFieldId: field.id, resultType: 'boolean' },
  });
  expect(
    groupValueText(lookup, [false, true], { ...format, fieldsById: new Map([[field.id, field]]) }, t),
  ).toBe('Unchecked, Checked');
  expect(groupValueText(field, null, format, t)).toBe('(Empty)');
  expect(groupValueText(FieldMeta.parse({ ...field, type: 'number', options: {} }), 12.5, format, t)).toBe(
    '12.5',
  );
  const date = FieldMeta.parse({ ...field, type: 'date', options: { includeTime: true, dateFormat: 'iso' } });
  expect(groupValueText(date, '2026-09-28', format, t)).toBe('2026-09-28');
});

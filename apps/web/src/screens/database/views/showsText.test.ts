import { FieldMeta, type CellValue } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { showsText } from './showsText';

const field = (spec: unknown, id = 'fld00000000000001'): FieldMeta =>
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

const drawn = {
  signedAt: '2026-09-27T15:05:00.000Z',
  signedBy: null,
  name: 'Ada',
  drawing: { path: 'M0 0L10 10', width: 100, height: 50 },
};

describe('showsText', () => {
  it('reads a checkbox as a mark, checked or not', () => {
    const checkbox = field({ type: 'checkbox' });
    for (const value of [true, false, null]) expect(showsText(checkbox, value)).toBe(false);
  });

  it('reads a signature as a mark, drawn or typed, and an empty one as text', () => {
    const signature = field({ type: 'signature' });
    expect(showsText(signature, drawn)).toBe(false);
    expect(showsText(signature, { ...drawn, drawing: null })).toBe(false);
    expect(showsText(signature, null)).toBe(true);
  });

  it('reads every branch that shows its words as text', () => {
    const cases: Array<[Record<string, unknown>, CellValue]> = [
      [{ type: 'text' }, 'Alpha'],
      [{ type: 'longText', options: { richText: false } }, 'Alpha'],
      [{ type: 'number' }, 42],
      [{ type: 'date' }, '2026-09-27'],
      [
        {
          type: 'singleSelect',
          options: { choices: [{ id: 'cho00000000000001', name: 'Ready', color: 'blue' }] },
        },
        'cho00000000000001',
      ],
      [
        {
          type: 'multipleSelect',
          options: { choices: [{ id: 'cho00000000000001', name: 'Ready', color: 'blue' }] },
        },
        ['cho00000000000001'],
      ],
      [{ type: 'button' }, null],
      [{ type: 'user' }, 'usr00000000000001'],
      [{ type: 'attachment' }, ['att00000000000001']],
      [{ type: 'rating' }, 3],
    ];
    for (const [spec, value] of cases) expect(showsText(field(spec), value)).toBe(true);
  });

  it('follows the field CardValue renders, not the type a lookup or formula points at', () => {
    const target = 'fld00000000000002';
    const lookup = field({
      type: 'lookup',
      options: { linkFieldId: 'fld00000000000003', targetFieldId: target },
    });
    expect(showsText(lookup, true)).toBe(true);
    const formula = field({ type: 'formula', options: { expression: '1', resultType: 'boolean' } });
    expect(showsText(formula, true)).toBe(true);
  });
});

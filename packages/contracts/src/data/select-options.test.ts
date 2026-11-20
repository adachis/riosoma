import { describe, expect, it } from 'vitest';
import { ChoiceId, FieldOptions, choicesForRecord, newId, sourceChoiceId } from '../index.js';

describe('select option contracts', () => {
  it('keeps fixed choices and combines multiple parent mappings without duplicates', () => {
    const parent = newId('field');
    const left = newId('choice');
    const right = newId('choice');
    const first = { id: newId('choice'), name: 'First', color: 'blue' };
    const second = { id: newId('choice'), name: 'Second', color: 'green' };
    const fixed = FieldOptions.singleSelect.parse({ choices: [first, second] });
    expect(choicesForRecord(fixed, {})).toEqual([first, second]);
    const options = FieldOptions.multipleSelect.parse({
      ...fixed,
      cascade: { fieldId: parent, mapping: { [left]: [first.id], [right]: [first.id, second.id] } },
    });
    expect(choicesForRecord(options, {})).toEqual([]);
    expect(choicesForRecord(options, { [parent]: left })).toEqual([first]);
    expect(choicesForRecord(options, { [parent]: [right, left] })).toEqual([first, second]);
    expect(choicesForRecord(options, { [parent]: newId('choice') })).toEqual([]);
  });

  it('keeps source record identity in valid opaque choice IDs', async () => {
    const record = newId('record');
    expect(ChoiceId.safeParse(await sourceChoiceId(record)).success).toBe(true);
    expect(await sourceChoiceId(record)).toBe(await sourceChoiceId(record));
    expect(await sourceChoiceId(record)).not.toContain(record.slice(3));
    expect(await sourceChoiceId(newId('record'))).not.toBe(await sourceChoiceId(record));
  });

  it('bounds the total number of mapped choices', () => {
    const ids = Array.from({ length: 101 }, () => newId('choice'));
    const mapping = Object.fromEntries(ids.map((id) => [id, ids]));
    expect(
      FieldOptions.singleSelect.safeParse({ cascade: { fieldId: newId('field'), mapping } }).success,
    ).toBe(false);
  });

  it('checks references and preserves optional source filters', () => {
    const source = {
      tableId: newId('table'),
      fieldId: newId('field'),
      filter: { conjunction: 'and', conditions: [] },
    };
    expect(FieldOptions.singleSelect.parse({ source })).toEqual({ choices: [], source });
    expect(
      FieldOptions.singleSelect.safeParse({ cascade: { fieldId: 'missing', mapping: {} } }).success,
    ).toBe(false);
    expect(FieldOptions.multipleSelect.safeParse({ source: { tableId: 'missing' } }).success).toBe(false);
  });
});

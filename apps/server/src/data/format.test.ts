import { describe, expect, it } from 'vitest';
import { FieldSpec, newId, type ChangeLogEntry } from '@riosoma/contracts';
import { formatValue, type FormatContext } from './format.js';
import type { StoredField } from './types.js';

describe('change log text', () => {
  it('uses collaborator names, visible field names, and the export time zone', () => {
    const actor = newId('user');
    const name = newId('field');
    const amount = newId('field');
    const hidden = newId('field');
    const field = { ...FieldSpec.parse({ type: 'changeLog' }), id: newId('field') } as StoredField;
    const entry: ChangeLogEntry = {
      at: '2026-01-15T20:30:00.000Z',
      actorId: actor,
      fieldIds: [name, amount, hidden],
    };
    const context: FormatContext = {
      locale: 'en-US',
      timeZone: 'America/New_York',
      people: new Map([[actor, { id: actor, name: 'River', email: '' }]]),
      fields: new Map([
        [name, { name: 'Name' }],
        [amount, { name: 'Amount' }],
      ]),
      files: new Map(),
      linked: new Map(),
    };
    expect(formatValue(field, [entry], context)).toBe('1/15/26, 3:30 PM River: Name and Amount');
    expect(formatValue(field, [entry], { ...context, locale: 'de', timeZone: 'UTC' })).toBe(
      '15.01.26, 20:30 River: Name und Amount',
    );
    expect(formatValue(field, [{ ...entry, actorId: newId('user') }], context)).toBe(
      '1/15/26, 3:30 PM Unknown person: Name and Amount',
    );
    expect(formatValue(field, [{ ...entry, fieldIds: [hidden] }], context)).toBe('');
  });

  it('marks deactivated people in export labels without changing stored names or values', () => {
    const person = { id: newId('user'), name: 'River', email: '', deactivated: true };
    const fieldId = newId('field');
    const context: FormatContext = {
      locale: 'en-US',
      timeZone: 'UTC',
      people: new Map([[person.id, person]]),
      fields: new Map([[fieldId, { name: 'Name' }]]),
      files: new Map(),
      linked: new Map(),
    };
    const userField = { ...FieldSpec.parse({ type: 'user' }), id: newId('field') } as StoredField;
    const value = [person.id];
    expect(formatValue(userField, value, context)).toBe('River (deactivated)');
    const history = { ...FieldSpec.parse({ type: 'changeLog' }), id: newId('field') } as StoredField;
    expect(
      formatValue(
        history,
        [{ at: '2026-01-15T20:30:00.000Z', actorId: person.id, fieldIds: [fieldId] }],
        context,
      ),
    ).toContain('River (deactivated): Name');
    expect(person.name).toBe('River');
    expect(value).toEqual([person.id]);
  });
});

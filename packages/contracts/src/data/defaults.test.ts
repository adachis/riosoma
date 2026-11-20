import { describe, expect, it } from 'vitest';
import { defaultCellValue, defaultIssue, defaultKinds, keptDefault, normalizedDefault } from './defaults.js';
import { FieldSpec, newId } from '../index.js';

const choice = (name: string) => ({ id: newId('choice'), name, color: 'blue' as const });
const now = new Date('2026-10-01T03:30:00.000Z');
const context = { now, userId: newId('user'), timeZone: 'America/Los_Angeles' };

describe('field defaults', () => {
  it('offers the kinds each type takes', () => {
    expect(defaultKinds('date')).toEqual(['value', 'today', 'now']);
    expect(defaultKinds('singleSelect')).toEqual(['value', 'firstChoice']);
    expect(defaultKinds('user')).toEqual(['creator']);
    expect(defaultKinds('formula')).toEqual([]);
    expect(defaultKinds('longText')).toEqual([]);
  });

  it('keeps a default in the field options and refuses one of the wrong shape', () => {
    const text = FieldSpec.parse({
      type: 'text',
      options: { defaultValue: { kind: 'value', value: 'New' } },
    });
    expect(text.options).toMatchObject({ defaultValue: { kind: 'value', value: 'New' } });
    expect(
      FieldSpec.safeParse({ type: 'number', options: { defaultValue: { kind: 'value', value: 'one' } } })
        .success,
    ).toBe(false);
    expect(FieldSpec.safeParse({ type: 'user', options: { defaultValue: { kind: 'today' } } }).success).toBe(
      false,
    );
    // Types without defaults leave the key out.
    expect(
      FieldSpec.parse({ type: 'longText', options: { defaultValue: { kind: 'value', value: 'x' } } }).options,
    ).not.toHaveProperty('defaultValue');
  });

  it('finds defaults that do not fit their field', () => {
    const fits = (spec: unknown) => defaultIssue(FieldSpec.parse(spec));
    expect(
      fits({ type: 'rating', options: { max: 5, defaultValue: { kind: 'value', value: 4 } } }),
    ).toBeNull();
    expect(fits({ type: 'rating', options: { max: 3, defaultValue: { kind: 'value', value: 4 } } })).toBe(
      'data.field.defaultInvalid',
    );
    expect(
      fits({ type: 'number', options: { allowNegative: false, defaultValue: { kind: 'value', value: -1 } } }),
    ).toBe('data.field.defaultInvalid');
    expect(
      fits({
        type: 'number',
        options: { validation: { max: { value: 10 } }, defaultValue: { kind: 'value', value: 11 } },
      }),
    ).toBe('data.field.defaultInvalid');
    expect(fits({ type: 'email', options: { defaultValue: { kind: 'value', value: 'nobody' } } })).toBe(
      'data.field.defaultInvalid',
    );
    expect(
      fits({ type: 'text', options: { unique: true, defaultValue: { kind: 'value', value: 'a' } } }),
    ).toBe('data.field.defaultUnique');
    expect(fits({ type: 'singleSelect', options: { defaultValue: { kind: 'firstChoice' } } })).toBe(
      'data.field.defaultInvalid',
    );
    const kept = choice('Kept');
    expect(
      fits({
        type: 'singleSelect',
        options: { choices: [kept], defaultValue: { kind: 'value', value: kept.id } },
      }),
    ).toBeNull();
    expect(
      fits({
        type: 'singleSelect',
        options: { choices: [kept], defaultValue: { kind: 'value', value: [kept.id] } },
      }),
    ).toBe('data.field.defaultInvalid');
    expect(
      fits({
        type: 'multipleSelect',
        options: { choices: [kept], defaultValue: { kind: 'value', value: [newId('choice')] } },
      }),
    ).toBe('data.field.defaultInvalid');
    expect(
      fits({
        type: 'date',
        options: { includeTime: false, defaultValue: { kind: 'value', value: '2026-13-01' } },
      }),
    ).toBe('data.field.defaultInvalid');
  });

  it('stores a fixed default the way the field stores values', () => {
    const date = FieldSpec.parse({
      type: 'date',
      options: { includeTime: true, defaultValue: { kind: 'value', value: '2026-10-01T09:00:00-07:00' } },
    });
    expect(normalizedDefault(date).options).toMatchObject({
      defaultValue: { kind: 'value', value: '2026-10-01T16:00:00.000Z' },
    });
  });

  it('gives each kind of default its value when a record is made', () => {
    const value = (spec: unknown, extra = {}) =>
      defaultCellValue(FieldSpec.parse(spec), { ...context, ...extra });
    expect(value({ type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } })).toBe(true);
    expect(value({ type: 'currency', options: { defaultValue: { kind: 'value', value: 12.5 } } })).toBe(12.5);
    // A day follows the person's time zone, where it is still September 30.
    expect(value({ type: 'date', options: { defaultValue: { kind: 'today' } } })).toBe('2026-09-30');
    expect(
      value({ type: 'date', options: { defaultValue: { kind: 'today' } } }, { timeZone: undefined }),
    ).toBe('2026-10-01');
    expect(
      value({ type: 'date', options: { timeZone: 'Asia/Tokyo', defaultValue: { kind: 'today' } } }),
    ).toBe('2026-10-01');
    expect(value({ type: 'date', options: { includeTime: true, defaultValue: { kind: 'now' } } })).toBe(
      now.toISOString(),
    );
    expect(value({ type: 'user', options: { defaultValue: { kind: 'creator' } } })).toEqual([context.userId]);
    expect(value({ type: 'user', options: { defaultValue: { kind: 'creator' } } }, { userId: null })).toBe(
      undefined,
    );
    const first = choice('First');
    expect(
      value({
        type: 'singleSelect',
        options: { choices: [first, choice('Second')], defaultValue: { kind: 'firstChoice' } },
      }),
    ).toBe(first.id);
    expect(value({ type: 'text', options: {} })).toBe(undefined);
  });

  it('drops removed choices and defaults a change no longer fits', () => {
    const [a, b] = [choice('A'), choice('B')];
    const multi = FieldSpec.parse({ type: 'multipleSelect', options: { choices: [b] } });
    expect(keptDefault(multi, { kind: 'value', value: [a.id, b.id] }).options).toMatchObject({
      defaultValue: { kind: 'value', value: [b.id] },
    });
    expect(keptDefault(multi, { kind: 'value', value: [a.id] }).options).not.toHaveProperty('defaultValue');
    const single = FieldSpec.parse({ type: 'singleSelect', options: { choices: [a, b] } });
    expect(keptDefault(single, { kind: 'value', value: [a.id] }).options).toMatchObject({
      defaultValue: { kind: 'value', value: a.id },
    });
    const number = FieldSpec.parse({ type: 'number', options: {} });
    expect(keptDefault(number, { kind: 'value', value: 'text' }).options).not.toHaveProperty('defaultValue');
    const currency = FieldSpec.parse({ type: 'currency', options: {} });
    expect(keptDefault(currency, { kind: 'value', value: 5 }).options).toMatchObject({
      defaultValue: { kind: 'value', value: 5 },
    });
    const day = FieldSpec.parse({ type: 'date', options: { includeTime: true } });
    expect(keptDefault(day, { kind: 'value', value: '2026-10-01' }).options).not.toHaveProperty(
      'defaultValue',
    );
    expect(keptDefault(day, { kind: 'today' }).options).toMatchObject({ defaultValue: { kind: 'today' } });
  });
});

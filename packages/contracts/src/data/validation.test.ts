import { describe, expect, it } from 'vitest';
import { FieldSpec } from './fields.js';
import { parsePattern, validPattern } from './patterns.js';
import { validateFieldValue } from './validation.js';

describe('field validation', () => {
  it.each([
    '(a+)+$',
    '(a*)*',
    '(a?){2}',
    '(ab{2})+',
    '(a)\\1',
    '(?=a)',
    '(?!a)',
    '(?<=a)',
    '(?<!a)',
    '[a-z',
    'a{999999}',
  ])('refuses unsafe or unsupported pattern %s', (pattern) => {
    expect(validPattern(pattern)).toBe(false);
    expect(
      FieldSpec.safeParse({ type: 'text', options: { validation: { pattern: { kind: 'custom', pattern } } } })
        .success,
    ).toBe(false);
  });
  it('matches ambiguous alternatives and adjacent repetitions with bounded state work', () => {
    expect(parsePattern('^(a|aa)+$')('a'.repeat(9999) + '!')).toBe(false);
    expect(parsePattern('^a*a*a*b$')('a'.repeat(9999) + '!')).toBe(false);
    expect(parsePattern('^[A-Z]{2}[0-9]+$')('AB123')).toBe(true);
    expect(parsePattern('^[A-Z]{2}[0-9]+$')('AB123!')).toBe(false);
    expect(parsePattern('a+')('a'.repeat(10_001))).toBe(false);
  });
  it.each(['number', 'currency', 'percent', 'duration'] as const)(
    'checks inclusive %s bounds and required zero',
    (type) => {
      const field = FieldSpec.parse({
        type,
        options: { validation: { required: {}, min: { value: 0 }, max: { value: 5 } } },
      });
      expect(validateFieldValue(field, null)?.messageKey).toBe('data.validation.required');
      expect(validateFieldValue(field, 0)).toBeNull();
      expect(validateFieldValue(field, 5)).toBeNull();
      expect(validateFieldValue(field, -1)?.messageKey).toBe('data.validation.min');
      expect(validateFieldValue(field, 6)?.messageKey).toBe('data.validation.max');
    },
  );
  it('compares dates as instants, counts text characters, and keeps custom messages', () => {
    const date = FieldSpec.parse({ type: 'date', options: { validation: { min: { value: '2026-01-01' } } } });
    expect(validateFieldValue(date, '2025-12-31')?.messageKey).toBe('data.validation.min');
    const text = FieldSpec.parse({
      type: 'text',
      options: {
        validation: { minLength: { value: 3, message: 'Use three letters' }, maxLength: { value: 5 } },
      },
    });
    expect(validateFieldValue(text, 'AB')).toMatchObject({ message: 'Use three letters' });
    expect(validateFieldValue(text, 'ABC')).toBeNull();
    expect(validateFieldValue(text, 'ABCDEF')?.messageKey).toBe('data.validation.maxLength');
  });
  it.each([
    ['email', `person@${['example', 'test'].join('.')}`, 'bad'],
    ['url', `https://${['example', 'test'].join('.')}`, 'bad'],
    ['phone', '+1 (555) 123-4567', 'letters'],
    ['postalCode', '12345-6789', '!'],
    ['digits', '123', '1a'],
    ['letters', 'Abc', '123'],
  ])('checks the %s preset', (preset, accepted, refused) => {
    const field = FieldSpec.parse({
      type: 'text',
      options: { validation: { pattern: { kind: 'preset', preset } } },
    });
    expect(validateFieldValue(field, accepted)).toBeNull();
    expect(validateFieldValue(field, refused)?.messageKey).toBe('data.validation.pattern');
    expect(validateFieldValue(field, 'x'.repeat(10_001))?.messageKey).toBe('data.validation.patternLength');
  });
});

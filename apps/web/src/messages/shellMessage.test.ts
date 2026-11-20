import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import { FORMULA_MESSAGES } from './formula';
import { SERVER_MESSAGES } from './server';
import { messageDescriptor } from './descriptors';
import { serverMessage } from './shellMessage';

describe('shell message compatibility', () => {
  it('registers every formula and server descriptor when the feature messages load', () => {
    for (const [key, descriptor] of Object.entries({ ...SERVER_MESSAGES, ...FORMULA_MESSAGES })) {
      expect(messageDescriptor(key), key).toEqual(descriptor);
    }
  });

  it.each([
    ['formula.function.unknown', 'formula.function.unavailable'],
    ['formula.function.arity', 'formula.function.arguments'],
  ])('uses a complete explanation for %s when a stored cell has no function name', (key, fallback) => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const cases: Array<Parameters<typeof serverMessage>[2]> = [undefined, {}, { name: false }, { name: 4 }];
    for (const params of cases) {
      expect(serverMessage(i18n, key, params)).toBe(serverMessage(i18n, fallback));
    }
    expect(serverMessage(i18n, key, { name: 'TOTAL' })).toContain('TOTAL');
  });

  it.each([
    ['sources.sync.columnMissing', 'column', 'A column used by this table is missing from the source.'],
    [
      'sources.sync.objectMissing',
      'object',
      'The table or view used by this table is missing from the source.',
    ],
    ['sources.sync.keyDuplicate', 'key', 'Some rows share a key.  Choose key columns that are unique.'],
  ])('explains %s when stored history has no parameters', (key, name, explanation) => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    for (const params of [undefined, {}, { [name]: false }, { [name]: 4 }]) {
      expect(serverMessage(i18n, key, params)).toBe(explanation);
    }
    expect(serverMessage(i18n, key, { [name]: '名前🚢' })).toContain('名前🚢');
  });
});

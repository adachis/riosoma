import { AppError, type FilterGroup } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { StoredField } from '../data/types.js';
import { resolveChoices } from './reads.js';

const tier = {
  id: 'fldTier00000000000',
  name: 'Tier',
  type: 'singleSelect',
  options: {
    choices: [
      { id: 'choFree0000000000', name: 'free', color: 'gray' },
      { id: 'choEnterprise0000', name: 'Enterprise', color: 'blue' },
    ],
  },
} as unknown as StoredField;
const fields = new Map([[tier.id, tier]]);
const where = (value: unknown, operator = 'is'): FilterGroup => ({
  conjunction: 'and',
  conditions: [{ id: 'c', fieldId: tier.id, operator: operator as 'is', value }],
});

describe('choice names in filters', () => {
  it('turns a choice name into its ID, ignoring case and spaces', () => {
    const resolved = resolveChoices(where(' enterprise '), fields);
    expect(resolved?.conditions[0]).toMatchObject({ value: 'choEnterprise0000' });
  });

  it('leaves choice IDs and lists of either as they are, resolving names in lists', () => {
    expect(resolveChoices(where('choFree0000000000'), fields)?.conditions[0]).toMatchObject({
      value: 'choFree0000000000',
    });
    expect(
      resolveChoices(where(['Free', 'choEnterprise0000'], 'isAnyOf'), fields)?.conditions[0],
    ).toMatchObject({
      value: ['choFree0000000000', 'choEnterprise0000'],
    });
  });

  it('refuses a value that names no choice, instead of widening the read', () => {
    try {
      resolveChoices(where('platinum'), fields);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).messageKey).toBe('api.filter.unknownChoice');
      expect((error as AppError).params).toMatchObject({
        field: 'Tier',
        value: 'platinum',
        choices: 'free, Enterprise',
      });
    }
  });

  it('works through nested groups', () => {
    const nested: FilterGroup = { conjunction: 'or', conditions: [where('Enterprise')] };
    const resolved = resolveChoices(nested, fields) as { conditions: FilterGroup[] };
    expect(resolved.conditions[0]!.conditions[0]).toMatchObject({ value: 'choEnterprise0000' });
  });
});

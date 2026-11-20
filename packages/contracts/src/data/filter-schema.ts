import { z } from 'zod';
import type { FilterCondition, FilterGroup } from './filters.js';

export const OPERATORS = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'isBefore',
  'isAfter',
  'isOnOrBefore',
  'isOnOrAfter',
  'isWithin',
  'overlaps',
  'containsDate',
  'isAnyOf',
  'isNoneOf',
  'hasAnyOf',
  'hasAllOf',
  'hasNoneOf',
  'isExactly',
  'isEmpty',
  'isNotEmpty',
] as const;
export const Operator = z.enum(OPERATORS);
export type Operator = z.infer<typeof Operator>;

export function isGroup(c: FilterCondition | FilterGroup): c is FilterGroup {
  return 'conjunction' in c;
}
export function createFilterGroup(
  fieldId: z.ZodString,
  limits: { filterConditions: number; filterDepth: number },
  allowCurrent = false,
) {
  const condition = z.object({
    /** Stable key for editing the list.  Any short string works. */
    id: z.string().min(1).max(32),
    fieldId,
    operator: Operator,
    /** Left out until the person picks one; conditions still missing a value are ignored */
    value: z.unknown().optional(),
    currentFieldId: allowCurrent ? fieldId.optional() : z.never().optional(),
  });
  const group: z.ZodType<FilterGroup> = z
    .object({
      id: z.string().min(1).max(32).optional(),
      conjunction: z.enum(['and', 'or']),
      get conditions() {
        return z.array(z.union([condition, group])).max(limits.filterConditions);
      },
    })
    .refine((value) => depth(value) <= limits.filterDepth && count(value) <= limits.filterConditions, {
      message: 'errors.validationFailed',
    });
  return { condition, group };
}
function depth(group: FilterGroup): number {
  return 1 + Math.max(0, ...group.conditions.filter(isGroup).map(depth));
}
function count(group: FilterGroup): number {
  return group.conditions.reduce((n, item) => n + (isGroup(item) ? count(item) : 1), 0);
}

import {
  checkCondition,
  isGroup,
  operatorsForField,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
} from '@riosoma/contracts';
import type { Fragment } from '../live/fragment.js';
import type { LiveField, LiveInput, LivePlan, LiveSkip } from '../live/translate.js';
import { COSMOS_SYSTEM_FIELDS } from './cosmos.js';
import { ALL, NONE, and, type Predicate } from './query.js';
import { fieldParts } from './paths.js';

function condition(
  field: LiveField | undefined,
  input: FilterCondition,
  dialect?: string,
): Predicate | undefined {
  if (!field?.source || field.overridden) return undefined;
  const name = field.source.column;
  if (dialect === 'cosmosdb' && COSMOS_SYSTEM_FIELDS.has(name)) return undefined;
  try {
    const path = fieldParts(name);
    if ((!dialect || dialect === 'couchdb') && path.some((part) => /[.\\$]/.test(part))) return undefined;
  } catch {
    return undefined;
  }
  if (
    field.type === 'number' &&
    field.source.sourceType === 'number' &&
    ['eq', 'lt', 'lte', 'gt', 'gte'].includes(input.operator) &&
    typeof input.value === 'number'
  )
    return { op: input.operator as 'eq', field: name, value: input.value, numeric: true };
  if (field.type === 'singleSelect' && field.source.sourceType === 'string' && input.operator === 'is') {
    const choices = field.options.choices as Array<{ id: string; name: string }> | undefined;
    const found = choices?.find((c) => c.id === input.value);
    return found ? { op: 'eq', field: name, value: found.name } : NONE;
  }
  if (
    field.type === 'checkbox' &&
    field.source.sourceType === 'boolean' &&
    input.operator === 'is' &&
    input.value === true
  )
    return { op: 'eq', field: name, value: true };
  return undefined;
}
function usable(field: LiveField | undefined, input: FilterCondition): boolean {
  return Boolean(
    field &&
    operatorsForField(field as FieldMeta).includes(input.operator) &&
    checkCondition(field as FieldMeta, input).usable,
  );
}
function group(
  input: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  strict: boolean,
  skipped: LiveSkip[],
  dialect?: string,
): Predicate {
  const terms: Predicate[] = [];
  let widened = false;
  for (const item of input.conditions) {
    if (isGroup(item)) {
      terms.push(group(item, fields, strict, skipped, dialect));
      continue;
    }
    const field = fields.get(item.fieldId);
    if (!usable(field, item)) {
      if (strict) terms.push(NONE);
      continue;
    }
    const translated = condition(field, item, dialect);
    if (translated) terms.push(translated);
    else {
      if (strict) terms.push(NONE);
      else {
        widened = true;
        skipped.push({
          part: 'filter',
          fieldId: item.fieldId,
          reason: !field?.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
        });
      }
    }
  }
  if (!strict && input.conjunction === 'or' && widened) return ALL;
  if (!terms.length) return strict ? NONE : ALL;
  return { op: input.conjunction, terms };
}
export function documentRuleTranslates(
  input: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  dialect?: string,
): boolean {
  return input.conditions.every((item) =>
    isGroup(item)
      ? documentRuleTranslates(item, fields, dialect)
      : !usable(fields.get(item.fieldId), item) ||
        Boolean(condition(fields.get(item.fieldId), item, dialect)),
  );
}
export function documentRule(
  input: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  dialect?: string,
): Fragment {
  return { parts: [], document: group(input, fields, true, [], dialect) };
}
export function documentPlan(input: LiveInput): LivePlan {
  const skipped: LiveSkip[] = [];
  const predicates: Predicate[] = [];
  if (input.filter) predicates.push(group(input.filter, input.fields, false, skipped, input.dialect));
  if (input.rules)
    predicates.push({
      op: 'or',
      terms: input.rules.map((rule) =>
        group(rule, input.allFields ?? input.fields, true, skipped, input.dialect),
      ),
    });
  const order: Fragment[] = [];
  for (const sort of input.sorts) {
    const field = input.fields.get(sort.fieldId);
    if (!field) continue;
    // Document indexes differ in missing-value order, so unsupported sorts stay explicit.
    if (
      (input.dialect as string) === 'couchbase' &&
      field.source?.sourceType === 'number' &&
      field.type === 'number' &&
      !field.overridden
    )
      order.push({ parts: [], documentOrder: { field: field.source.column, direction: sort.direction } });
    else
      skipped.push({
        part: 'sort',
        fieldId: field.id,
        reason: !field.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
      });
  }
  return { where: { parts: [], document: and(...predicates) }, order, skipped, sourceOrder: false };
}

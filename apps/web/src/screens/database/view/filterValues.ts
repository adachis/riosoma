import { checkCondition, isGroup, operatorsForField } from '@riosoma/contracts';
import type { FieldMeta, FilterCondition, FilterGroup } from '@riosoma/contracts';

export type Collaborators = ReadonlyMap<string, { name: string; email?: string }>;
export const emptyCollaborators: Collaborators = new Map();

export function conditionsOf(group: FilterGroup | null): FilterCondition[] {
  return (
    group?.conditions.flatMap((condition) => (isGroup(condition) ? conditionsOf(condition) : [condition])) ??
    []
  );
}

export function newCondition(field: FieldMeta): FilterCondition {
  return {
    id: crypto.randomUUID().replaceAll('-', ''),
    fieldId: field.id,
    operator: operatorsForField(field)[0]!,
  };
}

export function changeField(condition: FilterCondition, field: FieldMeta): FilterCondition {
  const operators = operatorsForField(field);
  const next = {
    ...condition,
    fieldId: field.id,
    operator: operators.includes(condition.operator) ? condition.operator : operators[0]!,
  };
  return fitValue(next, field);
}

export function fitValue(condition: FilterCondition, field: FieldMeta): FilterCondition {
  const { value, ...empty } = condition;
  if (condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty') return empty;
  if (!checkCondition(field, condition).valid) return empty;
  // Choice IDs belong to one field even when two fields share the same value shape.
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const ids = new Set(field.options.choices.map((choice) => choice.id));
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((id) => typeof id !== 'string' || !ids.has(id))) return empty;
  }
  return condition;
}

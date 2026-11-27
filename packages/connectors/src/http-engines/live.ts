import {
  checkCondition,
  dayIn,
  rangeDays,
  targetDay,
  type DateRange,
  type DateTarget,
  isGroup,
  operatorsForField,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type SearchSourceKind,
} from '@riosoma/contracts';
import type { Fragment } from '../live/fragment.js';
import { dayStart, nextDay } from '../live/days.js';
import type { LiveContext, LiveField, LiveInput, LivePlan, LiveSkip } from '../live/translate.js';
import { engineColumn, type Predicate } from './search.js';

const FALSE: Predicate = { op: 'false' };
const TRUE: Predicate = { op: 'true' };
export const native = (predicate: Predicate): Fragment => ({ parts: [], native: predicate });

function condition(
  field: LiveField,
  item: FilterCondition,
  kind: SearchSourceKind,
  ctx: LiveContext,
): Predicate | null {
  if (!field.source || field.overridden || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field.source.column))
    return null;
  const source = engineColumn(field.source.column, field.source.sourceType);
  if (source.kind === 'json') return null;
  const column = field.source.column;
  const exists: Predicate = { op: 'exists', column };
  if (kind !== 'typesense' && ['number', 'date'].includes(field.type)) {
    if (item.operator === 'isEmpty') return { op: 'not', arg: exists };
    if (item.operator === 'isNotEmpty') return exists;
  }
  if (
    field.type === 'number' &&
    ['integer', 'float'].includes(source.kind) &&
    typeof item.value === 'number' &&
    Number.isFinite(item.value)
  ) {
    if (['eq', 'lt', 'lte', 'gt', 'gte'].includes(item.operator))
      return { op: item.operator as 'eq' | 'lt' | 'lte' | 'gt' | 'gte', column, value: item.value };
    if (item.operator === 'neq' && kind !== 'typesense')
      return { op: 'not', arg: { op: 'eq', column, value: item.value } };
  }
  if (
    field.type === 'date' &&
    field.options.includeTime &&
    source.kind === 'timestamp' &&
    (kind === 'elasticsearch' || kind === 'opensearch')
  ) {
    const zone =
      typeof field.options.timeZone === 'string' && field.options.timeZone !== 'client'
        ? field.options.timeZone
        : ctx.timeZone;
    const today = dayIn(zone, ctx.now);
    const [first, last] =
      item.operator === 'isWithin'
        ? rangeDays(item.value as DateRange, today)
        : [targetDay(item.value as DateTarget, today), null];
    const start = new Date(dayStart(first, zone)).toISOString();
    const end = new Date(dayStart(nextDay(last ?? first), zone)).toISOString();
    const format = 'strict_date_optional_time';
    const lower: Predicate = { op: 'gte', column, value: start, format };
    const upper: Predicate = { op: 'lt', column, value: end, format };
    switch (item.operator) {
      case 'is':
      case 'isWithin':
        return { op: 'and', args: [lower, upper] };
      case 'isNot':
        return { op: 'not', arg: { op: 'and', args: [lower, upper] } };
      case 'isBefore':
        return { op: 'lt', column, value: start, format };
      case 'isAfter':
        return { op: 'gte', column, value: end, format };
      case 'isOnOrBefore':
        return upper;
      case 'isOnOrAfter':
        return lower;
    }
  }
  if (field.type === 'checkbox' && source.kind === 'boolean' && item.operator === 'is') {
    if (item.value === true) return { op: 'eq', column, value: true };
    if (kind !== 'typesense' && item.value === false)
      return { op: 'not', arg: { op: 'eq', column, value: true } };
  }
  return null;
}

function usable(field: LiveField | undefined, item: FilterCondition): field is LiveField {
  return Boolean(
    field &&
    operatorsForField(field as FieldMeta).includes(item.operator) &&
    checkCondition(field as FieldMeta, item).usable,
  );
}

function compile(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  kind: SearchSourceKind,
  strict: boolean,
  skipped: LiveSkip[],
  ctx: LiveContext,
): Predicate {
  const args: Predicate[] = [];
  for (const item of group.conditions) {
    if (isGroup(item)) {
      args.push(compile(item, fields, kind, strict, skipped, ctx));
      continue;
    }
    const field = fields.get(item.fieldId);
    if (!usable(field, item)) {
      if (strict) args.push(FALSE);
      continue;
    }
    const result = condition(field, item, kind, ctx);
    if (!result)
      skipped.push({
        part: 'filter',
        fieldId: field.id,
        reason: !field.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
      });
    args.push(result ?? (strict ? FALSE : TRUE));
  }
  if (!args.length) return strict ? FALSE : TRUE;
  return simplify({ op: group.conjunction, args });
}

export function simplify(p: Predicate): Predicate {
  if (p.op === 'not') {
    const arg = simplify(p.arg);
    return arg.op === 'true' ? FALSE : arg.op === 'false' ? TRUE : { op: 'not', arg };
  }
  if (p.op !== 'and' && p.op !== 'or') return p;
  const args = p.args.map(simplify);
  if (args.some((arg) => arg.op === (p.op === 'and' ? 'false' : 'true')))
    return p.op === 'and' ? FALSE : TRUE;
  const kept = args.filter((arg) => arg.op !== (p.op === 'and' ? 'true' : 'false'));
  return !kept.length
    ? p.op === 'and'
      ? TRUE
      : FALSE
    : kept.length === 1
      ? kept[0]!
      : { op: p.op, args: kept };
}

export function searchRule(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  kind: SearchSourceKind,
  ctx: LiveContext,
): Fragment {
  return native(compile(group, fields, kind, true, [], ctx));
}
export function searchRuleTranslates(
  group: FilterGroup,
  fields: ReadonlyMap<string, LiveField>,
  kind: SearchSourceKind,
): boolean {
  return group.conditions.every((item) =>
    isGroup(item)
      ? searchRuleTranslates(item, fields, kind)
      : !usable(fields.get(item.fieldId), item) ||
        condition(fields.get(item.fieldId)!, item, kind, { now: new Date(), timeZone: 'UTC' }) !== null,
  );
}

export function planSearch(input: LiveInput, kind: SearchSourceKind): LivePlan {
  const skipped: LiveSkip[] = [];
  const predicates: Predicate[] = [];
  if (input.filter) predicates.push(compile(input.filter, input.fields, kind, false, skipped, input.context));
  if (input.rules)
    predicates.push({
      op: 'or',
      args: input.rules.map((rule) =>
        compile(rule, input.allFields ?? input.fields, kind, true, skipped, input.context),
      ),
    });
  const order: Fragment[] = [];
  let sourceOrder = false;
  for (const sort of input.sorts) {
    const field = input.fields.get(sort.fieldId);
    if (!field) continue;
    const column = field.source && engineColumn(field.source.column, field.source.sourceType);
    if (
      !column ||
      field.overridden ||
      !['number', 'date', 'text'].includes(field.type) ||
      !['integer', 'float', 'timestamp', 'text'].includes(column.kind) ||
      column.column.sourceType === 'text' ||
      (kind === 'elasticsearch' && (column.column.name === '_id' || column.column.name === '_index')) ||
      (kind === 'typesense' &&
        (column.column.name === 'id' || /^(?:string\*|auto|image)$/.test(column.column.sourceType))) ||
      !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column.column.name)
    ) {
      skipped.push({
        part: 'sort',
        fieldId: field.id,
        reason: !field.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
      });
      continue;
    }
    order.push({ parts: [], nativeOrder: { column: column.column.name, direction: sort.direction } });
    sourceOrder ||= field.type === 'text';
  }
  return {
    where: predicates.length ? native(simplify({ op: 'and', args: predicates })) : null,
    order,
    skipped,
    sourceOrder,
  };
}

import {
  checkCondition,
  isGroup,
  operatorsForField,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
} from '@riosoma/contracts';
import { odataName } from '../api/odata.js';
import { ConnectorError } from '../types.js';
import type { Fragment } from './fragment.js';
import type { LiveField, LiveInput, LivePlan, LiveSkip } from './translate.js';

export interface ODataFragment extends Fragment {
  readonly odata: string;
}
const fragment = (odata: string): ODataFragment => ({ parts: [], odata });
export function odataText(value: Fragment): string {
  if (!('odata' in value) || typeof value.odata !== 'string')
    throw new ConnectorError('sources.live.unsupported');
  return value.odata;
}
export function odataLiteral(value: unknown, sourceType?: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new ConnectorError('sources.sync.keyEmpty');
  if (/^Edm\.(Byte|SByte|Int16|Int32|Int64|Decimal|Single|Double)$/.test(sourceType ?? '')) {
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) throw new ConnectorError('sources.sync.keyEmpty');
    return value;
  }
  if (sourceType === 'Edm.Guid') {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value))
      throw new ConnectorError('sources.sync.keyEmpty');
    return value;
  }
  if (sourceType === 'Edm.Date' || sourceType === 'Edm.DateTimeOffset') {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
      throw new ConnectorError('sources.sync.keyEmpty');
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function condition(field: LiveField | undefined, item: FilterCondition): string | null {
  if (
    !field?.source ||
    field.overridden ||
    !operatorsForField(field as FieldMeta).includes(item.operator) ||
    !checkCondition(field as FieldMeta, item).usable
  )
    return null;
  const name = odataName(field.source.column);
  const sourceType = field.source.sourceType;
  const op = item.operator;
  if (field.type === 'number' && /^Edm\.(Byte|SByte|Int16|Int32|Single|Double)$/.test(sourceType)) {
    if (op === 'isEmpty') return `${name} eq null`;
    if (op === 'isNotEmpty') return `${name} ne null`;
    const mapped: Record<string, string> = { eq: 'eq', neq: 'ne', lt: 'lt', lte: 'le', gt: 'gt', gte: 'ge' };
    if (!mapped[op] || typeof item.value !== 'number') return null;
    return `${name} ${mapped[op]} ${odataLiteral(item.value)}`;
  }
  if (field.type === 'checkbox' && sourceType === 'Edm.Boolean' && op === 'is')
    return item.value ? `${name} eq true` : `${name} ne true`;
  if (['text', 'longText', 'email', 'url', 'phone'].includes(field.type) && sourceType === 'Edm.String') {
    const empty = `(${name} eq null or ${name} eq '')`;
    if (op === 'isEmpty') return empty;
    if (op === 'isNotEmpty') return `not ${empty}`;
    if (typeof item.value !== 'string') return null;
    const input = odataLiteral(item.value);
    if (op === 'is') return `tolower(${name}) eq tolower(${input})`;
    if (op === 'isNot') return `(${empty} or tolower(${name}) ne tolower(${input}))`;
    if (op === 'contains') return `contains(tolower(${name}),tolower(${input}))`;
    if (op === 'doesNotContain') return `(${empty} or not contains(tolower(${name}),tolower(${input})))`;
  }
  return null;
}

export function odataRuleTranslates(group: FilterGroup, fields: ReadonlyMap<string, LiveField>): boolean {
  return group.conditions.every((item) =>
    isGroup(item) ? odataRuleTranslates(item, fields) : condition(fields.get(item.fieldId), item) !== null,
  );
}

/** Unknown record-rule conditions deny access, while unsupported view conditions are reported */
export function planOData(input: Omit<LiveInput, 'dialect'>): LivePlan {
  const skipped: LiveSkip[] = [];
  const compile = (group: FilterGroup, fields: ReadonlyMap<string, LiveField>, strict: boolean): string => {
    const parts = group.conditions.map((item): string => {
      if (isGroup(item)) return compile(item, fields, strict);
      const field = fields.get(item.fieldId);
      const translated = condition(field, item);
      if (translated !== null) return `(${translated})`;
      if (!strict)
        skipped.push({
          part: 'filter',
          fieldId: item.fieldId,
          reason: !field?.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
        });
      return strict ? 'false' : 'true';
    });
    return parts.length
      ? `(${parts.join(group.conjunction === 'and' ? ' and ' : ' or ')})`
      : strict
        ? 'false'
        : 'true';
  };
  const where: string[] = [];
  if (input.filter) where.push(compile(input.filter, input.fields, false));
  if (input.rules)
    where.push(
      input.rules.length
        ? `(${input.rules.map((rule) => compile(rule, input.allFields ?? input.fields, true)).join(' or ')})`
        : 'false',
    );
  const order: Fragment[] = [];
  let sourceOrder = false;
  for (const sort of input.sorts) {
    const field = input.fields.get(sort.fieldId);
    if (!field?.source || field.overridden || !['text', 'number', 'date', 'checkbox'].includes(field.type)) {
      skipped.push({
        part: 'sort',
        fieldId: sort.fieldId,
        reason: !field?.source ? 'localField' : field.overridden ? 'overridden' : 'unsupported',
      });
      continue;
    }
    order.push(fragment(`${odataName(field.source.column)} ${sort.direction === 'desc' ? 'desc' : 'asc'}`));
    sourceOrder ||= field.type === 'text';
  }
  return { where: where.length ? fragment(where.join(' and ')) : null, order, skipped, sourceOrder };
}

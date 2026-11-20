import {
  isTimeZone,
  type FieldSpec,
  type Operator,
  type PlatformBase,
  type RollupFunction,
  type ViewType,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { Attachment } from '../../core/files.js';
import type { Note } from '../../core/report.js';
import { currencyCode, isRecord, textOf } from '../../core/values.js';
import { platformAttachment, safeAttachmentPath } from '../attachments.js';
import {
  asCheck,
  asDay,
  asInstant,
  asNumber,
  asText,
  asTrimmed,
  choicesOf,
  colorOfName,
  dateFormatOf,
  filesPlan,
  linkPlan,
  note,
  omitted,
  peoplePlan,
  precisionOf,
  riosomaFormula,
  valuePlan,
} from '../fields.js';
import type { PlatformClient } from '../http.js';
import type { ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  Finish,
  FormulaOptions,
  PlatformSource,
  SourceCondition,
  SourceFilter,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';

/**
 * Teable, through its own REST API with a personal access token sent as a bearer.  Bases come from
 * the list of every base the token can read, or from each space it names when the token is scoped
 * to some bases, tables and fields from the table API, records a page at a time keyed by field ID,
 * and views with the fields, filters, sorts, stacks, covers, dates, and form questions Teable
 * shares.  Files come from the address Teable signed for each one, and from its own attachment
 * route when it signed none.
 */

const PAGE = 200;
/** Filters nest as deep as someone built them, and this walks them that far before giving up */
const FILTER_DEPTH = 4;
const Options = z.record(z.string(), z.unknown()).nullish();
const Column = z.record(z.string(), z.unknown());

const Space = z.object({ id: z.string().min(1), name: z.string() });
const BaseItem = z.object({ id: z.string().min(1), name: z.string(), spaceId: z.string().nullish() });
const TableItem = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullish(),
  order: z.number().nullish(),
  defaultViewId: z.string().nullish(),
});
type TableItem = z.infer<typeof TableItem>;
const Field = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  description: z.string().nullish(),
  options: Options,
  lookupOptions: Options,
  aiConfig: z.unknown().nullish(),
  isLookup: z.boolean().nullish(),
  isConditionalLookup: z.boolean().nullish(),
  isPrimary: z.boolean().nullish(),
  hasError: z.boolean().nullish(),
  cellValueType: z.string().nullish(),
  isMultipleCellValue: z.boolean().nullish(),
});
type Field = z.infer<typeof Field>;
const Sort = z
  .object({
    sortObjs: z.array(z.object({ fieldId: z.string(), order: z.string() })).default([]),
    manualSort: z.boolean().nullish(),
  })
  .nullish();
const Group = z.array(z.object({ fieldId: z.string(), order: z.string() })).nullish();
const View = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  description: z.string().nullish(),
  order: z.number().nullish(),
  options: Options,
  sort: Sort,
  /** Walked by hand, since Teable nests these as deep as a filter was built */
  filter: z.unknown().nullish(),
  group: Group,
  columnMeta: z.record(z.string(), Column).default({}),
});
type View = z.infer<typeof View>;
const Records = z.object({
  records: z.array(
    z.object({ id: z.string().min(1), fields: z.record(z.string(), z.unknown()).default({}) }),
  ),
});

const text = (options: Record<string, unknown> | null | undefined, key: string) =>
  typeof options?.[key] === 'string' ? (options[key] as string) : null;

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Teable's rating icons, as Riosoma names the ones it has */
const RATING_ICONS: Readonly<Record<string, 'star' | 'heart' | 'thumbsUp'>> = {
  star: 'star',
  heart: 'heart',
  'thumb-up': 'thumbsUp',
};

/** Functions Teable calls by other names, as Riosoma names them */
const RENAMES: Readonly<Record<string, string>> = {
  DATE_ADD: 'DATEADD',
  IS_ERROR: 'ISERROR',
  ARRAY_JOIN: 'ARRAYJOIN',
  ARRAY_UNIQUE: 'ARRAYUNIQUE',
  ARRAY_FLATTEN: 'ARRAYFLATTEN',
  ARRAY_COMPACT: 'ARRAYCOMPACT',
  REGEXP_REPLACE: 'REGEX_REPLACE',
};

/** Teable's rollup functions, by the name its expression writes them with */
const ROLLUPS: Readonly<Record<string, RollupFunction>> = {
  countall: 'countAll',
  counta: 'count',
  count: 'count',
  sum: 'sum',
  average: 'average',
  max: 'max',
  min: 'min',
  and: 'and',
  or: 'or',
  array_join: 'concatenate',
  array_unique: 'arrayUnique',
  concatenate: 'concatenate',
};

/** How Teable's kinds of view come across.  A plugin view has no kind here. */
const VIEWS: Readonly<Record<string, ViewType>> = {
  grid: 'grid',
  kanban: 'kanban',
  gallery: 'gallery',
  calendar: 'calendar',
  form: 'form',
};

const OPERATORS: Readonly<Record<string, Operator>> = {
  is: 'is',
  isNot: 'isNot',
  contains: 'contains',
  doesNotContain: 'doesNotContain',
  isEmpty: 'isEmpty',
  isNotEmpty: 'isNotEmpty',
  isGreater: 'gt',
  isGreaterEqual: 'gte',
  isLess: 'lt',
  isLessEqual: 'lte',
  isAnyOf: 'isAnyOf',
  isNoneOf: 'isNoneOf',
  hasAnyOf: 'hasAnyOf',
  hasAllOf: 'hasAllOf',
  hasNoneOf: 'hasNoneOf',
  isExactly: 'isExactly',
  isWithIn: 'isWithin',
  isBefore: 'isBefore',
  isAfter: 'isAfter',
  isOnOrBefore: 'isOnOrBefore',
  isOnOrAfter: 'isOnOrAfter',
};

/** Days a condition picks out, by the mode Teable's date filter writes */
type DayMode =
  'today' | 'tomorrow' | 'yesterday' | 'oneWeekAgo' | 'oneWeekFromNow' | 'oneMonthAgo' | 'oneMonthFromNow';

const TARGETS: Readonly<Record<string, DayMode>> = {
  today: 'today',
  tomorrow: 'tomorrow',
  yesterday: 'yesterday',
  oneWeekAgo: 'oneWeekAgo',
  oneWeekFromNow: 'oneWeekFromNow',
  oneMonthAgo: 'oneMonthAgo',
  oneMonthFromNow: 'oneMonthFromNow',
};

/** Periods an `isWithIn` condition picks out, by the same mode */
const RANGES: Readonly<
  Record<string, 'pastWeek' | 'pastMonth' | 'pastYear' | 'nextWeek' | 'nextMonth' | 'nextYear'>
> = {
  pastWeek: 'pastWeek',
  pastMonth: 'pastMonth',
  pastYear: 'pastYear',
  nextWeek: 'nextWeek',
  nextMonth: 'nextMonth',
  nextYear: 'nextYear',
};

interface Context {
  /** Every table in the base, by Teable's ID */
  tables: ReadonlySet<string>;
  address: string;
  headers(): Record<string, string>;
}

/** The people a cell names, by email address where Teable gives one and by name where it doesn't. */
function peopleOf(value: unknown): string[] {
  const people = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return people.flatMap((person) => {
    if (typeof person === 'string') return person.trim() ? [person.trim()] : [];
    if (!isRecord(person)) return [];
    const email = typeof person.email === 'string' ? person.email.trim() : '';
    const name = typeof person.title === 'string' ? person.title.trim() : '';
    return email || name ? [email || name] : [];
  });
}

/** The records a link cell names, however Teable wrote them. */
function linkedIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return list.flatMap((item) =>
    typeof item === 'string' ? [item] : isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
  );
}

/** A computed field's cell as text, since a list of values is what Teable shows for it. */
function computedText(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : textOf(value);
}

function attachmentsOf(value: unknown, context: Context): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Attachment[] => {
    if (!isRecord(item)) return [{ url: '', filename: null, size: null, problem: 'failed' }];
    const size = number(item.size);
    const filename = text(item, 'name');
    // Teable signs an address for each file it serves from a bucket of its own.
    const signed = text(item, 'presignedUrl') ?? text(item, 'url');
    const namespace = (path: string) => /^\/api\/attachments\/.+/.test(path);
    if (signed && /^https?:\/\//i.test(signed))
      return [
        platformAttachment(
          context.address,
          { url: signed, filename, size },
          (path) => namespace(path) || /^\/files\/.+/.test(path),
        ),
      ];
    const token = text(item, 'token');
    const path = text(item, 'path');
    if ((path && !safeAttachmentPath(path)) || (token && !safeAttachmentPath(token)))
      return [{ url: '', filename, size, problem: 'blocked' }];
    const own = path
      ? `${context.address}/api/attachments/read/${path
          .split('/')
          .filter(Boolean)
          .map(encodeURIComponent)
          .join('/')}${token ? `?token=${encodeURIComponent(token)}` : ''}`
      : token
        ? `${context.address}/api/attachments/${encodeURIComponent(token)}`
        : null;
    return own
      ? [
          platformAttachment(
            context.address,
            { url: own, filename, size, headers: context.headers() },
            namespace,
          ),
        ]
      : [{ url: '', filename, size, problem: 'failed' }];
  });
}

/** The spec and reader for the kind of value a computed field holds, by Teable's own value type. */
function computedSpec(field: Field): { spec: FieldSpec; read(value: unknown): unknown } {
  const formatting = isRecord(field.options?.formatting) ? field.options.formatting : {};
  switch (field.cellValueType) {
    case 'number':
      return {
        spec: {
          type: 'number',
          options: { precision: precisionOf(formatting.precision), thousands: true, allowNegative: true },
        },
        read: asNumber,
      };
    case 'boolean':
      return { spec: { type: 'checkbox', options: { color: 'green' } }, read: asCheck };
    case 'dateTime':
      return {
        spec: {
          type: 'date',
          options: {
            includeTime: true,
            dateFormat: dateFormatOf(formatting.date),
            timeFormat: 'local',
            timeZone: 'client',
          },
        },
        read: asInstant,
      };
    default:
      return { spec: { type: 'text', options: {} }, read: computedText };
  }
}

function displayOptions(field: Field): FormulaOptions {
  const options = field.options ?? {};
  const formatting = isRecord(options.formatting) ? options.formatting : {};
  const zone = text(options, 'timeZone');
  const timeZone = zone && zone !== 'client' && isTimeZone(zone) ? zone : 'client';
  const time = text(formatting, 'time');
  if (typeof formatting.date === 'string')
    return {
      precision: null,
      dateFormat: dateFormatOf(formatting.date),
      timeFormat: time === 'hh:mm A' ? '12h' : time ? '24h' : 'local',
      timeZone,
    };
  return {
    precision: precisionOf(formatting.precision),
    dateFormat: 'local',
    timeFormat: 'local',
    timeZone,
  };
}

/** The function a rollup's expression names, like `sum` out of `sum({values})`. */
function rollupName(options: Record<string, unknown>): string {
  return /^(\w+)\s*\(/.exec(text(options, 'expression') ?? '')?.[1] ?? '';
}

/** What a field Teable computes becomes here, or null when nothing here computes it the same way. */
function finishOf(field: Field): Finish | null {
  const options = field.options ?? {};
  const lookup = field.lookupOptions ?? {};
  const link = text(lookup, 'linkFieldId');
  const target = text(lookup, 'lookupFieldId');
  if (field.isLookup) return link && target ? { kind: 'lookup', link, target } : null;
  // A rollup with a filter of its own reads every linked record here, and the report says so.
  if (field.type === 'rollup' || field.type === 'conditionalRollup') {
    const fn = ROLLUPS[rollupName(options).toLowerCase()];
    return link && target && fn ? { kind: 'rollup', link, target, fn } : null;
  }
  if (field.type !== 'formula') return null;
  const expression = text(options, 'expression') ?? '';
  const written = riosomaFormula(expression, RENAMES);
  return {
    kind: 'formula',
    shown: expression,
    expression: written.expression,
    ...(field.hasError
      ? { problem: 'invalid' as const }
      : written.problem
        ? { problem: written.problem }
        : {}),
    functions: written.functions,
    options: displayOptions(field),
  };
}

/** How one Teable field comes across. */
export function planField(field: Field, context: Context): FieldPlan {
  const source = { id: field.id, name: field.name, description: field.description ?? null };
  const options = field.options ?? {};
  const showAs = isRecord(options.showAs) ? options.showAs : null;
  const notes: Note[] = [];
  if (field.aiConfig) notes.push(note('changed', 'import.platform.report.aiGenerated'));
  if (showAs && ['bar', 'ring', 'line'].includes(String(showAs.type)))
    notes.push(note('changed', 'import.platform.report.numberShowAs'));
  const computed = field.isLookup || field.type === 'rollup' || field.type === 'conditionalRollup';
  if (computed || field.type === 'formula') {
    const finish = finishOf(field);
    const { spec, read } = computedSpec(field);
    const extra: Note[] = [];
    // A field that reads only the linked records a filter picks reads all of them here.
    if (field.isConditionalLookup || field.type === 'conditionalRollup')
      extra.push(note('changed', 'import.platform.report.conditionalRead'));
    if (!finish)
      extra.push(
        field.type === 'rollup' || field.type === 'conditionalRollup'
          ? note('changed', 'import.platform.report.rollupUnknown', {
              fn: rollupName(options) || field.type,
            })
          : note('changed', 'import.platform.report.relationText'),
      );
    return valuePlan(source, spec, read, [...notes, ...extra], finish ?? undefined);
  }
  switch (field.type) {
    case 'singleLineText': {
      const shown = text(showAs, 'type');
      if (shown === 'url') return valuePlan(source, { type: 'url', options: {} }, asTrimmed, notes);
      if (shown === 'email') return valuePlan(source, { type: 'email', options: {} }, asTrimmed, notes);
      if (shown === 'phone') return valuePlan(source, { type: 'phone', options: {} }, asTrimmed, notes);
      return valuePlan(source, { type: 'text', options: {} }, asText, notes);
    }
    case 'longText':
      return valuePlan(
        source,
        { type: 'longText', options: { richText: text(showAs, 'type') === 'markdown' } },
        asText,
        notes,
      );
    case 'number': {
      const formatting = isRecord(options.formatting) ? options.formatting : {};
      const kind = text(formatting, 'type') ?? 'decimal';
      const precision = precisionOf(formatting.precision) ?? (kind === 'percent' ? 0 : 2);
      if (kind === 'percent')
        return valuePlan(
          source,
          { type: 'percent', options: { precision, allowNegative: true } },
          asNumber,
          notes,
        );
      if (kind === 'currency') {
        const symbol = text(formatting, 'symbol') ?? '$';
        const code = currencyCode(symbol);
        return code
          ? valuePlan(
              source,
              { type: 'currency', options: { code, precision, allowNegative: true } },
              asNumber,
              notes,
            )
          : valuePlan(
              source,
              { type: 'number', options: { precision, thousands: true, allowNegative: true } },
              asNumber,
              [...notes, note('changed', 'import.platform.report.currencyUnknown', { symbol })],
            );
      }
      return valuePlan(
        source,
        { type: 'number', options: { precision, thousands: true, allowNegative: true } },
        asNumber,
        notes,
      );
    }
    case 'rating': {
      const max = Math.min(10, Math.max(1, precisionOf(options.max, 10) ?? 5));
      const icon = RATING_ICONS[text(options, 'icon') ?? ''];
      return valuePlan(
        source,
        {
          type: 'rating',
          options: { max, icon: icon ?? 'star', color: colorOfName(options.color ?? 'yellow') },
        },
        (value) => (value === 0 ? null : asNumber(value)),
        icon
          ? notes
          : [
              ...notes,
              note('changed', 'import.platform.report.ratingIcon', {
                icon: (text(options, 'icon') ?? '').slice(0, 32),
              }),
            ],
      );
    }
    case 'checkbox':
      return valuePlan(source, { type: 'checkbox', options: { color: 'green' } }, asCheck, notes);
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime': {
      const formatting = isRecord(options.formatting) ? options.formatting : {};
      const time = text(formatting, 'time');
      const includeTime = field.type !== 'date' || (time !== null && time !== 'None' && time !== '');
      const zone = text(formatting, 'timeZone');
      return valuePlan(
        source,
        {
          type: 'date',
          options: {
            includeTime,
            dateFormat: dateFormatOf(formatting.date),
            timeFormat: time === 'hh:mm A' ? '12h' : includeTime ? '24h' : 'local',
            timeZone: includeTime && zone && isTimeZone(zone) ? zone : 'client',
          },
        },
        includeTime ? asInstant : asDay,
        field.type === 'date' ? notes : [...notes, note('changed', 'import.platform.report.timeFixed')],
      );
    }
    case 'singleSelect':
    case 'multipleSelect': {
      const raw = Array.isArray(options.choices) ? options.choices : [];
      const { choices, byName } = choicesOf(
        raw.flatMap((item) =>
          isRecord(item) && typeof item.name === 'string'
            ? [{ name: item.name, color: colorOfName(item.color) }]
            : [],
        ),
      );
      if (field.type === 'singleSelect')
        return valuePlan(
          source,
          { type: 'singleSelect', options: { choices } },
          (value) => (typeof value === 'string' ? (byName.get(value) ?? value) : (value ?? null)),
          notes,
        );
      return valuePlan(
        source,
        { type: 'multipleSelect', options: { choices } },
        (value) => {
          const names = Array.isArray(value)
            ? value.map(String)
            : typeof value === 'string' && value !== ''
              ? [value]
              : [];
          const ids = names.map((name) => byName.get(name));
          return ids.every((id) => id !== undefined) ? ids : names.join(', ');
        },
        notes,
      );
    }
    case 'attachment': {
      const plan = filesPlan(source, (value) => attachmentsOf(value, context));
      // A field Teable fills in by generating images keeps the ones it made.
      plan.notes.push(...notes);
      return plan;
    }
    case 'user':
      return peoplePlan(source, peopleOf, options.isMultiple === true, notes);
    case 'createdBy':
    case 'lastModifiedBy':
      return peoplePlan(source, peopleOf, false, [
        ...notes,
        note('changed', 'import.platform.report.peopleFixed'),
      ]);
    case 'autoNumber':
      return valuePlan(
        source,
        { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
        asNumber,
        notes,
        { kind: 'autoNumber' },
      );
    case 'link': {
      const foreign = text(options, 'foreignTableId') ?? '';
      if (!context.tables.has(foreign)) return omitted(source, 'import.platform.report.linkMissing');
      const relationship = text(options, 'relationship') ?? '';
      return linkPlan(
        source,
        foreign,
        text(options, 'symmetricFieldId'),
        relationship === 'oneOne' || relationship === 'manyOne',
        linkedIds,
      );
    }
    case 'button':
      return omitted(source, 'import.platform.report.button');
    default:
      return omitted(source, 'import.platform.report.typeUnsupported', { type: field.type.slice(0, 64) });
  }
}

/** One of Teable's filter conditions as one here, or null when there's none like it. */
export function conditionOf(
  condition: { fieldId: string; operator: string; value: unknown },
  field: Field,
): SourceCondition | null {
  const operator = OPERATORS[condition.operator];
  if (!operator) return null;
  const source = condition.fieldId;
  const { value } = condition;
  if (operator === 'isEmpty' || operator === 'isNotEmpty')
    return { field: source, operator, value: { kind: 'none' } };
  switch (field.type) {
    case 'singleLineText':
    case 'longText':
      if (!['is', 'isNot', 'contains', 'doesNotContain'].includes(operator)) return null;
      return typeof value === 'string'
        ? { field: source, operator, value: { kind: 'text', text: value } }
        : null;
    case 'number':
    case 'rating':
    case 'autoNumber': {
      const numericOperator = operator === 'is' ? 'eq' : operator === 'isNot' ? 'neq' : operator;
      const numeric =
        number(value) ?? (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
      if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(numericOperator) || !Number.isFinite(numeric))
        return null;
      return { field: source, operator: numericOperator, value: { kind: 'number', number: numeric } };
    }
    case 'checkbox':
      return operator === 'is' && typeof value === 'boolean'
        ? { field: source, operator, value: { kind: 'boolean', value } }
        : null;
    case 'singleSelect':
    case 'multipleSelect': {
      const names = (Array.isArray(value) ? value : [value]).flatMap((item) =>
        typeof item === 'string' && item !== '' ? [item] : [],
      );
      if (!names.length) return null;
      const suits =
        field.type === 'singleSelect'
          ? ['is', 'isNot', 'isAnyOf', 'isNoneOf']
          : ['hasAnyOf', 'hasAllOf', 'hasNoneOf', 'isExactly'];
      return suits.includes(operator) ? { field: source, operator, value: { kind: 'choices', names } } : null;
    }
    case 'link': {
      if (operator === 'contains' || operator === 'doesNotContain')
        return typeof value === 'string'
          ? { field: source, operator, value: { kind: 'text', text: value } }
          : null;
      const ids = linkedIds(value);
      return ids.length && (operator === 'hasAnyOf' || operator === 'hasNoneOf')
        ? { field: source, operator, value: { kind: 'records', ids } }
        : null;
    }
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime': {
      if (!isRecord(value)) return null;
      const mode = text(value, 'mode');
      const days = number(value.numberOfDays);
      if (operator === 'isWithin') {
        const range = mode ? RANGES[mode] : undefined;
        if (range) return { field: source, operator, value: { kind: 'range', range: { mode: range } } };
        const counted =
          mode === 'pastNumberOfDays' ? 'pastDays' : mode === 'nextNumberOfDays' ? 'nextDays' : null;
        return counted && days !== null && days >= 1
          ? { field: source, operator, value: { kind: 'range', range: { mode: counted, days } } }
          : null;
      }
      const target = mode ? TARGETS[mode] : undefined;
      if (target) return { field: source, operator, value: { kind: 'date', target: { mode: target } } };
      if ((mode === 'daysAgo' || mode === 'daysFromNow') && days !== null && days >= 0)
        return { field: source, operator, value: { kind: 'date', target: { mode, days } } };
      const exact = text(value, 'exactDate');
      return mode === 'exactDate' && exact && /^\d{4}-\d{2}-\d{2}/.test(exact)
        ? {
            field: source,
            operator,
            value: { kind: 'date', target: { mode: 'exactDate', date: exact.slice(0, 10) } },
          }
        : null;
    }
    default:
      return null;
  }
}

/** Teable's filter, which nests as deep as it was built, as one here. */
export function filterOf(
  filter: unknown,
  fields: ReadonlyMap<string, Field>,
): { filter: SourceFilter | null; unmatched: number } {
  let unmatched = 0;
  const walk = (value: unknown, level: number): SourceFilter | null => {
    if (!isRecord(value) || !Array.isArray(value.filterSet)) return null;
    const conditions: SourceFilter['conditions'] = [];
    for (const item of value.filterSet) {
      if (isRecord(item) && Array.isArray(item.filterSet)) {
        const nested = level < FILTER_DEPTH ? walk(item, level + 1) : null;
        if (nested?.conditions.length) conditions.push(nested);
        else unmatched++;
        continue;
      }
      if (!isRecord(item) || typeof item.fieldId !== 'string' || typeof item.operator !== 'string') {
        unmatched++;
        continue;
      }
      const field = fields.get(item.fieldId);
      const made = field
        ? conditionOf({ fieldId: item.fieldId, operator: item.operator, value: item.value }, field)
        : null;
      if (made) conditions.push(made);
      else unmatched++;
    }
    return conditions.length ? { conjunction: value.conjunction === 'or' ? 'or' : 'and', conditions } : null;
  };
  return { filter: walk(filter, 1), unmatched };
}

/** The fields a view shows, in its order, or null when Teable didn't say. */
function shownOf(view: View): string[] | null {
  const entries = Object.entries(view.columnMeta);
  if (!entries.length) return null;
  // A grid hides what it says is hidden, and the views that show cards say what a card shows.
  const hidden = (column: Record<string, unknown>) =>
    view.type === 'grid' ? column.hidden === true : column.visible === false;
  return entries
    .filter(([, column]) => !hidden(column))
    .sort((a, b) => (number(a[1].order) ?? 0) - (number(b[1].order) ?? 0))
    .map(([fieldId]) => fieldId);
}

function viewOf(view: View, fields: ReadonlyMap<string, Field>): SourceView {
  const kind = VIEWS[view.type] ?? null;
  const options = view.options ?? {};
  const notes: Note[] = [];
  const base: SourceView = { id: view.id, name: view.name, type: view.type, kind, notes };
  if (!kind) return base;
  const shown = shownOf(view);
  if (kind === 'form') {
    const asked = Object.entries(view.columnMeta)
      .filter(([, column]) => column.visible !== false)
      .sort((a, b) => (number(a[1].order) ?? 0) - (number(b[1].order) ?? 0));
    return {
      ...base,
      shown: asked.map(([fieldId]) => fieldId),
      questions: asked.map(([fieldId, column]) => ({
        field: fieldId,
        required: column.required === true,
        label: '',
        help: '',
      })),
      form: {
        title: view.name,
        description: view.description ?? '',
        submitLabel: text(options, 'submitLabel') ?? '',
        thankYou: '',
      },
    };
  }
  if (isRecord(options.colorConfig)) notes.push(note('omitted', 'import.platform.report.viewColors'));
  const found = filterOf(view.filter, fields);
  // A board stacks by the field its own options name, and the rest by the first of their groups.
  const grouped = view.group?.[0]?.fieldId ?? null;
  return {
    ...base,
    ...(shown ? { shown } : {}),
    filter: found.filter,
    unmatched: found.unmatched,
    sorts: (view.sort?.sortObjs ?? []).map((sort) => ({
      field: sort.fieldId,
      direction: sort.order === 'desc' ? ('desc' as const) : ('asc' as const),
    })),
    group: kind === 'kanban' ? (text(options, 'stackFieldId') ?? grouped) : grouped,
    cover: text(options, 'coverFieldId'),
    start: text(options, 'startDateFieldId'),
    end: text(options, 'endDateFieldId'),
  };
}

class TeableSource implements PlatformSource {
  readonly platform = 'teable' as const;
  private readonly tables = new Map<string, TableItem>();
  private readonly fieldsOf = new Map<string, Field[]>();

  constructor(
    private readonly client: PlatformClient,
    private readonly address: string,
    private readonly baseId: string,
  ) {}

  async schema(): Promise<SourceSchema> {
    const listed = await this.client.json(`/api/base/${this.baseId}/table`, z.array(TableItem));
    for (const table of listed) this.tables.set(table.id, table);
    for (const table of listed)
      this.fieldsOf.set(table.id, await this.client.json(`/api/table/${table.id}/field`, z.array(Field)));
    const context: Context = {
      tables: new Set(this.tables.keys()),
      address: this.address,
      headers: () => this.client.headers(),
    };
    const tables: SourceTable[] = [];
    for (const table of listed) {
      const fields = this.fieldsOf.get(table.id)!;
      const byId = new Map(fields.map((field) => [field.id, field]));
      const views = await this.client.json(`/api/table/${table.id}/view`, z.array(View));
      tables.push({
        id: table.id,
        name: table.name,
        description: table.description ?? null,
        primary: fields.find((field) => field.isPrimary)?.id ?? null,
        fields: fields.map((field) => planField(field, context)),
        views: views
          .slice()
          .sort((a, b) => (number(a.order) ?? 0) - (number(b.order) ?? 0))
          .map((view) => viewOf(view, byId)),
        notes: [],
      });
    }
    return { tables, notes: [] };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    for (let skip = 0; ; skip += PAGE) {
      const page = await this.client.json(`/api/table/${table.id}/record`, Records, {
        query: { take: PAGE, skip, fieldKeyType: 'id' },
      });
      yield page.records.map((record) => ({ id: record.id, values: record.fields }));
      if (page.records.length < PAGE) return;
    }
  }
}

export const teableReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => [token],
  });
  return {
    async bases(): Promise<PlatformBase[]> {
      try {
        const all = await client.json('/api/base/access/all', z.array(BaseItem), { purpose: 'list' });
        return all.map((base) => ({ id: base.id, name: base.name, group: null }));
      } catch (error) {
        // A token scoped to some bases can't list them all, but can list what each space it reads holds.
        const spaces = await client.json('/api/space', z.array(Space), { purpose: 'list' }).catch(() => {
          throw error;
        });
        const bases: PlatformBase[] = [];
        for (const space of spaces) {
          const listed = await client.json(`/api/space/${space.id}/base`, z.array(BaseItem), {
            purpose: 'list',
          });
          bases.push(...listed.map((base) => ({ id: base.id, name: base.name, group: space.name })));
        }
        return bases;
      }
    },
    kept: async () => context.credential,
    source: (baseId) => new TeableSource(client, context.address, baseId),
  };
};

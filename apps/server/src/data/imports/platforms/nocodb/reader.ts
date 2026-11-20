import type { DateRange, DateTarget, Operator, ViewType } from '@riosoma/contracts';
import { z } from 'zod';
import type { Attachment } from '../../core/files.js';
import type { Note } from '../../core/report.js';
import { isRecord } from '../../core/values.js';
import {
  asCheck,
  asDay,
  asInstant,
  asNumber,
  asText,
  asTrimmed,
  choicesOf,
  colorOfHex,
  dateFormatOf,
  emailsOf,
  filesPlan,
  formulaOptions,
  linkPlan,
  note,
  omitted,
  peoplePlan,
  precisionOf,
  riosomaFormula,
  ROLLUPS,
  valuePlan,
} from '../fields.js';
import type { PlatformClient } from '../http.js';
import type { ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  PlatformSource,
  SourceCondition,
  SourceFilter,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';

/**
 * NocoDB, through its v2 meta and data APIs with an API token sent as `xc-token`.  Bases come from
 * `/api/v2/meta/bases`, or from each workspace's bases on NocoDB's hosted service, tables and their
 * columns from the meta API, records from the data API a page at a time, and the records a link
 * holds from the links API, since NocoDB's record lists only count them.  Views keep their fields,
 * filters, sorts, stacks, covers, and form questions, which NocoDB shares.
 */

const PAGE = 200;
const flag = z.union([z.boolean(), z.number(), z.string()]).nullish();
const Meta = z.union([z.record(z.string(), z.unknown()), z.string()]).nullish();
const Options = z.record(z.string(), z.unknown()).nullish();
const PageInfo = z.object({ isLastPage: z.boolean().nullish() }).partial().nullish();
const pageOf = <T extends z.ZodType>(item: T) => z.object({ list: z.array(item), pageInfo: PageInfo });

const Base = z.object({ id: z.string().min(1), title: z.string() });
const Workspace = z.object({ id: z.string().min(1), title: z.string().nullish() });
const Column = z.object({
  id: z.string().min(1),
  title: z.string(),
  uidt: z.string(),
  pk: flag,
  pv: flag,
  system: flag,
  description: z.string().nullish(),
  meta: Meta,
  colOptions: Options,
});
type Column = z.infer<typeof Column>;
const TableMeta = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  columns: z.array(Column),
});
type TableMeta = z.infer<typeof TableMeta>;
const TableListing = z.object({ id: z.string().min(1), title: z.string(), mm: flag });
const View = z.object({
  id: z.string().min(1),
  title: z.string(),
  type: z.number(),
  view: Options,
});
type View = z.infer<typeof View>;
const Filter = z.object({
  id: z.string(),
  fk_column_id: z.string().nullish(),
  comparison_op: z.string().nullish(),
  comparison_sub_op: z.string().nullish(),
  value: z.unknown(),
  is_group: flag,
  logical_op: z.string().nullish(),
  enabled: flag,
});
type Filter = z.infer<typeof Filter>;
const Sort = z.object({ fk_column_id: z.string(), direction: z.string().nullish() });
const ViewColumn = z.object({
  fk_column_id: z.string(),
  show: flag,
  order: z.number().nullish(),
  group_by: flag,
});
const FormColumn = ViewColumn.extend({
  label: z.string().nullish(),
  help: z.string().nullish(),
  description: z.string().nullish(),
  required: flag,
});
const Form = z.object({
  heading: z.string().nullish(),
  subheading: z.string().nullish(),
  success_msg: z.string().nullish(),
  columns: z.array(FormColumn).default([]),
});
const Records = pageOf(z.record(z.string(), z.unknown()));

const on = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';

function metaOf(column: { meta?: unknown }): Record<string, unknown> {
  if (isRecord(column.meta)) return column.meta;
  if (typeof column.meta === 'string')
    try {
      const parsed: unknown = JSON.parse(column.meta);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  return {};
}

const text = (options: Record<string, unknown> | null | undefined, key: string) =>
  typeof options?.[key] === 'string' ? (options[key] as string) : null;

const DURATIONS = ['h:mm', 'h:mm:ss', 'h:mm:ss.s', 'h:mm:ss.ss', 'h:mm:ss.sss'] as const;
const RATING_ICONS = ['star', 'heart', 'circle', 'thumbsUp', 'flag'] as const;

/** Functions NocoDB calls by other names, as Riosoma names them */
const RENAMES: Readonly<Record<string, string>> = {
  CONCAT: 'CONCATENATE',
  AVG: 'AVERAGE',
  SUBSTR: 'MID',
  REPEAT: 'REPT',
  REPLACE: 'SUBSTITUTE',
};

/** How NocoDB's kinds of view come across */
const VIEWS: Readonly<Record<number, { name: string; kind: ViewType | null }>> = {
  1: { name: 'form', kind: 'form' },
  2: { name: 'gallery', kind: 'gallery' },
  3: { name: 'grid', kind: 'grid' },
  4: { name: 'kanban', kind: 'kanban' },
  5: { name: 'map', kind: 'map' },
  6: { name: 'calendar', kind: 'calendar' },
};

type Family = 'text' | 'number' | 'percent' | 'check' | 'date' | 'select' | 'multi' | 'link' | 'files';

function familyOf(column: Column): Family | null {
  switch (column.uidt) {
    case 'SingleLineText':
    case 'LongText':
    case 'Email':
    case 'URL':
    case 'PhoneNumber':
    case 'Formula':
    case 'Lookup':
      return 'text';
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Duration':
    case 'Rating':
    case 'Year':
    case 'AutoNumber':
    case 'ID':
    case 'Rollup':
      return 'number';
    case 'Percent':
      return 'percent';
    case 'Checkbox':
      return 'check';
    case 'Date':
    case 'DateTime':
    case 'CreatedTime':
    case 'LastModifiedTime':
      return 'date';
    case 'SingleSelect':
      return 'select';
    case 'MultiSelect':
      return 'multi';
    case 'Links':
    case 'LinkToAnotherRecord':
      return 'link';
    case 'Attachment':
      return 'files';
    default:
      return null;
  }
}

const EMPTY_OPERATORS: Readonly<Record<string, Operator>> = {
  blank: 'isEmpty',
  empty: 'isEmpty',
  null: 'isEmpty',
  notblank: 'isNotEmpty',
  notempty: 'isNotEmpty',
  notnull: 'isNotEmpty',
};

function dateTarget(sub: string | null | undefined, value: unknown): DateTarget | null {
  const days = Number(value);
  switch (sub) {
    case 'today':
    case 'tomorrow':
    case 'yesterday':
    case 'oneWeekAgo':
    case 'oneWeekFromNow':
    case 'oneMonthAgo':
    case 'oneMonthFromNow':
      return { mode: sub };
    case 'daysAgo':
    case 'daysFromNow':
      return Number.isInteger(days) && days >= 0 ? { mode: sub, days } : null;
    case 'exactDate':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
        ? { mode: 'exactDate', date: value.slice(0, 10) }
        : null;
    default:
      return null;
  }
}

function dateRange(sub: string | null | undefined, value: unknown): DateRange | null {
  const days = Number(value);
  switch (sub) {
    case 'pastWeek':
    case 'pastMonth':
    case 'pastYear':
    case 'nextWeek':
    case 'nextMonth':
    case 'nextYear':
      return { mode: sub };
    case 'pastNumberOfDays':
    case 'nextNumberOfDays':
      return Number.isInteger(days) && days >= 1
        ? { mode: sub === 'pastNumberOfDays' ? 'pastDays' : 'nextDays', days }
        : null;
    default:
      return null;
  }
}

const listOf = (value: unknown) =>
  (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [])
    .map((item) => item.trim())
    .filter(Boolean);

/** One of NocoDB's conditions as one here, or null when there's none like it. */
export function conditionOf(filter: Filter, column: Column): SourceCondition | null {
  const op = filter.comparison_op ?? '';
  const field = column.id;
  const empty = EMPTY_OPERATORS[op];
  if (empty) return { field, operator: empty, value: { kind: 'none' } };
  const family = familyOf(column);
  const value = filter.value;
  const number = typeof value === 'number' ? value : Number(value);
  switch (family) {
    case 'text': {
      const operator = ({ eq: 'is', neq: 'isNot', like: 'contains', nlike: 'doesNotContain' } as const)[
        op as 'eq'
      ];
      return operator && typeof value === 'string'
        ? { field, operator, value: { kind: 'text', text: value } }
        : null;
    }
    case 'number':
    case 'percent': {
      const operator = (
        { eq: 'eq', neq: 'neq', gt: 'gt', lt: 'lt', gte: 'gte', ge: 'gte', lte: 'lte', le: 'lte' } as const
      )[op as 'eq'];
      if (!operator || value === null || value === '' || !Number.isFinite(number)) return null;
      return {
        field,
        operator,
        value: { kind: 'number', number: family === 'percent' ? number / 100 : number },
      };
    }
    case 'check':
      if (op === 'checked' || op === 'notchecked')
        return { field, operator: 'is', value: { kind: 'boolean', value: op === 'checked' } };
      return null;
    case 'date': {
      if (op === 'isWithin') {
        const range = dateRange(filter.comparison_sub_op, value);
        return range ? { field, operator: 'isWithin', value: { kind: 'range', range } } : null;
      }
      const operator = (
        {
          eq: 'is',
          neq: 'isNot',
          lt: 'isBefore',
          gt: 'isAfter',
          lte: 'isOnOrBefore',
          le: 'isOnOrBefore',
          gte: 'isOnOrAfter',
          ge: 'isOnOrAfter',
        } as const
      )[op as 'eq'];
      const target = dateTarget(filter.comparison_sub_op, value);
      return operator && target ? { field, operator, value: { kind: 'date', target } } : null;
    }
    case 'select': {
      const operator = ({ eq: 'is', neq: 'isNot', anyof: 'isAnyOf', nanyof: 'isNoneOf' } as const)[
        op as 'eq'
      ];
      const names = op === 'eq' || op === 'neq' ? [String(value ?? '')] : listOf(value);
      return operator && names.length && names[0]
        ? { field, operator, value: { kind: 'choices', names } }
        : null;
    }
    case 'multi': {
      const operator = (
        { anyof: 'hasAnyOf', allof: 'hasAllOf', nanyof: 'hasNoneOf', eq: 'isExactly' } as const
      )[op as 'eq'];
      const names = listOf(value);
      return operator && names.length ? { field, operator, value: { kind: 'choices', names } } : null;
    }
    case 'link':
    case 'files': {
      const operator = ({ like: 'contains', nlike: 'doesNotContain' } as const)[op as 'like'];
      return operator && typeof value === 'string'
        ? { field, operator, value: { kind: 'text', text: value } }
        : null;
    }
    default:
      return null;
  }
}

interface Context {
  tables: ReadonlyMap<string, TableMeta>;
  table: TableMeta;
  address: string;
  headers(): Record<string, string>;
}

/** The field that holds a table's record IDs, named as the data API names it */
const keyOf = (table: TableMeta) => table.columns.find((column) => on(column.pk)) ?? null;

function inverseOf(column: Column, context: Context): string | null {
  const own = column.colOptions ?? {};
  const related = context.tables.get(text(own, 'fk_related_model_id') ?? '');
  if (!related) return null;
  const type = text(own, 'type');
  const match = related.columns.find((other) => {
    if (other.id === column.id || (other.uidt !== 'Links' && other.uidt !== 'LinkToAnotherRecord'))
      return false;
    const theirs = other.colOptions ?? {};
    if (text(theirs, 'fk_related_model_id') !== context.table.id) return false;
    const kind = text(theirs, 'type');
    if (type === 'mm')
      return (
        kind === 'mm' &&
        text(theirs, 'fk_mm_model_id') === text(own, 'fk_mm_model_id') &&
        text(theirs, 'fk_mm_child_column_id') === text(own, 'fk_mm_parent_column_id') &&
        text(theirs, 'fk_mm_parent_column_id') === text(own, 'fk_mm_child_column_id')
      );
    const pairs: Record<string, string> = { hm: 'bt', bt: 'hm', oo: 'oo' };
    return (
      kind === pairs[type ?? ''] &&
      text(theirs, 'fk_child_column_id') === text(own, 'fk_child_column_id') &&
      text(theirs, 'fk_parent_column_id') === text(own, 'fk_parent_column_id')
    );
  });
  return match?.id ?? null;
}

function attachmentsOf(value: unknown, context: Context): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const size = typeof item.size === 'number' ? item.size : null;
    const filename = item.title ?? item.name ?? null;
    const url =
      text(item, 'signedUrl') ??
      text(item, 'url') ??
      (text(item, 'signedPath') ? `${context.address}/${text(item, 'signedPath')}` : null);
    if (url) return [{ url, filename, size }];
    // A file NocoDB keeps itself, which it serves to whoever has the token.
    const path = text(item, 'path');
    return path ? [{ url: `${context.address}/${path}`, filename, size, headers: context.headers() }] : [];
  });
}

/** How one NocoDB column comes across, or null for the columns NocoDB keeps for itself. */
export function planColumn(column: Column, context: Context): FieldPlan | null {
  if (on(column.system) && column.uidt !== 'ID') return null;
  const field = { id: column.id, name: column.title, description: column.description ?? null };
  const meta = metaOf(column);
  const options = column.colOptions ?? {};
  switch (column.uidt) {
    case 'ForeignKey':
    case 'Order':
    case 'Deleted':
      return null;
    case 'ID':
    case 'AutoNumber':
      return valuePlan(
        field,
        { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
        asNumber,
        [],
        { kind: 'autoNumber' },
      );
    case 'SingleLineText':
      return valuePlan(field, { type: 'text', options: {} }, asText);
    case 'LongText':
      return valuePlan(field, { type: 'longText', options: { richText: on(meta.richMode) } }, asText);
    case 'Email':
      return valuePlan(field, { type: 'email', options: {} }, asTrimmed);
    case 'URL':
      return valuePlan(field, { type: 'url', options: {} }, asTrimmed);
    case 'PhoneNumber':
      return valuePlan(field, { type: 'phone', options: {} }, asTrimmed);
    case 'Number':
      return valuePlan(
        field,
        { type: 'number', options: { precision: 0, thousands: true, allowNegative: true } },
        asNumber,
      );
    case 'Decimal':
      return valuePlan(
        field,
        {
          type: 'number',
          options: { precision: precisionOf(meta.precision) ?? 1, thousands: true, allowNegative: true },
        },
        asNumber,
      );
    case 'Year':
      return valuePlan(
        field,
        { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
        asNumber,
      );
    case 'Currency': {
      const code = typeof meta.currency_code === 'string' ? meta.currency_code.toUpperCase() : 'USD';
      return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code)
        ? valuePlan(
            field,
            {
              type: 'currency',
              options: { code, precision: precisionOf(meta.precision) ?? 2, allowNegative: true },
            },
            asNumber,
          )
        : valuePlan(
            field,
            { type: 'number', options: { precision: 2, thousands: true, allowNegative: true } },
            asNumber,
            [note('changed', 'import.platform.report.currencyUnknown', { symbol: code })],
          );
    }
    case 'Percent':
      // NocoDB keeps 50 for 50%, and Riosoma keeps 0.5.
      return valuePlan(
        field,
        { type: 'percent', options: { precision: precisionOf(meta.precision) ?? 0, allowNegative: true } },
        (value) => {
          const number = asNumber(value);
          return typeof number === 'number' ? number / 100 : number;
        },
      );
    case 'Duration':
      return valuePlan(
        field,
        { type: 'duration', options: { format: DURATIONS[precisionOf(meta.duration, 4) ?? 0] ?? 'h:mm' } },
        asNumber,
      );
    case 'Rating': {
      const max = Math.min(10, Math.max(1, precisionOf(meta.max, 10) ?? 5));
      return valuePlan(
        field,
        {
          type: 'rating',
          options: {
            max,
            icon: RATING_ICONS[precisionOf(meta.iconIdx, 4) ?? 0] ?? 'star',
            color: colorOfHex(meta.color ?? '#fcb401'),
          },
        },
        (value) => (value === 0 ? null : asNumber(value)),
        max < (precisionOf(meta.max, 100) ?? 5)
          ? [note('changed', 'import.platform.report.ratingMax', { max })]
          : [],
      );
    }
    case 'Checkbox':
      return valuePlan(
        field,
        { type: 'checkbox', options: { color: meta.color ? colorOfHex(meta.color) : 'green' } },
        asCheck,
        isRecord(meta.icon) && !/check/i.test(JSON.stringify(meta.icon))
          ? [note('changed', 'import.platform.report.checkboxIcon')]
          : [],
      );
    case 'Date':
      return valuePlan(
        field,
        {
          type: 'date',
          options: {
            includeTime: false,
            dateFormat: dateFormatOf(meta.date_format),
            timeFormat: 'local',
            timeZone: 'client',
          },
        },
        asDay,
      );
    case 'DateTime':
    case 'CreatedTime':
    case 'LastModifiedTime':
      return valuePlan(
        field,
        {
          type: 'date',
          options: {
            includeTime: true,
            dateFormat: dateFormatOf(meta.date_format),
            timeFormat:
              /h/.test(String(meta.time_format ?? '')) && /A|a/.test(String(meta.time_format))
                ? '12h'
                : meta.time_format
                  ? '24h'
                  : 'local',
            timeZone: 'client',
          },
        },
        asInstant,
        column.uidt === 'DateTime' ? [] : [note('changed', 'import.platform.report.timeFixed')],
      );
    case 'Time':
      return valuePlan(field, { type: 'text', options: {} }, asText, [
        note('changed', 'import.platform.report.timeText'),
      ]);
    case 'SingleSelect':
    case 'MultiSelect': {
      const raw = Array.isArray(options.options) ? options.options : [];
      const { choices, byName } = choicesOf(
        raw.flatMap((item) =>
          isRecord(item) && typeof item.title === 'string'
            ? [{ name: item.title, color: colorOfHex(item.color) }]
            : [],
        ),
      );
      if (column.uidt === 'SingleSelect')
        return valuePlan(field, { type: 'singleSelect', options: { choices } }, (value) =>
          typeof value === 'string' ? (byName.get(value) ?? value) : (value ?? null),
        );
      return valuePlan(field, { type: 'multipleSelect', options: { choices } }, (value) => {
        const names = listOf(value);
        const ids = names.map((name) => byName.get(name));
        return ids.every((id) => id !== undefined) ? ids : names.join(', ');
      });
    }
    case 'GeoData':
      return valuePlan(field, { type: 'location', options: {} }, (value) => {
        if (typeof value !== 'string') return value ?? null;
        const [lat, lng] = value.split(';').map(Number);
        return { lat, lng };
      });
    case 'JSON':
      return valuePlan(field, { type: 'json', options: {} }, (value) =>
        typeof value === 'string'
          ? value
          : value === null || value === undefined
            ? null
            : JSON.stringify(value),
      );
    case 'Attachment':
      return filesPlan(field, (value) => attachmentsOf(value, context));
    case 'User':
      return peoplePlan(field, emailsOf, on(meta.is_multi));
    case 'CreatedBy':
    case 'LastModifiedBy':
      return peoplePlan(field, emailsOf, false, [note('changed', 'import.platform.report.peopleFixed')]);
    case 'Barcode':
    case 'QrCode':
      return valuePlan(field, { type: 'text', options: {} }, asText, [
        note('changed', 'import.platform.report.codeText'),
      ]);
    case 'SpecificDBType':
    case 'Geometry':
      return valuePlan(field, { type: 'text', options: {} }, (value) =>
        typeof value === 'string'
          ? value
          : value === null || value === undefined
            ? null
            : JSON.stringify(value),
      );
    case 'Links':
    case 'LinkToAnotherRecord': {
      const related = context.tables.get(text(options, 'fk_related_model_id') ?? '');
      if (!related) return omitted(field, 'import.platform.report.linkMissing');
      const key = keyOf(related);
      const type = text(options, 'type');
      const single = type === 'bt' || type === 'oo';
      // NocoDB's record lists give a count for many-record links, and the record itself for the rest.
      const read =
        column.uidt === 'LinkToAnotherRecord' || single
          ? (value: unknown) =>
              (Array.isArray(value) ? value : [value]).flatMap((item) =>
                isRecord(item) && key && item[key.title] !== undefined && item[key.title] !== null
                  ? [String(item[key.title])]
                  : [],
              )
          : null;
      return linkPlan(field, related.id, inverseOf(column, context), single, read);
    }
    case 'Lookup': {
      const link = text(options, 'fk_relation_column_id');
      const target = text(options, 'fk_lookup_column_id');
      return link && target
        ? valuePlan(field, { type: 'text', options: {} }, asText, [], { kind: 'lookup', link, target })
        : valuePlan(field, { type: 'text', options: {} }, asText, [
            note('changed', 'import.platform.report.relationText'),
          ]);
    }
    case 'Rollup': {
      const link = text(options, 'fk_relation_column_id');
      const target = text(options, 'fk_rollup_column_id');
      const fn = ROLLUPS[(text(options, 'rollup_function') ?? '').toLowerCase()];
      const spec = {
        type: 'number',
        options: { precision: null, thousands: true, allowNegative: true },
      } as const;
      return link && target && fn
        ? valuePlan(field, spec, asNumber, [], { kind: 'rollup', link, target, fn })
        : valuePlan(field, spec, asNumber, [
            note('changed', 'import.platform.report.rollupUnknown', {
              fn: text(options, 'rollup_function') ?? '',
            }),
          ]);
    }
    case 'Formula': {
      const source = text(options, 'formula_raw') ?? text(options, 'formula') ?? '';
      const written = riosomaFormula(source, RENAMES);
      const tree = isRecord(options.parsed_tree) ? options.parsed_tree : {};
      const numeric = tree.dataType === 'numeric';
      return valuePlan(
        field,
        numeric
          ? { type: 'number', options: { precision: null, thousands: true, allowNegative: true } }
          : { type: 'text', options: {} },
        numeric ? asNumber : asText,
        [],
        {
          kind: 'formula',
          shown: source,
          expression: written.expression,
          ...(text(options, 'error')
            ? { problem: 'invalid' as const }
            : written.problem
              ? { problem: written.problem }
              : {}),
          functions: written.functions,
          options: formulaOptions(),
        },
      );
    }
    case 'Button':
      return omitted(field, 'import.platform.report.button');
    default:
      return omitted(field, 'import.platform.report.typeUnsupported', { type: column.uidt.slice(0, 64) });
  }
}

class NocoSource implements PlatformSource {
  readonly platform = 'nocodb' as const;
  private readonly tables = new Map<string, TableMeta>();

  constructor(
    private readonly client: PlatformClient,
    private readonly address: string,
    private readonly baseId: string,
  ) {}

  private async all<T>(path: string, item: z.ZodType<T>): Promise<T[]> {
    const found: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.client.json(path, pageOf(item), { query: { limit: PAGE, offset } });
      found.push(...(page.list as T[]));
      if (page.pageInfo?.isLastPage !== false || page.list.length < PAGE) return found;
    }
  }

  private async filters(
    viewId: string,
    columns: ReadonlyMap<string, Column>,
  ): Promise<{ filter: SourceFilter | null; unmatched: number }> {
    const top = await this.client.json(`/api/v2/meta/views/${viewId}/filters`, pageOf(Filter));
    let dropped = 0;
    const group = async (
      items: Filter[],
      conjunction: 'and' | 'or',
      depth: number,
    ): Promise<SourceFilter> => {
      const conditions: SourceFilter['conditions'] = [];
      for (const item of items) {
        if (item.enabled !== undefined && item.enabled !== null && !on(item.enabled)) continue;
        if (on(item.is_group)) {
          const children =
            depth < 3
              ? (await this.client.json(`/api/v2/meta/filters/${item.id}/children`, pageOf(Filter))).list
              : [];
          const nested = await group(children, item.logical_op === 'or' ? 'or' : 'and', depth + 1);
          if (nested.conditions.length) conditions.push(nested);
          continue;
        }
        const column = columns.get(item.fk_column_id ?? '');
        const made = column ? conditionOf(item, column) : null;
        if (made) conditions.push(made);
        else dropped++;
      }
      return { conjunction, conditions };
    };
    // NocoDB joins a view's top conditions the way its second one says, and the first says nothing.
    const joined = top.list.slice(1).some((item) => item.logical_op === 'or') ? 'or' : 'and';
    const built = await group(top.list, joined, 1);
    return { filter: built.conditions.length ? built : null, unmatched: dropped };
  }

  private async view(view: View, table: TableMeta): Promise<SourceView> {
    const known = VIEWS[view.type];
    const columns = new Map(table.columns.map((column) => [column.id, column]));
    const details = view.view ?? {};
    const notes: Note[] = [];
    const base: SourceView = {
      id: view.id,
      name: view.title,
      type: known?.name ?? `view type ${view.type}`,
      kind: known?.kind ?? null,
      notes,
    };
    if (!known) return base;
    if (known.kind === 'form') {
      const form = await this.client.json(`/api/v2/meta/forms/${view.id}`, Form);
      return {
        ...base,
        questions: form.columns
          .filter((column) => on(column.show))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((column) => ({
            field: column.fk_column_id,
            required: on(column.required),
            label: column.label ?? '',
            help: column.help ?? column.description ?? '',
          })),
        form: {
          title: form.heading ?? view.title,
          description: form.subheading ?? '',
          submitLabel: '',
          thankYou: form.success_msg ?? '',
        },
      };
    }
    const shown = await this.client.json(`/api/v2/meta/views/${view.id}/columns`, pageOf(ViewColumn));
    const visible = shown.list
      .filter((column) => on(column.show))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((column) => column.fk_column_id);
    if (shown.list.some((column) => on(column.group_by)))
      notes.push(note('omitted', 'import.platform.report.viewGroupDropped'));
    const sorts = await this.client.json(`/api/v2/meta/views/${view.id}/sorts`, pageOf(Sort));
    const range =
      Array.isArray(details.calendar_range) && isRecord(details.calendar_range[0])
        ? details.calendar_range[0]
        : {};
    return {
      ...base,
      shown: visible,
      ...(await this.filters(view.id, columns)),
      sorts: sorts.list.map((sort) => ({
        field: sort.fk_column_id,
        direction: sort.direction === 'desc' ? 'desc' : 'asc',
      })),
      group: text(details, 'fk_grp_col_id'),
      cover: text(details, 'fk_cover_image_col_id'),
      start: text(details, 'fk_geo_data_col_id') ?? text(range, 'fk_from_column_id'),
      end: text(range, 'fk_to_column_id'),
    };
  }

  async schema(): Promise<SourceSchema> {
    const listed = await this.all(`/api/v2/meta/bases/${this.baseId}/tables`, TableListing);
    for (const item of listed) {
      if (on(item.mm)) continue;
      this.tables.set(item.id, await this.client.json(`/api/v2/meta/tables/${item.id}`, TableMeta));
    }
    const tables: SourceTable[] = [];
    for (const meta of this.tables.values()) {
      const context: Context = {
        tables: this.tables,
        table: meta,
        address: this.address,
        headers: () => this.client.headers(),
      };
      const fields = meta.columns.flatMap((column) => {
        const plan = planColumn(column, context);
        return plan ? [plan] : [];
      });
      const views = await this.client.json(`/api/v2/meta/tables/${meta.id}/views`, pageOf(View));
      const primary = meta.columns.find((column) => on(column.pv)) ?? null;
      tables.push({
        id: meta.id,
        name: meta.title,
        description: meta.description ?? null,
        primary: primary?.id ?? null,
        fields,
        views: await Promise.all(views.list.map((view) => this.view(view, meta))),
        notes: [],
      });
    }
    return { tables, notes: [] };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const meta = this.tables.get(table.id)!;
    const key = keyOf(meta);
    const titles = new Map(meta.columns.map((column) => [column.title, column.id]));
    let position = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.client.json(`/api/v2/tables/${meta.id}/records`, Records, {
        query: { limit: PAGE, offset },
      });
      yield page.list.map((row) => {
        const values: Record<string, unknown> = {};
        for (const [title, value] of Object.entries(row)) {
          const id = titles.get(title);
          if (id) values[id] = value;
        }
        position++;
        return {
          id: key && row[key.title] !== undefined ? String(row[key.title]) : `row${position}`,
          values,
        };
      });
      if (page.pageInfo?.isLastPage !== false || page.list.length < PAGE) return;
    }
  }

  async *links(
    table: SourceTable,
    link: Extract<FieldPlan, { kind: 'link' }>,
    ids: readonly string[],
  ): AsyncGenerator<Array<{ record: string; targets: string[] }>> {
    const related = this.tables.get(link.linkedTable);
    const key = related ? keyOf(related) : null;
    if (!key) return;
    let batch: Array<{ record: string; targets: string[] }> = [];
    for (const record of ids) {
      const targets: string[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await this.client.json(
          `/api/v2/tables/${table.id}/links/${link.source.id}/records/${encodeURIComponent(record)}`,
          Records,
          { query: { limit: PAGE, offset } },
        );
        for (const item of page.list)
          if (item[key.title] !== undefined) targets.push(String(item[key.title]));
        if (page.pageInfo?.isLastPage !== false || page.list.length < PAGE) break;
      }
      batch.push({ record, targets });
      if (batch.length >= 100) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  }
}

export const nocodbReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({ credentials: () => ({ 'xc-token': token }), secrets: () => [token] });
  return {
    async bases() {
      try {
        const page = await client.json('/api/v2/meta/bases', pageOf(Base), { purpose: 'list' });
        return page.list.map((base) => ({ id: base.id, name: base.title, group: null }));
      } catch (error) {
        // NocoDB's hosted service lists bases by workspace.
        const workspaces = await client
          .json('/api/v2/meta/workspaces', pageOf(Workspace), { purpose: 'list' })
          .catch(() => {
            throw error;
          });
        const bases = [];
        for (const workspace of workspaces.list) {
          const page = await client.json(`/api/v2/meta/workspaces/${workspace.id}/bases`, pageOf(Base), {
            purpose: 'list',
          });
          bases.push(
            ...page.list.map((base) => ({ id: base.id, name: base.title, group: workspace.title ?? null })),
          );
        }
        return bases;
      }
    },
    kept: async () => context.credential,
    source: (baseId) => new NocoSource(client, context.address, baseId),
  };
};

import {
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
  asNumber,
  asText,
  asTrimmed,
  choicesOf,
  colorOfHex,
  dateFormatOf,
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
import type { ClientCredentials, ReaderFactory } from '../importer.js';
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
 * SeaTable, through the API gateway its own API token opens.  The token is for one base, and
 * exchanging it for a base token answers with that base's ID and name, which is the whole list an
 * import can offer.  One metadata answer holds every table with its columns and views, rows come a
 * page at a time, and the records a link holds come from the link query, since a row's link column
 * stops at fifty of them.  Files are fetched through the download link SeaTable signs for each one,
 * which the reader asks for a page at a time, before the page is read.
 */

const PAGE = 200;
/** Linked records asked for at once, for one row of one link column */
const LINKS_PER_ROW = 1_000;
/** Rows a link query is asked about at once */
const LINK_ROWS = 50;

const Data = z.record(z.string(), z.unknown()).nullish();
const MetaColumn = z.object({
  key: z.string().min(1),
  name: z.string(),
  type: z.string(),
  data: Data,
});
type MetaColumn = z.infer<typeof MetaColumn>;
const Filter = z.object({
  column_key: z.string().nullish(),
  filter_predicate: z.string().nullish(),
  filter_term: z.unknown(),
  filter_term_modifier: z.string().nullish(),
});
type Filter = z.infer<typeof Filter>;
const MetaView = z.object({
  _id: z.string().min(1),
  name: z.string(),
  type: z.string().nullish(),
  filter_conjunction: z.string().nullish(),
  filters: z.array(Filter).default([]),
  sorts: z.array(z.object({ column_key: z.string(), sort_type: z.string().nullish() })).default([]),
  groupbys: z.array(z.object({ column_key: z.string(), sort_type: z.string().nullish() })).default([]),
  hidden_columns: z.array(z.string()).default([]),
  colors: z.unknown().nullish(),
  column_colors: z.unknown().nullish(),
});
type MetaView = z.infer<typeof MetaView>;
const MetaTable = z.object({
  _id: z.string().min(1),
  name: z.string(),
  columns: z.array(MetaColumn).default([]),
  views: z.array(MetaView).default([]),
});
type MetaTable = z.infer<typeof MetaTable>;
const Metadata = z.object({ metadata: z.object({ tables: z.array(MetaTable).default([]) }) });
const Rows = z.object({ rows: z.array(z.record(z.string(), z.unknown())).default([]) });
const RelatedUsers = z.object({
  user_list: z
    .array(
      z.object({
        email: z.string(),
        name: z.string().nullish(),
        contact_email: z.string().nullish(),
      }),
    )
    .default([]),
});
const AccessToken = z.object({
  access_token: z.string().min(1),
  dtable_uuid: z.string().min(1),
  dtable_name: z.string().nullish(),
});
const DownloadLink = z.object({ download_link: z.string().min(1) });
const LinkedRows = z.record(
  z.string(),
  z.array(z.object({ row_id: z.string(), display_value: z.unknown().nullish() })).nullish(),
);

const text = (data: Record<string, unknown> | null | undefined, key: string) =>
  typeof data?.[key] === 'string' ? (data[key] as string) : null;

/** SeaTable's number column formats that name a currency of their own */
const CURRENCIES: Readonly<Record<string, string>> = { dollar: '$', euro: '€', yuan: '¥' };

/** SeaTable's rating icons, as Riosoma names the ones it has */
const RATE_ICONS: Readonly<Record<string, 'star' | 'heart' | 'thumbsUp' | 'flag'>> = {
  'dtable-icon-rate': 'star',
  'dtable-icon-like': 'thumbsUp',
  'dtable-icon-praise': 'heart',
  'dtable-icon-flag': 'flag',
};

/** Functions SeaTable calls by other names, as Riosoma names them */
const RENAMES: Readonly<Record<string, string>> = {
  DATETIMEDIFF: 'DATETIME_DIFF',
  DATETIMEFORMAT: 'DATETIME_FORMAT',
  DATETIMEPARSE: 'DATETIME_PARSE',
  CREATEDTIME: 'CREATED_TIME',
  LASTMODIFIEDTIME: 'LAST_MODIFIED_TIME',
  RECORDID: 'RECORD_ID',
  ISBEFORE: 'IS_BEFORE',
  ISAFTER: 'IS_AFTER',
  ISSAME: 'IS_SAME',
  SETTIMEZONE: 'SET_TIMEZONE',
  WORKDAYDIFF: 'WORKDAY_DIFF',
  REGEXMATCH: 'REGEX_MATCH',
  REGEXEXTRACT: 'REGEX_EXTRACT',
  REGEXREPLACE: 'REGEX_REPLACE',
  ENCODEURLCOMPONENT: 'ENCODE_URL_COMPONENT',
};

/** How SeaTable's kinds of view come across.  Its boards, calendars, and galleries are apps of their own. */
const VIEWS: Readonly<Record<string, ViewType>> = { table: 'grid' };

const TEXT_OPERATORS: Readonly<Record<string, Operator>> = {
  contains: 'contains',
  does_not_contain: 'doesNotContain',
  is: 'is',
  is_not: 'isNot',
  is_empty: 'isEmpty',
  is_not_empty: 'isNotEmpty',
};
const NUMBER_OPERATORS: Readonly<Record<string, Operator>> = {
  ...TEXT_OPERATORS,
  equal: 'eq',
  not_equal: 'neq',
  less: 'lt',
  greater: 'gt',
  less_or_equal: 'lte',
  greater_or_equal: 'gte',
};
const SELECT_OPERATORS: Readonly<Record<string, Operator>> = {
  ...TEXT_OPERATORS,
  is_any_of: 'isAnyOf',
  is_none_of: 'isNoneOf',
};
const MULTI_OPERATORS: Readonly<Record<string, Operator>> = {
  ...TEXT_OPERATORS,
  has_any_of: 'hasAnyOf',
  has_all_of: 'hasAllOf',
  has_none_of: 'hasNoneOf',
  is_exactly: 'isExactly',
};
const DATE_OPERATORS: Readonly<Record<string, Operator>> = {
  ...TEXT_OPERATORS,
  is_before: 'isBefore',
  is_after: 'isAfter',
  is_on_or_before: 'isOnOrBefore',
  is_on_or_after: 'isOnOrAfter',
  is_within: 'isWithin',
};

/** Days a condition picks out, by the modifier SeaTable's date filter writes */
type DayMode =
  'today' | 'tomorrow' | 'yesterday' | 'oneWeekAgo' | 'oneWeekFromNow' | 'oneMonthAgo' | 'oneMonthFromNow';

const TARGETS: Readonly<Record<string, DayMode>> = {
  today: 'today',
  tomorrow: 'tomorrow',
  yesterday: 'yesterday',
  one_week_ago: 'oneWeekAgo',
  one_week_from_now: 'oneWeekFromNow',
  one_month_ago: 'oneMonthAgo',
  one_month_from_now: 'oneMonthFromNow',
};

/** Periods an `is_within` condition picks out */
type PeriodMode = 'pastWeek' | 'pastMonth' | 'pastYear' | 'nextWeek' | 'nextMonth' | 'nextYear';

const RANGES: Readonly<Record<string, PeriodMode>> = {
  the_past_week: 'pastWeek',
  the_past_month: 'pastMonth',
  the_past_year: 'pastYear',
  the_next_week: 'nextWeek',
  the_next_month: 'nextMonth',
  the_next_year: 'nextYear',
};

/** Counts of days an `is_within` condition picks out */
const COUNTED_RANGES: Readonly<Record<string, 'pastDays' | 'nextDays'>> = {
  the_past_numbers_of_days: 'pastDays',
  the_next_numbers_of_days: 'nextDays',
};

/** Durations, by the format SeaTable writes them with */
const DURATIONS: Readonly<Record<string, 'h:mm' | 'h:mm:ss' | 'h:mm:ss.s' | 'h:mm:ss.ss' | 'h:mm:ss.sss'>> = {
  'h:mm': 'h:mm',
  'h:mm:ss': 'h:mm:ss',
  'h:mm:ss.s': 'h:mm:ss.s',
  'h:mm:ss.ss': 'h:mm:ss.ss',
  'h:mm:ss.sss': 'h:mm:ss.sss',
};

interface Context {
  /** Every table in the base, by SeaTable's ID for it */
  tables: ReadonlyMap<string, MetaTable>;
  /** A column of this table, by its key or its name, since SeaTable's formulas and links use both */
  column(reference: string): MetaColumn | undefined;
  /** A column of the table a link column links to, by its key or its name */
  linked(link: MetaColumn, reference: string): MetaColumn | undefined;
  /** The column on the other side of a link, by its key, or null when the link is one way */
  inverse(column: MetaColumn): string | null;
  /** A person's email address or name, by the ID SeaTable's cells hold */
  people: ReadonlyMap<string, string>;
  /** The address a file's path downloads from, which the reader asked SeaTable for */
  fileUrl(path: string): string | null;
  address: string;
}

function assetPath(path: string): boolean {
  return safeAttachmentPath(path) && /^\/workspace\/[^/]+\/asset\/[^/]+\/(files|images)\/.+/.test(path);
}

function attachmentPath(path: string): boolean {
  return assetPath(path) || /^\/(seafhttp\/files|media)\/.+/.test(path);
}

/** SeaTable writes its own times without a zone, and they are UTC. */
function asUtc(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim());
  const instant = Date.parse(naive ? `${value.trim().replace(' ', 'T')}Z` : value);
  return Number.isNaN(instant) ? value : new Date(instant).toISOString();
}

/** The files a cell names, as the paths or addresses SeaTable keeps them at. */
function fileItems(value: unknown): Array<{ path: string; name: string | null; size: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') {
      const path = item.trim();
      return { path, name: path.split('/').filter(Boolean).pop() ?? null, size: null };
    }
    if (!isRecord(item)) return { path: '', name: null, size: null };
    const path = text(item, 'url') ?? text(item, 'path') ?? '';
    const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : null;
    return { path, name: text(item, 'name') ?? path.split('/').filter(Boolean).pop() ?? null, size };
  });
}

/** The people a cell names, from the IDs SeaTable holds and the collaborators it listed. */
function peopleOf(value: unknown, people: ReadonlyMap<string, string>): string[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return list.flatMap((person) => {
    const id = typeof person === 'string' ? person.trim() : isRecord(person) ? text(person, 'email') : null;
    if (!id) return [];
    return [people.get(id) ?? id];
  });
}

/** A computed column's cell, which SeaTable sends as the result alone. */
function resultText(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : textOf(value);
}

/** How one SeaTable column comes across. */
export function planColumn(column: MetaColumn, context: Context): FieldPlan {
  const source = { id: column.key, name: column.name, description: null };
  const data = column.data ?? {};
  switch (column.type) {
    case 'text':
    case 'default':
      return valuePlan(source, { type: 'text', options: {} }, asText);
    case 'long-text':
      // SeaTable's long text is Markdown, which is how rich text is kept here.
      return valuePlan(source, { type: 'longText', options: { richText: true } }, asText);
    case 'url':
      return valuePlan(source, { type: 'url', options: {} }, asTrimmed);
    case 'email':
      return valuePlan(source, { type: 'email', options: {} }, asTrimmed);
    case 'number': {
      const format = text(data, 'format') ?? '';
      const thousands = !['', 'no'].includes(text(data, 'thousands') ?? '');
      // SeaTable shows a set number of decimal places only when the column asks for one.
      const precision = data.enable_precision === true ? (precisionOf(data.precision) ?? 2) : null;
      if (format === 'percent')
        return valuePlan(
          source,
          { type: 'percent', options: { precision: precision ?? 0, allowNegative: true } },
          asNumber,
        );
      const symbol =
        format === 'custom_currency' ? (text(data, 'currency_symbol') ?? '') : (CURRENCIES[format] ?? '');
      const code = currencyCode(symbol);
      if (symbol && code)
        return valuePlan(
          source,
          { type: 'currency', options: { code, precision: precision ?? 2, allowNegative: true } },
          asNumber,
        );
      return valuePlan(
        source,
        { type: 'number', options: { precision, thousands, allowNegative: true } },
        asNumber,
        symbol ? [note('changed', 'import.platform.report.currencyUnknown', { symbol })] : [],
      );
    }
    case 'date': {
      const format = text(data, 'format') ?? '';
      const includeTime = /HH:mm/.test(format);
      return valuePlan(
        source,
        {
          type: 'date',
          options: {
            includeTime,
            dateFormat: dateFormatOf(format),
            timeFormat: includeTime ? '24h' : 'local',
            timeZone: 'client',
          },
        },
        includeTime ? asUtc : asDay,
      );
    }
    case 'ctime':
    case 'mtime':
      return valuePlan(
        source,
        {
          type: 'date',
          options: { includeTime: true, dateFormat: 'iso', timeFormat: 'local', timeZone: 'client' },
        },
        asUtc,
        [note('changed', 'import.platform.report.timeFixed')],
      );
    case 'duration':
      return valuePlan(
        source,
        {
          type: 'duration',
          options: { format: DURATIONS[text(data, 'duration_format') ?? ''] ?? 'h:mm' },
        },
        asNumber,
      );
    case 'checkbox':
      return valuePlan(source, { type: 'checkbox', options: { color: 'green' } }, asCheck);
    case 'rate': {
      const max = Math.min(10, Math.max(1, precisionOf(data.rate_max_number, 10) ?? 5));
      const icon = RATE_ICONS[text(data, 'rate_style_type') ?? ''];
      return valuePlan(
        source,
        {
          type: 'rating',
          options: { max, icon: icon ?? 'star', color: colorOfHex(data.rate_style_color ?? '#ffb114') },
        },
        (value) => (value === 0 ? null : asNumber(value)),
        icon
          ? []
          : [
              note('changed', 'import.platform.report.ratingIcon', {
                icon: (text(data, 'rate_style_type') ?? '').slice(0, 32),
              }),
            ],
      );
    }
    case 'single-select':
    case 'multiple-select': {
      const raw = Array.isArray(data.options) ? data.options : [];
      const { choices, byName } = choicesOf(
        raw.flatMap((item) =>
          isRecord(item) && typeof item.name === 'string'
            ? [{ name: item.name, color: colorOfHex(item.color) }]
            : [],
        ),
      );
      if (column.type === 'single-select')
        return valuePlan(source, { type: 'singleSelect', options: { choices } }, (value) =>
          typeof value === 'string' ? (byName.get(value) ?? value) : (value ?? null),
        );
      return valuePlan(source, { type: 'multipleSelect', options: { choices } }, (value) => {
        const names = Array.isArray(value)
          ? value.map(String)
          : typeof value === 'string' && value !== ''
            ? [value]
            : [];
        const ids = names.map((name) => byName.get(name));
        return ids.every((id) => id !== undefined) ? ids : names.join(', ');
      });
    }
    case 'image':
    case 'file':
      return filesPlan(source, (value) =>
        fileItems(value).flatMap((item): Attachment[] => {
          if (!item.path) return [{ url: '', filename: item.name, size: item.size, problem: 'failed' }];
          // An image can also be an address of its own, which needs no link from SeaTable.
          const direct = /^https?:\/\//i.test(item.path);
          if (!direct && !assetPath(item.path))
            return [{ url: '', filename: item.name, size: item.size, problem: 'blocked' }];
          const url = direct ? item.path : context.fileUrl(item.path);
          if (!url) return [{ url: '', filename: item.name, size: item.size, problem: 'failed' }];
          return [
            platformAttachment(
              context.address,
              { url, filename: item.name, size: item.size },
              attachmentPath,
            ),
          ];
        }),
      );
    case 'collaborator':
      return peoplePlan(source, (value) => peopleOf(value, context.people), true);
    case 'creator':
    case 'last-modifier':
      return peoplePlan(source, (value) => peopleOf(value, context.people), false, [
        note('changed', 'import.platform.report.peopleFixed'),
      ]);
    case 'auto-number': {
      const prefix = text(data, 'prefix') ?? '';
      const dated = data.prefix_type === 'date';
      // A number here only while SeaTable wrote plain numbers, so new records can be numbered the same way.
      return prefix || dated
        ? valuePlan(source, { type: 'text', options: {} }, asText, [
            dated
              ? note('changed', 'import.platform.report.autoNumberDateText')
              : note('changed', 'import.platform.report.autoNumberText', { prefix: prefix.slice(0, 32) }),
          ])
        : valuePlan(
            source,
            { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
            asNumber,
            [],
            { kind: 'autoNumber' },
          );
    }
    case 'geolocation': {
      if (text(data, 'geo_format') === 'country_region')
        return valuePlan(
          source,
          { type: 'text', options: {} },
          (value) =>
            isRecord(value) ? (text(value, 'country_region') ?? resultText(value)) : resultText(value),
          [note('changed', 'import.platform.report.placeText')],
        );
      return valuePlan(source, { type: 'location', options: {} }, (value) => {
        if (!isRecord(value)) return value ?? null;
        const lat = typeof value.lat === 'number' ? value.lat : Number(value.lat);
        const lng = typeof value.lng === 'number' ? value.lng : Number(value.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      });
    }
    case 'department-single-select':
      // The departments SeaTable names them by are the server's own, and it shares no list of them here.
      return valuePlan(source, { type: 'text', options: {} }, asText, [
        note('changed', 'import.platform.report.departmentText'),
      ]);
    case 'link': {
      const other = text(data, 'other_table_id') ?? '';
      if (!context.tables.has(other)) return omitted(source, 'import.platform.report.linkMissing');
      return linkPlan(source, other, context.inverse(column), data.is_multiple === false, null);
    }
    case 'formula': {
      const formula = text(data, 'formula') ?? '';
      const written = riosomaFormula(formula, RENAMES);
      return valuePlan(source, { type: 'text', options: {} }, resultText, [], {
        kind: 'formula',
        shown: formula,
        expression: written.expression,
        ...(written.problem ? { problem: written.problem } : {}),
        functions: written.functions,
        options: formulaOptions(),
      });
    }
    case 'link-formula':
      return linkFormula(column, context, source);
    case 'button':
      return omitted(source, 'import.platform.report.button');
    case 'digital-sign':
      return omitted(source, 'import.platform.report.signatureLeft');
    default:
      return omitted(source, 'import.platform.report.typeUnsupported', { type: column.type.slice(0, 64) });
  }
}

/**
 * A column that reads linked records: SeaTable's count of them, a lookup through them, a rollup of
 * one of their columns, or the one of them its `findmax` and `findmin` pick, which has no match here.
 */
function linkFormula(
  column: MetaColumn,
  context: Context,
  source: { id: string; name: string; description: null },
): FieldPlan {
  const data = column.data ?? {};
  const kind = text(data, 'formula') ?? '';
  const link = context.column(text(data, 'link_column') ?? '');
  const numberSpec: FieldSpec = {
    type: 'number',
    options: { precision: null, thousands: true, allowNegative: true },
  };
  const textSpec: FieldSpec = { type: 'text', options: {} };
  // A rollup counts or adds, so its values are numbers; the rest hold whatever they picked.
  const numeric = kind === 'rollup' || kind === 'count_links';
  const kept = (notes: Note[] = []) =>
    valuePlan(source, numeric ? numberSpec : textSpec, numeric ? asNumber : resultText, [
      ...notes,
      note('changed', 'import.platform.report.linkFormulaKept', { kind: kind.slice(0, 32) }),
    ]);
  if (!link || link.type !== 'link') return kept();
  if (kind === 'count_links')
    return valuePlan(source, numberSpec, asNumber, [], { kind: 'count', link: link.key });
  if (kind === 'lookup') {
    // A second hop reads through a link of the linked table, which lookups here don't do.
    const target = context.linked(link, text(data, 'level1_linked_column') ?? '');
    return target && !data.level2_linked_column
      ? valuePlan(source, textSpec, resultText, [], {
          kind: 'lookup',
          link: link.key,
          target: target.key,
        })
      : kept();
  }
  if (kind === 'rollup') {
    const target = context.linked(link, text(data, 'summary_column') ?? '');
    const method = text(data, 'summary_method') ?? '';
    const fn: RollupFunction | undefined = ROLLUPS[method.toLowerCase()];
    if (target && fn)
      return valuePlan(source, numberSpec, asNumber, [], {
        kind: 'rollup',
        link: link.key,
        target: target.key,
        fn,
      });
    return target
      ? valuePlan(source, numberSpec, asNumber, [
          note('changed', 'import.platform.report.rollupUnknown', { fn: method }),
        ])
      : kept();
  }
  return kept();
}

/** One of SeaTable's view filters as a condition here, or null when there's none like it. */
export function conditionOf(filter: Filter, column: MetaColumn): SourceCondition | null {
  const predicate = (filter.filter_predicate ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const field = column.key;
  const operators =
    column.type === 'single-select'
      ? SELECT_OPERATORS
      : column.type === 'multiple-select'
        ? MULTI_OPERATORS
        : column.type === 'date' || column.type === 'ctime' || column.type === 'mtime'
          ? DATE_OPERATORS
          : column.type === 'link'
            ? TEXT_OPERATORS
            : NUMBER_OPERATORS;
  const operator = operators[predicate];
  if (!operator) return null;
  if (operator === 'isEmpty' || operator === 'isNotEmpty')
    return { field, operator, value: { kind: 'none' } };
  const term = filter.filter_term;
  const modifier = filter.filter_term_modifier ?? '';
  // Conditions that read a cell as the text it holds, which is all some columns become here.
  const words = ['is', 'isNot', 'contains', 'doesNotContain'];
  const wordsOnly =
    words.includes(operator) && typeof term === 'string'
      ? { field, operator, value: { kind: 'text' as const, text: term } }
      : null;
  switch (column.type) {
    case 'text':
    case 'default':
    case 'long-text':
    case 'url':
    case 'email':
    case 'link':
      return wordsOnly;
    case 'number':
    case 'duration':
    case 'rate': {
      const value = typeof term === 'number' ? term : Number(term);
      return ['eq', 'neq', 'lt', 'gt', 'lte', 'gte'].includes(operator) && Number.isFinite(value)
        ? { field, operator, value: { kind: 'number', number: value } }
        : null;
    }
    case 'checkbox':
      return operator === 'is'
        ? {
            field,
            operator,
            value: { kind: 'boolean', value: term === true || term === 'true' || term === '1' },
          }
        : null;
    case 'single-select':
    case 'multiple-select': {
      const names = (Array.isArray(term) ? term : typeof term === 'string' ? term.split(',') : [])
        .map((item) => String(item).trim())
        .filter(Boolean);
      return names.length ? { field, operator, value: { kind: 'choices', names } } : null;
    }
    case 'date':
    case 'ctime':
    case 'mtime': {
      const named = modifier || (typeof term === 'string' ? term.trim() : '');
      const days = Number(term);
      if (operator === 'isWithin') {
        const period = RANGES[named];
        if (period) return { field, operator, value: { kind: 'range', range: { mode: period } } };
        const counted = COUNTED_RANGES[named];
        return counted && Number.isInteger(days) && days >= 1
          ? { field, operator, value: { kind: 'range', range: { mode: counted, days } } }
          : null;
      }
      const target = TARGETS[named];
      if (target) return { field, operator, value: { kind: 'date', target: { mode: target } } };
      if (named === 'number_of_days_ago' || named === 'number_of_days_from_now')
        return Number.isInteger(days) && days >= 0
          ? {
              field,
              operator,
              value: {
                kind: 'date',
                target: { mode: named === 'number_of_days_ago' ? 'daysAgo' : 'daysFromNow', days },
              },
            }
          : null;
      return named === 'exact_date' && /^\d{4}-\d{2}-\d{2}/.test(String(term))
        ? {
            field,
            operator,
            value: { kind: 'date', target: { mode: 'exactDate', date: String(term).slice(0, 10) } },
          }
        : null;
    }
    // Columns whose values are text here, whatever SeaTable computed or filled in for them.
    case 'formula':
    case 'link-formula':
    case 'creator':
    case 'last-modifier':
    case 'auto-number':
      return wordsOnly;
    default:
      return null;
  }
}

/** One of SeaTable's views as a view here, with what its settings can't carry across. */
export function viewOf(view: MetaView, columns: ReadonlyMap<string, MetaColumn>): SourceView {
  const kind = VIEWS[view.type ?? 'table'] ?? null;
  const notes: Note[] = [];
  const base: SourceView = { id: view._id, name: view.name, type: view.type ?? 'table', kind, notes };
  if (!kind) return base;
  const conditions: SourceCondition[] = [];
  let unmatched = 0;
  for (const filter of view.filters) {
    const column = columns.get(filter.column_key ?? '');
    const made = column ? conditionOf(filter, column) : null;
    if (made) conditions.push(made);
    else unmatched++;
  }
  // A grid here doesn't color records, so what SeaTable's view did is left behind.  Its grouping
  // is left to the view builder, which says so once.
  const colored = (value: unknown) => isRecord(value) && Object.keys(value).length > 0;
  if (colored(view.colors) || colored(view.column_colors))
    notes.push(note('omitted', 'import.platform.report.viewColors'));
  const hidden = new Set(view.hidden_columns);
  return {
    ...base,
    shown: [...columns.values()].filter((column) => !hidden.has(column.key)).map((column) => column.key),
    filter: conditions.length
      ? {
          conjunction: view.filter_conjunction === 'Or' ? ('or' as const) : ('and' as const),
          conditions: conditions as SourceFilter['conditions'],
        }
      : null,
    unmatched,
    sorts: view.sorts.map((sort) => ({
      field: sort.column_key,
      direction: sort.sort_type === 'down' ? ('desc' as const) : ('asc' as const),
    })),
    group: view.groupbys[0]?.column_key ?? null,
    cover: null,
    start: null,
    end: null,
  };
}

/** The base token every call to SeaTable's own API reads with, made from the API token given. */
class Session implements ClientCredentials {
  access: string | null = null;
  uuid = '';
  name = '';
  client!: PlatformClient;
  authentication!: PlatformClient;

  constructor(private readonly token: string) {}

  credentials(): Record<string, string> {
    return this.access ? { authorization: `Bearer ${this.access}` } : {};
  }

  secrets(): string[] {
    return [...(this.access ? [this.access] : []), this.token];
  }

  /** A base token, which lasts three days, and the base's own ID and name that come with it. */
  refresh = async (): Promise<boolean> => {
    const answer = await this.authentication.json('/api/v2.1/dtable/app-access-token/', AccessToken, {
      purpose: 'list',
    });
    this.access = answer.access_token;
    this.uuid = this.client.scrub(answer.dtable_uuid);
    this.name = this.client.scrub(answer.dtable_name ?? '');
    return true;
  };

  async ready(): Promise<void> {
    if (!this.access) await this.refresh();
  }
}

class SeaTableSource implements PlatformSource {
  readonly platform = 'seatable' as const;
  private readonly tables = new Map<string, MetaTable>();
  private readonly people = new Map<string, string>();
  /** Download links by the path a cell names */
  private readonly files = new Map<string, string>();
  /** Paths a link was already asked for, whether it answered or not */
  private readonly asked = new Set<string>();

  constructor(
    private readonly client: PlatformClient,
    private readonly session: Session,
    private readonly baseId: string,
    private readonly address: string,
  ) {}

  private url(path: string): string {
    return `/api-gateway/api/v2/dtables/${this.baseId}${path}`;
  }

  private fileUrl(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  /** Asks SeaTable for a download link for each file a page of rows names, once per file. */
  private async resolveFiles(table: MetaTable, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const columns = table.columns.filter((column) => column.type === 'image' || column.type === 'file');
    if (!columns.length) return;
    const paths = new Set<string>();
    for (const row of rows)
      for (const column of columns)
        for (const item of fileItems(row[column.key]))
          if (assetPath(item.path) && !this.asked.has(item.path)) paths.add(item.path);
    for (const path of [...paths]) {
      this.asked.add(path);
      try {
        const answer = await this.session.client.json('/api/v2.1/dtable/app-download-link/', DownloadLink, {
          query: { path },
        });
        this.files.set(path, answer.download_link);
      } catch {
        // Keep the unresolved file so the download report accounts for it without a fallback request.
      }
    }
  }

  async schema(): Promise<SourceSchema> {
    await this.session.ready();
    const { metadata } = await this.client.json(this.url('/metadata/'), Metadata);
    for (const table of metadata.tables) this.tables.set(table._id, table);
    const wanted = [...this.tables.values()].some((table) =>
      table.columns.some((column) => ['collaborator', 'creator', 'last-modifier'].includes(column.type)),
    );
    if (wanted) {
      const users = await this.client
        .json(this.url('/related-users/'), RelatedUsers)
        .catch(() => ({ user_list: [] }));
      for (const user of users.user_list)
        // SeaTable's own ID for a person is no use here, so their address comes first and their name next.
        this.people.set(user.email, user.contact_email || user.name || user.email);
    }
    const tables: SourceTable[] = [];
    for (const table of metadata.tables) {
      const byKey = new Map(table.columns.map((column) => [column.key, column]));
      const byName = new Map(table.columns.map((column) => [column.name, column]));
      const context: Context = {
        tables: this.tables,
        column: (reference) => byKey.get(reference) ?? byName.get(reference),
        linked: (link, reference) => {
          const other = this.tables.get(text(link.data ?? {}, 'other_table_id') ?? '');
          return other?.columns.find((item) => item.key === reference || item.name === reference);
        },
        inverse: (column) => inverseOf(column, table, this.tables),
        people: this.people,
        fileUrl: (path) => this.fileUrl(path),
        address: this.address,
      };
      tables.push({
        id: table._id,
        name: table.name,
        description: null,
        // SeaTable's first column names each row, and is the only one it lets a row be found by.
        primary: table.columns[0]?.key ?? null,
        fields: table.columns.map((column) => planColumn(column, context)),
        views: table.views.map((view) => viewOf(view, byKey)),
        notes: [],
      });
    }
    return { tables, notes: [] };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const meta = this.tables.get(table.id);
    if (!meta) return;
    await this.session.ready();
    for (let start = 0; ; start += PAGE) {
      const page = await this.client.json(this.url('/rows/'), Rows, {
        query: { table_name: meta.name, start, limit: PAGE, convert_keys: 'false' },
      });
      await this.resolveFiles(meta, page.rows);
      yield page.rows.map((row) => {
        const values: Record<string, unknown> = {};
        for (const column of meta.columns) {
          const value = row[column.key];
          if (value !== undefined) values[column.key] = value;
        }
        return { id: String(row._id ?? ''), values };
      });
      if (page.rows.length < PAGE) return;
    }
  }

  async *links(
    table: SourceTable,
    link: Extract<FieldPlan, { kind: 'link' }>,
    ids: readonly string[],
  ): AsyncGenerator<Array<{ record: string; targets: string[] }>> {
    const meta = this.tables.get(table.id);
    const column = meta?.columns.find((item) => item.key === link.source.id);
    if (!meta || !column) return;
    await this.session.ready();
    let batch: Array<{ record: string; targets: string[] }> = [];
    for (let at = 0; at < ids.length; at += LINK_ROWS) {
      const slice = ids.slice(at, at + LINK_ROWS);
      const targets = new Map(slice.map((id) => [id, [] as string[]]));
      let remaining = slice;
      for (let offset = 0; remaining.length; offset += LINKS_PER_ROW) {
        const answer = await this.client.json(this.url('/query-links/'), LinkedRows, {
          method: 'POST',
          body: {
            table_name: meta.name,
            link_column_name: column.name,
            rows: remaining.map((row_id) => ({ row_id, offset, limit: LINKS_PER_ROW })),
          },
        });
        const more: string[] = [];
        for (const record of remaining) {
          const found = answer[record] ?? [];
          targets.get(record)!.push(...found.map((item) => item.row_id));
          if (found.length >= LINKS_PER_ROW) more.push(record);
        }
        remaining = more;
      }
      for (const record of slice) batch.push({ record, targets: targets.get(record)! });
      if (batch.length >= 100) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  }
}

/** The column on the other side of a link, which shares its link ID, or null when there is none. */
function inverseOf(
  column: MetaColumn,
  table: MetaTable,
  tables: ReadonlyMap<string, MetaTable>,
): string | null {
  const data = column.data ?? {};
  const linkId = text(data, 'link_id');
  const other = tables.get(text(data, 'other_table_id') ?? '');
  if (!linkId || !other) return null;
  const found = other.columns.find(
    (item) =>
      item.type === 'link' &&
      text(item.data ?? {}, 'link_id') === linkId &&
      // An internal link's two columns sit on one table, so a column is its own other side there.
      (other._id !== table._id || item.key !== column.key),
  );
  return found?.key ?? null;
}

export const seatableReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const session = new Session(token);
  // The API token opens the way in and signs each file's download, and the base token reads the base.
  session.authentication = context.client({
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => [token],
  });
  // Signing responses can echo either token, while the exchange must retain the token it issues.
  session.client = context.client({
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => session.secrets(),
  });
  const client = context.client({
    credentials: () => session.credentials(),
    secrets: () => session.secrets(),
    refresh: session.refresh,
  });
  return {
    async bases(): Promise<PlatformBase[]> {
      await session.ready();
      return [{ id: session.uuid, name: session.name || session.uuid, group: null }];
    },
    kept: async () => context.credential,
    source: (baseId) => new SeaTableSource(client, session, baseId, context.address),
  };
};

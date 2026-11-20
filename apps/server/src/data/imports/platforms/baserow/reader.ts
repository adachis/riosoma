import {
  isTimeZone,
  type DateRange,
  type DateTarget,
  type FieldSpec,
  type Operator,
  type RollupFunction,
  type ViewType,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { Attachment } from '../../core/files.js';
import type { Note } from '../../core/report.js';
import { currencyCode, isRecord, textOf } from '../../core/values.js';
import {
  asCheck,
  asDay,
  asInstant,
  asNumber,
  asText,
  asTrimmed,
  choicesOf,
  colorOfName,
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
import type { ClientCredentials, ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  Finish,
  PlatformSource,
  SourceCondition,
  SourceFilter,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';

/**
 * Baserow, through its REST API.  A database token reads tables, fields, rows, and files, but
 * Baserow shares views, and databases' names, only with a signed-in person.  So a database token
 * brings everything but views across, and an email address and password sign in once instead,
 * keeping only the refresh token Baserow hands back, which gets a fresh access token whenever the
 * last one runs out, and brings views across too.
 */

const PAGE = 200;

const Table = z.object({
  id: z.number(),
  name: z.string(),
  order: z.number().nullish(),
  database_id: z.number(),
});
const Application = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  workspace: z.object({ name: z.string() }).nullish(),
  tables: z.array(Table.partial({ database_id: true })).default([]),
});
const Field = z
  .object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
    primary: z.boolean().nullish(),
    order: z.number().nullish(),
    description: z.string().nullish(),
  })
  .loose();
type Field = z.infer<typeof Field>;
const Rows = z.object({
  next: z.string().nullish(),
  results: z.array(z.object({ id: z.number() }).loose()),
});
const Filter = z.object({
  field: z.number(),
  type: z.string(),
  value: z.string().nullish(),
  group: z.number().nullish(),
});
type Filter = z.infer<typeof Filter>;
const View = z
  .object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
    filter_type: z.string().nullish(),
    filters_disabled: z.boolean().nullish(),
    filters: z.array(Filter).default([]),
    filter_groups: z.array(z.object({ id: z.number(), filter_type: z.string().nullish() })).default([]),
    sortings: z.array(z.object({ field: z.number(), order: z.string() })).default([]),
    group_bys: z.array(z.unknown()).default([]),
    decorations: z.array(z.unknown()).default([]),
  })
  .loose();
type View = z.infer<typeof View>;
const FieldOptions = z.object({
  field_options: z.record(
    z.string(),
    z
      .object({
        hidden: z.boolean().nullish(),
        order: z.number().nullish(),
        enabled: z.boolean().nullish(),
        required: z.boolean().nullish(),
        name: z.string().nullish(),
        description: z.string().nullish(),
      })
      .loose(),
  ),
});
const Tokens = z.object({ access_token: z.string().min(1), refresh_token: z.string().nullish() });

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const numberOf = (value: unknown) => (typeof value === 'number' ? value : null);

const DURATIONS: Readonly<Record<string, 'h:mm' | 'h:mm:ss' | 'h:mm:ss.s' | 'h:mm:ss.ss' | 'h:mm:ss.sss'>> = {
  'h:mm': 'h:mm',
  'h:mm:ss': 'h:mm:ss',
  'h:mm:ss.s': 'h:mm:ss.s',
  'h:mm:ss.ss': 'h:mm:ss.ss',
  'h:mm:ss.sss': 'h:mm:ss.sss',
};
const RATING_ICONS: Readonly<Record<string, 'star' | 'heart' | 'thumbsUp' | 'flag' | 'circle'>> = {
  star: 'star',
  heart: 'heart',
  'thumbs-up': 'thumbsUp',
  flag: 'flag',
  circle: 'circle',
  smile: 'star',
};

/** Functions Baserow calls by other names, as Riosoma names them */
const RENAMES: Readonly<Record<string, string>> = { CONCAT: 'CONCATENATE', AVG: 'AVERAGE', TOTEXT: 'T' };

/** A cell's text, for Baserow's selects, links, lookups, and formulas' lists */
function valueText(value: unknown): string | null {
  if (Array.isArray(value))
    return textOf(value.map((item) => (isRecord(item) ? (item.value ?? item.name) : item)));
  if (isRecord(value)) return textOf(value.value ?? value.name ?? null);
  return textOf(value);
}

/**
 * Baserow's formulas name fields with `field('Name')` and its functions in lowercase, which is
 * Riosoma's language otherwise.  The usual ways of reading linked records, like
 * `sum(lookup('Tasks', 'Hours'))` or `count(field('Tasks'))`, become rollups, counts, and lookups.
 */
export function baserowFormula(formula: string): Finish | { written: ReturnType<typeof riosomaFormula> } {
  const quoted = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  const unquote = (single?: string, double?: string) => (single ?? double ?? '').replace(/\\(.)/g, '$1');
  const aggregate = new RegExp(
    String.raw`^\s*(\w+)\(\s*lookup\(\s*(?:${quoted})\s*,\s*(?:${quoted})\s*\)\s*\)\s*$`,
  ).exec(formula);
  if (aggregate) {
    const fn: RollupFunction | undefined =
      ROLLUPS[aggregate[1]!.toLowerCase()] ?? (aggregate[1] === 'join' ? 'concatenate' : undefined);
    if (fn)
      return {
        kind: 'rollup',
        link: unquote(aggregate[2], aggregate[3]),
        target: unquote(aggregate[4], aggregate[5]),
        fn,
        shown: formula,
      };
  }
  const lookup = new RegExp(String.raw`^\s*lookup\(\s*(?:${quoted})\s*,\s*(?:${quoted})\s*\)\s*$`).exec(
    formula,
  );
  if (lookup)
    return {
      kind: 'lookup',
      link: unquote(lookup[1], lookup[2]),
      target: unquote(lookup[3], lookup[4]),
      shown: formula,
    };
  const count = new RegExp(String.raw`^\s*count\(\s*field\(\s*(?:${quoted})\s*\)\s*\)\s*$`).exec(formula);
  if (count) return { kind: 'count', link: unquote(count[1], count[2]), shown: formula };
  // Fields named in braces are what Riosoma's language reads.
  const braced = formula.replace(
    new RegExp(String.raw`field\(\s*(?:${quoted})\s*\)`, 'g'),
    (_whole, single?: string, double?: string) =>
      `{${unquote(single, double).replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`,
  );
  return { written: riosomaFormula(braced, RENAMES) };
}

interface Context {
  tables: ReadonlySet<string>;
  fields: ReadonlyMap<number, Field>;
}

/** How one Baserow field comes across. */
export function planBaserowField(field: Field, context: Context): FieldPlan {
  const source = { id: String(field.id), name: field.name, description: field.description ?? null };
  const options = field as Record<string, unknown>;
  switch (field.type) {
    case 'text':
      return valuePlan(source, { type: 'text', options: {} }, asText);
    case 'long_text':
      return valuePlan(
        source,
        { type: 'longText', options: { richText: options.long_text_enable_rich_text === true } },
        asText,
      );
    case 'url':
      return valuePlan(source, { type: 'url', options: {} }, asTrimmed);
    case 'email':
      return valuePlan(source, { type: 'email', options: {} }, asTrimmed);
    case 'phone_number':
      return valuePlan(source, { type: 'phone', options: {} }, asTrimmed);
    case 'number': {
      const precision = precisionOf(options.number_decimal_places) ?? 0;
      const prefix = text(options.number_prefix)?.trim() ?? '';
      const suffix = text(options.number_suffix)?.trim() ?? '';
      const negative = options.number_negative !== false;
      // Baserow writes a percent or an amount as a number with a sign after or before it.
      if (suffix === '%' && !prefix)
        return valuePlan(
          source,
          { type: 'percent', options: { precision, allowNegative: negative } },
          (value) => {
            const number = asNumber(value);
            return typeof number === 'number' ? number / 100 : number;
          },
        );
      const code = prefix && !suffix ? currencyCode(prefix) : null;
      if (code)
        return valuePlan(
          source,
          { type: 'currency', options: { code, precision, allowNegative: negative } },
          asNumber,
        );
      return valuePlan(
        source,
        {
          type: 'number',
          options: { precision, thousands: Boolean(options.number_separator), allowNegative: negative },
        },
        asNumber,
        prefix || suffix ? [note('changed', 'import.platform.report.numberAffixes', { prefix, suffix })] : [],
      );
    }
    case 'rating':
      return valuePlan(
        source,
        {
          type: 'rating',
          options: {
            max: Math.min(10, Math.max(1, numberOf(options.max_value) ?? 5)),
            icon: RATING_ICONS[text(options.style) ?? 'star'] ?? 'star',
            color: colorOfName(options.color ?? 'dark-orange'),
          },
        },
        (value) => (value === 0 ? null : asNumber(value)),
      );
    case 'boolean':
      return valuePlan(source, { type: 'checkbox', options: { color: 'green' } }, asCheck);
    case 'date':
    case 'created_on':
    case 'last_modified': {
      const includeTime = options.date_include_time === true;
      const zone = text(options.date_force_timezone);
      return valuePlan(
        source,
        {
          type: 'date',
          options: {
            includeTime,
            dateFormat:
              ({ ISO: 'iso', US: 'us', EU: 'european' } as const)[text(options.date_format) as 'ISO'] ??
              'local',
            timeFormat: includeTime ? (options.date_time_format === '12' ? '12h' : '24h') : 'local',
            timeZone: includeTime && zone && isTimeZone(zone) ? zone : 'client',
          },
        },
        includeTime ? asInstant : asDay,
        field.type === 'date' ? [] : [note('changed', 'import.platform.report.timeFixed')],
      );
    }
    case 'duration':
      return valuePlan(
        source,
        { type: 'duration', options: { format: DURATIONS[text(options.duration_format) ?? ''] ?? 'h:mm' } },
        asNumber,
        /^d/.test(text(options.duration_format) ?? '')
          ? [note('changed', 'import.platform.report.durationDays')]
          : [],
      );
    case 'single_select':
    case 'multiple_select': {
      const raw = Array.isArray(options.select_options) ? options.select_options : [];
      const { choices, byName } = choicesOf(
        raw.flatMap((item) =>
          isRecord(item) && typeof item.value === 'string'
            ? [{ name: item.value, color: colorOfName(item.color) }]
            : [],
        ),
      );
      if (field.type === 'single_select')
        return valuePlan(source, { type: 'singleSelect', options: { choices } }, (value) => {
          const name = isRecord(value) ? text(value.value) : null;
          return name === null ? null : (byName.get(name) ?? name);
        });
      return valuePlan(source, { type: 'multipleSelect', options: { choices } }, (value) => {
        const names = (Array.isArray(value) ? value : []).flatMap((item) =>
          isRecord(item) && typeof item.value === 'string' ? [item.value] : [],
        );
        const ids = names.map((name) => byName.get(name));
        return ids.every((id) => id !== undefined) ? ids : names.join(', ');
      });
    }
    case 'file':
      return filesPlan(source, (value) =>
        (Array.isArray(value) ? value : []).flatMap((item): Attachment[] =>
          isRecord(item) && typeof item.url === 'string'
            ? [{ url: item.url, filename: item.visible_name ?? item.name ?? null, size: numberOf(item.size) }]
            : [],
        ),
      );
    case 'multiple_collaborators':
      return peoplePlan(source, emailsOf, true);
    case 'created_by':
    case 'last_modified_by':
      return peoplePlan(source, emailsOf, false, [note('changed', 'import.platform.report.peopleFixed')]);
    case 'autonumber':
      return valuePlan(
        source,
        { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
        asNumber,
        [],
        { kind: 'autoNumber' },
      );
    case 'uuid':
      return valuePlan(source, { type: 'text', options: {} }, asText, [
        note('changed', 'import.platform.report.uuidText'),
      ]);
    case 'link_row': {
      const table = String(options.link_row_table_id ?? options.link_row_table ?? '');
      if (!context.tables.has(table)) return omitted(source, 'import.platform.report.linkMissing');
      const related = numberOf(options.link_row_related_field_id ?? options.link_row_related_field);
      return linkPlan(
        source,
        table,
        related === null ? null : String(related),
        options.link_row_multiple_relationships === false,
        (value) =>
          (Array.isArray(value) ? value : []).flatMap((item) =>
            isRecord(item) && typeof item.id === 'number' ? [String(item.id)] : [],
          ),
      );
    }
    case 'count':
    case 'rollup':
    case 'lookup': {
      const through = numberOf(options.through_field_id);
      const target = numberOf(options.target_field_id);
      const link = through === null ? null : context.fields.get(through);
      const spec: FieldSpec =
        field.type === 'lookup'
          ? { type: 'text', options: {} }
          : { type: 'number', options: { precision: null, thousands: true, allowNegative: true } };
      const read = field.type === 'lookup' ? valueText : asNumber;
      if (!link)
        return valuePlan(source, spec, read, [note('changed', 'import.platform.report.relationText')]);
      if (field.type === 'count')
        return valuePlan(source, spec, read, [], { kind: 'count', link: String(link.id) });
      if (target === null)
        return valuePlan(source, spec, read, [note('changed', 'import.platform.report.relationText')]);
      if (field.type === 'lookup')
        return valuePlan(source, spec, read, [], {
          kind: 'lookup',
          link: String(link.id),
          target: String(target),
        });
      const fn = ROLLUPS[(text(options.rollup_function) ?? '').toLowerCase()];
      return fn
        ? valuePlan(source, spec, read, [], {
            kind: 'rollup',
            link: String(link.id),
            target: String(target),
            fn,
          })
        : valuePlan(source, spec, read, [
            note('changed', 'import.platform.report.rollupUnknown', {
              fn: text(options.rollup_function) ?? '',
            }),
          ]);
    }
    case 'formula': {
      const formula = text(options.formula) ?? '';
      const type = text(options.formula_type);
      const numeric = type === 'number';
      const spec: FieldSpec = numeric
        ? {
            type: 'number',
            options: {
              precision: precisionOf(options.number_decimal_places),
              thousands: true,
              allowNegative: true,
            },
          }
        : { type: 'text', options: {} };
      const read = numeric
        ? asNumber
        : type === 'boolean'
          ? (value: unknown) => (value === true ? 'true' : value === false ? 'false' : null)
          : valueText;
      const made = baserowFormula(formula);
      if ('kind' in made) return valuePlan(source, spec, read, [], made);
      const { written } = made;
      return valuePlan(source, spec, read, [], {
        kind: 'formula',
        shown: formula,
        expression: written.expression,
        ...(options.error
          ? { problem: 'invalid' as const }
          : written.problem
            ? { problem: written.problem }
            : {}),
        functions: written.functions,
        options: formulaOptions({ precision: precisionOf(options.number_decimal_places) }),
      });
    }
    case 'password':
      return omitted(source, 'import.platform.report.password');
    default:
      return omitted(source, 'import.platform.report.typeUnsupported', { type: field.type.slice(0, 64) });
  }
}

const EMPTY: Readonly<Record<string, Operator>> = { empty: 'isEmpty', not_empty: 'isNotEmpty' };

/** Baserow's dates in a filter, like `UTC?2026-01-10?exact_date` or `UTC?3?nr_days_ago`. */
function dateValue(value: string): { target?: DateTarget; range?: DateRange } | null {
  const [, amount = '', operator = ''] = value.split('?');
  const days = Number(amount);
  const targets: Record<string, DateTarget['mode']> = {
    today: 'today',
    yesterday: 'yesterday',
    tomorrow: 'tomorrow',
    one_week_ago: 'oneWeekAgo',
    one_week_from_now: 'oneWeekFromNow',
    one_month_ago: 'oneMonthAgo',
    one_month_from_now: 'oneMonthFromNow',
  };
  if (targets[operator]) return { target: { mode: targets[operator] } as DateTarget };
  if ((operator === 'nr_days_ago' || operator === 'nr_days_from_now') && Number.isInteger(days) && days >= 0)
    return { target: { mode: operator === 'nr_days_ago' ? 'daysAgo' : 'daysFromNow', days } };
  if (operator === 'exact_date' && /^\d{4}-\d{2}-\d{2}/.test(amount))
    return { target: { mode: 'exactDate', date: amount.slice(0, 10) } };
  const ranges: Record<string, DateRange> = {
    next_week: { mode: 'nextWeek' },
    next_month: { mode: 'nextMonth' },
    next_year: { mode: 'nextYear' },
  };
  if (ranges[operator]) return { range: ranges[operator] };
  if (operator === 'nr_days_from_now' && Number.isInteger(days) && days >= 1)
    return { range: { mode: 'nextDays', days } };
  return null;
}

/** One of Baserow's view filters as a condition here, or null when there's none like it. */
export function baserowCondition(filter: Filter, field: Field): SourceCondition | null {
  const id = String(field.id);
  const value = filter.value ?? '';
  const empty = EMPTY[filter.type];
  if (empty) return { field: id, operator: empty, value: { kind: 'none' } };
  const options = Array.isArray((field as Record<string, unknown>).select_options)
    ? ((field as Record<string, unknown>).select_options as Array<Record<string, unknown>>)
    : [];
  const names = (ids: string) =>
    ids
      .split(',')
      .map((item) => options.find((option) => String(option.id) === item.trim())?.value)
      .filter((name): name is string => typeof name === 'string');
  const numeric =
    field.type === 'number' ||
    field.type === 'rating' ||
    field.type === 'duration' ||
    field.type === 'count' ||
    field.type === 'autonumber' ||
    field.type === 'rollup';
  const number = Number(value);
  switch (filter.type) {
    case 'equal':
    case 'not_equal':
      if (numeric)
        return value !== '' && Number.isFinite(number)
          ? { field: id, operator: filter.type === 'equal' ? 'eq' : 'neq', value: { kind: 'number', number } }
          : null;
      return {
        field: id,
        operator: filter.type === 'equal' ? 'is' : 'isNot',
        value: { kind: 'text', text: value },
      };
    case 'contains':
    case 'contains_word':
    case 'link_row_contains':
      return { field: id, operator: 'contains', value: { kind: 'text', text: value } };
    case 'contains_not':
    case 'doesnt_contain_word':
    case 'link_row_not_contains':
      return { field: id, operator: 'doesNotContain', value: { kind: 'text', text: value } };
    case 'higher_than':
    case 'higher_than_or_equal':
    case 'lower_than':
    case 'lower_than_or_equal': {
      const operator = (
        {
          higher_than: 'gt',
          higher_than_or_equal: 'gte',
          lower_than: 'lt',
          lower_than_or_equal: 'lte',
        } as const
      )[filter.type];
      return value !== '' && Number.isFinite(number)
        ? { field: id, operator, value: { kind: 'number', number } }
        : null;
    }
    case 'boolean':
      return {
        field: id,
        operator: 'is',
        value: { kind: 'boolean', value: value === '1' || value === 'true' },
      };
    case 'single_select_equal':
    case 'single_select_not_equal':
    case 'single_select_is_any_of':
    case 'single_select_is_none_of': {
      const chosen = names(value);
      if (!chosen.length) return null;
      const operator = (
        {
          single_select_equal: 'is',
          single_select_not_equal: 'isNot',
          single_select_is_any_of: 'isAnyOf',
          single_select_is_none_of: 'isNoneOf',
        } as const
      )[filter.type];
      return { field: id, operator, value: { kind: 'choices', names: chosen } };
    }
    case 'multiple_select_has':
    case 'multiple_select_has_not': {
      const chosen = names(value);
      return chosen.length
        ? {
            field: id,
            operator: filter.type === 'multiple_select_has' ? 'hasAnyOf' : 'hasNoneOf',
            value: { kind: 'choices', names: chosen },
          }
        : null;
    }
    case 'link_row_has':
    case 'link_row_has_not':
      return /^\d+$/.test(value)
        ? {
            field: id,
            operator: filter.type === 'link_row_has' ? 'hasAnyOf' : 'hasNoneOf',
            value: { kind: 'records', ids: [value] },
          }
        : null;
    case 'date_is':
    case 'date_is_not':
    case 'date_is_before':
    case 'date_is_on_or_before':
    case 'date_is_after':
    case 'date_is_on_or_after':
    case 'date_is_within': {
      const parsed = dateValue(value);
      if (filter.type === 'date_is_within')
        return parsed?.range
          ? { field: id, operator: 'isWithin', value: { kind: 'range', range: parsed.range } }
          : null;
      const operator = (
        {
          date_is: 'is',
          date_is_not: 'isNot',
          date_is_before: 'isBefore',
          date_is_on_or_before: 'isOnOrBefore',
          date_is_after: 'isAfter',
          date_is_on_or_after: 'isOnOrAfter',
        } as const
      )[filter.type];
      return parsed?.target ? { field: id, operator, value: { kind: 'date', target: parsed.target } } : null;
    }
    default:
      return null;
  }
}

const KINDS: Readonly<Record<string, ViewType>> = {
  grid: 'grid',
  gallery: 'gallery',
  form: 'form',
  kanban: 'kanban',
  calendar: 'calendar',
  timeline: 'timeline',
};

class Auth implements ClientCredentials {
  access: string | null = null;
  client!: PlatformClient;

  constructor(private way: { token: string } | { email: string; password: string } | { refresh: string }) {}

  credentials(): Record<string, string> {
    if ('token' in this.way) return { authorization: `Token ${this.way.token}` };
    return this.access ? { authorization: `JWT ${this.access}` } : {};
  }

  secrets(): string[] {
    return [
      ...('token' in this.way ? [this.way.token] : []),
      ...('password' in this.way ? [this.way.password] : []),
      ...('refresh' in this.way ? [this.way.refresh] : []),
      ...(this.access ? [this.access] : []),
    ];
  }

  get signedIn(): boolean {
    return !('token' in this.way);
  }

  get refreshToken(): string | null {
    return 'refresh' in this.way ? this.way.refresh : null;
  }

  /** Makes sure there's an access token, signing in or refreshing for one. */
  async ready(): Promise<void> {
    if (!this.signedIn || this.access) return;
    if ('password' in this.way) await this.signIn();
    else if (!(await this.refresh())) throw new Error('Nothing to sign in with');
  }

  /** Signs in with the password, once, keeping the tokens Baserow answers with. */
  private async signIn(): Promise<void> {
    if (!('password' in this.way)) throw new Error('No password to sign in with');
    const answer = await this.client.json('/api/user/token-auth/', Tokens, {
      method: 'POST',
      body: { email: this.way.email, password: this.way.password },
      purpose: 'list',
      anonymous: true,
    });
    this.access = answer.access_token;
    this.way = { refresh: answer.refresh_token ?? '' };
  }

  /** A fresh access token from the refresh token, when the last one ran out or there's none yet. */
  refresh = async (): Promise<boolean> => {
    if (!('refresh' in this.way) || !this.way.refresh) return false;
    const answer = await this.client.json(
      '/api/user/token-refresh/',
      Tokens.partial({ refresh_token: true }),
      {
        method: 'POST',
        body: { refresh_token: this.way.refresh },
        anonymous: true,
      },
    );
    this.access = answer.access_token;
    return true;
  };
}

class BaserowSource implements PlatformSource {
  readonly platform = 'baserow' as const;
  private readonly fieldsOf = new Map<string, Field[]>();

  constructor(
    private readonly client: PlatformClient,
    private readonly auth: Auth,
    private readonly databaseId: string,
  ) {}

  private async tables(): Promise<Array<{ id: number; name: string }>> {
    if (!this.auth.signedIn) {
      const all = await this.client.json('/api/database/tables/all-tables/', z.array(Table));
      return all.filter((table) => String(table.database_id) === this.databaseId);
    }
    await this.auth.ready();
    const database = await this.client.json(`/api/applications/${this.databaseId}/`, Application);
    return database.tables.map((table) => ({ id: table.id!, name: table.name! }));
  }

  private async view(view: View, fields: readonly Field[]): Promise<SourceView> {
    const kind = KINDS[view.type] ?? null;
    const notes: Note[] = [];
    const base: SourceView = { id: String(view.id), name: view.name, type: view.type, kind, notes };
    if (!kind) return base;
    const byId = new Map(fields.map((field) => [field.id, field]));
    const { field_options: options } = await this.client.json(
      `/api/database/views/${view.id}/field-options/`,
      FieldOptions,
    );
    const order = (field: Field) =>
      [options[String(field.id)]?.order ?? 32_767, field.order ?? 0, field.id] as const;
    const ordered = [...fields].sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    const pick = (key: string) => {
      const id = numberOf((view as Record<string, unknown>)[key]);
      return id === null ? null : String(id);
    };
    if (kind === 'form') {
      return {
        ...base,
        questions: ordered
          .filter((field) => options[String(field.id)]?.enabled)
          .map((field) => {
            const option = options[String(field.id)]!;
            return {
              field: String(field.id),
              required: option.required === true,
              label: option.name ?? '',
              help: option.description ?? '',
            };
          }),
        form: {
          title: text((view as Record<string, unknown>).title) ?? view.name,
          description: text((view as Record<string, unknown>).description) ?? '',
          submitLabel: text((view as Record<string, unknown>).submit_text) ?? '',
          thankYou: text((view as Record<string, unknown>).submit_action_message) ?? '',
        },
      };
    }
    if (view.group_bys.length) notes.push(note('omitted', 'import.platform.report.viewGroupDropped'));
    if (view.decorations.length) notes.push(note('omitted', 'import.platform.report.viewColors'));
    let unmatched = 0;
    const condition = (filter: Filter) => {
      const field = byId.get(filter.field);
      const made = field ? baserowCondition(filter, field) : null;
      if (!made) unmatched++;
      return made ? [made] : [];
    };
    const conjunction = (type: string | null | undefined) => (type === 'OR' ? 'or' : 'and') as 'and' | 'or';
    const filter: SourceFilter | null =
      view.filters_disabled || !view.filters.length
        ? null
        : {
            conjunction: conjunction(view.filter_type),
            conditions: [
              ...view.filters.filter((item) => !item.group).flatMap(condition),
              ...view.filter_groups.map((group) => ({
                conjunction: conjunction(group.filter_type),
                conditions: view.filters.filter((item) => item.group === group.id).flatMap(condition),
              })),
            ],
          };
    return {
      ...base,
      shown: ordered.filter((field) => !options[String(field.id)]?.hidden).map((field) => String(field.id)),
      filter,
      unmatched,
      sorts: view.sortings.map((sort) => ({
        field: String(sort.field),
        direction: sort.order === 'DESC' ? 'desc' : 'asc',
      })),
      group: pick('single_select_field'),
      cover: pick('card_cover_image_field'),
      start: pick('date_field') ?? pick('start_date_field'),
      end: pick('end_date_field'),
    };
  }

  async schema(): Promise<SourceSchema> {
    const tables = await this.tables();
    const tableIds = new Set(tables.map((table) => String(table.id)));
    for (const table of tables)
      this.fieldsOf.set(
        String(table.id),
        await this.client.json(`/api/database/fields/table/${table.id}/`, z.array(Field)),
      );
    const everyField = new Map([...this.fieldsOf.values()].flat().map((field) => [field.id, field]));
    const result: SourceTable[] = [];
    for (const table of tables) {
      const fields = this.fieldsOf.get(String(table.id))!;
      const views = this.auth.signedIn
        ? await this.client.json(`/api/database/views/table/${table.id}/`, z.array(View), {
            query: { include: 'filters,sortings,decorations,group_bys' },
          })
        : [];
      result.push({
        id: String(table.id),
        name: table.name,
        primary: String(fields.find((field) => field.primary)?.id ?? ''),
        fields: fields.map((field) => planBaserowField(field, { tables: tableIds, fields: everyField })),
        views: await Promise.all(views.map((view) => this.view(view, fields))),
        notes: [],
      });
    }
    return {
      tables: result,
      notes: this.auth.signedIn ? [] : [note('omitted', 'import.platform.report.viewsNeedSignIn')],
    };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    for (let page = 1; ; page++) {
      const answer = await this.client.json(`/api/database/rows/table/${table.id}/`, Rows, {
        query: { size: PAGE, page, user_field_names: 'false' },
      });
      yield answer.results.map((row) => {
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row))
          if (key.startsWith('field_')) values[key.slice(6)] = value;
        return { id: String(row.id), values };
      });
      if (!answer.next || answer.results.length < PAGE) return;
    }
  }
}

export const baserowReader: ReaderFactory = (context) => {
  const way =
    context.credential.kind === 'token'
      ? { token: context.credential.token }
      : context.credential.kind === 'refresh'
        ? { refresh: context.credential.refresh }
        : { email: context.credential.email, password: context.credential.password };
  const auth = new Auth(way);
  const client = context.client({
    credentials: () => auth.credentials(),
    secrets: () => auth.secrets(),
    refresh: auth.refresh,
  });
  auth.client = client;
  return {
    async bases() {
      if (!auth.signedIn) {
        // A database token sees tables, each with its database's ID, but not databases' names.
        const tables = await client.json('/api/database/tables/all-tables/', z.array(Table), {
          purpose: 'list',
        });
        const databases = new Map<number, string[]>();
        for (const table of tables)
          databases.set(table.database_id, [...(databases.get(table.database_id) ?? []), table.name]);
        return [...databases].map(([id, names]) => ({ id: String(id), name: names.join(', '), group: null }));
      }
      await auth.ready();
      const applications = await client.json('/api/applications/', z.array(Application), { purpose: 'list' });
      return applications
        .filter((application) => application.type === 'database')
        .map((application) => ({
          id: String(application.id),
          name: application.name,
          group: application.workspace?.name ?? null,
        }));
    },
    async kept() {
      if (context.credential.kind !== 'password') return context.credential;
      // Only the refresh token is kept while the import runs, never the password.
      await auth.ready();
      return { kind: 'refresh', refresh: auth.refreshToken ?? '' };
    },
    source: (databaseId) => new BaserowSource(client, auth, databaseId),
  };
};

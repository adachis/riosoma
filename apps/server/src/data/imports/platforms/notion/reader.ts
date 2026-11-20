import { AppError, LIMITS, type FieldSpec, type PlatformBase, type ViewType } from '@riosoma/contracts';
import { z } from 'zod';
import { isRecord, textOf } from '../../core/values.js';
import { platformAttachment } from '../attachments.js';
import {
  asInstant,
  asNumber,
  asText,
  choicesOf,
  colorOfName,
  filesPlan,
  formulaOptions,
  linkPlan,
  note,
  omitted,
  peoplePlan,
  riosomaFormula,
  valuePlan,
  ROLLUPS,
} from '../fields.js';
import type { PlatformClient } from '../http.js';
import type { ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  PlatformSource,
  SourceFilter,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';
import { fieldNames } from '../words.js';

export const NOTION_VERSION = '2026-03-11';
const PAGE = 100;
const Json = z.record(z.string(), z.unknown());
const Entity = z.object({ id: z.string().min(1) }).passthrough();
const Property = z
  .object({ id: z.string().min(1), name: z.string(), type: z.string(), description: z.string().nullish() })
  .passthrough();
type Property = z.infer<typeof Property>;
const DataSource = z.object({
  id: z.string(),
  title: z.array(Json),
  properties: z.record(z.string(), Property),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
});
const Database = z.object({
  id: z.string(),
  title: z.array(Json),
  data_sources: z.array(z.object({ id: z.string(), name: z.string() })),
  parent: Json,
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
});
const Pages = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      properties: z.record(z.string(), Json),
      archived: z.boolean().optional(),
      in_trash: z.boolean().optional(),
    }),
  ),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
type Pages = z.infer<typeof Pages>;
const BODY = '__riosoma_page_body';
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const gone = (value: Record<string, unknown>) => value.archived === true || value.in_trash === true;
const unavailable = () => new AppError('unavailable', 'import.platform.unreadable');

export function richText(value: unknown): string {
  return array(value)
    .map((part) => {
      const item = object(part);
      return (
        string(item.plain_text) ??
        string(object(item.text).content) ??
        textOf(item.mention ?? item.equation) ??
        ''
      );
    })
    .join('');
}

/** Cursors are opaque, and a malformed or repeated cursor must fail instead of silently truncating. */
function cursor(hasMore: boolean, next: string | null, seen: Set<string>): string | undefined {
  if (!hasMore) return undefined;
  if (!next || seen.has(next)) throw unavailable();
  seen.add(next);
  return next;
}

async function* listed(client: PlatformClient, path: string, query: Record<string, string | number> = {}) {
  let start: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.json(
      path,
      z.object({ results: z.array(Entity), has_more: z.boolean(), next_cursor: z.string().nullable() }),
      {
        query: { ...query, page_size: PAGE, start_cursor: start },
      },
    );
    yield page.results;
    start = cursor(page.has_more, page.next_cursor, seen);
  } while (start);
}

const typedValue = (value: unknown): unknown => {
  const item = object(value);
  const type = string(item.type);
  if (!type) return value ?? null;
  if (type === 'array') return array(item.array).map(typedValue);
  if (type === 'title' || type === 'rich_text') return richText(item[type]);
  if (type === 'date') return dateText(item.date);
  return item[type] ?? null;
};
function dateText(value: unknown): string | null {
  if (!isRecord(value) || !value.start) return null;
  return [value.start, value.end ? `– ${String(value.end)}` : null, value.time_zone]
    .filter(Boolean)
    .join(' ');
}

/** Translate the scalar subset.  List methods and property tokens remain snapshots with a report. */
export function notionFormula(source: string) {
  const expression = source.replace(/prop\(\s*("(?:\\.|[^"\\])*")\s*\)/g, (_match, quoted: string) => {
    let name: string;
    try {
      name = JSON.parse(quoted) as string;
    } catch {
      return 'prop()';
    }
    return name.includes('{') || name.includes('}') ? 'prop()' : `{${name}}`;
  });
  const written = riosomaFormula(expression, {
    CEIL: 'CEILING',
    LENGTH: 'LEN',
    POW: 'POWER',
  });
  return { kind: 'formula' as const, shown: source, ...written, options: formulaOptions() };
}

function computedSpec(sample: unknown): FieldSpec {
  const type = string(object(sample).type);
  if (type === 'number')
    return { type: 'number', options: { precision: 8, thousands: true, allowNegative: true } };
  if (type === 'boolean') return { type: 'checkbox', options: { color: 'green' } };
  return { type: 'longText', options: { richText: false } };
}

interface Context {
  tables: ReadonlySet<string>;
  address: string;
  sample?: Record<string, unknown>;
}

export function planField(field: Property, context: Context): FieldPlan {
  const config = object(field[field.type]);
  const source = { id: field.id, name: field.name, description: field.description };
  const read = (value: unknown) => object(value)[field.type] ?? null;
  switch (field.type) {
    case 'title':
    case 'rich_text':
      return valuePlan(
        source,
        field.type === 'title'
          ? { type: 'text', options: {} }
          : { type: 'longText', options: { richText: false } },
        (value) => richText(read(value)) || null,
        [note('changed', 'import.platform.report.richTextPlain')],
      );
    case 'number': {
      const format = string(config.format) ?? 'number';
      const currencies: Record<string, string> = {
        dollar: 'USD',
        euro: 'EUR',
        pound: 'GBP',
        yen: 'JPY',
        ruble: 'RUB',
        rupee: 'INR',
        won: 'KRW',
        yuan: 'CNY',
        real: 'BRL',
        canadian_dollar: 'CAD',
        australian_dollar: 'AUD',
        franc: 'CHF',
        hong_kong_dollar: 'HKD',
        new_zealand_dollar: 'NZD',
        krona: 'SEK',
        norwegian_krone: 'NOK',
        mexican_peso: 'MXN',
        singapore_dollar: 'SGD',
      };
      const spec: FieldSpec =
        format === 'percent'
          ? { type: 'percent', options: { precision: 2, allowNegative: true } }
          : currencies[format]
            ? { type: 'currency', options: { code: currencies[format]!, precision: 2, allowNegative: true } }
            : { type: 'number', options: { precision: 8, thousands: true, allowNegative: true } };
      return valuePlan(
        source,
        spec,
        (value) => asNumber(read(value)),
        format === 'number' || format === 'number_with_commas' || format === 'percent' || currencies[format]
          ? []
          : [note('changed', 'import.platform.report.currencyUnknown', { symbol: format })],
      );
    }
    case 'checkbox':
      return valuePlan(source, { type: 'checkbox', options: { color: 'green' } }, read);
    case 'url':
    case 'email':
    case 'phone_number':
      return valuePlan(
        source,
        { type: field.type === 'phone_number' ? 'phone' : field.type, options: {} },
        read,
      );
    case 'date':
      return valuePlan(source, { type: 'text', options: {} }, (value) => dateText(read(value)), [
        note('changed', 'import.platform.report.dateRangeText'),
      ]);
    case 'created_time':
    case 'last_edited_time':
      return valuePlan(
        source,
        {
          type: 'date',
          options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'UTC' },
        },
        (value) => asInstant(read(value)),
        [note('changed', 'import.platform.report.timeFixed')],
      );
    case 'select':
    case 'status':
    case 'multi_select': {
      const { choices, byName } = choicesOf(
        array(config.options).map((option) => ({
          name: string(object(option).name) ?? '',
          color: colorOfName(object(option).color),
        })),
      );
      const names = (value: unknown) =>
        field.type === 'multi_select'
          ? array(read(value)).map((item) => string(object(item).name) ?? '')
          : [string(object(read(value)).name) ?? ''];
      if (choices.length > LIMITS.choicesPerField)
        return valuePlan(
          source,
          { type: 'text', options: {} },
          (value) => names(value).filter(Boolean).join(', ') || null,
          [note('changed', 'import.platform.report.tooManyChoices', { max: LIMITS.choicesPerField })],
        );
      return valuePlan(
        source,
        { type: field.type === 'multi_select' ? 'multipleSelect' : 'singleSelect', options: { choices } },
        (value) => {
          const found = names(value).filter(Boolean);
          const ids = found.map((name) => byName.get(name));
          if (ids.some((id) => !id)) return found.join(', ');
          return field.type === 'multi_select' ? ids : (ids[0] ?? null);
        },
        field.type === 'status' ? [note('changed', 'import.platform.report.statusGroups')] : [],
      );
    }
    case 'people':
    case 'created_by':
    case 'last_edited_by':
      return peoplePlan(
        source,
        (value) => {
          const raw = read(value);
          return (Array.isArray(raw) ? raw : raw ? [raw] : [])
            .map((person) => {
              const item = object(person);
              return string(object(item.person).email) ?? string(item.name) ?? string(item.id) ?? '';
            })
            .filter(Boolean);
        },
        field.type === 'people',
        field.type === 'people' ? [] : [note('changed', 'import.platform.report.peopleFixed')],
      );
    case 'files':
      return filesPlan(source, (value) =>
        array(read(value)).map((file) => {
          const item = object(file);
          return platformAttachment(
            context.address,
            { url: string(object(item[item.type as string]).url) ?? '', filename: item.name, size: null },
            (path) => path.startsWith('/files/'),
          );
        }),
      );
    case 'relation': {
      const target = string(config.data_source_id) ?? '';
      if (!context.tables.has(target))
        return valuePlan(
          source,
          { type: 'longText', options: { richText: false } },
          (value) =>
            array(read(value))
              .map((item) => string(object(item).id))
              .filter(Boolean)
              .join(', ') || null,
          [note('changed', 'import.platform.report.linkTargetText')],
        );
      return linkPlan(
        source,
        target,
        string(object(config.dual_property).synced_property_id),
        false,
        (value) =>
          array(read(value)).flatMap((item) =>
            typeof object(item).id === 'string' ? [String(object(item).id)] : [],
          ),
      );
    }
    case 'formula':
    case 'rollup': {
      const sample = context.sample?.[field.id];
      const spec = computedSpec(object(sample)[field.type]);
      const convert = (value: unknown) => {
        const result = typedValue(read(value));
        return spec.type === 'number' || spec.type === 'checkbox' ? result : textOf(result);
      };
      if (field.type === 'formula')
        return valuePlan(source, spec, convert, [], notionFormula(string(config.expression) ?? ''));
      const link = string(config.relation_property_id);
      const target = string(config.rollup_property_id);
      const fn = string(config.function) ?? '';
      const mapped =
        (
          {
            count_all: 'countAll',
            count_values: 'count',
            count_unique_values: 'countUnique',
            earliest_date: 'earliest',
            latest_date: 'latest',
          } as const
        )[fn as 'count_all'] ?? ROLLUPS[fn];
      const finish =
        link && target
          ? fn === 'show_original'
            ? { kind: 'lookup' as const, link, target }
            : mapped
              ? { kind: 'rollup' as const, link, target, fn: mapped }
              : undefined
          : undefined;
      return valuePlan(
        source,
        spec,
        convert,
        finish ? [] : [note('changed', 'import.platform.report.rollupUnknown', { fn })],
        finish,
      );
    }
    case 'unique_id':
      return valuePlan(
        source,
        { type: 'text', options: {} },
        (value) => {
          const item = object(read(value));
          return item.number === null || item.number === undefined
            ? null
            : `${item.prefix ? `${String(item.prefix)}-` : ''}${String(item.number)}`;
        },
        [note('changed', 'import.platform.report.uniqueIdFixed')],
      );
    case 'place':
      return valuePlan(
        source,
        { type: 'location', options: {} },
        (value) => {
          const place = object(read(value));
          if (place.lat == null || place.lon == null) return null;
          const label = [place.name, place.address, place.aws_place_id, place.google_place_id]
            .filter((detail) => typeof detail === 'string' && detail.length > 0)
            .join(', ');
          return {
            lat: asNumber(place.lat),
            lng: asNumber(place.lon),
            ...(label ? { label } : {}),
          };
        },
        [note('changed', 'import.platform.report.placeDetails')],
      );
    case 'verification':
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        (value) => textOf(read(value)),
        [note('changed', 'import.platform.report.valueSnapshot')],
      );
    case 'button':
      return omitted(source, 'import.platform.report.button');
    default:
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        (value) => textOf(read(value)),
        [note('changed', 'import.platform.report.valueSnapshot')],
      );
  }
}

/** Keep simple view conditions.  Every unmatched condition is counted in the shared report. */
function filterOf(value: unknown, fields: Property[]): { filter: SourceFilter | null; unmatched: number } {
  if (!isRecord(value)) return { filter: null, unmatched: 0 };
  let unmatched = 0;
  const walk = (raw: unknown, depth: number): SourceFilter | null => {
    const item = object(raw);
    const nested = Array.isArray(item.and) ? item.and : Array.isArray(item.or) ? item.or : null;
    if (nested) {
      if (depth > 8) {
        unmatched++;
        return null;
      }
      const conditions = nested.flatMap((child) => {
        const found = walk(child, depth + 1);
        return found ? (found.conditions.length === 1 ? found.conditions : [found]) : [];
      });
      return conditions.length ? { conjunction: item.or ? 'or' : 'and', conditions } : null;
    }
    const field = fields.find((field) => field.id === item.property || field.name === item.property);
    if (!field) {
      unmatched++;
      return null;
    }
    const settings = object(item[field.type]);
    const entry = Object.entries(settings)[0];
    if (!entry) {
      unmatched++;
      return null;
    }
    const [operator, value] = entry;
    const empty = operator === 'is_empty' || operator === 'is_not_empty';
    if (empty)
      return {
        conjunction: 'and',
        conditions: [
          {
            field: field.id,
            operator: operator === 'is_empty' ? 'isEmpty' : 'isNotEmpty',
            value: { kind: 'none' },
          },
        ],
      };
    if (['number', 'checkbox'].includes(field.type)) {
      const op = (
        {
          equals: 'eq',
          does_not_equal: 'neq',
          greater_than: 'gt',
          greater_than_or_equal_to: 'gte',
          less_than: 'lt',
          less_than_or_equal_to: 'lte',
        } as const
      )[operator as 'equals'];
      if (op && typeof value === 'number')
        return {
          conjunction: 'and',
          conditions: [{ field: field.id, operator: op, value: { kind: 'number', number: value } }],
        };
      if (operator === 'equals' && typeof value === 'boolean')
        return {
          conjunction: 'and',
          conditions: [{ field: field.id, operator: 'is', value: { kind: 'boolean', value } }],
        };
    }
    const op = (
      {
        equals: 'is',
        does_not_equal: 'isNot',
        contains: 'contains',
        does_not_contain: 'doesNotContain',
      } as const
    )[operator as 'equals'];
    if (
      op &&
      typeof value === 'string' &&
      ['title', 'rich_text', 'url', 'email', 'phone_number', 'select', 'status'].includes(field.type)
    )
      return {
        conjunction: 'and',
        conditions: [
          {
            field: field.id,
            operator: op,
            value:
              field.type === 'select' || field.type === 'status'
                ? { kind: 'choices', names: [value] }
                : { kind: 'text', text: value },
          },
        ],
      };
    unmatched++;
    return null;
  };
  return { filter: walk(value, 0), unmatched };
}

async function viewsOf(client: PlatformClient, id: string, fields: Property[]): Promise<SourceView[]> {
  const views: SourceView[] = [];
  const kinds: Record<string, ViewType> = {
    table: 'grid',
    board: 'kanban',
    calendar: 'calendar',
    timeline: 'timeline',
    gallery: 'gallery',
    list: 'list',
    form: 'form',
    map: 'map',
  };
  for await (const page of listed(client, '/v1/views', { data_source_id: id }))
    for (const stub of page) {
      const view = await client.json(
        `/v1/views/${encodeURIComponent(stub.id)}`,
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          configuration: Json.nullish(),
          filter: z.unknown().optional(),
          sorts: z.array(Json).nullish(),
        }),
      );
      const config = view.configuration ?? {};
      const found = filterOf(view.filter, fields);
      views.push({
        id: view.id,
        name: view.name,
        type: view.type,
        kind: kinds[view.type] ?? null,
        ...(Array.isArray(config.properties)
          ? {
              shown: config.properties
                .filter((property) => object(property).visible !== false)
                .flatMap((property) =>
                  string(object(property).property_id) ? [String(object(property).property_id)] : [],
                ),
            }
          : {}),
        ...found,
        sorts: (view.sorts ?? []).flatMap((sort) => {
          const field = fields.find((field) => field.id === sort.property || field.name === sort.property);
          return field
            ? [
                {
                  field: field.id,
                  direction: sort.direction === 'descending' ? ('desc' as const) : ('asc' as const),
                },
              ]
            : [];
        }),
        group: string(object(config.group_by).property_id),
        start: string(config.date_property_id ?? config.timeline_property_id),
        cover: string(object(config.cover).property_id),
        notes: [note('changed', 'import.platform.report.viewPlain')],
      });
    }
  return views;
}

class NotionSource implements PlatformSource {
  readonly platform = 'notion' as const;
  private readonly fields = new Map<string, Property[]>();
  private readonly first = new Map<string, Pages>();
  private readonly users = new Map<string, Record<string, unknown>>();
  constructor(
    private readonly client: PlatformClient,
    private readonly baseId: string,
    private readonly names: ReturnType<typeof fieldNames>,
  ) {}

  async schema(): Promise<SourceSchema> {
    const database = await this.client.json(`/v1/databases/${encodeURIComponent(this.baseId)}`, Database);
    if (gone(database)) throw new AppError('not_found', 'import.platform.baseUnavailable');
    const pending = database.data_sources.map((source) => source.id);
    const visited = new Set<string>();
    const sources: Array<z.infer<typeof DataSource>> = [];
    const notes = [
      note('omitted', 'import.platform.report.notShared'),
      note('omitted', 'import.platform.report.archivedExcluded'),
    ];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      let source: z.infer<typeof DataSource>;
      try {
        source = await this.client.json(`/v1/data_sources/${encodeURIComponent(id)}`, DataSource);
      } catch (error) {
        if (index >= database.data_sources.length && error instanceof AppError && error.code === 'not_found')
          continue;
        throw error;
      }
      if (gone(source)) continue;
      sources.push(source);
      for (const field of Object.values(source.properties)) {
        const target = string(object(field.relation).data_source_id);
        if (field.type === 'relation' && target && !visited.has(target)) pending.push(target);
      }
    }
    if (sources.some((source) => !database.data_sources.some((own) => own.id === source.id)))
      notes.push(note('changed', 'import.platform.report.relatedIncluded'));
    const tables: SourceTable[] = [];
    for (const source of sources) {
      const fields = Object.values(source.properties);
      this.fields.set(source.id, fields);
      const first = await this.query(source.id);
      this.first.set(source.id, first);
      const samples: Record<string, unknown> = {};
      for (const page of first.results.filter((page) => !gone(page)))
        for (const value of Object.values(page.properties)) {
          const id = string(value.id);
          if (
            id &&
            (samples[id] === undefined || typedValue(object(samples[id])[String(value.type)]) === null)
          )
            samples[id] = value;
        }
      tables.push({
        id: source.id,
        name:
          richText(source.title) ||
          database.data_sources.find((item) => item.id === source.id)?.name ||
          source.id,
        primary: fields.find((field) => field.type === 'title')?.id ?? null,
        fields: [
          ...fields.map((field) =>
            planField(field, {
              tables: new Set(sources.map((source) => source.id)),
              address: this.client.options.address,
              sample: samples,
            }),
          ),
          valuePlan(
            { id: BODY, name: this.names.body },
            { type: 'longText', options: { richText: false } },
            asText,
            [note('changed', 'import.platform.report.pageBody')],
          ),
        ],
        views: await viewsOf(this.client, source.id, fields),
        notes: [],
      });
    }
    return { tables, notes };
  }

  private query(id: string, start?: string): Promise<Pages> {
    return this.client.json(`/v1/data_sources/${encodeURIComponent(id)}/query`, Pages, {
      method: 'POST',
      body: { page_size: PAGE, ...(start ? { start_cursor: start } : {}) },
    });
  }

  private async property(pageId: string, field: Property): Promise<Record<string, unknown>> {
    let start: string | undefined;
    const seen = new Set<string>();
    const values: unknown[] = [];
    const typed: Record<string, unknown>[] = [];
    do {
      // Notion returns encoded property IDs.  Encoding them again would address a different property.
      const raw = await this.client.json(
        `/v1/pages/${encodeURIComponent(pageId)}/properties/${field.id}`,
        Json,
        { query: { page_size: PAGE, start_cursor: start } },
      );
      if (raw.object === 'property_item') return raw;
      const parsed = z
        .object({
          results: z.array(Json),
          has_more: z.boolean(),
          next_cursor: z.string().nullable(),
          property_item: Json.optional(),
        })
        .safeParse(raw);
      if (!parsed.success) throw unavailable();
      const result = parsed.data;
      for (const item of result.results) {
        values.push(item[String(item.type)] ?? null);
        typed.push({ type: item.type, [String(item.type)]: item[String(item.type)] });
      }
      start = cursor(result.has_more, result.next_cursor, seen);
      if (!start && field.type === 'rollup') {
        const rollup = object(result.property_item?.rollup);
        if (rollup.type === 'incomplete') throw unavailable();
        return {
          id: field.id,
          type: 'rollup',
          rollup: rollup.type === 'array' ? { ...rollup, array: typed } : rollup,
        };
      }
    } while (start);
    return { id: field.id, type: field.type, [field.type]: values };
  }

  private async body(id: string): Promise<string | null> {
    const lines: string[] = [];
    const pending: Array<{ id: string } | { text: string }> = [{ id }];
    const visited = new Set<string>();
    // A stack walks descendants in their original order without depending on JavaScript call depth.
    while (pending.length) {
      const task = pending.pop()!;
      if ('text' in task) {
        if (task.text && task.text !== '{}') lines.push(task.text);
        continue;
      }
      const next = task.id;
      if (visited.has(next)) throw unavailable();
      visited.add(next);
      const children: Array<z.infer<typeof Entity>> = [];
      for await (const page of listed(this.client, `/v1/blocks/${encodeURIComponent(next)}/children`))
        children.push(...page);
      for (const block of children.reverse()) {
        const content = object(block[String(block.type)]);
        const caption = richText(content.caption);
        const detail = Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'caption'));
        const text =
          richText(content.rich_text) ||
          string(content.title) ||
          [caption, string(content.url) || textOf(detail)].filter((part) => part && part !== '{}').join('\n');
        if (block.has_children === true && !['child_page', 'child_database'].includes(String(block.type)))
          pending.push({ id: block.id });
        pending.push({ text: text ?? '' });
      }
    }
    return lines.length ? lines.join('\n') : null;
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    let page = this.first.get(table.id) ?? (await this.query(table.id));
    this.first.delete(table.id);
    const seen = new Set<string>();
    for (;;) {
      const rows: SourceRecord[] = [];
      for (const record of page.results) {
        if (gone(record)) continue;
        const values: Record<string, unknown> = {};
        for (const field of this.fields.get(table.id) ?? []) {
          let value = Object.values(record.properties).find((value) => value.id === field.id) ?? {};
          if (['title', 'rich_text', 'relation', 'people', 'rollup', 'formula'].includes(field.type)) {
            const complete = await this.property(record.id, field);
            // Some aggregations are unavailable from property reads.  The page still exposes their value.
            if (field.type !== 'rollup' || object(complete.rollup).type !== 'unsupported') value = complete;
          }
          if (['people', 'created_by', 'last_edited_by'].includes(field.type)) {
            const people = value[field.type];
            const enrich = async (raw: unknown) => {
              const person = object(raw);
              const id = string(person.id);
              if (!id || object(person.person).email) return person;
              let known = this.users.get(id);
              if (!known) {
                try {
                  known = await this.client.json(`/v1/users/${encodeURIComponent(id)}`, Json);
                } catch (error) {
                  if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
                  known = person;
                }
                this.users.set(id, known);
              }
              return { ...person, ...known };
            };
            value = {
              ...value,
              [field.type]: Array.isArray(people)
                ? await Promise.all(people.map(enrich))
                : people
                  ? await enrich(people)
                  : null,
            };
          }
          values[field.id] = value;
        }
        values[BODY] = await this.body(record.id);
        rows.push({ id: record.id, values });
      }
      yield rows;
      const next = cursor(page.has_more, page.next_cursor, seen);
      if (!next) return;
      page = await this.query(table.id, next);
    }
  }
}

export const notionReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }),
    secrets: () => [token],
  });
  return {
    async bases(): Promise<PlatformBase[]> {
      const databases = new Map<string, PlatformBase>();
      const groups = new Map<string, string>();
      let start: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.json(
          '/v1/search',
          z.object({ results: z.array(Entity), has_more: z.boolean(), next_cursor: z.string().nullable() }),
          {
            method: 'POST',
            purpose: 'list',
            body: {
              filter: { value: 'data_source', property: 'object' },
              page_size: PAGE,
              ...(start ? { start_cursor: start } : {}),
            },
          },
        );
        for (const source of page.results) {
          if (gone(source)) continue;
          const id = string(object(source.parent).database_id);
          if (!id || databases.has(id)) continue;
          const database = await client.json(`/v1/databases/${encodeURIComponent(id)}`, Database);
          if (gone(database)) continue;
          const parentId = string(database.parent.page_id);
          let group: string | null = null;
          if (parentId) {
            if (!groups.has(parentId)) {
              try {
                const parent = await client.json(
                  `/v1/pages/${encodeURIComponent(parentId)}`,
                  z.object({ properties: z.record(z.string(), Json) }),
                );
                groups.set(
                  parentId,
                  richText(Object.values(parent.properties).find((value) => value.type === 'title')?.title) ||
                    parentId,
                );
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
                groups.set(parentId, parentId);
              }
            }
            group = groups.get(parentId)!;
          }
          databases.set(id, { id, name: richText(database.title) || id, group });
        }
        start = cursor(page.has_more, page.next_cursor, seen);
      } while (start);
      return [...databases.values()];
    },
    kept: async () => context.credential,
    source: (id) => new NotionSource(client, id, fieldNames(context)),
  };
};

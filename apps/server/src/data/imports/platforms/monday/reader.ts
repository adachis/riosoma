import { AppError, LIMITS, type FieldSpec, type PlatformBase, type ViewType } from '@riosoma/contracts';
import { z } from 'zod';
import { RateLimiter } from '../../core/clock.js';
import { isRecord, textOf } from '../../core/values.js';
import { platformAttachment } from '../attachments.js';
import {
  asInstant,
  asDay,
  asNumber,
  asText,
  choicesOf,
  colorOfHex,
  filesPlan,
  formulaOptions,
  linkPlan,
  note,
  omitted,
  peoplePlan,
  riosomaFormula,
  valuePlan,
} from '../fields.js';
import { tokenInvalid, TRIES, type PlatformClient, type Purpose } from '../http.js';
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

export const MONDAY_VERSION = '2026-10';
const PAGE = 50;
const STATUS_COLORS: ReadonlyArray<readonly [number, string, string]> = [
  [0, 'working_orange', '#fdab3d'],
  [1, 'done_green', '#00c875'],
  [2, 'stuck_red', '#e2445c'],
  [3, 'dark_blue', '#0086c0'],
  [4, 'purple', '#9d50dd'],
  [5, 'explosive', '#ff642e'],
  [6, 'grass_green', '#037f4c'],
  [7, 'bright_blue', '#579bfc'],
  [8, 'saladish', '#cab641'],
  [9, 'egg_yolk', '#ffcb00'],
  [10, 'blackish', '#333333'],
  [11, 'dark_red', '#bb3354'],
  [12, 'sofia_pink', '#ff158a'],
  [13, 'lipstick', '#ff5ac4'],
  [14, 'dark_purple', '#784bd1'],
  [15, 'bright_green', '#9cd326'],
  [16, 'chili_blue', '#66ccff'],
  [17, 'american_gray', '#808080'],
  [18, 'brown', '#7f5347'],
  [19, 'dark_orange', '#d974b0'],
  [101, 'sunset', '#ff7575'],
  [102, 'bubble', '#faa1f1'],
  [103, 'peach', '#ffadad'],
  [104, 'berry', '#e8697d'],
  [105, 'winter', '#9aadbd'],
  [106, 'river', '#68a1bd'],
  [107, 'navy', '#225091'],
  [108, 'aquamarine', '#4eccc6'],
  [109, 'indigo', '#5559df'],
  [110, 'dark_indigo', '#401694'],
  [151, 'pecan', '#563e3e'],
  [152, 'lavender', '#a25ddc'],
  [153, 'royal', '#2b76e5'],
  [154, 'steel', '#a9bee8'],
  [155, 'orchid', '#dce3ea'],
  [156, 'lilac', '#bda8f0'],
  [157, 'tan', '#a0a0a0'],
  [158, 'sky', '#a1e3f6'],
  [159, 'coffee', '#bd816e'],
  [160, 'teal', '#2da283'],
];
const Json = z.record(z.string(), z.unknown());
const Column = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  description: z.string().nullish(),
  settings: z.unknown().optional(),
});
type Column = z.infer<typeof Column>;
const Workspace = z.object({ id: z.string(), name: z.string() });
const Board = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  state: z.string().optional(),
  hierarchy_type: z.string().optional(),
  workspace: Workspace.nullish(),
  columns: z.array(Column),
  groups: z.array(z.object({ id: z.string(), title: z.string(), color: z.string() })),
  views: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      settings: z.unknown().optional(),
      filter: z.unknown().optional(),
      sort: z.unknown().optional(),
    }),
  ),
});
type Board = z.infer<typeof Board>;
const Child = z.object({
  id: z.string(),
  board: z.object({ id: z.string() }),
  parent_item: z.object({ id: z.string() }).nullish(),
});
const Item = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().optional(),
  board: z.object({ id: z.string() }),
  group: z.object({ id: z.string(), title: z.string() }).nullish(),
  parent_item: z.object({ id: z.string(), parent_item: z.object({ id: z.string() }).nullish() }).nullish(),
  subitems: z.array(Child),
  column_values: z.array(
    z
      .object({ id: z.string(), type: z.string(), text: z.string().nullish(), value: z.unknown().optional() })
      .passthrough(),
  ),
});
type Item = z.infer<typeof Item>;
const Discovery = z.object({ id: z.string(), state: z.string().optional(), subitems: z.array(Child) });
const GROUP = '__riosoma_group';
const PARENT = '__riosoma_parent';
const CHILD_PARENT = '__riosoma_child_parent';
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
};
const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const active = (value: { state?: string }) => !value.state || value.state === 'active';
const unreadable = () => new AppError('unavailable', 'import.platform.unreadable');
const BUDGET = 'complexity { query after reset_in_x_seconds }';
/** Formula display values have a separate 10,000-per-minute limit shared across imports. */
const formulaQuotas = new WeakMap<RateLimiter, RateLimiter>();
const BOARD_FIELDS =
  'id name description state hierarchy_type workspace { id name } columns { id title type description settings } groups { id title color } views { id name type settings filter sort }';
const DISCOVERY_FIELDS = 'id state subitems { id board { id } parent_item { id } }';
// Formula values are fetched separately in batches of five columns, as their endpoint requires.
const ITEM_FIELDS = `id name state board { id } group { id title } parent_item { id parent_item { id } } subitems { id board { id } parent_item { id } }
  column_values(capabilities: [CALCULATED]) { id type text value
    ... on NumbersValue { number }
    ... on DateValue { date time }
    ... on TimelineValue { from to }
    ... on BatteryValue { battery_value { key count } }
    ... on BoardRelationValue { linked_item_ids display_value linked_items { id board { id } } }
    ... on DependencyValue { linked_item_ids display_value }
    ... on MirrorValue { display_value }
    ... on SubtasksValue { subitems_ids }
    ... on PeopleValue { persons_and_teams { id kind } }
    ... on FileValue { files { ... on FileAssetValue { asset_id name asset { id name public_url file_size } } ... on FileLinkValue { name url } ... on FileDocValue { url } } }
  }`;

/** GraphQL can return rate-limit errors with HTTP 200.  Partial data must never look like success. */
export class MondayApi {
  private readonly formulaQuota: RateLimiter;
  constructor(readonly client: PlatformClient) {
    let quota = formulaQuotas.get(client.options.limiter);
    if (!quota) {
      quota = new RateLimiter(client.options.clock, 160);
      formulaQuotas.set(client.options.limiter, quota);
    }
    this.formulaQuota = quota;
  }

  async formulaValues(count: number): Promise<void> {
    for (let index = 0; index < count; index++) await this.formulaQuota.take(this.client.options.signal);
  }
  async query<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    purpose: Purpose = 'base',
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.client.json(
        '/v2',
        z.object({
          data: Json.nullish(),
          errors: z
            .array(z.object({ message: z.string().optional(), extensions: Json.optional() }))
            .optional(),
          extensions: Json.optional(),
          retry_in_seconds: z.number().optional(),
          error_data: Json.optional(),
          error_code: z.string().optional(),
        }),
        { method: 'POST', purpose, body: { query, variables } },
      );
      const errors = response.errors ?? [];
      const codes = [
        ...errors.map((error) => String(error.extensions?.code ?? error.extensions?.error_code ?? '')),
        response.error_code ?? '',
      ];
      const retry =
        response.retry_in_seconds ??
        [
          response.error_data?.retry_in_seconds,
          ...errors.flatMap((error) => [
            error.extensions?.retry_in_seconds,
            object(error.extensions?.error_data).retry_in_seconds,
          ]),
        ].find((value): value is number => typeof value === 'number');
      const limited =
        retry !== undefined ||
        codes.some((code) => /complexity|rate.?limit|budget|concurrency|DAILY_LIMIT/i.test(code));
      if (limited) {
        if (attempt >= TRIES) throw new AppError('rate_limited', 'import.platform.rateLimited');
        const wait = typeof retry === 'number' && Number.isFinite(retry) ? Math.max(1, retry) : 60;
        this.client.options.limiter.pause(wait * 1_000);
        continue;
      }
      if (codes.some((code) => /auth|token/i.test(code))) throw tokenInvalid();
      if (errors.length || response.error_code) {
        if (codes.some((code) => /permission|not.?found|InvalidBoardId/i.test(code)))
          throw new AppError('not_found', 'import.platform.baseUnavailable');
        throw unreadable();
      }
      const data = schema.safeParse(response.data);
      if (!data.success) throw unreadable();
      const complexity = object(response.data?.complexity);
      const cost = typeof complexity.query === 'number' ? complexity.query : 0;
      const remaining = typeof complexity.after === 'number' ? complexity.after : Infinity;
      if (remaining < Math.max(cost, 100_000)) {
        const reset = typeof complexity.reset_in_x_seconds === 'number' ? complexity.reset_in_x_seconds : 60;
        this.client.options.limiter.pause(Math.max(1, reset) * 1_000);
      }
      return data.data;
    }
  }

  async boards(): Promise<Array<{ id: string; name: string; workspace?: z.infer<typeof Workspace> | null }>> {
    const boards: Array<{ id: string; name: string; workspace?: z.infer<typeof Workspace> | null }> = [];
    for (let page = 1; ; page++) {
      const result = await this.query(
        `query ListBoards ($page: Int!) { ${BUDGET} boards(limit: 100, page: $page, state: active) { id name workspace { id name } } }`,
        { page },
        z.object({
          boards: z.array(z.object({ id: z.string(), name: z.string(), workspace: Workspace.nullish() })),
        }),
        'list',
      );
      boards.push(...result.boards);
      if (result.boards.length < 100) return boards;
    }
  }

  async board(id: string): Promise<Board | null> {
    const result = await this.query(
      `query ReadBoard ($ids: [ID!]) { ${BUDGET} boards(ids: $ids) { ${BOARD_FIELDS} } }`,
      { ids: [id] },
      z.object({ boards: z.array(Board) }),
    );
    return result.boards.find((board) => board.id === id && active(board)) ?? null;
  }

  async *pages<T>(board: string, fields: string, item: z.ZodType<T>): AsyncGenerator<T[]> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const page = z.object({ cursor: z.string().nullable(), items: z.array(item) });
    const operation = fields === DISCOVERY_FIELDS ? 'Discover' : 'Read';
    do {
      let result: z.infer<typeof page>;
      if (cursor) {
        const data = await this.query(
          `query ${operation}NextItems ($cursor: String!) { ${BUDGET} next_items_page(limit: ${PAGE}, cursor: $cursor) { cursor items { ${fields} } } }`,
          { cursor },
          z.object({ next_items_page: page }),
        );
        result = data.next_items_page;
      } else {
        const data = await this.query(
          `query ${operation}BoardItems ($ids: [ID!]) { ${BUDGET} boards(ids: $ids) { items_page(limit: ${PAGE}) { cursor items { ${fields} } } } }`,
          { ids: [board] },
          z.object({ boards: z.array(z.object({ items_page: page })) }),
        );
        if (!data.boards[0]) throw new AppError('not_found', 'import.platform.baseUnavailable');
        result = data.boards[0].items_page;
      }
      yield result.items;
      cursor = result.cursor;
      if (cursor && seen.has(cursor)) throw unreadable();
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
}

const cell = (value: unknown) => object(object(value).value);
const display = (value: unknown) =>
  string(object(value).display_value) ?? string(object(value).text) ?? textOf(object(value).value);
const linked = (value: unknown): string[] =>
  array(object(value).linked_item_ids ?? object(value).subitems_ids).map(String);
const numberSpec: FieldSpec = {
  type: 'number',
  options: { precision: 8, thousands: true, allowNegative: true },
};
interface Context {
  board: string;
  tables: ReadonlyMap<string, string>;
  address: string;
  children?: string;
  childInverse?: string;
  multiLevel?: boolean;
}

export function planField(column: Column, context: Context): FieldPlan {
  const settings = object(column.settings);
  const source = { id: column.id, name: column.title, description: column.description };
  const snapshot = () =>
    valuePlan(source, { type: 'longText', options: { richText: false } }, display, [
      note('changed', 'import.platform.report.valueSnapshot'),
    ]);
  switch (column.type) {
    case 'name':
      return valuePlan(source, { type: 'text', options: {} }, asText);
    case 'text':
      return valuePlan(source, { type: 'text', options: {} }, display);
    case 'long_text':
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        (value) => string(cell(value).text) ?? display(value),
      );
    case 'numbers':
      return valuePlan(
        source,
        numberSpec,
        (value) => {
          if (object(value).number != null) return asNumber(object(value).number);
          let raw = object(value).value;
          if (typeof raw === 'string') {
            try {
              raw = JSON.parse(raw) as unknown;
            } catch {
              return raw;
            }
          }
          return asNumber(raw);
        },
        context.multiLevel ? [note('changed', 'import.platform.report.valueSnapshot')] : [],
      );
    case 'checkbox':
      return valuePlan(
        source,
        { type: 'checkbox', options: { color: 'green' } },
        (value) => cell(value).checked === 'true' || cell(value).checked === true,
      );
    case 'email':
    case 'phone':
    case 'link':
      return valuePlan(
        source,
        { type: column.type === 'link' ? 'url' : column.type, options: {} },
        (value) => cell(value)[column.type === 'link' ? 'url' : column.type] ?? null,
        column.type === 'link' ? [note('changed', 'import.platform.report.linkLabel')] : [],
      );
    case 'date':
      return valuePlan(
        source,
        {
          type: 'date',
          options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'UTC' },
        },
        (value) => {
          const raw = cell(value);
          const date = raw.date ?? object(value).date;
          const time = raw.time ?? object(value).time;
          return date
            ? asInstant(
                String(date).includes('T') ? date : `${String(date)}T${time ? String(time) : '00:00:00'}Z`,
              )
            : null;
        },
        context.multiLevel ? [note('changed', 'import.platform.report.valueSnapshot')] : [],
      );
    case 'creation_log':
    case 'last_updated':
      return valuePlan(
        source,
        {
          type: 'date',
          options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'UTC' },
        },
        (value) => asInstant(cell(value).created_at ?? cell(value).updated_at ?? display(value)),
        [note('changed', 'import.platform.report.timeFixed')],
      );
    case 'status':
    case 'dropdown': {
      const raw = settings.labels;
      const colors = object(settings.labels_colors);
      const entryOf = (id: string, value: unknown) => {
        const label = object(value);
        const hex = STATUS_COLORS.find(([id, name]) => label.color === id || label.color === name)?.[2];
        return {
          id,
          name: typeof value === 'string' ? value : (string(label.label) ?? string(label.name) ?? ''),
          color: colorOfHex(label.hex ?? hex ?? label.color ?? object(colors[id]).color),
        };
      };
      const entries = Array.isArray(raw)
        ? raw.map((entry) => entryOf(String(object(entry).id), entry))
        : Object.entries(object(raw)).map(([id, value]) => entryOf(id, value));
      const { choices, byName } = choicesOf(entries);
      const byId = new Map(entries.map((entry) => [entry.id, entry.name]));
      if (column.type === 'status' && context.multiLevel)
        return valuePlan(
          source,
          { type: 'longText', options: { richText: false } },
          (value) => {
            const battery = array(object(value).battery_value);
            return battery.length
              ? battery
                  .map(
                    (entry) =>
                      `${byId.get(String(object(entry).key)) ?? String(object(entry).key)}: ${String(object(entry).count)}`,
                  )
                  .join(', ')
              : display(value);
          },
          [note('changed', 'import.platform.report.valueSnapshot')],
        );
      const names = (value: unknown) =>
        column.type === 'status'
          ? [byId.get(String(cell(value).index)) ?? display(value) ?? ''].filter(Boolean)
          : array(cell(value).ids).map((id) => byId.get(String(id)) ?? String(id));
      if (choices.length > LIMITS.choicesPerField)
        return valuePlan(source, { type: 'text', options: {} }, (value) => names(value).join(', ') || null, [
          note('changed', 'import.platform.report.tooManyChoices', { max: LIMITS.choicesPerField }),
        ]);
      return valuePlan(
        source,
        { type: column.type === 'status' ? 'singleSelect' : 'multipleSelect', options: { choices } },
        (value) => {
          const found = names(value);
          const ids = found.map((name) => byName.get(name));
          return ids.some((id) => !id) ? found.join(', ') : column.type === 'status' ? (ids[0] ?? null) : ids;
        },
      );
    }
    case 'people':
    case 'person':
    case 'team':
      return peoplePlan(source, (value) => array(object(value).people).map(String), true);
    case 'file':
      return filesPlan(source, (value) =>
        array(object(value).files).map((raw) => {
          const file = object(raw);
          const asset = object(file.asset);
          return platformAttachment(
            context.address,
            {
              url: string(asset.public_url) ?? string(file.url) ?? '',
              filename: asset.name ?? file.name,
              size: typeof asset.file_size === 'number' ? asset.file_size : null,
            },
            (path) => path.startsWith('/files/'),
          );
        }),
      );
    case 'board_relation': {
      const boards = array(settings.boardIds).map(String);
      if (boards.length === 1 && context.tables.has(boards[0]!))
        return linkPlan(
          source,
          context.tables.get(boards[0]!)!,
          null,
          settings.allowMultipleItems === false,
          linked,
        );
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        (value) => display(value) || linked(value).join(', ') || null,
        [
          note(
            'changed',
            boards.length > 1
              ? 'import.platform.report.linkSeveralBoards'
              : 'import.platform.report.linkTargetText',
          ),
        ],
      );
    }
    case 'dependency': {
      const plan = linkPlan(source, context.board, null, false, linked);
      plan.notes.push(note('changed', 'import.platform.report.dependencyLinks'));
      return plan;
    }
    case 'subtasks':
      return context.children
        ? linkPlan(source, context.children, context.childInverse ?? PARENT, false, linked)
        : snapshot();
    case 'mirror': {
      const link = Object.keys(object(settings.relation_column)).find(
        (id) => object(settings.relation_column)[id] === true,
      );
      const displayed = array(settings.displayed_linked_columns);
      const target = displayed.length === 1 ? array(object(displayed[0]).column_ids) : [];
      const finish =
        link && target.length === 1 && !settings.sumType && !settings.calcType
          ? { kind: 'lookup' as const, link, target: String(target[0]) }
          : undefined;
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        display,
        finish ? [] : [note('changed', 'import.platform.report.relationText')],
        finish,
      );
    }
    case 'formula': {
      const shown = string(settings.formula) ?? '';
      const written = riosomaFormula(shown, {});
      return valuePlan(source, { type: 'longText', options: { richText: false } }, display, [], {
        kind: 'formula',
        shown,
        ...written,
        options: formulaOptions(),
      });
    }
    case 'rating':
      return valuePlan(
        source,
        {
          type: 'rating',
          options: {
            max: Math.min(10, Math.max(1, Number(settings.limit ?? settings.stars_count) || 5)),
            icon: settings.symbol === 'hearts' ? 'heart' : 'star',
            color: colorOfHex(settings.color ?? '#ffcb00'),
          },
        },
        (value) => asNumber(cell(value).rating ?? null),
      );
    case 'time_tracking':
      return valuePlan(
        source,
        { type: 'duration', options: { format: 'h:mm:ss' } },
        (value) => asNumber(cell(value).duration ?? null),
        [note('changed', 'import.platform.report.trackingFixed')],
      );
    case 'vote':
      return valuePlan(
        source,
        numberSpec,
        (value) => (object(value).value == null ? null : array(cell(value).voters).length),
        [note('changed', 'import.platform.report.valueSnapshot')],
      );
    case 'item_id':
      return valuePlan(
        source,
        { type: 'text', options: {} },
        (value) => object(value).itemId ?? display(value),
        [note('changed', 'import.platform.report.uniqueIdFixed')],
      );
    case 'auto_number':
      return omitted(source, 'import.platform.report.apiValueUnavailable');
    case 'button':
      return omitted(source, 'import.platform.report.button');
    case 'timeline':
    case 'week':
      return valuePlan(
        source,
        {
          type: 'dateRange',
          options: { includeTime: false, dateFormat: 'local', timeFormat: 'local', timeZone: 'UTC' },
        },
        (value) => {
          const raw = cell(value);
          const start =
            column.type === 'week' ? object(raw.week).startDate : (raw.from ?? object(value).from);
          const end = column.type === 'week' ? object(raw.week).endDate : (raw.to ?? object(value).to);
          return start || end ? { start: asDay(start), end: asDay(end) } : null;
        },
        [
          note('changed', 'import.platform.report.rangePlain'),
          ...(context.multiLevel ? [note('changed', 'import.platform.report.valueSnapshot')] : []),
        ],
      );
    case 'location':
      return valuePlan(source, { type: 'location', options: {} }, (value) => {
        const raw = cell(value);
        if (raw.lat == null || raw.lng == null) return null;
        return { lat: asNumber(raw.lat), lng: asNumber(raw.lng), label: string(raw.address) ?? undefined };
      });
    case 'country':
      return valuePlan(
        source,
        { type: 'longText', options: { richText: false } },
        (value) => textOf(object(value).value),
        [note('changed', 'import.platform.report.placeText')],
      );
    case 'hour':
    case 'world_clock':
    case 'color_picker':
    case 'doc':
    case 'tags':
    case 'progress':
    case 'integration':
      return snapshot();
    default:
      return snapshot();
  }
}

function viewOf(view: Board['views'][number], board: Board): SourceView {
  const settings = object(view.settings);
  const kinds: Record<string, ViewType> = {
    table: 'grid',
    Table: 'grid',
    kanban: 'kanban',
    Kanban: 'kanban',
    calendar: 'calendar',
    Calendar: 'calendar',
    timeline: 'timeline',
    Timeline: 'timeline',
    gantt: 'gantt',
    Gantt: 'gantt',
    form: 'form',
    Form: 'form',
    map: 'map',
    Map: 'map',
    gallery: 'gallery',
  };
  const properties = array(object(settings.columns).column_properties);
  const filter = object(view.filter);
  // More involved operators keep the unfiltered view and report how many rules were left out.
  const conditions: SourceFilter['conditions'] = [];
  let unmatched = array(filter.groups).length;
  for (const raw of array(filter.rules)) {
    const rule = object(raw);
    const column = board.columns.find((column) => column.id === rule.column_id);
    const names = array(rule.compare_value).map(String);
    if (
      column &&
      rule.operator === 'contains_text' &&
      names.length === 1 &&
      ['text', 'long_text', 'name'].includes(column.type)
    )
      conditions.push({ field: column.id, operator: 'contains', value: { kind: 'text', text: names[0]! } });
    else unmatched++;
  }
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    kind: kinds[view.type] ?? null,
    ...(properties.length
      ? {
          shown: properties
            .filter((property) => object(property).visible !== false)
            .map((property) => String(object(property).column_id)),
        }
      : {}),
    group: string(object(settings.group_by).column_id) ?? GROUP,
    start: string(settings.date_column_id ?? settings.timeline_column_id),
    filter: conditions.length ? { conjunction: filter.operator === 'or' ? 'or' : 'and', conditions } : null,
    unmatched,
    sorts: array(view.sort).flatMap((sort) =>
      typeof object(sort).column_id === 'string'
        ? [
            {
              field: String(object(sort).column_id),
              direction:
                String(object(sort).direction).toLowerCase() === 'desc'
                  ? ('desc' as const)
                  : ('asc' as const),
            },
          ]
        : [],
    ),
    notes: [note('changed', 'import.platform.report.viewPlain')],
  };
}

class MondaySource implements PlatformSource {
  readonly platform = 'monday' as const;
  private readonly boards = new Map<string, Board>();
  private readonly children = new Map<string, { parent: string; board: string }>();
  private readonly people = new Map<string, string>();
  constructor(
    private readonly api: MondayApi,
    private readonly baseId: string,
    private readonly names: ReturnType<typeof fieldNames>,
  ) {}

  async schema(): Promise<SourceSchema> {
    const pending = [this.baseId];
    const visited = new Set<string>();
    const childBoards = new Map<string, string>();
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      let board: Board | null;
      try {
        board = await this.api.board(id);
      } catch (error) {
        if (index > 0 && error instanceof AppError && error.code === 'not_found') continue;
        throw error;
      }
      if (!board) {
        if (index === 0) throw new AppError('not_found', 'import.platform.baseUnavailable');
        continue;
      }
      this.boards.set(id, board);
      for (const column of board.columns)
        if (column.type === 'board_relation')
          pending.push(...array(object(column.settings).boardIds).map(String));
      // Classic child boards have their own schema, but their records are read through their parents.
      if ([...childBoards].some(([key, child]) => child === id && key.split('\u0000')[0] !== id)) continue;
      for (const column of board.columns)
        if (column.type === 'subtasks') {
          const targets = array(object(column.settings).boardIds).map(String);
          if (!targets.length && board.hierarchy_type?.includes('multi')) targets.push(id);
          for (const child of targets) {
            childBoards.set(`${id}\u0000${child}`, child);
            if (child !== id) pending.push(child);
          }
        }
      for await (const items of this.api.pages(id, DISCOVERY_FIELDS, Discovery))
        for (const item of items) {
          if (!active(item)) continue;
          for (const child of item.subitems) {
            childBoards.set(`${id}\u0000${child.board.id}`, child.board.id);
            if (child.board.id !== id) pending.push(child.board.id);
          }
        }
    }
    for (const [key, id] of childBoards) {
      const parent = key.split('\u0000')[0]!;
      const childId = id === parent ? `${id}:subitems` : id;
      if (id !== parent && !this.boards.has(id)) {
        const board = await this.api.board(id);
        if (!board) throw new AppError('not_found', 'import.platform.baseUnavailable');
        this.boards.set(id, board);
      }
      this.children.set(childId, { parent, board: id });
    }
    const tables: SourceTable[] = [];
    const ids = new Map([...this.boards.keys()].map((id) => [id, id]));
    const add = (id: string, board: Board, child?: { parent: string; board: string }) => {
      const childId = child ? id : [...this.children].find(([, info]) => info.parent === board.id)?.[0];
      const groups = choicesOf(
        board.groups.map((group) => ({ name: group.title, color: colorOfHex(group.color) })),
      );
      const fields = board.columns.flatMap((column) => {
        const planned = planField(column, {
          board: id,
          tables: ids,
          address: this.api.client.options.address,
          multiLevel: board.hierarchy_type === 'multi_level',
          ...(childId ? { children: childId, childInverse: child ? CHILD_PARENT : PARENT } : {}),
        });
        const targets =
          column.type === 'board_relation' ? array(object(column.settings).boardIds).map(String) : [];
        if (targets.length <= 1) return [planned];
        return [
          planned,
          ...targets
            .filter((target) => ids.has(target))
            .map((target) =>
              linkPlan(
                {
                  id: `${column.id}:board:${target}`,
                  name: `${column.title} · ${this.boards.get(target)!.name}`,
                },
                ids.get(target)!,
                null,
                false,
                (value) =>
                  array(object(value).linked_items)
                    .filter((item) => String(object(object(item).board).id) === target)
                    .map((item) => String(object(item).id)),
              ),
            ),
        ];
      });
      if (!fields.some((field) => field.source.id === 'name'))
        fields.unshift(
          valuePlan({ id: 'name', name: this.names.name }, { type: 'text', options: {} }, asText),
        );
      fields.push(
        valuePlan(
          { id: GROUP, name: this.names.group },
          { type: 'singleSelect', options: { choices: groups.choices } },
          (value) => (typeof value === 'string' ? (groups.byName.get(value) ?? value) : null),
        ),
      );
      if (child) {
        fields.push(
          linkPlan(
            { id: PARENT, name: this.names.parent },
            child.parent,
            this.boards.get(child.parent)!.columns.find((column) => column.type === 'subtasks')?.id ?? null,
            true,
            (value) => array(value).map(String),
          ),
        );
        if (board.columns.some((column) => column.type === 'subtasks'))
          fields.push(
            linkPlan(
              { id: CHILD_PARENT, name: `${this.names.parent} · ${this.names.children}` },
              id,
              board.columns.find((column) => column.type === 'subtasks')?.id ?? null,
              true,
              (value) => array(value).map(String),
            ),
          );
      }
      tables.push({
        id,
        name: child ? `${this.boards.get(child.parent)!.name} · ${this.names.children}` : board.name,
        description: board.description,
        primary: 'name',
        fields,
        views: child ? [] : board.views.map((view) => viewOf(view, board)),
        notes: child ? [note('changed', 'import.platform.report.subitemsTable')] : [],
      });
    };
    for (const [id, board] of this.boards) if (!this.children.has(id)) add(id, board);
    for (const [id, child] of this.children) add(id, this.boards.get(child.board)!, child);
    return {
      tables,
      notes: [
        note('omitted', 'import.platform.report.notShared'),
        note('omitted', 'import.platform.report.archivedExcluded'),
        ...(this.boards.size > 1 ? [note('changed', 'import.platform.report.relatedIncluded')] : []),
      ],
    };
  }

  private async enrich(items: Item[], board: Board): Promise<void> {
    const formulas = board.columns.filter((column) => column.type === 'formula');
    for (let start = 0; start < formulas.length; start += 5) {
      const ids = formulas.slice(start, start + 5).map((column) => column.id);
      await this.api.formulaValues(items.length * ids.length);
      const result = await this.api.query(
        `query FormulaValues ($ids: [ID!], $columns: [String!]) { ${BUDGET} items(ids: $ids) { id column_values(ids: $columns) { id ... on FormulaValue { display_value } } } }`,
        { ids: items.map((item) => item.id), columns: ids },
        z.object({
          items: z.array(
            z.object({
              id: z.string(),
              column_values: z.array(z.object({ id: z.string(), display_value: z.string().nullish() })),
            }),
          ),
        }),
      );
      for (const item of result.items) {
        const source = items.find((source) => source.id === item.id);
        for (const value of item.column_values)
          Object.assign(source?.column_values.find((column) => column.id === value.id) ?? {}, value);
      }
    }
    const needed = new Set<string>();
    for (const item of items)
      for (const column of item.column_values)
        if (['people', 'person', 'team'].includes(column.type)) {
          for (const entity of array(column.persons_and_teams ?? cell(column).personsAndTeams))
            if (object(entity).kind === 'person' && !this.people.has(String(object(entity).id)))
              needed.add(String(object(entity).id));
        }
    const ids = [...needed];
    for (let start = 0; start < ids.length; start += PAGE) {
      const result = await this.api.query(
        `query ReadPeople ($ids: [ID!]) { ${BUDGET} users(ids: $ids) { id name email } }`,
        { ids: ids.slice(start, start + PAGE) },
        z.object({
          users: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullish() })),
        }),
      );
      for (const user of result.users) this.people.set(user.id, user.email || user.name);
    }
    for (const item of items)
      for (const column of item.column_values)
        if (['people', 'person', 'team'].includes(column.type)) {
          const entities = array(column.persons_and_teams ?? cell(column).personsAndTeams);
          // Teams cannot be assigned as Riosoma members.  Preserve the displayed names as text.
          column.people = entities.some((entity) => object(entity).kind !== 'person')
            ? [column.text || entities.map((entity) => String(object(entity).id)).join(', ')]
            : entities.map(
                (entity) => this.people.get(String(object(entity).id)) ?? String(object(entity).id),
              );
        }
  }

  private record(item: Item, child: boolean): SourceRecord {
    const values: Record<string, unknown> = Object.fromEntries(
      item.column_values.map((column) => [
        column.id,
        {
          ...column,
          ...(column.type === 'item_id' ? { itemId: item.id } : {}),
          ...(column.type === 'subtasks'
            ? {
                subitems_ids: item.subitems
                  .filter((child) => !child.parent_item || child.parent_item.id === item.id)
                  .map((child) => child.id),
              }
            : {}),
        },
      ]),
    );
    for (const column of this.boards.get(item.board.id)?.columns ?? []) {
      const targets =
        column.type === 'board_relation' ? array(object(column.settings).boardIds).map(String) : [];
      if (targets.length > 1)
        for (const target of targets) values[`${column.id}:board:${target}`] = values[column.id];
    }
    values.name = item.name;
    values[GROUP] = item.group?.title ?? null;
    if (child && item.parent_item)
      values[item.parent_item.parent_item ? CHILD_PARENT : PARENT] = [item.parent_item.id];
    return { id: item.id, values };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const child = this.children.get(table.id);
    if (!child) {
      const board = this.boards.get(table.id)!;
      for await (const page of this.api.pages(table.id, ITEM_FIELDS, Item)) {
        const items = page.filter((item) => active(item) && !item.parent_item);
        if (!items.length) {
          yield [];
          continue;
        }
        await this.enrich(items, board);
        yield items.map((item) => this.record(item, false));
      }
      return;
    }
    const seen = new Set<string>();
    for await (const roots of this.api.pages(child.parent, DISCOVERY_FIELDS, Discovery)) {
      const pending = roots
        .filter(active)
        .flatMap((root) =>
          root.subitems.filter((item) => item.board.id === child.board).map((item) => item.id),
        );
      while (pending.length) {
        const ids = pending.splice(0, PAGE).filter((id) => !seen.has(id));
        if (!ids.length) continue;
        ids.forEach((id) => seen.add(id));
        const page = await this.api.query(
          `query ReadChildren ($ids: [ID!]) { ${BUDGET} items(ids: $ids) { ${ITEM_FIELDS} } }`,
          { ids },
          z.object({ items: z.array(Item) }),
        );
        const items = page.items.filter(active);
        for (const item of items)
          pending.push(
            ...item.subitems.filter((item) => item.board.id === child.board).map((item) => item.id),
          );
        if (items.length) await this.enrich(items, this.boards.get(child.board)!);
        yield items.map((item) => this.record(item, true));
      }
    }
  }
}

export const mondayReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: token, 'API-Version': MONDAY_VERSION }),
    secrets: () => [token],
  });
  const api = new MondayApi(client);
  return {
    bases: async (): Promise<PlatformBase[]> =>
      (await api.boards()).map((board) => ({
        id: board.id,
        name: board.name,
        group: board.workspace?.name ?? null,
      })),
    kept: async () => context.credential,
    source: (id) => new MondaySource(api, id, fieldNames(context)),
  };
};

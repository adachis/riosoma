import { z } from 'zod';
import type { CellValue } from './data/values.js';

/**
 * The parts of Data Source that tables, fields, and records refer to.  They live apart from the
 * connection contracts in `sources.ts`, which depend on the data contracts, so neither imports the
 * other in a cycle.
 */

export const SourceId = z.string().regex(/^src[0-9A-Za-z]{14}$/);

export const SOURCE_KINDS = [
  'postgres',
  'mysql',
  'sqlserver',
  'oracle',
  'firebird',
  'snowflake',
  'bigquery',
  'databricks',
  'motherduck',
  'redshift',
  'athena',
  'duckdb-file',
  'clickhouse',
  'trino',
  'druid',
  'teradata',
  'db2',
  'informix',
  'file-url',
  'bucket',
  'sftp',
  'ftp',
  'ftps',
  'webdav',
  'graphql',
  'odata',
  'rest',
  'app',
  'mongodb',
  'dynamodb',
  'couchdb',
  'couchbase',
  'firestore',
  'cosmosdb',
  'elasticsearch',
  'opensearch',
  'meilisearch',
  'typesense',
  'neo4j',
  'influxdb',
  'prometheus',
  'google-sheets',
  'airtable',
  'sharepoint-list',
  'excel-online',
  'dataverse',
  'feed',
  'webhook',
] as const;
export const SourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * The kinds that read files rather than a database: one file at a web address, a bucket's files,
 * or a file server's directory.
 */
export const FILE_SOURCE_KINDS = [
  'file-url',
  'bucket',
  'sftp',
  'ftp',
  'ftps',
  'webdav',
] as const satisfies readonly SourceKind[];
export type FileSourceKind = (typeof FILE_SOURCE_KINDS)[number];

export function isFileKind(kind: SourceKind): kind is FileSourceKind {
  return (FILE_SOURCE_KINDS as readonly SourceKind[]).includes(kind);
}

/** Whether a kind reads a web API's endpoints, which it offers instead of tables. */
export function isApiKind(kind: SourceKind): kind is 'rest' | 'graphql' | 'odata' {
  return kind === 'rest' || kind === 'graphql' || kind === 'odata';
}

/** Document services accessed through their HTTP APIs. */
export const NOSQL_KINDS = ['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb'] as const;
export type NoSqlKind = (typeof NOSQL_KINDS)[number];

export function isNoSqlKind(kind: string): kind is NoSqlKind {
  return (NOSQL_KINDS as readonly string[]).includes(kind);
}

/** Whether a source offers document collections instead of relational tables. */
export function isDocumentKind(kind: SourceKind): kind is 'mongodb' | NoSqlKind {
  return kind === 'mongodb' || isNoSqlKind(kind);
}

/**
 * The kinds that read another app's own tables: a Google spreadsheet's sheets, an Airtable base's
 * tables, a SharePoint site's lists, an Excel workbook's sheets, or a Dataverse environment's tables.
 */
export const APP_SOURCE_KINDS = [
  'app',
  'google-sheets',
  'airtable',
  'sharepoint-list',
  'excel-online',
  'dataverse',
] as const satisfies readonly SourceKind[];
export type AppSourceKind = (typeof APP_SOURCE_KINDS)[number];

/** The Microsoft 365 kinds, which all sign in as an Entra app with a client secret. */
export const MICROSOFT_SOURCE_KINDS = [
  'sharepoint-list',
  'excel-online',
  'dataverse',
] as const satisfies readonly SourceKind[];
export type MicrosoftSourceKind = (typeof MICROSOFT_SOURCE_KINDS)[number];

export function isMicrosoftKind(kind: SourceKind): kind is MicrosoftSourceKind {
  return (MICROSOFT_SOURCE_KINDS as readonly SourceKind[]).includes(kind);
}

/** Whether a kind reads an app's sheets or tables, which take no queries. */
export function isAppKind(kind: SourceKind): kind is AppSourceKind {
  return (APP_SOURCE_KINDS as readonly SourceKind[]).includes(kind);
}

/** Whether a kind reads an RSS, Atom, or JSON feed, whose items are what it offers. */
export function isFeedKind(kind: SourceKind): kind is 'feed' {
  return kind === 'feed';
}

/**
 * Whether a kind is an incoming webhook: another system posts to it, and each post becomes or
 * updates records as they arrive, so its tables never sync on a schedule.
 */
export function isWebhookKind(kind: SourceKind): kind is 'webhook' {
  return kind === 'webhook';
}

/** The one thing a feed source offers, its items, and the one a webhook offers, its posts. */
export const FEED_OBJECT = 'items';
export const WEBHOOK_OBJECT = 'posts';

/** How often a feed's table may sync, in minutes: every 15 minutes at most, and once a day at least. */
export const FEED_SCHEDULE = { min: 15, max: 1_440 } as const;

export const SourceObjectRef = z.object({
  schema: z.string().max(255).nullable(),
  name: z.string().min(1).max(255),
});
export type SourceObjectRef = z.infer<typeof SourceObjectRef>;

/** The longest filter a synced table may keep, as text. */
export const FILTER_LENGTH = 20_000;

/**
 * Operators that run JavaScript on the server, which a filter never may: a filter is a query
 * document and nothing more.  `$code` is how Extended JSON writes a piece of JavaScript.
 */
const JAVASCRIPT_OPERATORS = new Set(['$where', '$function', '$accumulator', '$code']);

/**
 * What keeps text from being a MongoDB filter, if anything: `json` when it isn't one JSON object,
 * or `javascript` when it asks the server to run code.  Extended JSON's own forms, like
 * `{"$oid": "…"}` or `{"$date": "…"}`, are JSON objects too, so they pass.
 */
export function filterProblem(text: string): 'json' | 'javascript' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'json';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'json';
  const pending: Array<[unknown, number]> = [[parsed, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    // A filter this deep is no filter a person wrote.
    if (depth > 100) return 'json';
    for (const [key, inner] of Object.entries(value)) {
      if (JAVASCRIPT_OPERATORS.has(key)) return 'javascript';
      pending.push([inner, depth + 1]);
    }
  }
  return null;
}

/**
 * What keeps an engine's own filter text from being safe to AND with a reader's record rules, if
 * anything: `unbalanced` when it closes a group it never opened, or leaves a group or a quoted
 * value open.  Depth is measured outside quoted values, where a parenthesis is only text.
 *
 * Meilisearch binds AND tighter than OR, so text like `a) OR (b` would end the group the record
 * rules sit in and exempt every document from them.  It quotes a value with `'` or `"` and escapes
 * inside one with a backslash, so a backtick is plain text there.  A filter left open fails every
 * read.
 *
 * Typesense takes one filter string, with the record rules joined after the admin's text.  It
 * quotes only with backticks, and its tokenizer toggles on every one, escaped or not, and never
 * refuses an unclosed one.  An open backtick would swallow the rules into one value, and a group
 * closed early would end the one they sit in.
 */
export function searchFilterProblem(text: string, kind: 'meilisearch' | 'typesense'): 'unbalanced' | null {
  const quotes = kind === 'meilisearch' ? ['"', "'"] : ['`'];
  let depth = 0;
  let quote: string | null = null;
  for (let at = 0; at < text.length; at++) {
    const character = text[at]!;
    if (quote !== null) {
      if (kind === 'meilisearch' && character === '\\') at++;
      else if (character === quote) quote = null;
      continue;
    }
    if (quotes.includes(character)) quote = character;
    else if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return 'unbalanced';
  }
  return depth === 0 && quote === null ? null : 'unbalanced';
}

/**
 * What a synced table reads: a whole table or view, or (admins only) a read-only query.  A
 * MongoDB collection or view can also carry a filter (admins only), a JSON query document that
 * narrows which documents it reads.
 */
export const SourceSelect = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('object'),
    object: SourceObjectRef,
    nativeFilter: z.string().trim().min(1).max(FILTER_LENGTH).optional(),
    filter: z
      .string()
      .trim()
      .min(1)
      .max(FILTER_LENGTH)
      .refine((text) => filterProblem(text) === null)
      .optional(),
  }),
  z.object({ kind: z.literal('query'), sql: z.string().min(1).max(20_000) }),
]);
export type SourceSelect = z.infer<typeof SourceSelect>;

/**
 * How fresh a synced table's source fields are.  `copy` keeps a copy that syncs on a schedule.
 * `live` keeps no copy and reads the source whenever someone reads the table, passing the view's
 * filters, sorts, and paging down to it.  Overrides, local fields, comments, and history stay
 * here either way.
 */
export const FRESHNESS = ['copy', 'live'] as const;
export const Freshness = z.enum(FRESHNESS);
export type Freshness = z.infer<typeof Freshness>;

/** Search engines that take filters and sorts through their own HTTP APIs. */
export const SEARCH_SOURCE_KINDS = [
  'elasticsearch',
  'opensearch',
  'meilisearch',
  'typesense',
] as const satisfies readonly SourceKind[];
export type SearchSourceKind = (typeof SEARCH_SOURCE_KINDS)[number];

/** Every kind reached over HTTP with JSON: the search engines, a graph, and two time-series stores. */
export const HTTP_ENGINE_KINDS = [
  ...SEARCH_SOURCE_KINDS,
  'neo4j',
  'influxdb',
  'prometheus',
] as const satisfies readonly SourceKind[];
export type HttpEngineKind = (typeof HTTP_ENGINE_KINDS)[number];

export function isSearchSource(kind: string): kind is SearchSourceKind {
  return (SEARCH_SOURCE_KINDS as readonly string[]).includes(kind);
}

export function isHttpEngine(kind: string): kind is HttpEngineKind {
  return (HTTP_ENGINE_KINDS as readonly string[]).includes(kind);
}

/** Sources that can answer live reads with predicates enforced by the source. */
export const LIVE_SOURCE_KINDS = [
  ...SEARCH_SOURCE_KINDS,
  'odata',
  'postgres',
  'mysql',
  'sqlserver',
  'redshift',
  'athena',
  ...NOSQL_KINDS,
] as const satisfies readonly SourceKind[];

export function supportsLive(kind: SourceKind): boolean {
  return (LIVE_SOURCE_KINDS as readonly SourceKind[]).includes(kind);
}

/**
 * Field types a live table can't hold, since each needs every record at hand: links and what reads
 * through them, and formulas, which compute from the stored copy.
 */
export const LIVE_UNAVAILABLE_TYPES = ['link', 'lookup', 'rollup', 'count', 'formula'] as const;

export function liveAllowsType(type: string): boolean {
  return !(LIVE_UNAVAILABLE_TYPES as readonly string[]).includes(type);
}

/**
 * How a synced table follows its source.  Stored on the table; `status` is set by the server.
 */
export const TableSourceSettings = z.object({
  sourceId: SourceId,
  select: SourceSelect,
  /** Copy on a schedule, or read the source live (PostgreSQL, MySQL, and SQL Server only) */
  freshness: Freshness.default('copy'),
  /**
   * Source columns whose values identify a record from one sync to the next.  Every kind needs at
   * least one, except a webhook, whose posts each add a record when it has none.
   */
  keyColumns: z.array(z.string().min(1).max(255)).max(8),
  /** Minutes between syncs; null syncs only when someone asks */
  everyMinutes: z.number().int().min(5).max(10_080).nullable().default(60),
  allowOverrides: z.boolean().default(true),
  /**
   * A sync that would remove more than this share of the table's records waits for someone to
   * confirm it, since a broken source often looks like an empty one.
   */
  holdAboveDeleteShare: z.number().min(0).max(1).default(0.5),
  /**
   * Whether records whose rows leave the source are removed.  Unset means the kind's own way:
   * removed for every kind but a feed, whose old items stay once they scroll out of it.
   */
  removeMissing: z.boolean().optional(),
});
export type TableSourceSettings = z.infer<typeof TableSourceSettings>;

/** Whether a sync removes the records whose rows have left the source. */
export function removesMissing(
  settings: Pick<TableSourceSettings, 'removeMissing'>,
  kind: SourceKind,
): boolean {
  return settings.removeMissing ?? !isFeedKind(kind);
}

export const SYNC_STATES = ['queued', 'running', 'idle', 'failed', 'held'] as const;
export const SyncState = z.enum(SYNC_STATES);
export type SyncState = z.infer<typeof SyncState>;

export const SyncStats = z.object({
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
  unchanged: z.number().int(),
  /** Overrides that cleared themselves because the source now agrees with them */
  overridesCleared: z.number().int(),
  ms: z.number(),
});
export type SyncStats = z.infer<typeof SyncStats>;

export const SyncStatus = z.object({
  state: SyncState,
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextSyncAt: z.string().nullable(),
  /** Safe message parameters keep source names available after the status crosses the API boundary. */
  error: z
    .object({
      messageKey: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      detail: z.string().optional(),
    })
    .nullable(),
  stats: SyncStats.nullable(),
  /** Rows reported by the current copy, without estimating a total the source did not give. */
  progress: z.object({ rowsRead: z.number().int().nonnegative() }).optional(),
  /** Set while a sync waits for someone to confirm it may remove this many of the total */
  held: z.object({ removing: z.number().int(), total: z.number().int() }).nullable(),
  /**
   * Set while a live table switching to Copy waits for its first sync.  It keeps reading the source
   * live until that sync has copied every record, and becomes a Copy table in the same step.
   */
  switchingToCopy: z.boolean().optional(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

/** A synced table's settings as everyone sees them, with where the data comes from and how it's going. */
export const TableSource = TableSourceSettings.extend({
  sourceName: z.string(),
  sourceKind: SourceKind,
  status: SyncStatus,
});
export type TableSource = z.infer<typeof TableSource>;

/**
 * Whether a synced table reads its source live now: set to Live, or switching to Copy and still
 * waiting for the first sync that makes its copy.
 */
export function readsSourceLive(
  source: { freshness?: Freshness; status: { switchingToCopy?: boolean } } | undefined | null,
): boolean {
  return Boolean(source && (source.freshness === 'live' || source.status.switchingToCopy === true));
}

/** A field copied from a source column.  Its values change only through syncs and overrides. */
export const FieldSource = z.object({
  column: z.string().min(1).max(255),
  sourceType: z.string().max(255),
});
export type FieldSource = z.infer<typeof FieldSource>;

/** A local value standing in for a source value in one cell. */
export const OverrideSchema = z.object({
  source: z.unknown(),
  by: z.string().nullable(),
  at: z.string(),
  value: z.unknown().optional(),
});
export interface Override {
  /** A computed result pinned locally instead of stored in a field column */
  value?: CellValue;
  /** What the source says now */
  source: CellValue;
  by: string | null;
  at: string;
}

/** A retained sync attempt, including attempts that failed or waited for confirmation. */
export interface SyncRun {
  id: string;
  tableId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: 'running' | 'succeeded' | 'held' | 'failed' | 'canceled';
  stats: SyncStats | null;
  errorKey: string | null;
}

export interface SyncHistoryPage {
  runs: SyncRun[];
  next: string | null;
}

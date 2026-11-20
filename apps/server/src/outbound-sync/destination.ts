import type { z } from 'zod';
import type {
  ChoiceColor,
  DestinationCredential,
  DestinationKind,
  DestinationLookup,
  DestinationPlaces,
  OutboundDestination,
  SyncOutValueKind,
  SyncOutWrite,
} from '@riosoma/contracts';
import type { Resolve } from '../automations/outbound.js';
import type { Clock, Limiter } from '../data/imports/core/clock.js';

/**
 * What a destination kind does for Sync out.  The engine reads the view, decides which rows to
 * create, update, and remove, and keeps the map of record to outside row.  An adapter knows one
 * outside system: how to list where rows can go, describe a table's columns, make a table and its
 * columns, and write a batch of rows.  It never reads Riosoma's data and never touches the
 * database, so a SQL or warehouse destination is one more adapter and nothing else.
 *
 * Every call an adapter makes goes through `DestinationContext.http`, which the engine builds from
 * the adapter's own `address`, `headers`, `pacing`, and `problem`.  An adapter never opens a
 * connection of its own, so the address guard, the pacing, the retries, and the scrubbing of
 * credentials out of answers are the same for every kind.
 */

export type DestinationOf<K extends DestinationKind> = Extract<OutboundDestination, { kind: K }>;
export type LookupOf<K extends DestinationKind> = Extract<DestinationLookup, { kind: K }>;

/**
 * How far a problem reaches.  A `row` problem is one row's alone, and the run carries on.  A `run`
 * problem ends this run, and a later run may well succeed, as after a rate limit.  A `sync`
 * problem will come back every run until a person changes something, as with a refused token.
 */
export type ProblemScope = 'row' | 'run' | 'sync';

/** What went wrong, as a server message key and what fills it in.  Never a value or a credential. */
export interface DestinationProblem {
  messageKey: string;
  params?: Record<string, string | number | boolean>;
  scope: ProblemScope;
  /**
   * The outside column the problem is about, by the service's own ID, when the service names one.
   * The engine turns it into the field, so the message is kept from people who can't see that
   * field.
   */
  columnId?: string;
}

/**
 * A call to the destination that failed.  `status` is the HTTP status the service answered with,
 * or null when no answer came back.  `unconfirmed` is true when the request may have reached the
 * service and its answer never came back, so nobody knows whether it was carried out.
 */
export class DestinationError extends Error {
  readonly status: number | null;
  readonly unconfirmed: boolean;

  constructor(
    readonly problem: DestinationProblem,
    options: { status?: number | null; unconfirmed?: boolean; cause?: unknown } = {},
  ) {
    super(problem.messageKey, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DestinationError';
    this.status = options.status ?? null;
    this.unconfirmed = options.unconfirmed ?? false;
  }
}

export interface OutboundRequest<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A path under the adapter's address, starting with a slash */
  path: string;
  query?: URLSearchParams;
  /** Sent as JSON */
  body?: unknown;
  /** Checks a 2xx answer.  An empty answer is checked as `{}`. */
  schema: z.ZodType<T>;
  /**
   * Whether sending it twice does no harm.  Only these are sent again after a failure that may
   * have reached the service.  A request that isn't, and fails that way, throws a
   * `DestinationError` with `unconfirmed` set.
   */
  idempotent: boolean;
}

/** The part of a request an adapter's `problem` is told about */
export type OutboundCall = Pick<OutboundRequest<unknown>, 'method' | 'path'>;

/**
 * One guarded JSON call to the destination.  The implementation:
 *
 * 1. Waits its turn with the limiter before every try.
 * 2. Sends through the server's guarded network path, only ever to the adapter's own origin, with
 *    the adapter's headers, `accept: application/json`, and, when there is a body,
 *    `content-type: application/json`.
 * 3. On 2xx, takes the credential out of every string in the answer, then checks it with `schema`.
 *    An answer that doesn't check is `syncOut.destination.unreadable`, a `run` problem, and
 *    `unconfirmed` for a request that isn't idempotent.
 * 4. On a 5xx, a timeout, or a dropped connection, tries an idempotent request again with a
 *    doubling wait, up to six tries, then throws `syncOut.destination.unavailable`.  For any other
 *    request it throws `syncOut.destination.unconfirmed` at once, with `unconfirmed` set.  A
 *    failure before anything was sent, such as a name that doesn't resolve, is never `unconfirmed`.
 * 5. On any other status outside 2xx, reads up to 64 KB of the answer, takes the credential out,
 *    and asks the adapter's `problem` what it means, passing the request's method and path.
 * 6. On 429, throws that problem at once when its scope is `sync`, as for a used-up quota.
 *    Otherwise pauses the limiter for the `retry-after` time, or `pacing.waitMs` without one, and
 *    tries again, up to six tries, whatever the method, since a 429 was never carried out.  When
 *    the tries run out it throws `syncOut.destination.rateLimited`.
 * 7. On any other refusal, throws the adapter's problem.
 *
 * Every `DestinationError` it throws carries the answer's status, or null when none came back.
 */
export interface OutboundHttp {
  send<T>(request: OutboundRequest<T>): Promise<T>;
}

export interface DestinationContext {
  http: OutboundHttp;
  signal: AbortSignal;
}

/** A column Riosoma wants in the destination, in terms no one service owns */
export interface ColumnPlan {
  /** The Riosoma field it carries, or null for the key column */
  fieldId: string | null;
  /**
   * The field's name, cut to the destination's limit.  The name of a column that is to be made is
   * also unique among the plans and among the columns already there.
   */
  name: string;
  kind: SyncOutValueKind;
  /**
   * True for the column that names each row.  Exactly one plan of a new table has it, and it goes
   * first: the table's primary field when it is sent, and the key column otherwise.  Some services
   * need it to be text.
   */
  primary: boolean;
  /** Choice names in order, for the select kinds */
  choices?: ReadonlyArray<{ name: string; color: ChoiceColor }>;
  /** Decimal places, when the field fixes them */
  precision?: number | null;
  /** For `currency`: the ISO 4217 code and the symbol it's shown with */
  currency?: { code: string; symbol: string };
  /** For `longText`: whether the text is Markdown */
  richText?: boolean;
  /** For `rating`: the most a rating can be */
  ratingMax?: number;
  /** For `duration`: `h:mm`, `h:mm:ss`, and so on */
  durationFormat?: string;
  /** For `dateTime`: the IANA time zone its text is written in */
  timeZone?: string;
}

/**
 * One value on its way out.  `text` is how the app words it, and every cell has it, with `''` for
 * an empty cell.  The typed parts are there only when the value has them, and an adapter uses the
 * one the outside column's type calls for and falls back to `text`.
 */
export interface OutboundCell {
  text: string;
  number?: number;
  boolean?: boolean;
  /** `YYYY-MM-DD`.  A date and time also carries its date in the sync's time zone. */
  date?: string;
  /** An instant, as ISO 8601 in UTC */
  instant?: string;
  /** Choice names */
  choices?: readonly string[];
}

export interface OutsideColumn {
  /** The service's own ID for it */
  id: string;
  name: string;
  /** The service's own name for its type */
  type: string;
  /**
   * True only for a column of a type this version writes that the service doesn't compute or
   * lock.  An adapter decides from a list of types it knows it can write, so a type it has never
   * heard of is not writable.
   */
  writable: boolean;
  primary: boolean;
}

export interface OutsideTable {
  id: string;
  name: string;
  /** Where a person opens it, when the service gives an address */
  url: string | null;
  columns: OutsideColumn[];
  /** How many rows it holds, when the service says */
  rows: number | null;
}

/** A field's column as a run writes it */
export interface MappedColumn {
  /** Null when the field is no longer sent, and its cells are cleared */
  plan: ColumnPlan | null;
  column: OutsideColumn;
  write: SyncOutWrite;
}

export interface RowWrite {
  recordId: string;
  /** One cell for each mapped column, in the same order */
  cells: readonly OutboundCell[];
}

/**
 * One request's worth of rows, all for the same operation.  The engine never passes more than
 * `limits.writeBatch` rows to create or update, or `limits.removeBatch` to remove.
 */
export type RowBatch =
  | { op: 'create'; rows: readonly RowWrite[] }
  | { op: 'update'; rows: ReadonlyArray<RowWrite & { externalId: string }> }
  | { op: 'remove'; rows: ReadonlyArray<{ recordId: string; externalId: string }> };

/**
 * What became of one row.  `gone` means the outside row an update or removal named isn't there
 * anymore.  The engine counts a `gone` removal as removed, and makes a `gone` update's row again
 * in the same run.
 */
export type RowResult =
  | { recordId: string; outcome: 'created' | 'updated'; externalId: string }
  | { recordId: string; outcome: 'removed' | 'gone' }
  | { recordId: string; outcome: 'failed'; problem: DestinationProblem };

/** What lets a run find a table it made before it could save the table's ID */
export interface TableClaim {
  /**
   * The sync's ID.  An adapter writes it where the service has a place for it, such as a table's
   * description, and adopts a table by name only when it finds the ID there.
   */
  syncId: string;
  /** When an earlier run may have made the table, as ISO 8601, or null when none has tried */
  since: string | null;
  /**
   * Tables other syncs in the organization already send to, by the service's own ID.  None of
   * these is ever adopted.
   */
  taken: readonly string[];
}

export interface DestinationLimits {
  rows: number;
  columns: number;
  cells: number | null;
  cellCharacters: number;
  tableNameLength: number;
  columnNameLength: number;
  /** Rows one create or update request carries */
  writeBatch: number;
  /** Rows one removal request names */
  removeBatch: number;
}

export interface DestinationPacing {
  /** Requests that may start each second */
  perSecond: number;
  /** How long to hold every request after a 429 that names no wait, in milliseconds */
  waitMs: number;
  /**
   * What shares one budget: a base for Airtable, and an address with a token for Smartsheet.  A
   * key made from the credential holds a hash of it, never the credential itself.
   */
  key(where: OutboundDestination | DestinationLookup, credential: DestinationCredential): string;
  /** A limiter other features already use for the same budget, so they all stay under one limit */
  shared?(where: OutboundDestination | DestinationLookup): Limiter | undefined;
}

export interface DestinationAdapter<K extends DestinationKind = DestinationKind> {
  kind: K;
  limits: DestinationLimits;
  pacing: DestinationPacing;
  /**
   * Whether sending the same create twice leaves one row, as an upsert on the key column does.
   * Where it doesn't, the engine reads the key column before every run.
   */
  idempotentCreates: boolean;

  /** Where the service's API answers, without a trailing slash.  Tests point the engine elsewhere. */
  address(where: DestinationOf<K> | LookupOf<K>): string;
  /** The headers that carry the credential */
  headers(credential: DestinationCredential): Record<string, string>;
  /** Everything secret in the credential, to take out of answers */
  secrets(credential: DestinationCredential): string[];
  /**
   * What a refusal means.  `body` is the answer's JSON when it had any, and its text otherwise.
   * `request` says which call was refused, since a service may answer a read and a write alike.
   */
  problem(status: number, body: unknown, request: OutboundCall): DestinationProblem;

  /**
   * Checks the credential and lists where rows can go.  A credential the service refuses throws
   * the kind's `token` problem.
   */
  places(ctx: DestinationContext, lookup: LookupOf<K>): Promise<DestinationPlaces>;

  /**
   * A table's columns as they are now, or null when the table is gone.  A credential that can't
   * read the place the table is in throws that problem instead.
   */
  describe(ctx: DestinationContext, destination: DestinationOf<K>): Promise<OutsideTable | null>;

  /** The type the service would give a new column for this plan, by its own name */
  columnType(plan: ColumnPlan): string;

  /**
   * How a plan's values go into a column that's already there: in the column's own type, as text,
   * or not at all, for a column that isn't `writable` or whose type takes neither.
   */
  fit(plan: ColumnPlan, column: OutsideColumn): SyncOutWrite | null;

  /**
   * Makes the table or sheet named in `destination.table.name` with these columns, the primary
   * one first.  Before making one, it looks for a table an earlier run of this sync made and
   * couldn't save: one that carries `claim.syncId` where the service keeps such a mark, or, where
   * it keeps none and `claim.since` is set, one by that name made since then that holds the key
   * column.  It never adopts any other table by name.
   *
   * Each column it answers carries the type that was asked for, `columnType(plan)`, whatever type
   * the service's answer names.
   */
  createTable(
    ctx: DestinationContext,
    destination: DestinationOf<K>,
    columns: readonly ColumnPlan[],
    claim: TableClaim,
  ): Promise<OutsideTable>;

  /**
   * Adds columns after the ones there, and answers them in the order asked, each with the type
   * that was asked for, `columnType(plan)`.
   */
  addColumns(
    ctx: DestinationContext,
    destination: DestinationOf<K>,
    table: OutsideTable,
    columns: readonly ColumnPlan[],
  ): Promise<OutsideColumn[]>;

  /**
   * Every outside row's ID and what its key column holds, reading only the key column.  A row
   * with an empty key column is answered with `''`, so the engine can tell a row whose key was
   * cleared from a row that was deleted.  The listing is whole and consistent: where the service
   * pages by position, the adapter reads it again from the start when the table changes between
   * pages.
   */
  keys(
    ctx: DestinationContext,
    destination: DestinationOf<K>,
    table: OutsideTable,
    keyColumn: OutsideColumn,
  ): AsyncIterable<Array<{ externalId: string; key: string }>>;

  /**
   * Writes one batch and answers one result for each row, in any order.  The key column's cell
   * is the adapter's to fill, with each row's `recordId`, on every create and every update.  An
   * update names its row by `externalId`, never by the key, and answers `gone` when that row
   * isn't there.  A problem with one row comes back as that row's `failed` result.  A problem
   * with the whole request is thrown as a `DestinationError`.
   */
  apply(
    ctx: DestinationContext,
    destination: DestinationOf<K>,
    table: OutsideTable,
    keyColumn: OutsideColumn,
    columns: readonly MappedColumn[],
    batch: RowBatch,
  ): Promise<RowResult[]>;
}

const adapters = new Map<DestinationKind, DestinationAdapter>();

/** Makes a destination kind available.  A later registration for the same kind replaces it. */
export function registerDestination<K extends DestinationKind>(adapter: DestinationAdapter<K>): void {
  adapters.set(adapter.kind, adapter as unknown as DestinationAdapter);
}

export function destinationFor(kind: DestinationKind): DestinationAdapter | undefined {
  return adapters.get(kind);
}

/** What the engine hands the HTTP layer to build one `OutboundHttp` */
export interface OutboundHttpOptions {
  adapter: DestinationAdapter;
  where: OutboundDestination | DestinationLookup;
  credential: DestinationCredential;
  /** Where the API answers in place of the adapter's own address.  Tests point this at a fake. */
  address?: string;
  /** The budget this call shares, which the engine chooses from the adapter's `pacing` */
  limiter: Limiter;
  clock: Clock;
  resolve: Resolve;
  allowPrivate(url: URL): boolean;
  signal: AbortSignal;
  /** Told each call's method, path, status, and message key, and never a body or a header */
  log?(entry: { method: string; path: string; status: number | null; messageKey?: string }): void;
}

export type OutboundHttpFactory = (options: OutboundHttpOptions) => OutboundHttp;

let httpFactory: OutboundHttpFactory | undefined;

/** Sets how calls reach a destination.  The engine and the HTTP layer meet only here. */
export function registerOutboundHttp(factory: OutboundHttpFactory): void {
  httpFactory = factory;
}

/** One guarded way out for one run or one request, built by whatever was registered */
export function outboundHttp(options: OutboundHttpOptions): OutboundHttp {
  if (!httpFactory) throw new Error('No outbound HTTP layer is registered');
  return httpFactory(options);
}

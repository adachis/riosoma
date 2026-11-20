import type { DocumentRequest } from './nosql/connector.js';
import type { SearchRequest } from './http-engines/search.js';
import type {
  CellValue,
  SourceColumn,
  SourceConnection,
  SourceKind,
  SourceObject,
  SourceObjectRef,
  SourceSecrets,
  SourceSelect,
  SourceTestResult,
} from '@riosoma/contracts';

/** What every connector call receives: where to connect, with what, and when to give up. */
export interface ConnectorContext {
  connection: SourceConnection;
  secrets: SourceSecrets;
  /** Provider account values are resolved by the server for this operation only. */
  accountValues?: Readonly<Record<string, string>>;
  /** The server turns a refused account into a reconnect message naming its owner. */
  onAuthRefused?(): Promise<never>;
  signal?: AbortSignal;
  /** Milliseconds before a call gives up (default 30 seconds; reads apply it per batch) */
  timeoutMs?: number;
  /** For a live read, each statement's own limit, when it's shorter than the time to connect */
  statementTimeoutMs?: number;
  /** The saved source's ID, for connectors whose data the server keeps, like a webhook's posts */
  sourceId?: string;
  /** Persistent driver storage shared by the server and workers */
  driversDir?: string;
  /**
   * The server's own secrets, which an installed driver's words never carry back, since its code
   * runs with the server's file access
   */
  serverSecrets?: readonly string[];
}

/** What a feed said about its answer last time, so the next read asks only for what changed. */
export interface Validators {
  etag?: string;
  cursor?: string;
  projection?: string;
  pending?: { validators: Validators | null; incremental: boolean };
  lastModified?: string;
}

export interface ReadOptions {
  /** Source columns to read, in this order */
  columns: string[];
  /** The field type each column is read as, so values arrive in Riosoma's forms */
  types: Record<string, string>;
  /** Columns whose values make each row's key */
  keyColumns: string[];
  /** Rows per batch (default 5,000) */
  batchSize?: number;
  /**
   * The validators the last finished read's answer gave.  A source that honors them answers "not
   * modified" when nothing changed, and the read throws `NotModified` instead of giving rows.
   */
  since?: Validators;
  /** Hears the validators this read's answer gave, to keep for the next one */
  onValidators?(validators: Validators): void;
  onIncremental?(): void;
}

/** A read found nothing changed since the validators it was given, so there are no rows to give. */
export class NotModified extends Error {
  constructor() {
    super('not modified');
    this.name = 'NotModified';
  }
}

/** One source row: its key (see `sourceKey`) and its values by column name. */
export interface SourceRow {
  deleted?: boolean;
  key: string;
  values: Record<string, CellValue>;
}

export interface SourcePreviewRows {
  columns: SourceColumn[];
  rows: CellValue[][];
  rowEstimate: number | null;
}

/**
 * One kind of source.  Connectors never keep connections between calls: each call connects,
 * works, and disconnects, so a changed password or a moved server takes effect at once.
 */
export interface Connector {
  kind: SourceKind;
  /** Climbs the test steps in order and stops at the first failure; never throws for a failure */
  test(ctx: ConnectorContext): Promise<SourceTestResult>;
  listObjects(ctx: ConnectorContext): Promise<SourceObject[]>;
  describe(ctx: ConnectorContext, select: SourceSelect): Promise<SourceColumn[]>;
  preview(ctx: ConnectorContext, select: SourceSelect, limit: number): Promise<SourcePreviewRows>;
  /** Column sets the source declares unique, primary key first; empty for queries and views */
  keyCandidates(ctx: ConnectorContext, object: SourceObjectRef): Promise<string[][]>;
  /** Every row, in batches, with values converted to each column's field type */
  read(ctx: ConnectorContext, select: SourceSelect, options: ReadOptions): AsyncIterable<SourceRow[]>;
  /**
   * Opens a session a live table's pool keeps between reads.  Only the SQL databases, which can
   * answer a filtered, sorted page, have one.
   */
  session?(ctx: ConnectorContext): Promise<LiveSession>;
  documentQuery?(ctx: ConnectorContext, select: SourceSelect, request: DocumentRequest): Promise<SourceRow[]>;
  /**
   * Reads raw documents that meet a predicate, in the engine's own order, in pages.  Only the
   * search engines have one, since each pushes a filter and a sort down to its own query syntax.
   */
  search?(
    ctx: ConnectorContext,
    select: SourceSelect,
    request: SearchRequest,
  ): AsyncIterable<Array<Record<string, unknown>>>;
}

/** A connection kept open for live reads, with the dialect's own statement timeout. */
export interface LiveSession {
  close(): Promise<void>;
  describe(select: SourceSelect): Promise<SourceColumn[]>;
  /** Runs one read in a read-only transaction where the system has them */
  select(text: string, params: readonly string[]): Promise<Array<Record<string, unknown>>>;
}

/** Why a connector call failed, as a message key people can act on plus the driver's words. */
export class ConnectorError extends Error {
  constructor(
    readonly messageKey: string,
    readonly detail?: string,
    readonly params?: Record<string, unknown>,
  ) {
    super(detail ?? messageKey);
    this.name = 'ConnectorError';
  }
}

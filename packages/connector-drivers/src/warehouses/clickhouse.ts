import { isIP } from 'node:net';
import { ClickHouseError, ClickHouseLogLevel, createClient } from '@clickhouse/client';
import type { SourceConnection, SourceObject, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { positive } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type Connector, type ConnectorContext } from '@riosoma/connectors/internal/types.js';
import {
  connectionOf,
  KEYS,
  objectMissing,
  secretOf,
  wordsOf,
  type Missing,
} from '@riosoma/connectors/internal/warehouses/errors.js';
import {
  directNetwork,
  httpAddress,
  makeWarehouseConnector,
  type Endpoint,
  type Network,
  type Row,
  type WarehouseSession,
} from '@riosoma/connectors/internal/warehouses/frame.js';
import { clickHouseEndpoint } from '@riosoma/connectors/internal/warehouses/clickhouse-endpoint.js';
import {
  blockedHost,
  bodyExcerpt,
  sessionAgent,
  type HostGuard,
} from '@riosoma/connectors/internal/warehouses/http.js';
import {
  describeColumn,
  type Described,
  type TypeClass,
} from '@riosoma/connectors/internal/warehouses/mapping.js';
import {
  CLICKHOUSE,
  guard,
  guardedSelect,
  literal,
  quotePath,
} from '@riosoma/connectors/internal/warehouses/sql.js';
import {
  exactInteger,
  ownSchemaFirst,
  textOr,
  wholeNumber,
} from '@riosoma/connectors/internal/warehouses/values.js';

export { clickHouseEndpoint };

/**
 * ClickHouse and ClickHouse Cloud, through the HTTP interface with `@clickhouse/client`.  Every
 * answer comes as JSON lines, names and types first, and the connector asks for nothing a
 * read-only user can't: no settings travel, so values that depend on output settings are written
 * in SQL instead (64-bit integers and decimals as their digits, and date-times in UTC).  A read
 * pages through a fixed order, so each request stays short, and a row never lands on two pages.
 * A table whose engine merges rows in the background reads with `FINAL`, so it shows each row once,
 * merged, even before ClickHouse gets to it.
 */

type ClickHouseSettings = Extract<SourceConnection, { kind: 'clickhouse' }>;

/** Rows a read asks for in one request. */
export const CLICKHOUSE_PAGE_ROWS = 50_000;
/** Databases ClickHouse keeps for itself, which hold nothing anyone means to sync. */
const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];
/**
 * Engines whose rows are messages: reading one takes them from everyone else, so they're never
 * offered.  ClickHouse refuses to read them directly anyway, unless an admin allows it.
 */
const STREAMING_ENGINES = ['Kafka', 'RabbitMQ', 'NATS', 'FileLog', 'S3Queue', 'AzureQueue'];
/**
 * Engines that replace, collapse, sum, or aggregate rows as parts merge, whether on one server,
 * replicated, or in ClickHouse Cloud.  Until a merge, such a table holds every version of a row,
 * and `FINAL` reads it as the merge would leave it.
 */
const MERGING_ENGINE =
  /^(?:Replicated|Shared)?(?:Replacing|Collapsing|VersionedCollapsing|Summing|Aggregating)MergeTree$/;

/** Whether a table's engine needs `FINAL` for a read to see its rows merged. */
export function readsFinal(engine: unknown): boolean {
  return MERGING_ENGINE.test(String(engine ?? ''));
}

export interface ClickHouseConnect {
  url: string;
  username: string;
  password: string;
  database: string;
  caPem?: string;
  timeoutMs: number;
  /** Holds the host to the server's private-network rule */
  hostGuard?: HostGuard;
}

/** One query's answer: its column names, their types, then its rows in chunks as they stream in. */
export interface ClickHouseAnswer {
  names: string[];
  types: string[];
  chunks: AsyncIterable<unknown[][]>;
}

export interface ClickHouseClientLike {
  query(sql: string, params: Record<string, string>, signal: AbortSignal): Promise<ClickHouseAnswer>;
  close(): Promise<void>;
}

/** The slice of the client this connector uses, so a test can stand in a fake of the same shape. */
export interface ClickHouseDriver {
  createClient(options: ClickHouseConnect): ClickHouseClientLike;
}

/** The names and types rows of a `JSONCompactEachRowWithNamesAndTypes` answer, then the rest. */
async function answerOf(chunks: AsyncIterator<unknown[][]>): Promise<ClickHouseAnswer> {
  const head: unknown[][] = [];
  let rest: unknown[][] = [];
  while (head.length < 2) {
    const next = await chunks.next();
    if (next.done) break;
    const needed = 2 - head.length;
    head.push(...next.value.slice(0, needed));
    rest = next.value.slice(needed);
  }
  const strings = (row: unknown[] | undefined) => (row ?? []).map((item) => String(item));
  return {
    names: strings(head[0]),
    types: strings(head[1]),
    chunks: (async function* () {
      if (rest.length > 0) yield rest;
      for (;;) {
        const next = await chunks.next();
        if (next.done) return;
        yield next.value;
      }
    })(),
  };
}

/**
 * A failure as the client gives it, except that one from something other than ClickHouse, like a
 * proxy or another service on the port, keeps only the start of its body, as plain text.  The
 * client makes such a body the whole message.
 */
function withPlainBody(error: unknown): unknown {
  if (error instanceof ClickHouseError || !(error instanceof Error)) return error;
  if ((error as { code?: unknown }).code !== undefined) return error;
  error.message = bodyExcerpt(error.message) || 'the server answered with an error page';
  return error;
}

const realDriver: ClickHouseDriver = {
  createClient(options) {
    // The session's own connections carry the authority it trusts and look hosts up through the
    // guard, which the client's default connections can't.
    const agent = sessionAgent({
      secure: options.url.startsWith('https:'),
      ...(options.caPem ? { ca: options.caPem } : {}),
      ...(options.hostGuard ? { guard: options.hostGuard } : {}),
    });
    const client = createClient({
      url: options.url,
      username: options.username,
      password: options.password,
      database: options.database,
      application: 'riosoma',
      request_timeout: options.timeoutMs,
      log: { level: ClickHouseLogLevel.OFF },
      http_agent: agent,
    });
    return {
      async query(sql, params, signal) {
        const result = await client
          .query({
            query: sql,
            format: 'JSONCompactEachRowWithNamesAndTypes',
            query_params: params,
            abort_signal: signal,
          })
          .catch((error: unknown) => {
            throw withPlainBody(error);
          });
        const stream = result.stream<unknown[]>();
        const chunks = (async function* () {
          try {
            for await (const rows of stream) yield rows.map((row) => row.json());
          } finally {
            result.close();
          }
        })();
        return answerOf(chunks[Symbol.asyncIterator]());
      },
      close: () => client.close(),
    };
  },
};

/** A ClickHouse type, read into its name and the text inside its parentheses. */
interface TypeParts {
  name: string;
  args: string;
}

function partsOf(type: string): TypeParts {
  const text = type.trim();
  const open = text.indexOf('(');
  if (open < 0 || !text.endsWith(')')) return { name: text, args: '' };
  return { name: text.slice(0, open).trim(), args: text.slice(open + 1, -1) };
}

/** The arguments of a type, split at its top-level commas, outside quotes and parentheses. */
function topLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const character = args[i]!;
    if (quote) {
      if (character === '\\') i++;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '`' || character === '"') quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** The type inside the wrappers that change nothing about the values: nullability, dictionaries, and simple aggregates. */
function unwrapped(type: string): { type: string; nullable: boolean } {
  let nullable = false;
  let current = type.trim();
  for (;;) {
    const { name, args } = partsOf(current);
    if (name === 'Nullable') nullable = true;
    else if (name !== 'LowCardinality' && name !== 'SimpleAggregateFunction')
      return { type: current, nullable };
    current = name === 'SimpleAggregateFunction' ? (topLevel(args)[1] ?? '') : args;
  }
}

/** An enumeration's labels, in the order it declares them, with ClickHouse's escapes read. */
export function enumLabels(args: string): string[] {
  const labels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "'") continue;
    let label = '';
    for (i++; i < args.length; i++) {
      const character = args[i]!;
      if (character === '\\' && i + 1 < args.length) {
        const escaped = args[++i]!;
        label += { n: '\n', t: '\t', r: '\r', '0': '\0' }[escaped] ?? escaped;
      } else if (character === "'") {
        if (args[i + 1] === "'") {
          label += "'";
          i++;
        } else break;
      } else label += character;
    }
    labels.push(label);
    // Past the label's number, to the next one.
    while (i < args.length && args[i] !== ',') i++;
  }
  return labels;
}

const WIDE_INTEGERS = new Set(['Int64', 'UInt64', 'Int128', 'UInt128', 'Int256', 'UInt256']);
const INTEGERS = new Set(['Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', ...WIDE_INTEGERS]);
const DECIMALS = new Set(['Decimal', 'Decimal32', 'Decimal64', 'Decimal128', 'Decimal256']);
const STRUCTURED = new Set([
  'Array',
  'Map',
  'Tuple',
  'Nested',
  'JSON',
  'Object',
  'Dynamic',
  'Variant',
  // Geometry is tuples and arrays of numbers underneath, which read well as JSON.
  'Point',
  'Ring',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'Geometry',
]);

/** What a ClickHouse type comes down to, with a decimal's scale and an enumeration's labels. */
export function clickHouseTypeClass(type: string): {
  kind: TypeClass;
  nullable: boolean;
  scale?: number;
  length?: number;
  labels?: string[];
} {
  const inner = unwrapped(type);
  const { name, args } = partsOf(inner.type);
  const nullable = inner.nullable;
  if (name === 'Bool' || name === 'Boolean') return { kind: 'boolean', nullable };
  if (INTEGERS.has(name)) return { kind: 'integer', nullable };
  if (name === 'Float32' || name === 'Float64' || name === 'BFloat16') return { kind: 'float', nullable };
  if (DECIMALS.has(name)) {
    const parts = topLevel(args);
    // `Decimal(P, S)` names its scale second, and `Decimal64(S)` alone.
    const scale = Number(name === 'Decimal' ? (parts[1] ?? '0') : (parts[0] ?? '0'));
    return { kind: 'decimal', nullable, scale: Number.isFinite(scale) ? scale : 0 };
  }
  if (name === 'String') return { kind: 'text', nullable };
  if (name === 'FixedString') return { kind: 'text', nullable, length: Number(args) || 0 };
  if (name === 'UUID' || name === 'IPv4' || name === 'IPv6') return { kind: 'text', nullable };
  if (name === 'Enum8' || name === 'Enum16' || name === 'Enum')
    return { kind: 'text', nullable, labels: enumLabels(args) };
  if (name === 'Date' || name === 'Date32') return { kind: 'date', nullable };
  // A date-time names its zone, and reads as the instant it is, in UTC.
  if (name === 'DateTime' || name === 'DateTime64') return { kind: 'timestamp', nullable };
  if (name === 'Time' || name === 'Time64') return { kind: 'time', nullable };
  if (STRUCTURED.has(name)) return { kind: 'json', nullable };
  // Intervals, aggregate states, `Nothing`, and anything new are named, not guessed at.
  return { kind: 'unknown', nullable };
}

/** A column as ClickHouse describes it.  A column is nullable only when its type says so. */
export function clickHouseColumn(name: string, type: string): Described {
  const { kind, nullable, scale, length, labels } = clickHouseTypeClass(type);
  return describeColumn({
    name,
    sourceType: type,
    nullable,
    kind,
    scale: scale ?? null,
    length: length ?? null,
    ...(labels === undefined ? {} : { labels }),
  });
}

/**
 * How a read writes one column so it arrives the same whatever the server's output settings:
 * integers past 32 bits and decimals as their digits, date-times as UTC wall time, and everything
 * else as ClickHouse writes it in JSON.
 */
export function clickHouseProjection(entry: Described, reference: string): string {
  const { name } = partsOf(unwrapped(entry.column.sourceType).type);
  if (WIDE_INTEGERS.has(name) || DECIMALS.has(name)) return `toString(${reference})`;
  if (name === 'DateTime' || name === 'DateTime64') return `toString(toTimeZone(${reference}, 'UTC'))`;
  return reference;
}

/** Whether a read can sort by a column: every scalar ClickHouse holds, and none of the structured ones. */
function sortable(entry: Described): boolean {
  return entry.kind !== 'json' && entry.kind !== 'unknown';
}

/**
 * How a column's values from a JSON answer become plain ones: a wide integer keeps its digits, a
 * decimal gets back the trailing zeros ClickHouse leaves off, so its digits match the other
 * systems', and a fixed string loses the NUL bytes that pad it, which no text holds.
 */
export function clickHouseValues(entry: Described): (value: unknown) => unknown {
  const type = unwrapped(entry.column.sourceType).type;
  if (entry.kind === 'integer')
    return (value) => (typeof value === 'string' || typeof value === 'bigint' ? exactInteger(value) : value);
  if (entry.kind === 'decimal') {
    const scale = clickHouseTypeClass(type).scale ?? 0;
    return (value) => (typeof value === 'string' ? withScale(value, scale) : value);
  }
  if (partsOf(type).name === 'FixedString')
    return (value) => (typeof value === 'string' ? value.replace(/\0+$/, '') : value);
  return (value) => value;
}

/** Decimal digits with as many places after the point as the type's scale. */
function withScale(digits: string, scale: number): string {
  if (scale <= 0 || !/^-?\d+(?:\.\d*)?$/.test(digits)) return digits;
  const [whole, fraction = ''] = digits.split('.');
  return `${whole}.${fraction.padEnd(scale, '0')}`;
}

/** The plain names in a sorting key, up to its first expression, which an order can follow. */
function sortingColumns(key: string, columns: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const part of topLevel(key)) {
    const name = /^`((?:[^`\\]|\\.)+)`$/.exec(part)?.[1]?.replace(/\\(.)/g, '$1') ?? part;
    if (!columns.has(name)) break;
    names.push(name);
  }
  return names;
}

function isView(engine: unknown): boolean {
  return /View$/.test(String(engine ?? ''));
}

/** A ClickHouse error that says who signed in may not use the connection's database. */
function scopeError(error: unknown): boolean {
  return /\b(?:UNKNOWN_DATABASE|ACCESS_DENIED)\b|\((?:81|497)\)/.test(wordsOf(error));
}

/**
 * A table the source doesn't have, or won't show this user: its catalog lists only what the user
 * may read, so the two look the same from here.
 */
function unreadable(name: string): ConnectorError {
  return objectMissing(name, `the source has no table or view named ${name} that this user may read`);
}

function closed(): ConnectorError {
  return new ConnectorError(KEYS.read, 'the session was closed');
}

class ClickHouseSession implements WarehouseSession {
  private readonly stopped = new AbortController();
  /** Why the connection's database can't be used, found while signing in */
  unusable: unknown;

  constructor(
    private readonly client: ClickHouseClientLike,
    private readonly settings: ClickHouseSettings,
    private readonly pageRows: number,
  ) {}

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    await this.client.close().catch(() => undefined);
  }

  /** Waits on the client, unless the session closes first. */
  private until<T>(work: Promise<T>): Promise<T> {
    const signal = this.stopped.signal;
    if (signal.aborted) {
      work.catch(() => undefined);
      return Promise.reject(closed());
    }
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(closed());
      signal.addEventListener('abort', stop, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  private async answer(sql: string, params: Record<string, string> = {}): Promise<ClickHouseAnswer> {
    return this.until(this.client.query(sql, params, this.stopped.signal));
  }

  /** Every row of a small answer, by column name, which is all a catalog query returns. */
  async all(sql: string, params: Record<string, string> = {}): Promise<Row[]> {
    const { names, chunks } = await this.answer(sql, params);
    const rows: Row[] = [];
    const iterator = chunks[Symbol.asyncIterator]();
    for (;;) {
      const next = await this.until(iterator.next());
      if (next.done) break;
      for (const values of next.value)
        rows.push(Object.fromEntries(names.map((name, index) => [name, values[index]])));
    }
    return rows;
  }

  private schemaOf(object: SourceObjectRef): string {
    return object.schema || this.settings.database;
  }

  /** Where a read of a table comes from, with `FINAL` when its engine merges rows. */
  private async source(select: SourceSelect): Promise<{ from: string; table?: Row }> {
    if (select.kind !== 'object') return { from: guard(select.sql, CLICKHOUSE) };
    const table = await this.table(select.object);
    if (!table) throw unreadable(select.object.name);
    const path = quotePath([this.schemaOf(select.object), select.object.name], CLICKHOUSE);
    return { from: readsFinal(table.engine) ? `${path} FINAL` : path, table };
  }

  private async table(object: SourceObjectRef): Promise<Row | undefined> {
    const rows = await this.all(
      `SELECT engine, total_rows, sorting_key FROM system.tables
       WHERE database = {database:String} AND name = {table:String}`,
      { database: this.schemaOf(object), table: object.name },
    );
    return rows[0];
  }

  async version(): Promise<string> {
    if (this.unusable !== undefined) throw this.unusable;
    const rows = await this.all('SELECT version() AS version');
    const version = textOr(rows[0]?.version);
    return version ? `ClickHouse ${version}` : 'ClickHouse';
  }

  async list(): Promise<SourceObject[]> {
    const rows = await this.all(
      `SELECT database, name, engine, total_rows FROM system.tables
       WHERE NOT is_temporary AND database NOT IN (${SYSTEM_DATABASES.map(literal).join(', ')})
         AND engine NOT IN (${STREAMING_ENGINES.map(literal).join(', ')})
       ORDER BY database, name`,
    );
    const objects = rows.map((row) => {
      const view = isView(row.engine);
      return {
        schema: textOr(row.database),
        name: String(row.name ?? ''),
        type: view ? ('view' as const) : ('table' as const),
        rowEstimate: view ? null : wholeNumber(row.total_rows),
      };
    });
    return ownSchemaFirst(objects, this.settings.database);
  }

  /** ClickHouse declares no unique keys: a sorting key allows repeats, so it's no promise of one. */
  async keys(object: SourceObjectRef): Promise<string[][]> {
    if (!(await this.table(object))) throw unreadable(object.name);
    return [];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'query') {
      // `LIMIT 0` runs the query without reading a row, and the answer's first lines name its columns.
      const { names, types, chunks } = await this.answer(
        `SELECT * FROM ${guard(select.sql, CLICKHOUSE)} LIMIT 0`,
      );
      // The answer ends right after its names and types, and reading to its end lets it go.
      for await (const chunk of chunks) void chunk;
      return names.map((name, index) => clickHouseColumn(name, types[index] ?? ''));
    }
    // An ephemeral column exists only while rows are inserted, so no read can ask for one.
    const rows = await this.all(
      `SELECT name, type FROM system.columns
       WHERE database = {database:String} AND table = {table:String} AND default_kind != 'EPHEMERAL'
       ORDER BY position`,
      { database: this.schemaOf(select.object), table: select.object.name },
    );
    if (rows.length === 0) throw unreadable(select.object.name);
    return rows.map((row) => clickHouseColumn(String(row.name ?? ''), String(row.type ?? '')));
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    const table = await this.table(object);
    return table && !isView(table.engine) ? wholeNumber(table.total_rows) : null;
  }

  /** One request's rows, in chunks as they stream in, and then how many there were and the last. */
  private async *page(
    sql: string,
    columns: readonly Described[],
    params: Record<string, string> = {},
  ): AsyncGenerator<Row[], { count: number; last: Row | undefined }> {
    const { chunks } = await this.answer(sql, params);
    const iterator = chunks[Symbol.asyncIterator]();
    const plain = columns.map(clickHouseValues);
    let count = 0;
    let last: Row | undefined;
    try {
      for (;;) {
        const next = await this.until(iterator.next());
        if (next.done) break;
        if (next.value.length === 0) continue;
        count += next.value.length;
        const rows = next.value.map((values) =>
          Object.fromEntries(
            columns.map((entry, index) => {
              const value = values[index];
              return [entry.column.name, value === null || value === undefined ? null : plain[index]!(value)];
            }),
          ),
        );
        last = rows.at(-1);
        yield rows;
      }
    } finally {
      await iterator.return?.();
    }
    return { count, last };
  }

  /** The table's sorting key, as the plain columns at its start, or nothing for a view or a query. */
  private async sortingKey(select: SourceSelect, table: Row | undefined): Promise<Described[]> {
    if (select.kind !== 'object' || !table || isView(table.engine)) return [];
    const all = new Map((await this.describe(select)).map((entry) => [entry.column.name, entry]));
    return sortingColumns(String(table.sorting_key ?? ''), new Set(all.keys())).map((name) => all.get(name)!);
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    _batchSize: number,
    limit?: number,
    keys: readonly string[] = [],
  ): AsyncGenerator<Row[]> {
    const { from, table } = await this.source(select);
    const projectionOf = (entries: readonly Described[]) =>
      entries.map((entry) => clickHouseProjection(entry, CLICKHOUSE.quote(entry.column.name))).join(', ');
    const projection = projectionOf(columns);
    const names = columns.map((entry) => entry.column.name);
    // A preview reads the first rows, in whatever order they come.
    if (limit !== undefined) {
      const max = positive(limit, 50);
      const sql =
        select.kind === 'object'
          ? `SELECT ${projection} FROM ${from} LIMIT ${max}`
          : guardedSelect(select.sql, projection, CLICKHOUSE, { limit: max, columns: names });
      yield* this.page(sql, columns);
      return;
    }
    const sortingKey = await this.sortingKey(select, table);
    const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
    const keyEntries = keys.map((name) => byName.get(name)).filter((entry) => entry !== undefined);
    // Pages that pick up after the last row read are the steadiest: rows added while a sync reads
    // land in a later page or an earlier one, and never push a row read once into the next page.
    // That takes an order every row has a place in, which the key gives, and values a cursor can
    // carry exactly.  The sorting key's start comes first, so ClickHouse finds each page's start
    // from its index.
    if (
      keyEntries.length === keys.length &&
      keyEntries.length > 0 &&
      keyEntries.every((entry) => cursorType(entry))
    ) {
      const order: Described[] = [];
      for (const entry of sortingKey) {
        if (!cursorType(entry)) break;
        order.push(entry);
      }
      for (const entry of keyEntries)
        if (!order.some((known) => known.column.name === entry.column.name)) order.push(entry);
      // Columns the order needs and the read didn't ask for come along at the end.
      const all = [...columns, ...order.filter((entry) => !byName.has(entry.column.name))];
      const orderBy = order.map((entry) => CLICKHOUSE.quote(entry.column.name)).join(', ');
      const types = order.map((entry) => cursorType(entry)!);
      let after: Row | undefined;
      for (;;) {
        const where = after ? ` WHERE ${afterCondition(order, types)}` : '';
        const params: Record<string, string> = after
          ? Object.fromEntries(order.map((entry, index) => [`k${index}`, String(after![entry.column.name])]))
          : {};
        // Rows that tie with a page's last row come with it, so the next page can start past all of them.
        const { count, last } = yield* this.page(
          `SELECT ${projectionOf(all)} FROM ${from}${where} ORDER BY ${orderBy} LIMIT ${this.pageRows} WITH TIES`,
          all,
          params,
        );
        if (count < this.pageRows || !last) return;
        after = last;
      }
    }
    // Otherwise pages count their way through one fixed order: the sorting key first, then every
    // chosen column that sorts, so rows that tie on the key still come in one order every time.
    const order = sortingKey.map((entry) => entry.column.name);
    for (const entry of columns)
      if (sortable(entry) && !order.includes(entry.column.name)) order.push(entry.column.name);
    if (order.length === 0) {
      // With nothing to sort by, no order can split the rows into pages, so they come in one request.
      const sql =
        select.kind === 'object'
          ? `SELECT ${projection} FROM ${from}`
          : guardedSelect(select.sql, projection, CLICKHOUSE, { columns: names });
      yield* this.page(sql, columns);
      return;
    }
    const orderBy = order.map((name) => CLICKHOUSE.quote(name)).join(', ');
    for (let offset = 0; ; offset += this.pageRows) {
      const { count } = yield* this.page(
        `SELECT ${projection} FROM ${from} ORDER BY ${orderBy} LIMIT ${this.pageRows} OFFSET ${offset}`,
        columns,
      );
      if (count < this.pageRows) return;
    }
  }
}

/**
 * The type a page binds a column's last value as, to pick up after it, or null for a column a
 * cursor can't follow exactly: one that may be empty, a float, a choice, a time of day, or a
 * structured value.  A date-time arrives in UTC, so it's bound in UTC whatever the column's zone.
 */
export function cursorType(entry: Described): string | null {
  const { type, nullable } = unwrapped(entry.column.sourceType);
  if (nullable) return null;
  const { name, args } = partsOf(type);
  if (name === 'DateTime') return "DateTime('UTC')";
  if (name === 'DateTime64') return `DateTime64(${topLevel(args)[0] ?? '3'}, 'UTC')`;
  if (
    INTEGERS.has(name) ||
    DECIMALS.has(name) ||
    ['Bool', 'Date', 'Date32', 'UUID', 'IPv4', 'IPv6', 'String', 'FixedString'].includes(name)
  )
    return type;
  return null;
}

/** Rows that sort after the values bound as `k0`, `k1`, and on, written so the index can find them. */
function afterCondition(order: readonly Described[], types: readonly string[]): string {
  const at = (index: number): string => {
    const name = CLICKHOUSE.quote(order[index]!.column.name);
    const value = `{k${index}:${types[index]}}`;
    return index === order.length - 1
      ? `${name} > ${value}`
      : `(${name} > ${value} OR (${name} = ${value} AND ${at(index + 1)}))`;
  };
  return at(0);
}

/** What ClickHouse's words say is missing: a table or database, or a column it can't find. */
export function clickHouseMissing(detail: string): Missing | null {
  if (
    /\bUNKNOWN_(?:TABLE|DATABASE)\b|\((?:60|81)\)|Table .+ does(?:n't| not) exist|Database .+ does(?:n't| not) exist/i.test(
      detail,
    )
  )
    return { kind: 'object' };
  const column =
    /Missing columns: '([^']+)'/i.exec(detail) ??
    /Unknown (?:expression (?:or function )?)?identifier [`']([^`']+)[`']/i.exec(detail) ??
    /There(?:'s| is) no column [`']([^`']+)[`']/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

export interface ClickHouseConnectorOptions {
  /** Observes the actual driver boundary during a contract run */
  observeDriver?: (driver: ClickHouseDriver) => ClickHouseDriver;
  /** Holds the host to the server's private-network rule */
  hostGuard?: HostGuard;
  /** Stands in for `@clickhouse/client`, so tests can supply a fake client */
  driver?: ClickHouseDriver;
  /** Rows a read asks for in one request, which tests make small */
  pageRows?: number;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createClickHouseConnector(options: ClickHouseConnectorOptions = {}): Connector {
  const driver = options.observeDriver?.(options.driver ?? realDriver) ?? options.driver ?? realDriver;
  const hostGuard = options.hostGuard;
  return makeWarehouseConnector(
    {
      kind: 'clickhouse',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'clickhouse' ? clickHouseEndpoint(ctx.connection) : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'clickhouse');
        const password = secretOf(ctx.secrets, 'password');
        const endpoint = clickHouseEndpoint(settings);
        if (hostGuard && isIP(endpoint.host) && !hostGuard.allowsAddress(endpoint.host))
          throw blockedHost(endpoint.host);
        const client = driver.createClient({
          url: httpAddress(endpoint, settings.secure),
          username: settings.user,
          password,
          database: settings.database,
          ...(settings.secure && settings.caPem ? { caPem: settings.caPem } : {}),
          timeoutMs: positive(ctx.timeoutMs, 30000),
          ...(hostGuard ? { hostGuard } : {}),
        });
        const session = new ClickHouseSession(
          client,
          settings,
          positive(options.pageRows, CLICKHOUSE_PAGE_ROWS),
        );
        try {
          // ClickHouse checks the password before the database, so a database it refuses means the
          // sign-in worked, and the connection test says so at its query step instead.
          await session.all('SELECT 1 AS signed_in').catch((error: unknown) => {
            if (!scopeError(error)) throw error;
            session.unusable = error;
          });
          return session;
        } catch (error) {
          void session.close();
          throw error;
        }
      },
      missing: clickHouseMissing,
    },
    options.network ?? directNetwork(hostGuard),
  );
}

export const clickHouseConnector: Connector = createClickHouseConnector();

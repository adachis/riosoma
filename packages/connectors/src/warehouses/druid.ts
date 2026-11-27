import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SourceConnection, SourceObject, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { registerConnector } from '../registry.js';
import { positive } from '../sql.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { connectionOf, KEYS, objectMissing, secretOf, type Missing } from './errors.js';
import {
  directNetwork,
  hostAndPort,
  httpAddress,
  makeWarehouseConnector,
  type Endpoint,
  type Network,
  type Row,
  type WarehouseSession,
} from './frame.js';
import {
  agentFetch,
  blockedHost,
  bodyExcerpt,
  sessionAgent,
  type HostGuard,
  type HttpFetch,
} from './http.js';
import { describeColumn, type Described, type TypeClass } from './mapping.js';
import { DRUID, guard, guardedSelect, quotePath } from './sql.js';
import { exactInteger, textOr, wholeNumber } from './values.js';

/**
 * Apache Druid, through the router's SQL API over HTTP.  Datasources are the tables, and `__time`
 * is each one's date and time.  Every answer comes as JSON lines with a header of names and SQL
 * types, and Druid ends a complete answer with a blank line, so an answer cut short is a failed
 * read rather than a short one.
 *
 * A read pages by `__time`, the one order Druid sorts a datasource by, and picks up after the last
 * time a page reached rather than counting rows.  Druid keeps no order among rows that share a
 * time, so a page that ends inside them can't say which ones it left out.  Instead, a full page
 * sets aside its rows at its last time, reads every row at that time in one request, and the next
 * page starts after it.  No row is read twice or missed, however Druid orders ties.
 */

type DruidSettings = Extract<SourceConnection, { kind: 'druid' }>;

/** Rows a read asks for in one request. */
export const DRUID_PAGE_ROWS = 50_000;
/** Rows at one `__time` a read takes in its one request for them, past which it stops. */
export const DRUID_TIE_ROWS = 1_000_000;
/** How long canceling a query may take once the call is over. */
const CANCEL_MS = 2_000;
const TIME = '__time';

export type DruidFetch = HttpFetch;

/** A failed request, with Druid's own words and the status it answered with. */
export class DruidError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DruidError';
  }
}

/**
 * Druid's words for a failed request: its error message in either of its two shapes, or the
 * start of whatever else answered, as plain text, and the status.
 */
async function errorOf(response: Response): Promise<DruidError> {
  let text = '';
  try {
    text = (await response.text()).trim();
  } catch {
    // The status alone still says what happened.
  }
  let said = text;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    said =
      ([body.errorMessage, body.error, body.errorClass].find((part) => typeof part === 'string') as
        string | undefined) ?? '';
  } catch {
    // Not every failure answers in JSON.
  }
  said = bodyExcerpt(said);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return new DruidError(`Druid answered ${status}${said ? `: ${said}` : ''}`, response.status);
}

/** An answer's lines, in groups as they arrive. */
async function* linesOf(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string[]> {
  if (!body) return;
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    if (lines.length > 0) yield lines;
  }
  rest += decoder.decode();
  if (rest) yield [rest];
}

/** One query's answer: its column names, their SQL types, then its rows in chunks as they stream in. */
interface Answer {
  names: string[];
  types: string[];
  chunks: AsyncGenerator<unknown[][]>;
}

function cutShort(): ConnectorError {
  return new ConnectorError(
    KEYS.read,
    "Druid's answer ended before its last row, so the query failed partway",
  );
}

/**
 * Reads an `arrayLines` answer with its three header lines: names, Druid's types, and SQL types.
 * The blank line after the last row says the answer is whole.
 */
async function answerOf(body: ReadableStream<Uint8Array> | null): Promise<Answer> {
  const iterator = linesOf(body);
  const head: unknown[][] = [];
  let pending: string[] = [];
  while (head.length < 3) {
    if (pending.length === 0) {
      const next = await iterator.next();
      if (next.done) throw cutShort();
      pending = next.value;
      continue;
    }
    const line = pending.shift()!;
    if (line.trim() === '') throw cutShort();
    head.push(JSON.parse(line) as unknown[]);
  }
  const strings = (row: unknown[] | undefined) => (row ?? []).map((item) => String(item));
  async function* chunks(): AsyncGenerator<unknown[][]> {
    let lines = pending;
    for (;;) {
      const rows: unknown[][] = [];
      for (const line of lines) {
        if (line.trim() === '') {
          if (rows.length > 0) yield rows;
          await iterator.return(undefined);
          return;
        }
        rows.push(JSON.parse(line) as unknown[]);
      }
      if (rows.length > 0) yield rows;
      const next = await iterator.next();
      if (next.done) throw cutShort();
      lines = next.value;
    }
  }
  return { names: strings(head[0]), types: strings(head[2]), chunks: chunks() };
}

/** What a Druid SQL type comes down to. */
export function druidTypeClass(type: string): TypeClass {
  const name = type.trim().toUpperCase();
  if (/ARRAY/.test(name)) return 'json';
  if (name === 'COMPLEX<JSON>') return 'json';
  switch (name.replace(/\(.*$/, '')) {
    case 'TINYINT':
    case 'SMALLINT':
    case 'INTEGER':
    case 'BIGINT':
      return 'integer';
    // Druid keeps no exact decimals: a DECIMAL is a double underneath.
    case 'FLOAT':
    case 'REAL':
    case 'DOUBLE':
    case 'DECIMAL':
      return 'float';
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'TIMESTAMP':
      return 'timestamp';
    case 'VARCHAR':
    case 'CHAR':
      return 'text';
    // Sketches, other complex columns, and anything new are named, not guessed at.
    default:
      return 'unknown';
  }
}

export function druidColumn(name: string, type: string, nullable: boolean): Described {
  return describeColumn({ name, sourceType: type, nullable, kind: druidTypeClass(type) });
}

/** How a read writes one column: a `BIGINT` as its digits, since JSON rounds past 2^53. */
export function druidProjection(entry: Described, reference: string): string {
  return entry.column.sourceType.trim().toUpperCase() === 'BIGINT'
    ? `CAST(${reference} AS VARCHAR)`
    : reference;
}

/** A value from a read as a plain one. */
export function plainOfDruid(value: unknown, entry: Described): unknown {
  if (value === null || value === undefined) return null;
  if (entry.kind === 'integer' && typeof value === 'string') return exactInteger(value);
  return value;
}

/**
 * A table the source doesn't have, or won't show this user: its catalog lists only what the user
 * may read, so the two look the same from here.
 */
function unreadable(name: string): ConnectorError {
  return objectMissing(name, `the source has no datasource named ${name} that this user may read`);
}

function closed(): ConnectorError {
  return new ConnectorError(KEYS.read, 'the session was closed');
}

/** A page's time for a row, from the milliseconds a read asks for after the chosen columns. */
function millisOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new ConnectorError(
    KEYS.read,
    "Druid sent a row without a __time, so the read can't tell where its next page starts",
  );
}

function tooManyAt(millis: number, limit: number): ConnectorError {
  return new ConnectorError(
    KEYS.read,
    `Druid holds more than ${limit.toLocaleString('en-US')} rows at the one __time ${new Date(millis).toISOString()}, more than a read takes at once, so it stopped`,
  );
}

/** Druid's words when it can't sort a read the way a page needs. */
function unsortable(error: unknown): boolean {
  return (
    error instanceof DruidError &&
    error.status === 400 &&
    /order|sort|cannot (?:be )?plan|can't plan|unsupported/i.test(error.message)
  );
}

interface DruidLimits {
  timeoutMs: number;
  pageRows: number;
  tieRows: number;
}

class DruidSession implements WarehouseSession {
  private readonly stopped = new AbortController();
  /** Queries still running, which closing the session cancels */
  private readonly running = new Set<string>();
  /** Set when Druid signed the user in and then refused its SQL */
  forbidden: DruidError | undefined;
  note: string | undefined;

  constructor(
    private readonly fetcher: DruidFetch,
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly limits: DruidLimits,
    /** Lets go of the session's connections once its queries are canceled */
    private readonly release: () => void = () => undefined,
  ) {}

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    const running = [...this.running];
    this.running.clear();
    try {
      await Promise.all(running.map((id) => this.cancel(id)));
    } finally {
      this.release();
    }
  }

  /** Asks Druid to stop a query, briefly, since the call that ran it is already over. */
  private async cancel(id: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANCEL_MS);
    try {
      const response = await this.fetcher(`${this.base}/druid/v2/sql/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers,
        signal: controller.signal,
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // A query Druid already finished can't be canceled, and that's fine.
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits on a request, unless the session closes first. */
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

  /** Runs one SQL query, with each `?` filled from `parameters` as text. */
  private async sql(query: string, parameters: readonly string[] = []): Promise<Answer> {
    const id = randomUUID();
    const response = await this.until(
      this.fetcher(`${this.base}/druid/v2/sql`, {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query,
          resultFormat: 'arrayLines',
          header: true,
          typesHeader: true,
          sqlTypesHeader: true,
          parameters: parameters.map((value) => ({ type: 'VARCHAR', value })),
          // Times come back in UTC, and a query stops on Druid's side when the call would give up.
          context: { sqlQueryId: id, sqlTimeZone: 'Etc/UTC', timeout: this.limits.timeoutMs },
        }),
        signal: this.stopped.signal,
        redirect: 'error',
      }),
    );
    if (!response.ok) throw await errorOf(response);
    this.running.add(id);
    let answer: Answer;
    try {
      answer = await this.until(answerOf(response.body));
    } catch (error) {
      this.running.delete(id);
      throw error;
    }
    const running = this.running;
    const until = this.until.bind(this);
    return {
      ...answer,
      chunks: (async function* () {
        try {
          for (;;) {
            const next = await until(answer.chunks.next());
            if (next.done) return;
            yield next.value;
          }
        } finally {
          running.delete(id);
          await answer.chunks.return(undefined).catch(() => undefined);
        }
      })(),
    };
  }

  /** Every row of a small answer, by column name, which is all a catalog query returns. */
  async all(query: string, parameters: readonly string[] = []): Promise<Row[]> {
    const { names, chunks } = await this.sql(query, parameters);
    const rows: Row[] = [];
    for await (const chunk of chunks)
      for (const values of chunk)
        rows.push(Object.fromEntries(names.map((name, index) => [name, values[index]])));
    return rows;
  }

  async version(): Promise<string> {
    if (this.forbidden)
      throw new ConnectorError(
        KEYS.read,
        `Druid signed this user in, but its permissions don't let it run SQL queries (${this.forbidden.message})`,
      );
    // Listing the datasources shows the user may read the catalog.  A new cluster has none yet,
    // which is a connection that works with nothing to sync, so the test passes and says so.
    const visible = await this.all(
      `SELECT TABLE_NAME AS "visible" FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'druid' LIMIT 1`,
    );
    if (visible.length === 0) this.note = KEYS.noDatasources;
    // `/status` names the version when the user may read it.
    try {
      const response = await this.until(
        this.fetcher(`${this.base}/status`, {
          headers: this.headers,
          signal: this.stopped.signal,
          redirect: 'error',
        }),
      );
      if (response.ok) {
        const version = textOr(((await response.json()) as { version?: unknown }).version);
        if (version) return `Apache Druid ${version}`;
      } else await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (this.stopped.signal.aborted) throw error;
    }
    return 'Apache Druid';
  }

  async list(): Promise<SourceObject[]> {
    const rows = await this.all(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'druid' ORDER BY TABLE_NAME`,
    );
    const counts = await this.counts();
    return rows.map((row) => {
      const name = String(row.TABLE_NAME ?? '');
      return { schema: null, name, type: 'table' as const, rowEstimate: counts.get(name) ?? null };
    });
  }

  /**
   * Each datasource's rows as its segments count them, from the system tables, which a user may
   * not be allowed to read.  Then there are no counts.
   */
  private async counts(): Promise<Map<string, number>> {
    try {
      const rows = await this.all(
        `SELECT "datasource", SUM("num_rows") AS "rows" FROM sys.segments WHERE "is_active" = 1 GROUP BY "datasource"`,
      );
      const counts = new Map<string, number>();
      for (const row of rows) {
        const count = wholeNumber(row.rows);
        if (count !== null) counts.set(String(row.datasource ?? ''), count);
      }
      return counts;
    } catch (error) {
      if (this.stopped.signal.aborted) throw error;
      return new Map();
    }
  }

  /** A datasource has no keys, so there's none to offer. */
  async keys(object: SourceObjectRef): Promise<string[][]> {
    const rows = await this.all(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'druid' AND TABLE_NAME = ?`,
      [object.name],
    );
    if (rows.length === 0) throw unreadable(object.name);
    return [];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'query') {
      // `LIMIT 0` runs the query without reading a row, and the answer's header names its columns.
      const { names, types, chunks } = await this.sql(`SELECT * FROM ${guard(select.sql, DRUID)} LIMIT 0`);
      // Reading the answer to its blank line is what shows it came whole.
      for await (const chunk of chunks) void chunk;
      return names.map((name, index) => druidColumn(name, types[index] ?? '', true));
    }
    const rows = await this.all(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'druid' AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [select.object.name],
    );
    if (rows.length === 0) throw unreadable(select.object.name);
    return rows.map((row) =>
      druidColumn(
        String(row.COLUMN_NAME ?? ''),
        String(row.DATA_TYPE ?? ''),
        String(row.IS_NULLABLE ?? 'YES').toUpperCase() !== 'NO',
      ),
    );
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    return (await this.counts()).get(object.name) ?? null;
  }

  /** One request's rows, in chunks as they stream in. */
  private async *page(query: string, columns: readonly Described[]): AsyncGenerator<Row[]> {
    const { chunks } = await this.sql(query);
    for await (const chunk of chunks) yield chunk.map((values) => rowOf(values, columns));
  }

  /**
   * Every row, in pages by `__time`.  Each row comes with its time in milliseconds after the
   * chosen columns, which says where a page ended even when the read didn't ask for `__time`.
   * Druid may refuse to sort a query this way, which it says before a row is read.
   */
  private async *byTime(
    projection: string,
    from: string,
    columns: readonly Described[],
  ): AsyncGenerator<Row[]> {
    const time = DRUID.quote(TIME);
    const select = `SELECT ${projection}, TIMESTAMP_TO_MILLIS(${time}) FROM ${from}`;
    const width = columns.length;
    let after: number | undefined;
    for (;;) {
      const where = after === undefined ? '' : ` WHERE ${time} > MILLIS_TO_TIMESTAMP(${after})`;
      const { chunks } = await this.sql(`${select}${where} ORDER BY ${time} LIMIT ${this.limits.pageRows}`);
      let count = 0;
      // Rows at the latest time so far, which wait until a later time shows they're all here.
      let held: Row[] = [];
      let heldAt: number | undefined;
      for await (const chunk of chunks) {
        const ready: Row[] = [];
        for (const values of chunk) {
          count += 1;
          const at = millisOf(values[width]);
          if (at !== heldAt) {
            ready.push(...held);
            held = [];
            heldAt = at;
          }
          held.push(rowOf(values, columns));
        }
        if (ready.length > 0) yield ready;
      }
      if (count < this.limits.pageRows) {
        if (held.length > 0) yield held;
        return;
      }
      // The page ended at `heldAt`, maybe partway through its rows, so they're read again, all together.
      const last = heldAt!;
      yield* this.at(`${select} WHERE ${time} = MILLIS_TO_TIMESTAMP(${last})`, columns, last);
      after = last;
    }
  }

  /** Every row at one time, in one request, or a plain failure when there are too many. */
  private async *at(query: string, columns: readonly Described[], millis: number): AsyncGenerator<Row[]> {
    const limit = this.limits.tieRows;
    const { chunks } = await this.sql(`${query} LIMIT ${limit + 1}`);
    let count = 0;
    for await (const chunk of chunks) {
      count += chunk.length;
      if (count > limit) throw tooManyAt(millis, limit);
      yield chunk.map((values) => rowOf(values, columns));
    }
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    _batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    // Columns aren't renamed, so an order names the datasource's own columns, not a written one.
    const projection = columns
      .map((entry) => druidProjection(entry, DRUID.quote(entry.column.name)))
      .join(', ');
    const from =
      select.kind === 'object' ? quotePath(['druid', select.object.name], DRUID) : guard(select.sql, DRUID);
    const names = columns.map((entry) => entry.column.name);
    if (limit !== undefined) {
      const max = positive(limit, 50);
      const sql =
        select.kind === 'object'
          ? `SELECT ${projection} FROM ${from} LIMIT ${max}`
          : guardedSelect(select.sql, projection, DRUID, { limit: max, columns: names, qualifyOrder: true });
      yield* this.page(sql, columns);
      return;
    }
    // A datasource always has `__time`, and a query pages by its own when it has one.
    const timed =
      select.kind === 'object' ||
      (await this.describe(select)).some((entry) => entry.column.name === TIME && entry.kind === 'timestamp');
    if (timed) {
      let reading = false;
      try {
        for await (const rows of this.byTime(projection, from, columns)) {
          reading = true;
          yield rows;
        }
        return;
      } catch (error) {
        // Druid can't always sort a query by time, and says so before its first row.
        if (reading || !unsortable(error)) throw error;
      }
    }
    // Without a time to page by, the rows come in one request, streamed as they arrive.
    const sql =
      select.kind === 'object'
        ? `SELECT ${projection} FROM ${from}`
        : guardedSelect(select.sql, projection, DRUID, { columns: names, qualifyOrder: true });
    yield* this.page(sql, columns);
  }
}

/** One row's values by the chosen columns' names, as plain values. */
function rowOf(values: readonly unknown[], columns: readonly Described[]): Row {
  return Object.fromEntries(
    columns.map((entry, index) => [entry.column.name, plainOfDruid(values[index], entry)]),
  );
}

/** What Druid's words say is missing: a datasource, or a column it can't find. */
export function druidMissing(detail: string): Missing | null {
  if (/Object '[^']+' not found|Table '[^']+' not found|datasource .* does not exist/i.test(detail))
    return { kind: 'object' };
  const column = /Column '([^']+)' not found/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

/** Where a Druid router is, and whether it's secured. */
export function druidEndpoint(settings: DruidSettings): Endpoint {
  return { ...hostAndPort(settings.host, settings.port), tls: settings.secure ? {} : false };
}

export interface DruidConnectorOptions {
  /** Holds the router to the server's private-network rule */
  hostGuard?: HostGuard;
  /** Stands in for the session's own connections, so tests can answer as Druid would */
  fetch?: DruidFetch;
  /** Rows a read asks for in one request, which tests make small */
  pageRows?: number;
  /** Rows at one `__time` a read takes at once, which tests make small */
  tieRows?: number;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createDruidConnector(options: DruidConnectorOptions = {}): Connector {
  const hostGuard = options.hostGuard;
  return makeWarehouseConnector(
    {
      kind: 'druid',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'druid' ? druidEndpoint(ctx.connection) : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'druid');
        const headers: Record<string, string> = {};
        if (settings.user) {
          const password = secretOf(ctx.secrets, 'password');
          headers.authorization = `Basic ${Buffer.from(`${settings.user}:${password}`).toString('base64')}`;
        }
        const endpoint = druidEndpoint(settings);
        if (hostGuard && isIP(endpoint.host) && !hostGuard.allowsAddress(endpoint.host))
          throw blockedHost(endpoint.host);
        const agent = options.fetch
          ? undefined
          : sessionAgent({ secure: settings.secure, ...(hostGuard ? { guard: hostGuard } : {}) });
        const session = new DruidSession(
          options.fetch ?? agentFetch(agent!, hostGuard),
          httpAddress(endpoint, settings.secure),
          headers,
          {
            timeoutMs: positive(ctx.timeoutMs, 30000),
            pageRows: positive(options.pageRows, DRUID_PAGE_ROWS),
            tieRows: positive(options.tieRows, DRUID_TIE_ROWS),
          },
          () => agent?.destroy(),
        );
        try {
          // Druid answers 401 to a sign-in it refuses and 403 to one it accepts for a user who may
          // not run SQL, which the connection test says at its query step.
          await session.all('SELECT 1 AS "signed_in"').catch((error: unknown) => {
            if (!(error instanceof DruidError && error.status === 403)) throw error;
            session.forbidden = error;
          });
          return session;
        } catch (error) {
          void session.close();
          throw error;
        }
      },
      missing: druidMissing,
    },
    options.network ?? directNetwork(hostGuard),
  );
}

export const druidConnector: Connector = createDruidConnector();
registerConnector(druidConnector);

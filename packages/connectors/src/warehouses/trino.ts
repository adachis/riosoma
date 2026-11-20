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
import { guard, literal, quotePath, TRINO } from './sql.js';
import { exactInteger, ownSchemaFirst, textOr, wholeNumber } from './values.js';

/**
 * Trino, and services built on it, through the coordinator's client protocol over HTTP.  A
 * statement is posted to `/v1/statement`, and its answer names the address of the next one, which
 * a read follows to the query's end instead of paging with offsets.  Every request can be stopped,
 * and a query left before its end is canceled by deleting the address it would have asked next,
 * so an abandoned query never keeps running on a shared cluster.  Trino has no bind parameters, so
 * the few values a catalog query needs travel as string literals, and names are always quoted.
 * Values arrive as Trino writes them in JSON, except where JSON loses something: a `bigint` is
 * read as its digits, and an instant with a zone is written in UTC first.
 */

type TrinoSettings = Extract<SourceConnection, { kind: 'trino' }>;

/** A safety valve on a catalog listing, not a limit anyone should reach. */
const MOST_CATALOG_ROWS = 100_000;
/** How long canceling a query may take once the call is over. */
const CANCEL_MS = 2_000;
/** Statuses that mean the coordinator was briefly busy, which the protocol says to try again after. */
const BUSY = new Set([502, 503, 504]);
const TRIES = 5;

/** One answer of the client protocol: part of a query's rows, and where the next part is. */
export interface TrinoPage {
  id?: string;
  nextUri?: string;
  columns?: Array<{ name: string; type: string }>;
  data?: unknown[][];
  error?: { message?: string; errorName?: string; errorCode?: number };
  stats?: { state?: string };
}

/** A request the coordinator refused, with the start of what it said and its status. */
export class TrinoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TrinoHttpError';
  }
}

async function httpError(response: Response): Promise<TrinoHttpError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // The status alone still says what happened.
  }
  const said = bodyExcerpt(text);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return new TrinoHttpError(`Trino answered ${status}${said ? `: ${said}` : ''}`, response.status);
}

/** The headers every request carries: who is asking, from where, and how they sign in. */
export function trinoHeaders(settings: TrinoSettings, secret: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'X-Trino-Source': 'riosoma' };
  // A token alone can say who is asking, so the user goes along only when there is one.
  if (settings.user) headers['X-Trino-User'] = settings.user;
  if (settings.auth === 'password')
    headers.Authorization = `Basic ${Buffer.from(`${settings.user ?? ''}:${secret ?? ''}`).toString('base64')}`;
  if (settings.auth === 'token' && secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/** A Trino type, read from its signature, like `row(city varchar, zip integer)`. */
export interface TrinoType {
  /** The base name in lower case, like `varchar` or `timestamp with time zone` */
  name: string;
  /** Numbers in the parentheses, like a decimal's precision and scale */
  numbers: number[];
  /** The element types of an array or a map, or a row's fields */
  args: Array<{ field: string | null; type: TrinoType }>;
}

/** Splits text at its top-level commas, outside quotes and parentheses. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** A type written in several words, at the end of a row's field. */
const WORDY_TYPE =
  /(?:^|\s)((?:time|timestamp)(?:\(\d+\))? with(?:out)? time zone|interval \w+ to \w+|double precision)$/i;

/**
 * A row's field: its name, which may be quoted or hold spaces, and then its type, which is the last
 * word (parentheses and all) unless it's a type written in several words.
 */
function fieldOf(part: string): { field: string | null; type: string } {
  let type: string;
  let name: string;
  const wordy = WORDY_TYPE.exec(part);
  if (wordy) {
    type = wordy[1]!;
    name = part.slice(0, part.length - type.length).trim();
  } else {
    let depth = 0;
    let quoted = false;
    let split = -1;
    for (let i = 0; i < part.length; i++) {
      const character = part[i]!;
      if (character === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (character === '(') depth++;
      else if (character === ')') depth--;
      else if (/\s/.test(character) && depth === 0) split = i;
    }
    if (split < 0) return { field: null, type: part };
    type = part.slice(split + 1);
    name = part.slice(0, split).trim();
  }
  if (!name) return { field: null, type };
  const quotedName = /^"((?:[^"]|"")*)"$/.exec(name);
  return { field: quotedName ? quotedName[1]!.replaceAll('""', '"') : name, type };
}

export function parseTrinoType(signature: string): TrinoType {
  const text = signature.trim();
  const open = text.indexOf('(');
  if (open < 0) return { name: text.toLowerCase(), numbers: [], args: [] };
  const close = text.lastIndexOf(')');
  const head = text.slice(0, open).trim().toLowerCase();
  const inner = text.slice(open + 1, close);
  // `timestamp(3) with time zone` puts words after its parentheses.
  const tail = text
    .slice(close + 1)
    .trim()
    .toLowerCase();
  const name = tail ? `${head} ${tail}` : head;
  const parts = topLevel(inner);
  if (name === 'row')
    return {
      name,
      numbers: [],
      args: parts.map((part) => {
        const { field, type } = fieldOf(part);
        return { field, type: parseTrinoType(type) };
      }),
    };
  if (name === 'array' || name === 'map')
    return { name, numbers: [], args: parts.map((part) => ({ field: null, type: parseTrinoType(part) })) };
  return { name, numbers: parts.map(Number).filter(Number.isFinite), args: [] };
}

/** What a Trino type comes down to. */
export function trinoTypeClass(type: TrinoType): TypeClass {
  switch (type.name) {
    case 'tinyint':
    case 'smallint':
    case 'integer':
    case 'bigint':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'real':
    case 'double':
      return 'float';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    // A timestamp without a zone reads as UTC, and one with a zone as the instant it names.
    case 'timestamp':
    case 'timestamp with time zone':
      return 'timestamp';
    case 'time':
    case 'time with time zone':
      return 'time';
    case 'varchar':
    case 'char':
    case 'uuid':
    case 'ipaddress':
      return 'text';
    case 'json':
    case 'array':
    case 'map':
    case 'row':
      return 'json';
    case 'varbinary':
      return 'binary';
    // Intervals, sketches, geometry, and anything new are named, not guessed at.
    default:
      return 'unknown';
  }
}

/** A column as Trino describes it, with its type's own name as the source type. */
export function trinoColumn(name: string, signature: string, nullable: boolean): Described {
  const type = parseTrinoType(signature);
  const kind = trinoTypeClass(type);
  return describeColumn({
    name,
    sourceType: signature,
    nullable,
    kind,
    scale: kind === 'decimal' ? (type.numbers[1] ?? 0) : null,
    length:
      kind === 'text' && type.name !== 'uuid' && type.name !== 'ipaddress' ? (type.numbers[0] ?? null) : null,
  });
}

/**
 * How a read writes one column: a `bigint` as its digits, which JSON would round, and an instant
 * with a zone in UTC, since Trino writes it in its own zone by name.
 */
export function trinoProjection(entry: Described, reference: string): string {
  const { name } = parseTrinoType(entry.column.sourceType);
  if (name === 'bigint') return `CAST(${reference} AS varchar)`;
  if (name === 'timestamp with time zone') return `(${reference} AT TIME ZONE 'UTC')`;
  return reference;
}

/**
 * A value in the form Trino's JSON gives it, with rows given their fields' names.  Trino writes a
 * row as a list, so a nested one would otherwise lose its names.
 */
export function trinoValue(value: unknown, type: TrinoType): unknown {
  if (value === null || value === undefined) return null;
  if (type.name === 'row' && Array.isArray(value)) {
    // A row whose fields have no names stays a list, as Trino writes it.
    if (type.args.every((arg) => arg.field === null))
      return type.args.map((arg, index) => trinoValue(value[index], arg.type));
    return Object.fromEntries(
      type.args.map((arg, index) => [arg.field ?? `field${index + 1}`, trinoValue(value[index], arg.type)]),
    );
  }
  if (type.name === 'array' && Array.isArray(value)) {
    const element = type.args[0]?.type;
    return element ? value.map((item) => trinoValue(item, element)) : value;
  }
  if (type.name === 'map' && typeof value === 'object') {
    const element = type.args[1]?.type;
    return element
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trinoValue(item, element)]))
      : value;
  }
  return value;
}

/** A value from a read as a plain one. */
export function plainOfTrino(value: unknown, entry: Described): unknown {
  if (value === null || value === undefined) return null;
  if (entry.kind === 'integer' && typeof value === 'string') return exactInteger(value);
  if (entry.kind === 'json') return trinoValue(value, parseTrinoType(entry.column.sourceType));
  return value;
}

/** A failed query, as Trino names it and says why. */
export class TrinoQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'TrinoQueryError';
  }
}

function queryError(error: NonNullable<TrinoPage['error']>): TrinoQueryError {
  const name = error.errorName ?? 'QUERY_FAILED';
  return new TrinoQueryError(`${name}: ${error.message ?? 'the query failed'}`, name);
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

function isView(type: unknown): boolean {
  return String(type ?? '')
    .toUpperCase()
    .includes('VIEW');
}

/** A query on the coordinator: its ID, and the address a read would ask next while it runs. */
interface Statement {
  id?: string;
  next?: string;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class TrinoSession implements WarehouseSession {
  private readonly stopped = new AbortController();
  /** Queries still running, which closing the session cancels */
  private readonly running = new Set<Statement>();
  private readonly origin: string;

  constructor(
    private readonly fetcher: HttpFetch,
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly settings: TrinoSettings,
    /** Lets go of the session's connections once its queries are canceled */
    private readonly release: () => void = () => undefined,
  ) {
    this.origin = new URL(base).origin;
  }

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return;
    // Stopping every request first means no read asks for another page while its query is canceled.
    this.stopped.abort();
    const running = [...this.running];
    this.running.clear();
    try {
      await Promise.all(running.map((statement) => this.cancel(statement)));
    } finally {
      this.release();
    }
  }

  /**
   * Asks the coordinator to stop a query by deleting the address a read would ask next, briefly,
   * since the call that ran it is already over.  A query with no next address has finished, and
   * one still being posted was never started, since Trino starts a query once its first address is
   * asked for.
   */
  private async cancel(statement: Statement): Promise<void> {
    if (!statement.next) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANCEL_MS);
    try {
      const response = await this.fetcher(statement.next, {
        method: 'DELETE',
        headers: this.headers,
        signal: controller.signal,
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // A query Trino already finished can't be canceled, and that's fine.
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

  /** One request of the protocol, tried again while the coordinator says it's briefly busy. */
  private async request(url: string, init: RequestInit): Promise<TrinoPage> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.until(
        this.fetcher(url, { ...init, signal: this.stopped.signal, redirect: 'error' }),
      );
      if (response.ok) {
        try {
          return (await this.until(response.json())) as TrinoPage;
        } catch (error) {
          if (this.stopped.signal.aborted) throw error;
          throw new ConnectorError(
            KEYS.read,
            "Trino's answer wasn't the JSON its client protocol sends, so something other than a coordinator may be answering",
          );
        }
      }
      if (!BUSY.has(response.status) || attempt >= TRIES) throw await httpError(response);
      await response.body?.cancel().catch(() => undefined);
      await this.until(pause(Math.min(100 * 2 ** attempt, 1_000)));
    }
  }

  /**
   * The address of a query's next page, which must be on the coordinator the connection names, so
   * its sign-in never goes anywhere else.
   */
  private nextOf(uri: string): string {
    let next: URL;
    try {
      next = new URL(uri, this.base);
    } catch {
      throw new ConnectorError(KEYS.read, "Trino named a next page at an address that doesn't read as one");
    }
    if (next.origin !== this.origin)
      throw new ConnectorError(
        KEYS.read,
        `Trino named its next page on ${next.host} over ${next.protocol.replace(':', '').toUpperCase()}, not at the coordinator's own address, so the read stopped rather than send the sign-in there.  A coordinator behind a proxy needs http-server.process-forwarded=true.`,
      );
    return next.href;
  }

  /**
   * A query's pages, in order, each one fetched when the last is used, and ending in an error when
   * the query fails.  A query that reads the source runs in the connection's catalog and schema,
   * so an admin's query can name tables the way the person using Trino would.
   */
  private async *pages(sql: string, scoped: boolean): AsyncGenerator<TrinoPage> {
    const statement: Statement = {};
    this.running.add(statement);
    let finished = false;
    try {
      let page = await this.request(`${this.base}/v1/statement`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'text/plain; charset=utf-8',
          ...(scoped ? { 'X-Trino-Catalog': this.settings.catalog } : {}),
          ...(scoped && this.settings.schema ? { 'X-Trino-Schema': this.settings.schema } : {}),
        },
        body: sql,
      });
      for (;;) {
        statement.id ??= page.id;
        const next = page.nextUri === undefined ? undefined : this.nextOf(page.nextUri);
        statement.next = next;
        if (page.error) throw queryError(page.error);
        yield page;
        if (next === undefined) {
          finished = true;
          return;
        }
        page = await this.request(next, { method: 'GET', headers: this.headers });
      }
    } finally {
      // A query left before its last page keeps running on the coordinator unless it's canceled.
      if (this.running.delete(statement) && !finished) void this.cancel(statement);
    }
  }

  /** Every row of a small answer, by column name, which is all a catalog query returns. */
  async all(sql: string, scoped = false): Promise<Row[]> {
    const rows: Row[] = [];
    let names: string[] = [];
    for await (const page of this.pages(sql, scoped)) {
      if (page.columns) names = page.columns.map((column) => column.name);
      for (const values of page.data ?? [])
        rows.push(Object.fromEntries(names.map((name, index) => [name, values[index]])));
      if (rows.length >= MOST_CATALOG_ROWS) break;
    }
    return rows;
  }

  private schemaOf(object: SourceObjectRef): string {
    return object.schema || this.settings.schema || 'default';
  }

  private information(view: string): string {
    return quotePath([this.settings.catalog, 'information_schema', view], TRINO);
  }

  private async tableRows(object: SourceObjectRef): Promise<Row[]> {
    return this.all(
      `SELECT table_type FROM ${this.information('tables')}
       WHERE table_schema = ${literal(this.schemaOf(object))} AND table_name = ${literal(object.name)}`,
    );
  }

  async version(): Promise<string> {
    const rows = await this.all('SELECT version() AS version');
    // Signing in says nothing about the catalog, so listing its schemas is what shows it can be read.
    const schemas = await this.all(`SHOW SCHEMAS FROM ${TRINO.quote(this.settings.catalog)}`);
    const schema = this.settings.schema;
    if (schema !== undefined && !schemas.some((row) => String(row.Schema ?? '') === schema))
      throw new ConnectorError(
        KEYS.read,
        `the catalog ${this.settings.catalog} has no schema named ${schema}, or this user can't see it`,
      );
    const version = textOr(rows[0]?.version);
    return version ? `Trino ${version}` : 'Trino';
  }

  async list(): Promise<SourceObject[]> {
    const rows = await this.all(
      `SELECT table_schema, table_name, table_type FROM ${this.information('tables')}
       WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name`,
    );
    // Row counts depend on each connector's statistics, which a listing shouldn't wait for.
    const objects = rows.map((row) => ({
      schema: textOr(row.table_schema),
      name: String(row.table_name ?? ''),
      type: isView(row.table_type) ? ('view' as const) : ('table' as const),
      rowEstimate: null,
    }));
    return ownSchemaFirst(objects, this.settings.schema ?? 'default');
  }

  /** Trino passes on no connector's keys, so there's none to offer. */
  async keys(object: SourceObjectRef): Promise<string[][]> {
    if ((await this.tableRows(object)).length === 0) throw unreadable(object.name);
    return [];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'query') {
      // `LIMIT 0` runs the query without reading a row, and the first page with columns names them.
      // The few pages after it are read too, so the query finishes rather than ending canceled.
      let columns: Described[] | undefined;
      for await (const page of this.pages(`SELECT * FROM ${guard(select.sql, TRINO)} LIMIT 0`, true))
        if (page.columns && !columns)
          columns = page.columns.map((column) => trinoColumn(column.name, column.type, true));
      return columns ?? [];
    }
    const rows = await this.all(
      `SELECT column_name, data_type, is_nullable FROM ${this.information('columns')}
       WHERE table_schema = ${literal(this.schemaOf(select.object))}
         AND table_name = ${literal(select.object.name)}
       ORDER BY ordinal_position`,
    );
    if (rows.length === 0) throw unreadable(select.object.name);
    return rows.map((row) =>
      trinoColumn(
        String(row.column_name ?? ''),
        String(row.data_type ?? ''),
        String(row.is_nullable ?? 'YES').toUpperCase() !== 'NO',
      ),
    );
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    // Statistics are the connector's to keep, so a catalog without them says nothing.
    try {
      const rows = await this.all(
        `SHOW STATS FOR ${quotePath([this.settings.catalog, this.schemaOf(object), object.name], TRINO)}`,
      );
      const total = rows.find((row) => row.column_name === null || row.column_name === undefined);
      return total ? wholeNumber(total.row_count) : null;
    } catch {
      return null;
    }
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    _batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const projection = columns
      .map(
        (entry) =>
          `${trinoProjection(entry, TRINO.quote(entry.column.name))} AS ${TRINO.quote(entry.column.name)}`,
      )
      .join(', ');
    const from =
      select.kind === 'object'
        ? quotePath([this.settings.catalog, this.schemaOf(select.object), select.object.name], TRINO)
        : guard(select.sql, TRINO);
    const sql = `SELECT ${projection} FROM ${from}${limit === undefined ? '' : ` LIMIT ${positive(limit, 50)}`}`;
    for await (const page of this.pages(sql, true))
      if (page.data && page.data.length > 0)
        yield page.data.map((values) =>
          Object.fromEntries(
            columns.map((entry, index) => [entry.column.name, plainOfTrino(values[index], entry)]),
          ),
        );
  }
}

/** What Trino's words say is missing: a catalog, schema, or table, or a column it can't resolve. */
export function trinoMissing(detail: string): Missing | null {
  if (/\b(?:TABLE|SCHEMA|CATALOG)_NOT_FOUND\b|(?:Table|Schema|Catalog) '[^']+' does not exist/i.test(detail))
    return { kind: 'object' };
  const column = /Column '([^']+)' cannot be resolved/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

/** Where a Trino coordinator is, and how it's secured. */
export function trinoEndpoint(settings: TrinoSettings): Endpoint {
  const endpoint = hostAndPort(settings.host, settings.port);
  return { ...endpoint, tls: settings.secure ? (settings.caPem ? { ca: settings.caPem } : {}) : false };
}

export interface TrinoConnectorOptions {
  /** Holds the coordinator to the server's private-network rule */
  hostGuard?: HostGuard;
  /** Stands in for the session's own connections, so tests can answer as a coordinator would */
  fetch?: HttpFetch;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createTrinoConnector(options: TrinoConnectorOptions = {}): Connector {
  const hostGuard = options.hostGuard;
  return makeWarehouseConnector(
    {
      kind: 'trino',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'trino' ? trinoEndpoint(ctx.connection) : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'trino');
        // The contract keeps a password or a token off plain HTTP, and so does the connector.
        if (settings.auth !== 'none' && !settings.secure)
          throw new ConnectorError(KEYS.read, 'Trino takes a password or a token only over HTTPS');
        const secret =
          settings.auth === 'password'
            ? secretOf(ctx.secrets, 'password')
            : settings.auth === 'token'
              ? secretOf(ctx.secrets, 'token')
              : undefined;
        const endpoint = trinoEndpoint(settings);
        if (hostGuard && isIP(endpoint.host) && !hostGuard.allowsAddress(endpoint.host))
          throw blockedHost(endpoint.host);
        const agent = options.fetch
          ? undefined
          : sessionAgent({
              secure: settings.secure,
              ...(settings.secure && settings.caPem ? { ca: settings.caPem } : {}),
              ...(hostGuard ? { guard: hostGuard } : {}),
            });
        const session = new TrinoSession(
          options.fetch ?? agentFetch(agent!, hostGuard),
          httpAddress(endpoint, settings.secure),
          trinoHeaders(settings, secret),
          settings,
          () => agent?.destroy(),
        );
        try {
          // Any statement signs in, and one outside the catalog proves nothing but the sign-in.
          await session.all('SELECT 1 AS signed_in');
          return session;
        } catch (error) {
          void session.close();
          throw error;
        }
      },
      missing: trinoMissing,
    },
    options.network ?? directNetwork(hostGuard),
  );
}

export const trinoConnector: Connector = createTrinoConnector();
registerConnector(trinoConnector);

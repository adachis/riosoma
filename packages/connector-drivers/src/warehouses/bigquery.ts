import {
  BigQuery,
  BigQueryDate,
  BigQueryDatetime,
  BigQueryInt,
  BigQueryTime,
  BigQueryTimestamp,
  Geography,
} from '@google-cloud/bigquery';
import type { SourceConnection, SourceObject, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { positive } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type Connector, type ConnectorContext } from '@riosoma/connectors/internal/types.js';
import {
  connectionOf,
  KEYS,
  objectMissing,
  secretOf,
  type Missing,
} from '@riosoma/connectors/internal/warehouses/errors.js';
import {
  makeWarehouseConnector,
  nodeNetwork,
  type Endpoint,
  type Network,
  type Row,
  type WarehouseSession,
} from '@riosoma/connectors/internal/warehouses/frame.js';
import {
  describeColumn,
  sized,
  type Described,
  type TypeClass,
} from '@riosoma/connectors/internal/warehouses/mapping.js';
import { BIGQUERY, guard, selectSql } from '@riosoma/connectors/internal/warehouses/sql.js';
import { exactInteger, wholeNumber } from '@riosoma/connectors/internal/warehouses/values.js';

/**
 * BigQuery.  A service account key signs every request, so there is no connection to hold, and a
 * dataset is the level a schema is everywhere else.  Results are paged, a page at a time, and a job
 * that is still running is asked again rather than read as empty.  Every name the connector writes
 * is quoted in backticks, with BigQuery's own escapes.
 */

type BigQuerySettings = Extract<SourceConnection, { kind: 'bigquery' }>;

const LIST_PAGE = 1_000;
/** A guard against an API that keeps handing back more pages, not a limit anyone should reach. */
const MOST_PAGES = 1_000;
/** A listing carries no row counts, so this many tables have theirs looked up, one request each. */
const COUNTED_TABLES = 200;
const LOOKUPS_AT_ONCE = 8;
/** A pause between asking about a job that isn't done, on top of the wait the API does itself. */
const POLL_MS = 250;

export interface ListPage {
  maxResults: number;
  pageToken?: string;
}

export interface ListAnswer<T> {
  items: T[];
  /** The token for the next page, or null after the last */
  pageToken: string | null;
}

/** One column of a table or of a query's result, as the API describes it. */
export interface BigQueryField {
  name: string;
  type?: string | null;
  mode?: string | null;
  precision?: string | number | null;
  scale?: string | number | null;
  maxLength?: string | number | null;
  fields?: BigQueryField[] | null;
}

export interface BigQueryTableSummary {
  id: string;
  type: string | null;
}

export interface BigQueryTable {
  type: string | null;
  numRows: string | number | null;
  fields: BigQueryField[];
  /** The columns of the primary key the table declares, which BigQuery doesn't enforce */
  primaryKey: string[];
}

export interface BigQueryPage {
  /** False while the job still runs, when the page holds nothing yet */
  complete: boolean;
  rows: Row[];
  pageToken: string | null;
}

export interface BigQueryJob {
  results(page: ListPage): Promise<BigQueryPage>;
  cancel(): Promise<void>;
}

/** The slice of the client this connector uses, so a test can stand in a fake of the same shape. */
export interface BigQueryClient {
  /** Gets an access token, which proves the key signs in without asking BigQuery anything */
  authenticate(): Promise<void>;
  datasets(page: ListPage): Promise<ListAnswer<string>>;
  tables(dataset: string, page: ListPage): Promise<ListAnswer<BigQueryTableSummary>>;
  table(dataset: string, table: string): Promise<BigQueryTable>;
  /** The columns a query would produce, without running it or paying for a scan */
  dryRun(sql: string): Promise<BigQueryField[]>;
  query(sql: string, options: { jobTimeoutMs: number }): Promise<BigQueryJob>;
}

export interface BigQueryDriver {
  createClient(options: {
    projectId: string;
    credentials: Record<string, string>;
    location?: string;
  }): BigQueryClient;
}

interface ApiField {
  name?: string | null;
  type?: string | null;
  mode?: string | null;
  precision?: string | null;
  scale?: string | null;
  maxLength?: string | null;
  fields?: ApiField[] | null;
}

function fieldsOf(fields: readonly ApiField[] | null | undefined): BigQueryField[] {
  return (fields ?? []).map((field) => ({
    name: field.name ?? '',
    type: field.type ?? null,
    mode: field.mode ?? null,
    precision: field.precision ?? null,
    scale: field.scale ?? null,
    maxLength: field.maxLength ?? null,
    fields: field.fields ? fieldsOf(field.fields) : null,
  }));
}

/** The API's own response, which the client hands back last and only sometimes. */
function responseOf<T>(answer: readonly unknown[]): T | undefined {
  return answer[2] as T | undefined;
}

function clientOf(bigquery: BigQuery): BigQueryClient {
  return {
    async authenticate() {
      await bigquery.authClient.getAccessToken();
    },
    async datasets(page) {
      const answer = await bigquery.getDatasets({ autoPaginate: false, ...page });
      return {
        items: answer[0].map((dataset) => dataset.id ?? '').filter((id) => id.length > 0),
        pageToken: responseOf<{ nextPageToken?: string | null }>(answer)?.nextPageToken ?? null,
      };
    },
    async tables(dataset, page) {
      const answer = await bigquery.dataset(dataset).getTables({ autoPaginate: false, ...page });
      return {
        items: answer[0].map((table) => ({
          id: table.id ?? '',
          type: (table.metadata as { type?: string | null } | undefined)?.type ?? null,
        })),
        pageToken: responseOf<{ nextPageToken?: string | null }>(answer)?.nextPageToken ?? null,
      };
    },
    async table(dataset, table) {
      const [metadata] = await bigquery.dataset(dataset).table(table).getMetadata();
      return {
        type: metadata.type ?? null,
        numRows: metadata.numRows ?? null,
        fields: fieldsOf(metadata.schema?.fields),
        primaryKey: metadata.tableConstraints?.primaryKey?.columns ?? [],
      };
    },
    async dryRun(sql) {
      const [, response] = await bigquery.createQueryJob({ query: sql, dryRun: true });
      return fieldsOf(response.statistics?.query?.schema?.fields);
    },
    async query(sql, options) {
      const [job] = await bigquery.createQueryJob({ query: sql, jobTimeoutMs: options.jobTimeoutMs });
      return {
        async results(page) {
          // Wrapped integers keep an INT64's digits, and JSON stays the text BigQuery sent.
          const answer = await job.getQueryResults({
            autoPaginate: false,
            wrapIntegers: true,
            parseJSON: false,
            ...page,
          });
          const response = responseOf<{ jobComplete?: boolean | null; pageToken?: string | null }>(answer);
          return {
            complete: response?.jobComplete !== false,
            rows: answer[0] as Row[],
            pageToken: response?.pageToken ?? null,
          };
        },
        async cancel() {
          await job.cancel();
        },
      };
    },
  };
}

const realDriver: BigQueryDriver = {
  createClient: (options) =>
    clientOf(
      new BigQuery({
        projectId: options.projectId,
        credentials: options.credentials,
        ...(options.location === undefined ? {} : { location: options.location }),
      }),
    ),
};

/**
 * A service account key as credentials.  A key that doesn't parse is reported without the parser's
 * own words, which quote the text it choked on, and a secret is nobody's to quote.
 */
export function credentialsOf(key: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new ConnectorError(KEYS.read, "the service account key isn't JSON");
  }
  const credentials: Record<string, string> = {};
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
    for (const [name, value] of Object.entries(parsed))
      if (typeof value === 'string') credentials[name] = value;
  if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key)
    throw new ConnectorError(
      KEYS.read,
      "the key isn't a service account key with an email and a private key",
    );
  return credentials;
}

/** What a BigQuery field's type comes down to.  A repeated field is an array, whatever it holds. */
export function bigQueryTypeClass(field: Pick<BigQueryField, 'type' | 'mode'>): TypeClass {
  if (String(field.mode ?? '').toUpperCase() === 'REPEATED') return 'json';
  switch (String(field.type ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT64':
      return 'integer';
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'DECIMAL':
    case 'BIGDECIMAL':
      return 'decimal';
    case 'FLOAT':
    case 'FLOAT64':
      return 'float';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'DATE':
      return 'date';
    // A DATETIME has no zone, so it reads as UTC, and a TIMESTAMP is an instant.
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'timestamp';
    case 'TIME':
      return 'time';
    case 'STRING':
      return 'text';
    case 'JSON':
    case 'RECORD':
    case 'STRUCT':
      return 'json';
    case 'BYTES':
      return 'binary';
    // Geography, intervals, ranges, and anything new are named, not guessed at.
    default:
      return 'unknown';
  }
}

function fieldColumn(field: BigQueryField): Described {
  const type = String(field.type ?? '').toUpperCase();
  const mode = String(field.mode ?? '').toUpperCase();
  const kind = bigQueryTypeClass(field);
  const scale = wholeNumber(field.scale);
  const length = wholeNumber(field.maxLength);
  // NUMERIC and BIGNUMERIC declare no scale unless parameterized, and then show values as entered.
  const base =
    kind === 'decimal'
      ? sized(type, wholeNumber(field.precision), scale)
      : type === 'STRING'
        ? sized(type, length)
        : type;
  return describeColumn({
    name: field.name,
    sourceType: mode === 'REPEATED' ? `ARRAY<${base}>` : base,
    nullable: mode !== 'REQUIRED',
    kind,
    scale: kind === 'decimal' ? scale : null,
    length,
  });
}

/**
 * The client's value objects as plain values: an INT64's digits, a NUMERIC's every digit, the
 * text of dates, times, and instants, and records and arrays with their parts unwrapped too.
 */
function plainOfBigQuery(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof BigQueryInt) return exactInteger(value.value);
  if (
    value instanceof BigQueryDate ||
    value instanceof BigQueryDatetime ||
    value instanceof BigQueryTime ||
    value instanceof BigQueryTimestamp ||
    value instanceof Geography
  )
    return value.value;
  if (value instanceof Uint8Array || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(plainOfBigQuery);
  if (typeof value === 'object') {
    // NUMERIC and BIGNUMERIC arrive as big decimals, whose `toFixed` writes every digit in full.
    const fixed = (value as { toFixed?: unknown }).toFixed;
    if (typeof fixed === 'function' && 'c' in value && 'e' in value && 's' in value)
      return String(fixed.call(value));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plainOfBigQuery(item)]));
  }
  return value;
}

function isView(type: string | null): boolean {
  return String(type ?? '')
    .toUpperCase()
    .includes('VIEW');
}

function closed(): ConnectorError {
  return new ConnectorError(KEYS.read, 'the session was closed');
}

/** Runs work on items with at most `limit` of it at once. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

class BigQuerySession implements WarehouseSession {
  private readonly jobs = new Set<BigQueryJob>();
  private readonly stopped = new AbortController();

  constructor(
    private readonly client: BigQueryClient,
    private readonly settings: BigQuerySettings,
    private readonly timeoutMs: number,
  ) {}

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    const jobs = [...this.jobs];
    this.jobs.clear();
    await Promise.all(jobs.map((job) => job.cancel().catch(() => undefined)));
  }

  /** Waits on the client, unless the session closes first.  A request in flight is left behind. */
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

  private async start(sql: string): Promise<BigQueryJob> {
    const starting = this.client.query(sql, { jobTimeoutMs: this.timeoutMs });
    // A job that only starts after the session closed is canceled the moment it exists.
    starting.then(
      (job) => {
        if (this.stopped.signal.aborted) void job.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const job = await this.until(starting);
    this.jobs.add(job);
    return job;
  }

  /** One page of a job's results, asking again while BigQuery says the job is still running. */
  private async page(job: BigQueryJob, maxResults: number, pageToken?: string): Promise<BigQueryPage> {
    for (;;) {
      const page = await this.until(job.results({ maxResults, ...(pageToken ? { pageToken } : {}) }));
      if (page.complete) return page;
      await this.until(new Promise((resolve) => setTimeout(resolve, POLL_MS)));
    }
  }

  private async all<T>(fetch: (page: ListPage) => Promise<ListAnswer<T>>): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let count = 0; count < MOST_PAGES; count++) {
      const answer = await this.until(
        fetch(pageToken ? { maxResults: LIST_PAGE, pageToken } : { maxResults: LIST_PAGE }),
      );
      items.push(...answer.items);
      if (answer.pageToken === null || answer.pageToken === pageToken) break;
      pageToken = answer.pageToken;
    }
    return items;
  }

  private datasetOf(object: SourceObjectRef): string {
    const dataset = object.schema || this.settings.dataset;
    if (!dataset)
      throw objectMissing(
        object.name,
        `${object.name} names no dataset, and the connection has no default one`,
      );
    return dataset;
  }

  private path(object: SourceObjectRef): string[] {
    return [this.settings.projectId, this.datasetOf(object), object.name];
  }

  private table(object: SourceObjectRef): Promise<BigQueryTable> {
    return this.until(this.client.table(this.datasetOf(object), object.name));
  }

  async version(): Promise<string> {
    const job = await this.start('SELECT 1 AS one');
    await this.page(job, 1);
    this.jobs.delete(job);
    return 'BigQuery';
  }

  async list(): Promise<SourceObject[]> {
    const preferred = this.settings.dataset?.toLowerCase();
    const datasets = (await this.all((page) => this.client.datasets(page))).sort(
      (left, right) =>
        Number(right.toLowerCase() === preferred) - Number(left.toLowerCase() === preferred) ||
        left.localeCompare(right),
    );
    const objects: SourceObject[] = [];
    for (const dataset of datasets) {
      const tables = await this.all((page) => this.client.tables(dataset, page));
      for (const table of tables.sort((left, right) => left.id.localeCompare(right.id)))
        objects.push({
          schema: dataset,
          name: table.id,
          type: isView(table.type) ? 'view' : 'table',
          rowEstimate: null,
        });
    }
    const counted = objects.filter((object) => object.type === 'table').slice(0, COUNTED_TABLES);
    await eachLimited(counted, LOOKUPS_AT_ONCE, async (object) => {
      object.rowEstimate = await this.table(object)
        .then((table) => wholeNumber(table.numRows))
        .catch(() => null);
    });
    return objects;
  }

  async keys(object: SourceObjectRef): Promise<string[][]> {
    const table = await this.table(object);
    return isView(table.type) || table.primaryKey.length === 0 ? [] : [table.primaryKey];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    const fields =
      select.kind === 'query'
        ? await this.until(this.client.dryRun(`SELECT * FROM ${guard(select.sql, BIGQUERY)}`))
        : (await this.table(select.object)).fields;
    return fields.map(fieldColumn);
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    const table = await this.table(object);
    return isView(table.type) ? null : wholeNumber(table.numRows);
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const names = columns.map((entry) => entry.column.name);
    const job = await this.start(selectSql(select, names, BIGQUERY, (object) => this.path(object), limit));
    try {
      let pageToken: string | undefined;
      for (;;) {
        const page = await this.page(job, batchSize, pageToken);
        if (page.rows.length > 0)
          yield page.rows.map((row) =>
            Object.fromEntries(names.map((name) => [name, plainOfBigQuery(row[name])])),
          );
        if (page.pageToken === null) break;
        pageToken = page.pageToken;
      }
    } finally {
      this.jobs.delete(job);
    }
  }
}

/** What BigQuery's words say is missing: a table, view, or dataset, or a name a query can't bind. */
export function bigQueryMissing(detail: string): Missing | null {
  if (/\bNot found: (?:Table|View|Dataset)\b/i.test(detail)) return { kind: 'object' };
  const column =
    /\bUnrecognized name: `?([^\s`;,]+)/i.exec(detail) ??
    /\bName `?([^\s`]+?)`? not found inside\b/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

export interface BigQueryConnectorOptions {
  /** Observes the actual driver boundary during a contract run */
  observeDriver?: (driver: BigQueryDriver) => BigQueryDriver;
  /** Stands in for `@google-cloud/bigquery`, so tests can supply a fake client */
  driver?: BigQueryDriver;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createBigQueryConnector(options: BigQueryConnectorOptions = {}): Connector {
  const driver = options.observeDriver?.(options.driver ?? realDriver) ?? options.driver ?? realDriver;
  return makeWarehouseConnector(
    {
      kind: 'bigquery',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'bigquery' ? { host: 'bigquery.googleapis.com', port: 443 } : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'bigquery');
        const credentials = credentialsOf(secretOf(ctx.secrets, 'serviceAccountJson'));
        const client = driver.createClient({
          projectId: settings.projectId,
          credentials,
          ...(settings.location === undefined ? {} : { location: settings.location }),
        });
        await client.authenticate();
        return new BigQuerySession(client, settings, positive(ctx.timeoutMs, 30000));
      },
      missing: bigQueryMissing,
    },
    options.network ?? nodeNetwork,
  );
}

export const bigQueryConnector: Connector = createBigQueryConnector();

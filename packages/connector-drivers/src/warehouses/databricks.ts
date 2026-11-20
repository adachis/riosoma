import { DBSQLClient, thrift } from '@databricks/sql';
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
import { DATABRICKS, guard, quotePath, selectSql } from '@riosoma/connectors/internal/warehouses/sql.js';
import {
  exactInteger,
  ownSchemaFirst,
  textOr,
  wholeNumber,
} from '@riosoma/connectors/internal/warehouses/values.js';

/**
 * Databricks SQL.  A workspace host, a SQL warehouse's HTTP path, and an access token; a catalog
 * and schema narrow what the session sees.  The catalog is Unity Catalog's `information_schema`,
 * every name is quoted in backticks, catalog filters travel as named parameters, and the session
 * runs in UTC because Spark writes timestamps in the session's zone.
 */

type DatabricksSettings = Extract<SourceConnection, { kind: 'databricks' }>;

/** Rows per fetch while reading a catalog, whose answers are small. */
const CATALOG_CHUNK = 1_000;
/** A safety valve on a catalog listing, not a limit anyone should reach. */
const MOST_CATALOG_ROWS = 100_000;
const TYPE_NAMES: Record<number, string> = thrift.TCLIService_types.TYPE_NAMES;

/** One column of a result, with the type name the driver reports for it. */
export interface DatabricksColumn {
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
}

export interface DatabricksOperation {
  /** The columns this operation produces, in order */
  columns(): Promise<DatabricksColumn[]>;
  /** Up to `maxRows` more rows */
  fetchChunk(maxRows: number): Promise<Row[]>;
  hasMoreRows(): Promise<boolean>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabricksSession {
  execute(
    sql: string,
    options: { queryTimeout: number; parameters?: Record<string, string> },
  ): Promise<DatabricksOperation>;
  close(): Promise<void>;
}

export interface DatabricksConnect {
  host: string;
  port?: number;
  path: string;
  token: string;
  timeoutMs: number;
}

export interface DatabricksClient {
  connect(options: DatabricksConnect): Promise<void>;
  openSession(options: { initialCatalog?: string; initialSchema?: string }): Promise<DatabricksSession>;
  close(): Promise<void>;
}

/** The slice of the driver this connector uses, so a test can stand in a fake of the same shape. */
export interface DatabricksDriver {
  createClient(): DatabricksClient;
}

type DriverSession = Awaited<ReturnType<DBSQLClient['openSession']>>;
type DriverOperation = Awaited<ReturnType<DriverSession['executeStatement']>>;
type DriverSchema = NonNullable<Awaited<ReturnType<DriverOperation['getSchema']>>>;
type DriverType = DriverSchema['columns'][number]['typeDesc']['types'][number];

/** The driver's Thrift schema as the columns this connector reads. */
function columnsOf(schema: DriverSchema | null): DatabricksColumn[] {
  return [...(schema?.columns ?? [])]
    .sort((left, right) => left.position - right.position)
    .map((column) => {
      const entry: DriverType | undefined = column.typeDesc.types[0];
      const primitive = entry?.primitiveEntry;
      const qualifiers = primitive?.typeQualifiers?.qualifiers ?? {};
      return {
        name: column.columnName,
        type: primitive ? (TYPE_NAMES[primitive.type] ?? String(primitive.type)) : complexName(entry),
        precision: wholeNumber(qualifiers.precision?.i32Value),
        scale: wholeNumber(qualifiers.scale?.i32Value),
      };
    });
}

function complexName(entry: DriverType | undefined): string {
  if (entry?.arrayEntry) return 'ARRAY';
  if (entry?.mapEntry) return 'MAP';
  if (entry?.structEntry) return 'STRUCT';
  return 'UNKNOWN';
}

function operationOf(operation: DriverOperation): DatabricksOperation {
  return {
    columns: async () => columnsOf(await operation.getSchema()),
    fetchChunk: async (maxRows) => (await operation.fetchChunk({ maxRows })) as Row[],
    hasMoreRows: () => operation.hasMoreRows(),
    cancel: async () => {
      await operation.cancel();
    },
    close: async () => {
      await operation.close();
    },
  };
}

/** The driver logs to the console and catches the process's uncaught errors unless given a logger. */
const QUIET_LOGGER = { log: () => undefined };

const realDriver: DatabricksDriver = {
  createClient() {
    const client = new DBSQLClient({ logger: QUIET_LOGGER });
    return {
      async connect(options) {
        await client.connect({
          host: options.host,
          ...(options.port === undefined ? {} : { port: options.port }),
          path: options.path,
          token: options.token,
          userAgentEntry: 'riosoma',
          // Exact digits for DECIMAL and BIGINT, which the driver otherwise rounds to doubles.
          preserveBigNumericPrecision: true,
          telemetryEnabled: false,
          socketTimeout: options.timeoutMs,
          retriesTimeout: options.timeoutMs,
        });
      },
      async openSession(options) {
        const session = await client.openSession(options);
        return {
          execute: async (sql, execute) =>
            operationOf(
              await session.executeStatement(sql, {
                queryTimeout: execute.queryTimeout,
                ...(execute.parameters === undefined ? {} : { namedParameters: execute.parameters }),
              }),
            ),
          close: async () => {
            await session.close();
          },
        };
      },
      close: () => client.close(),
    };
  },
};

/** The workspace's host and port, from a host or a whole address someone pasted. */
export function workspaceOf(host: string): Endpoint {
  const address = host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '');
  const port = /:(\d+)$/.exec(address);
  return port
    ? { host: address.slice(0, -port[0].length), port: Number(port[1]) }
    : { host: address, port: 443 };
}

/** The SQL warehouse's HTTP path, from a path or a whole address someone pasted. */
export function httpPathOf(path: string): string {
  const trimmed = path.trim().replace(/^https?:\/\/[^/]+/i, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** What a Databricks type name comes down to.  The catalog and the driver both use Spark's names. */
export function databricksTypeClass(type: string): TypeClass {
  switch (
    type
      .trim()
      .toUpperCase()
      .replace(/[(<].*$/s, '')
      .trim()
  ) {
    case 'TINYINT':
    case 'BYTE':
    case 'SMALLINT':
    case 'SHORT':
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'LONG':
      return 'integer';
    case 'DECIMAL':
    case 'DEC':
    case 'NUMERIC':
      return 'decimal';
    case 'FLOAT':
    case 'REAL':
    case 'DOUBLE':
      return 'float';
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
      return 'date';
    // A plain TIMESTAMP is an instant, and a TIMESTAMP_NTZ has no zone, which reads as UTC.
    case 'TIMESTAMP':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_NTZ':
      return 'timestamp';
    case 'STRING':
    case 'VARCHAR':
    case 'CHAR':
      return 'text';
    case 'ARRAY':
    case 'MAP':
    case 'STRUCT':
    case 'VARIANT':
    case 'UNIONTYPE':
      return 'json';
    case 'BINARY':
      return 'binary';
    // Intervals, geospatial types, and anything new are named, not guessed at.
    default:
      return 'unknown';
  }
}

/** A column as `information_schema.columns` describes it. */
function catalogColumn(row: Row): Described {
  const kind = databricksTypeClass(String(row.data_type ?? ''));
  return describeColumn({
    name: String(row.column_name ?? ''),
    sourceType: String(row.full_data_type ?? row.data_type ?? ''),
    nullable: String(row.is_nullable ?? 'YES').toUpperCase() !== 'NO',
    kind,
    scale: kind === 'decimal' ? wholeNumber(row.numeric_scale) : null,
    length: wholeNumber(row.character_maximum_length),
  });
}

/** A query's column as the result describes it, which says nothing about nulls. */
function resultColumn(column: DatabricksColumn): Described {
  const kind = databricksTypeClass(column.type);
  return describeColumn({
    name: column.name,
    sourceType: kind === 'decimal' ? sized(column.type, column.precision, column.scale) : column.type,
    nullable: true,
    kind,
    scale: kind === 'decimal' ? column.scale : null,
  });
}

function isView(type: unknown): boolean {
  return String(type ?? '')
    .toUpperCase()
    .includes('VIEW');
}

/** A value a row holds under a name, allowing for a name the result writes in another case. */
function valueIn(row: Row, name: string): unknown {
  if (name in row) return row[name];
  const folded = name.toLowerCase();
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === folded);
  return key === undefined ? null : row[key];
}

function closed(): ConnectorError {
  return new ConnectorError(KEYS.read, 'the session was closed');
}

class DatabricksWarehouseSession implements WarehouseSession {
  private readonly operations = new Set<DatabricksOperation>();
  private readonly stopped = new AbortController();
  private currentCatalog: Promise<string> | undefined;

  constructor(
    private readonly client: DatabricksClient,
    private readonly session: DatabricksSession,
    private readonly settings: DatabricksSettings,
    private readonly timeoutMs: number,
  ) {}

  async close(): Promise<void> {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    const operations = [...this.operations];
    this.operations.clear();
    await Promise.all(operations.map((operation) => operation.cancel().catch(() => undefined)));
    await this.session.close().catch(() => undefined);
    await this.client.close().catch(() => undefined);
  }

  /** Waits on the driver, unless the session closes first. */
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

  /** Runs one statement and hands back its operation, which closing the session cancels. */
  private async execute(sql: string, parameters?: Record<string, string>): Promise<DatabricksOperation> {
    const operation = await this.until(
      this.session.execute(sql, {
        queryTimeout: Math.max(1, Math.ceil(this.timeoutMs / 1000)),
        ...(parameters === undefined ? {} : { parameters }),
      }),
    );
    this.operations.add(operation);
    return operation;
  }

  private async finish(operation: DatabricksOperation): Promise<void> {
    if (!this.operations.delete(operation)) return;
    await operation.close().catch(() => undefined);
  }

  /** Every row of a small result, which is all a catalog query returns. */
  async all(sql: string, parameters?: Record<string, string>): Promise<Row[]> {
    const operation = await this.execute(sql, parameters);
    try {
      const rows: Row[] = [];
      for (;;) {
        const chunk = await this.until(operation.fetchChunk(CATALOG_CHUNK));
        rows.push(...chunk);
        if (chunk.length === 0 || rows.length >= MOST_CATALOG_ROWS) break;
        if (!(await this.until(operation.hasMoreRows()))) break;
      }
      return rows;
    } finally {
      await this.finish(operation);
    }
  }

  /** The catalog this source reads: the connection's, or the one the warehouse starts a session in. */
  private catalog(): Promise<string> {
    this.currentCatalog ??=
      this.settings.catalog !== undefined
        ? Promise.resolve(this.settings.catalog)
        : this.all('SELECT current_catalog() AS catalog').then((rows) => {
            const name = textOr(rows[0]?.catalog);
            if (name === null) throw new Error('the warehouse named no current catalog');
            return name;
          });
    return this.currentCatalog;
  }

  private schemaOf(object: SourceObjectRef): string {
    return object.schema || this.settings.schema || 'default';
  }

  private async information(view: string): Promise<string> {
    return quotePath([await this.catalog(), 'information_schema', view], DATABRICKS);
  }

  private async tableRows(object: SourceObjectRef): Promise<Row[]> {
    return this.all(
      `SELECT table_type FROM ${await this.information('tables')}
       WHERE lower(table_schema) = lower(:schema) AND lower(table_name) = lower(:table)`,
      { schema: this.schemaOf(object), table: object.name },
    );
  }

  async version(): Promise<string> {
    const rows = await this.all('SELECT version() AS version');
    const version = textOr(rows[0]?.version)?.split(' ')[0];
    return version ? `Databricks (Spark ${version})` : 'Databricks';
  }

  async list(): Promise<SourceObject[]> {
    const rows = await this.all(
      `SELECT table_schema, table_name, table_type FROM ${await this.information('tables')}
       WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name`,
    );
    // Unity Catalog keeps no row counts, so every estimate is unknown.
    const objects = rows.map((row) => ({
      schema: textOr(row.table_schema),
      name: String(row.table_name ?? ''),
      type: isView(row.table_type) ? ('view' as const) : ('table' as const),
      rowEstimate: null,
    }));
    // Unity Catalog folds names to lower case, so the connection's schema matches in any case.
    return ownSchemaFirst(
      objects,
      this.settings.schema ?? 'default',
      (left, right) => left.toLowerCase() === right.toLowerCase(),
    );
  }

  async keys(object: SourceObjectRef): Promise<string[][]> {
    const tables = await this.tableRows(object);
    if (tables.length === 0) throw objectMissing(object.name);
    if (isView(tables[0]?.table_type)) return [];
    // Unity Catalog records the keys a table declares, which it doesn't enforce.
    const rows = await this.all(
      `SELECT tc.constraint_name, kcu.column_name
       FROM ${await this.information('table_constraints')} AS tc
       JOIN ${await this.information('key_column_usage')} AS kcu
         ON kcu.constraint_catalog = tc.constraint_catalog
        AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
       WHERE lower(tc.table_schema) = lower(:schema) AND lower(tc.table_name) = lower(:table)
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
       ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, tc.constraint_name,
                kcu.ordinal_position`,
      { schema: this.schemaOf(object), table: object.name },
    );
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const column = textOr(row.column_name);
      if (column === null) continue;
      const name = textOr(row.constraint_name) ?? '';
      groups.set(name, [...(groups.get(name) ?? []), column]);
    }
    return [...groups.values()];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'query') {
      // Nothing describes a query without running it, and `LIMIT 0` runs it without reading a row.
      const operation = await this.execute(`SELECT * FROM ${guard(select.sql, DATABRICKS)} LIMIT 0`);
      try {
        return (await this.until(operation.columns())).map(resultColumn);
      } finally {
        await this.finish(operation);
      }
    }
    const rows = await this.all(
      `SELECT column_name, data_type, full_data_type, is_nullable, numeric_scale, character_maximum_length
       FROM ${await this.information('columns')}
       WHERE lower(table_schema) = lower(:schema) AND lower(table_name) = lower(:table)
       ORDER BY ordinal_position`,
      { schema: this.schemaOf(select.object), table: select.object.name },
    );
    if (rows.length === 0) throw objectMissing(select.object.name);
    return rows.map(catalogColumn);
  }

  async estimate(): Promise<number | null> {
    return null;
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const catalog = select.kind === 'object' ? await this.catalog() : '';
    const sql = selectSql(
      select,
      columns.map((entry) => entry.column.name),
      DATABRICKS,
      (object) => [catalog, this.schemaOf(object), object.name],
      limit,
    );
    const operation = await this.execute(sql);
    try {
      for (;;) {
        const chunk = await this.until(operation.fetchChunk(batchSize));
        if (chunk.length > 0)
          yield chunk.map((raw) => {
            const row: Row = {};
            for (const { column, kind } of columns) {
              const value = valueIn(raw, column.name);
              row[column.name] =
                kind === 'integer' && (typeof value === 'bigint' || typeof value === 'string')
                  ? exactInteger(value)
                  : value;
            }
            return row;
          });
        if (chunk.length === 0 || !(await this.until(operation.hasMoreRows()))) break;
      }
    } finally {
      await this.finish(operation);
    }
  }
}

/** What Databricks' words say is missing: a table, view, or schema, or a column it can't resolve. */
export function databricksMissing(detail: string): Missing | null {
  if (/TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|Table or view not found/i.test(detail))
    return { kind: 'object' };
  const column =
    /UNRESOLVED_COLUMN[\s\S]*?name `([^`]+)`/i.exec(detail) ?? /cannot resolve '`?([^`']+?)`?'/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

export interface DatabricksConnectorOptions {
  /** Observes the actual driver boundary during a contract run */
  observeDriver?: (driver: DatabricksDriver) => DatabricksDriver;
  /** Stands in for `@databricks/sql`, so tests can supply a fake client */
  driver?: DatabricksDriver;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createDatabricksConnector(options: DatabricksConnectorOptions = {}): Connector {
  const driver = options.observeDriver?.(options.driver ?? realDriver) ?? options.driver ?? realDriver;
  return makeWarehouseConnector(
    {
      kind: 'databricks',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'databricks' ? workspaceOf(ctx.connection.host) : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'databricks');
        const token = secretOf(ctx.secrets, 'token');
        const timeoutMs = positive(ctx.timeoutMs, 30000);
        const workspace = workspaceOf(settings.host);
        const client = driver.createClient();
        let opened: DatabricksWarehouseSession | undefined;
        try {
          await client.connect({
            host: workspace.host,
            ...(workspace.port === 443 ? {} : { port: workspace.port }),
            path: httpPathOf(settings.httpPath),
            token,
            timeoutMs,
          });
          const session = await client.openSession({
            ...(settings.catalog === undefined ? {} : { initialCatalog: settings.catalog }),
            ...(settings.schema === undefined ? {} : { initialSchema: settings.schema }),
          });
          opened = new DatabricksWarehouseSession(client, session, settings, timeoutMs);
          // Spark writes a timestamp in the session's zone, so the session asks for UTC.
          await opened.all("SET TIME ZONE 'UTC'");
          return opened;
        } catch (error) {
          if (opened) void opened.close();
          else void client.close().catch(() => undefined);
          throw error;
        }
      },
      missing: databricksMissing,
    },
    options.network ?? nodeNetwork,
  );
}

export const databricksConnector: Connector = createDatabricksConnector();

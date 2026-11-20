import {
  DuckDBArrayValue,
  DuckDBBlobValue,
  DuckDBDateValue,
  DuckDBDecimalType,
  DuckDBDecimalValue,
  DuckDBEnumType,
  DuckDBInstance,
  DuckDBListValue,
  DuckDBMapValue,
  DuckDBStructValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  DuckDBUnionValue,
  DuckDBVariantValue,
} from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBType, DuckDBValue } from '@duckdb/node-api';
import type {
  SourceConnection,
  SourceObject,
  SourceObjectRef,
  SourceSecrets,
  SourceSelect,
} from '@riosoma/contracts';
import { registerConnector } from '../registry.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { connectionOf, KEYS, objectMissing, secretOf, type Missing } from './errors.js';
import {
  makeWarehouseConnector,
  nodeNetwork,
  type Endpoint,
  type Network,
  type Row,
  type WarehouseSession,
} from './frame.js';
import { describeColumn, type Described, type TypeClass } from './mapping.js';
import { DUCKDB, guard, quotePath, selectSql } from './sql.js';
import { exactInteger, textOr, wholeNumber } from './values.js';

/**
 * MotherDuck, whose engine is DuckDB.  The same connector reads a MotherDuck database in
 * production and a local DuckDB file in tests, which is what lets its tests run end to end with no
 * network and no token.  The engine runs inside Riosoma's own process, so a MotherDuck session
 * runs in SaaS mode, where a query can't reach the server's files, and attaches only the one
 * database this source reads.
 */

type MotherDuckSettings = Extract<SourceConnection, { kind: 'motherduck' }>;

const DEFAULT_SCHEMA = 'main';
/** Catalogs DuckDB attaches itself, which hold nothing anyone means to sync. */
const INTERNAL_CATALOGS = new Set(['system', 'temp']);
/** The widest instant a JS `Date` holds, in microseconds, so a wilder value reads as none. */
const MOST_MICROS = 8_640_000_000_000_000n;

export interface MotherDuckConnectorOptions {
  /** Builds the connection string, which tests point at a local DuckDB file instead of MotherDuck */
  connectionString?: (connection: MotherDuckSettings, secrets: SourceSecrets) => string;
  /** Opens the engine, which tests may slow down */
  openInstance?: (connectionString: string) => Promise<DuckDBInstance>;
  /** Stands in for the network checks of a connection test, which MotherDuck skips */
  network?: Network;
}

/**
 * The connection string for a MotherDuck database.  The name is checked rather than escaped: one
 * that could end the query string would quietly attach something else.
 */
export function motherDuckConnectionString(connection: MotherDuckSettings, secrets: SourceSecrets): string {
  const token = secretOf(secrets, 'token');
  if (/[?&#\s]/.test(connection.database))
    throw new ConnectorError(KEYS.read, 'a MotherDuck database name can\'t hold a space, "?", "&", or "#"');
  return `md:${connection.database}?attach_mode=single&saas_mode=true&motherduck_token=${encodeURIComponent(token)}`;
}

/** What a DuckDB type comes down to, read from the type itself so decimals and enums keep their details. */
export function duckTypeClass(type: DuckDBType): {
  kind: TypeClass;
  scale?: number;
  labels?: readonly string[];
} {
  if (type.alias?.toUpperCase() === 'JSON') return { kind: 'json' };
  switch (type.typeId) {
    case DuckDBTypeId.BOOLEAN:
      return { kind: 'boolean' };
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.BIGNUM:
      return { kind: 'integer' };
    case DuckDBTypeId.DECIMAL:
      return { kind: 'decimal', scale: type instanceof DuckDBDecimalType ? type.scale : 0 };
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
      return { kind: 'float' };
    case DuckDBTypeId.DATE:
      return { kind: 'date' };
    case DuckDBTypeId.TIME:
    case DuckDBTypeId.TIME_TZ:
    case DuckDBTypeId.TIME_NS:
      return { kind: 'time' };
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
      return { kind: 'timestamp' };
    case DuckDBTypeId.VARCHAR:
    case DuckDBTypeId.UUID:
      return { kind: 'text' };
    case DuckDBTypeId.ENUM:
      return { kind: 'text', labels: type instanceof DuckDBEnumType ? type.values : [] };
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY:
    case DuckDBTypeId.STRUCT:
    case DuckDBTypeId.MAP:
    case DuckDBTypeId.UNION:
    case DuckDBTypeId.VARIANT:
      return { kind: 'json' };
    case DuckDBTypeId.BLOB:
      return { kind: 'binary' };
    // Bit strings, intervals, geometry, and anything new are named, not guessed at.
    default:
      return { kind: 'unknown' };
  }
}

function duckColumn(name: string, type: DuckDBType, nullable: boolean): Described {
  const { kind, scale, labels } = duckTypeClass(type);
  return describeColumn({
    name,
    sourceType: type.alias ?? String(type),
    nullable,
    kind,
    scale: scale ?? null,
    ...(labels === undefined ? {} : { labels }),
  });
}

/**
 * A DuckDB value as a plain one.  The engine's own wrappers hold more than a double can, so a
 * decimal gives up its exact digits, and a timestamp is written from its count since the epoch,
 * which reads as UTC whether the column carries a zone or not.
 */
export function plainOfDuck(value: DuckDBValue | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return exactInteger(value);
  if (typeof value !== 'object') return value;
  if (value instanceof DuckDBDecimalValue) return value.toString();
  if (value instanceof DuckDBDateValue) return value.isFinite ? new Date(value.days * 86_400_000) : null;
  if (value instanceof DuckDBTimestampTZValue || value instanceof DuckDBTimestampValue)
    return value.isFinite ? instantFromMicros(value.micros) : null;
  if (value instanceof DuckDBTimestampMillisecondsValue)
    return value.isFinite ? instantFromMicros(value.millis * 1_000n) : null;
  if (value instanceof DuckDBTimestampSecondsValue)
    return value.isFinite ? instantFromMicros(value.seconds * 1_000_000n) : null;
  if (value instanceof DuckDBTimestampNanosecondsValue)
    return value.isFinite ? instantFromMicros(value.nanos / 1_000n) : null;
  if (value instanceof DuckDBBlobValue) return Buffer.from(value.bytes);
  if (value instanceof DuckDBListValue || value instanceof DuckDBArrayValue)
    return value.items.map((item) => plainOfDuck(item));
  if (value instanceof DuckDBStructValue)
    return Object.fromEntries(Object.entries(value.entries).map(([name, item]) => [name, plainOfDuck(item)]));
  if (value instanceof DuckDBMapValue)
    return Object.fromEntries(
      value.entries.map((entry) => [String(plainOfDuck(entry.key) ?? ''), plainOfDuck(entry.value)]),
    );
  if (value instanceof DuckDBUnionValue) return { tag: value.tag, value: plainOfDuck(value.value) };
  if (value instanceof DuckDBVariantValue) return plainOfDuck(value.value);
  // Times, UUIDs, intervals, bit strings, and geometry write their own faithful text.
  return String(value);
}

function instantFromMicros(micros: bigint): Date | null {
  const magnitude = micros < 0n ? -micros : micros;
  if (magnitude > MOST_MICROS) return null;
  // Toward the epoch, so a fraction never rounds an instant into the next millisecond.
  const millis = micros < 0n ? -(magnitude / 1_000n) : magnitude / 1_000n;
  return new Date(Number(millis));
}

function isView(type: unknown): boolean {
  return String(type ?? '')
    .toUpperCase()
    .includes('VIEW');
}

export class DuckSession implements WarehouseSession {
  private closed = false;

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly catalog: string,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Interrupting first makes a read in progress stop instead of holding the engine open.
    for (const step of [
      () => this.connection.interrupt(),
      () => this.connection.disconnectSync(),
      () => this.instance.closeSync(),
    ]) {
      try {
        step();
      } catch {
        // Closing is best effort: the call's own error is the one worth keeping.
      }
    }
  }

  private async metadata(sql: string, values: string[] = []): Promise<Row[]> {
    if (this.closed) throw new ConnectorError(KEYS.read, 'the session was closed');
    const reader = await this.connection.runAndReadAll(sql, values);
    return reader.getRowObjectsJS() as Row[];
  }

  private schemaOf(object: SourceObjectRef): string {
    return object.schema ? object.schema : DEFAULT_SCHEMA;
  }

  private path(object: SourceObjectRef): string[] {
    return [this.catalog, this.schemaOf(object), object.name];
  }

  private async tableRows(object: SourceObjectRef): Promise<Row[]> {
    return this.metadata(
      `SELECT table_type FROM information_schema.tables
       WHERE table_catalog = $1 AND table_schema = $2 AND table_name = $3`,
      [this.catalog, this.schemaOf(object), object.name],
    );
  }

  async version(): Promise<string> {
    const rows = await this.metadata('SELECT version() AS version');
    return `DuckDB ${textOr(rows[0]?.version) ?? ''}`.trim();
  }

  async list(): Promise<SourceObject[]> {
    const rows = await this.metadata(
      `SELECT t.table_schema AS schema, t.table_name AS name, t.table_type AS type, s.estimated_size AS estimate
       FROM information_schema.tables AS t
       LEFT JOIN duckdb_tables() AS s
         ON s.database_name = t.table_catalog AND s.schema_name = t.table_schema AND s.table_name = t.table_name
       WHERE t.table_catalog = $1 AND t.table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY CASE WHEN t.table_schema = $2 THEN 0 ELSE 1 END, t.table_schema, t.table_name`,
      [this.catalog, DEFAULT_SCHEMA],
    );
    return rows.map((row) => {
      const view = isView(row.type);
      return {
        schema: textOr(row.schema),
        name: String(row.name ?? ''),
        type: view ? ('view' as const) : ('table' as const),
        rowEstimate: view ? null : wholeNumber(row.estimate),
      };
    });
  }

  async keys(object: SourceObjectRef): Promise<string[][]> {
    const tables = await this.tableRows(object);
    if (tables.length === 0) throw objectMissing(object.name);
    if (isView(tables[0]?.table_type)) return [];
    const rows = await this.metadata(
      `SELECT constraint_column_names AS columns FROM duckdb_constraints()
       WHERE database_name = $1 AND schema_name = $2 AND table_name = $3
         AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
       ORDER BY CASE WHEN constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, constraint_index`,
      [this.catalog, this.schemaOf(object), object.name],
    );
    return rows
      .map((row) =>
        Array.isArray(row.columns)
          ? row.columns.filter((name): name is string => typeof name === 'string')
          : [],
      )
      .filter((columns) => columns.length > 0);
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    // DuckDB reports a prepared statement's columns without running it.
    const prepared = await this.connection.prepare(
      select.kind === 'query'
        ? `SELECT * FROM ${guard(select.sql, DUCKDB)}`
        : `SELECT * FROM ${quotePath(this.path(select.object), DUCKDB)}`,
    );
    const nullable = new Map<string, boolean>();
    if (select.kind === 'object')
      for (const row of await this.metadata(
        `SELECT column_name, is_nullable FROM duckdb_columns()
         WHERE database_name = $1 AND schema_name = $2 AND table_name = $3`,
        [this.catalog, this.schemaOf(select.object), select.object.name],
      ))
        nullable.set(String(row.column_name), row.is_nullable !== false);
    return Array.from({ length: prepared.columnCount }, (_unused, index) => {
      const name = prepared.columnName(index);
      // A query declares nothing, so the person choosing a key hears "maybe".
      return duckColumn(name, prepared.columnType(index), nullable.get(name) ?? true);
    });
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    const rows = await this.metadata(
      `SELECT estimated_size AS estimate FROM duckdb_tables()
       WHERE database_name = $1 AND schema_name = $2 AND table_name = $3`,
      [this.catalog, this.schemaOf(object), object.name],
    );
    return rows.length === 0 ? null : wholeNumber(rows[0]?.estimate);
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    _batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const names = columns.map((entry) => entry.column.name);
    const result = await this.connection.stream(
      selectSql(select, names, DUCKDB, (object) => this.path(object), limit),
    );
    // DuckDB hands over its own chunks, which the frame gathers into batches of the size asked for.
    for await (const chunk of result.yieldRows())
      yield chunk.map((values) =>
        Object.fromEntries(names.map((name, index) => [name, plainOfDuck(values[index])])),
      );
  }
}

/**
 * The catalog this source reads.  MotherDuck attaches a database under its own name, and a local
 * DuckDB file in tests is attached under the file's name, so the configured name wins when it is
 * there and the session's own default stands in when it isn't.
 */
async function catalogOf(connection: DuckDBConnection, database: string): Promise<string> {
  const reader = await connection.runAndReadAll(
    'SELECT database_name AS name FROM duckdb_databases() WHERE NOT internal',
  );
  const names = (reader.getRowObjectsJS() as Row[])
    .map((row) => textOr(row.name))
    .filter((name): name is string => name !== null && !INTERNAL_CATALOGS.has(name.toLowerCase()));
  const matched = names.find((name) => name.toLowerCase() === database.toLowerCase());
  if (matched) return matched;
  const current = await connection.runAndReadAll('SELECT current_database() AS name');
  return textOr((current.getRowObjectsJS() as Row[])[0]?.name) ?? names[0] ?? database;
}

/** What DuckDB's words say is missing: a table, view, or schema, or a column it can't bind. */
export function duckMissing(detail: string): Missing | null {
  if (/Catalog Error: (?:Table|View|Schema|Table Function) with name .* does not exist/i.test(detail))
    return { kind: 'object' };
  const column = /Referenced column "?([^"!]+?)"? not found/i.exec(detail);
  return column ? { kind: 'column', column: column[1]! } : null;
}

export function createMotherDuckConnector(options: MotherDuckConnectorOptions = {}): Connector {
  const connectionStringOf = options.connectionString ?? motherDuckConnectionString;
  const openInstance = options.openInstance ?? ((path: string) => DuckDBInstance.create(path));
  return makeWarehouseConnector(
    {
      kind: 'motherduck',
      // MotherDuck's extension picks its own endpoint, so a test starts at signing in.
      endpoint: (): Endpoint | null => null,
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'motherduck');
        const instance = await openInstance(connectionStringOf(settings, ctx.secrets));
        let connection: DuckDBConnection | undefined;
        try {
          connection = await instance.connect();
          return new DuckSession(instance, connection, await catalogOf(connection, settings.database));
        } catch (error) {
          try {
            connection?.disconnectSync();
            instance.closeSync();
          } catch {
            // Closing is best effort: the error that stopped the opening is the one worth keeping.
          }
          throw error;
        }
      },
      missing: duckMissing,
    },
    options.network ?? nodeNetwork,
  );
}

export const motherDuckConnector: Connector = createMotherDuckConnector();
registerConnector(motherDuckConnector);

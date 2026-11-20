import snowflake from 'snowflake-sdk';
import type {
  SourceConnection,
  SourceObject,
  SourceObjectRef,
  SourceSecrets,
  SourceSelect,
} from '@riosoma/contracts';
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
import { guard, quotePath, selectSql, SNOWFLAKE } from '@riosoma/connectors/internal/warehouses/sql.js';
import {
  exactInteger,
  ownSchemaFirst,
  textOr,
  wholeNumber,
} from '@riosoma/connectors/internal/warehouses/values.js';

/**
 * Snowflake.  One account, one user, one warehouse, and key-pair or password authentication.
 * Every name the connector writes is double-quoted, so mixed-case and odd names resolve exactly,
 * and the catalog it reads is the configured database's own `INFORMATION_SCHEMA`.  Numbers arrive
 * as the source's own digits, and dates and timestamps as the driver's epoch-based `Date`s, which
 * no account's output formats can change.
 */

type SnowflakeSettings = Extract<SourceConnection, { kind: 'snowflake' }>;

const DEFAULT_SCHEMA = 'PUBLIC';
const APPLICATION = 'riosoma';
/** Snowflake's longest text, which a VARCHAR declared without a length reports as its length. */
const TEXT_MAXIMUM = 16_777_216;

export type Bind = string | number;

/** The driver options this connector sets, a subset of `snowflake-sdk`'s own. */
export interface SnowflakeOptions {
  account: string;
  username: string;
  password?: string;
  authenticator?: string;
  privateKey?: string;
  privateKeyPass?: string;
  warehouse: string;
  database: string;
  schema?: string;
  role?: string;
  application: string;
  rowMode: 'object';
  fetchAsString: ('Number' | 'JSON')[];
}

/** The slice of the driver this connector uses, so a test can stand in a fake of the same shape. */
export interface SnowflakeDriver {
  createConnection(options: SnowflakeOptions): SnowflakeConnection;
}

export interface SnowflakeConnection {
  connectAsync(): Promise<unknown>;
  execute(options: SnowflakeExecute): SnowflakeStatement;
  destroy(done: (error?: unknown) => void): void;
}

export interface SnowflakeExecute {
  sqlText: string;
  binds?: Bind[];
  streamResult?: boolean;
  describeOnly?: boolean;
  complete: (error: unknown, statement: SnowflakeStatement, rows?: Row[]) => void;
}

export interface SnowflakeStatement {
  getColumns(): SnowflakeColumn[] | undefined;
  streamRows(): SnowflakeRowStream;
  cancel(): void;
}

/** A streamed result.  Destroying it ends a read in progress, as a Node stream's destroy does. */
export interface SnowflakeRowStream extends AsyncIterable<Row> {
  destroy(error?: Error): void;
}

export interface SnowflakeColumn {
  getName(): string;
  getType(): string;
  getPrecision(): number;
  getScale(): number;
  isNullable(): boolean;
}

let quieted = false;

/** The driver logs to a file in the working directory, and to the console, unless it's given a logger. */
function quietDriver(): void {
  if (quieted) return;
  quieted = true;
  const silent = () => undefined;
  snowflake.configure({
    customLogger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
  });
}

const realDriver: SnowflakeDriver = {
  createConnection(options) {
    quietDriver();
    const connection = snowflake.createConnection(options);
    return {
      connectAsync: () => connection.connectAsync(),
      execute: (execute) =>
        connection.execute({
          sqlText: execute.sqlText,
          binds: execute.binds,
          streamResult: execute.streamResult,
          describeOnly: execute.describeOnly,
          complete: (error, statement, rows) => execute.complete(error, statement, rows),
        }),
      destroy: (done) => connection.destroy((error) => done(error)),
    };
  },
};

/**
 * The account identifier the driver expects.  People often paste the whole address, so a scheme,
 * a path, and the `snowflakecomputing` domain come off.
 */
export function accountOf(account: string): string {
  return account
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.snowflakecomputing\.(?:com|cn)$/i, '');
}

/** The host the driver connects to for an account, worked out the way the driver does. */
export function snowflakeHost(account: string): string {
  const identifier = accountOf(account).toLowerCase();
  const dot = identifier.indexOf('.');
  if (dot < 0) return `${identifier}.snowflakecomputing.com`;
  const name = identifier.slice(0, dot);
  const region = identifier.slice(dot + 1);
  if (region === 'us-west-2') return `${name}.snowflakecomputing.com`;
  return `${name}.${region}.snowflakecomputing.${region.startsWith('cn-') ? 'cn' : 'com'}`;
}

/**
 * The name Snowflake stores for one an admin typed.  An unquoted name is stored in upper case, and
 * a quoted one exactly as written inside its quotes, which is how the driver's own settings read.
 */
export function storedName(typed: string): string {
  const text = typed.trim();
  if (/^"(?:[^"]|"")+"$/.test(text)) return text.slice(1, -1).replaceAll('""', '"');
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(text) ? text.toUpperCase() : text;
}

/** The settings the driver gets, with the secret this connection's authentication asks for. */
export function driverOptionsFor(settings: SnowflakeSettings, secrets: SourceSecrets): SnowflakeOptions {
  const shared: SnowflakeOptions = {
    account: accountOf(settings.account),
    username: settings.user,
    warehouse: settings.warehouse,
    database: settings.database,
    application: APPLICATION,
    rowMode: 'object',
    // The source's own digits for numbers, and JSON text the driver doesn't try to evaluate.
    fetchAsString: ['Number', 'JSON'],
    ...(settings.schema === undefined ? {} : { schema: settings.schema }),
    ...(settings.role === undefined ? {} : { role: settings.role }),
  };
  if (settings.auth === 'password') return { ...shared, password: secretOf(secrets, 'password') };
  const passphrase = secrets.privateKeyPassphrase;
  return {
    ...shared,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: secretOf(secrets, 'privateKeyPem'),
    ...(passphrase === undefined ? {} : { privateKeyPass: passphrase }),
  };
}

/**
 * What every session sets first: UTC, a time format with every digit, JSON a parser can read, one
 * statement per request, and a statement timeout that matches the call's own budget.
 */
function sessionSettings(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return (
    "ALTER SESSION SET TIMEZONE = 'UTC', TIME_OUTPUT_FORMAT = 'HH24:MI:SS.FF9', STRICT_JSON_OUTPUT = TRUE, " +
    `MULTI_STATEMENT_COUNT = 1, STATEMENT_TIMEOUT_IN_SECONDS = ${seconds}`
  );
}

/** What a Snowflake type name comes down to.  A number with no digits after the point is an integer. */
export function snowflakeTypeClass(type: string, scale?: number | null): TypeClass {
  switch (type.trim().toUpperCase()) {
    case 'NUMBER':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'TINYINT':
    case 'BYTEINT':
    case 'FIXED':
      return (scale ?? 0) > 0 ? 'decimal' : 'integer';
    case 'FLOAT':
    case 'FLOAT4':
    case 'FLOAT8':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'REAL':
      return 'float';
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'TIME':
      return 'time';
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
      return 'timestamp';
    case 'TEXT':
    case 'VARCHAR':
    case 'STRING':
    case 'CHAR':
    case 'CHARACTER':
    case 'NCHAR':
    case 'NVARCHAR':
      return 'text';
    // Semi-structured values are held as their JSON text.
    case 'VARIANT':
    case 'OBJECT':
    case 'ARRAY':
    case 'MAP':
      return 'json';
    case 'BINARY':
    case 'VARBINARY':
      return 'binary';
    // Geography, geometry, vectors, and anything new are named, not guessed at.
    default:
      return 'unknown';
  }
}

const FIXED_POINT = new Set(['NUMBER', 'DECIMAL', 'NUMERIC', 'FIXED']);
/** Snowflake's own names for the types the driver reports under internal ones. */
const DRIVER_NAMES: Record<string, string> = { FIXED: 'NUMBER', REAL: 'FLOAT', TEXT: 'VARCHAR' };

/** A column as the database's `INFORMATION_SCHEMA.COLUMNS` describes it. */
function catalogColumn(row: Row): Described {
  const type = String(row.DATA_TYPE ?? '').toUpperCase();
  const precision = wholeNumber(row.NUMERIC_PRECISION);
  const scale = wholeNumber(row.NUMERIC_SCALE);
  const length = wholeNumber(row.CHARACTER_MAXIMUM_LENGTH);
  const kind = snowflakeTypeClass(type, scale);
  const sourceType = FIXED_POINT.has(type)
    ? sized('NUMBER', precision, scale)
    : kind === 'text'
      ? sized('VARCHAR', length)
      : type;
  return describeColumn({
    name: String(row.COLUMN_NAME ?? ''),
    sourceType,
    nullable: String(row.IS_NULLABLE ?? 'YES').toUpperCase() !== 'NO',
    kind,
    scale,
    // A VARCHAR declared without a length reports the longest there is, which declares nothing.
    length: length !== null && length < TEXT_MAXIMUM ? length : null,
  });
}

/** A query's column as the driver describes it without running the query. */
function driverColumn(column: SnowflakeColumn): Described {
  const type = column.getType().toUpperCase();
  const scale = column.getScale();
  return describeColumn({
    name: column.getName(),
    sourceType:
      type === 'FIXED' ? sized('NUMBER', column.getPrecision(), scale) : (DRIVER_NAMES[type] ?? type),
    nullable: column.isNullable(),
    kind: snowflakeTypeClass(type, scale),
    scale,
  });
}

function isView(type: unknown): boolean {
  return String(type ?? '')
    .toUpperCase()
    .includes('VIEW');
}

/** Floats arrive as text, including Snowflake's words for the values a double has no digits for. */
function floatOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (/^-inf/i.test(text)) return -Infinity;
  if (/^\+?inf/i.test(text)) return Infinity;
  return Number(text);
}

/** A row's values unwrapped by class: exact digits, instants, and times without trailing zeros. */
function plainRow(raw: Row, columns: readonly Described[]): Row {
  const row: Row = {};
  for (const { column, kind } of columns) {
    const value = raw[column.name];
    if (value === null || value === undefined) row[column.name] = null;
    else if (kind === 'integer' && (typeof value === 'string' || typeof value === 'bigint'))
      row[column.name] = exactInteger(value);
    else if (kind === 'float') row[column.name] = floatOf(value);
    else if (kind === 'time' && typeof value === 'string')
      row[column.name] = value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    else row[column.name] = value;
  }
  return row;
}

/** Primary or unique keys from `SHOW ... KEYS`, one list per constraint, each in its declared order. */
function keyGroups(rows: readonly Row[]): string[][] {
  const groups = new Map<string, { position: number; column: string }[]>();
  for (const row of rows) {
    const column = textOr(row.column_name);
    if (column === null) continue;
    const name = textOr(row.constraint_name) ?? '';
    const group = groups.get(name) ?? [];
    group.push({ position: wholeNumber(row.key_sequence) ?? 0, column });
    groups.set(name, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) =>
      group.sort((left, right) => left.position - right.position).map((entry) => entry.column),
    );
}

class SnowflakeSession implements WarehouseSession {
  private readonly statements = new Set<SnowflakeStatement>();
  private readonly streams = new Set<SnowflakeRowStream>();
  private closing: Promise<void> | undefined;
  private readonly database: string;
  private readonly schema: string;
  private readonly warehouse: string;

  constructor(
    private readonly connection: SnowflakeConnection,
    settings: SnowflakeSettings,
  ) {
    this.database = storedName(settings.database);
    this.schema = settings.schema === undefined ? DEFAULT_SCHEMA : storedName(settings.schema);
    this.warehouse = storedName(settings.warehouse);
  }

  /** Runs one statement and waits for it to finish.  A streamed statement's rows come afterward. */
  run(
    sqlText: string,
    options: { binds?: Bind[]; streamResult?: boolean; describeOnly?: boolean } = {},
  ): Promise<{ statement: SnowflakeStatement; rows: Row[] }> {
    if (this.closing) return Promise.reject(new ConnectorError(KEYS.read, 'the session was closed'));
    return new Promise((resolve, reject) => {
      let finished = false;
      const statement = this.connection.execute({
        sqlText,
        ...options,
        complete: (error, executed, rows) => {
          finished = true;
          this.statements.delete(executed);
          if (error) reject(error);
          else resolve({ statement: executed, rows: rows ?? [] });
        },
      });
      if (!finished) this.statements.add(statement);
    });
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      for (const stream of this.streams)
        stream.destroy(new ConnectorError(KEYS.read, 'the session was closed'));
      for (const statement of this.statements) {
        try {
          statement.cancel();
        } catch {
          // A statement that already finished has nothing to cancel.
        }
      }
      this.streams.clear();
      this.statements.clear();
      try {
        this.connection.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
    return this.closing;
  }

  private schemaOf(object: SourceObjectRef): string {
    return object.schema ? object.schema : this.schema;
  }

  private path(object: SourceObjectRef): string[] {
    return [this.database, this.schemaOf(object), object.name];
  }

  private catalog(view: 'TABLES' | 'COLUMNS'): string {
    return quotePath([this.database, 'INFORMATION_SCHEMA', view], SNOWFLAKE);
  }

  private async tableRow(object: SourceObjectRef): Promise<Row | undefined> {
    const { rows } = await this.run(
      `SELECT "TABLE_TYPE", "ROW_COUNT" FROM ${this.catalog('TABLES')} WHERE "TABLE_SCHEMA" = ? AND "TABLE_NAME" = ?`,
      { binds: [this.schemaOf(object), object.name] },
    );
    return rows[0];
  }

  async version(): Promise<string> {
    const { rows } = await this.run(
      'SELECT CURRENT_VERSION() AS "version", CURRENT_DATABASE() AS "database", CURRENT_WAREHOUSE() AS "warehouse"',
    );
    const row = rows[0] ?? {};
    // Signing in succeeds without either, and then every catalog query fails.
    if (textOr(row.database) === null)
      throw new Error(`the database ${this.database} doesn't exist, or this role can't use it`);
    if (textOr(row.warehouse) === null)
      throw new Error(`the warehouse ${this.warehouse} doesn't exist, or this role can't use it`);
    return `Snowflake ${String(row.version ?? '').trim()}`.trim();
  }

  async list(): Promise<SourceObject[]> {
    const { rows } = await this.run(
      `SELECT "TABLE_SCHEMA", "TABLE_NAME", "TABLE_TYPE", "ROW_COUNT" FROM ${this.catalog('TABLES')}
       WHERE "TABLE_SCHEMA" <> 'INFORMATION_SCHEMA' ORDER BY "TABLE_SCHEMA", "TABLE_NAME"`,
    );
    const objects = rows.map((row) => {
      const view = isView(row.TABLE_TYPE);
      return {
        schema: textOr(row.TABLE_SCHEMA),
        name: String(row.TABLE_NAME ?? ''),
        type: view ? ('view' as const) : ('table' as const),
        rowEstimate: view ? null : wholeNumber(row.ROW_COUNT),
      };
    });
    return ownSchemaFirst(objects, this.schema);
  }

  async keys(object: SourceObjectRef): Promise<string[][]> {
    const table = await this.tableRow(object);
    if (!table) throw objectMissing(object.name);
    if (isView(table.TABLE_TYPE)) return [];
    // Snowflake records primary and unique keys without enforcing them, which is all a candidate is.
    const name = quotePath(this.path(object), SNOWFLAKE);
    const primary = await this.run(`SHOW PRIMARY KEYS IN TABLE ${name}`);
    const unique = await this.run(`SHOW UNIQUE KEYS IN TABLE ${name}`);
    return [...keyGroups(primary.rows), ...keyGroups(unique.rows)];
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'query') {
      const { statement } = await this.run(`SELECT * FROM ${guard(select.sql, SNOWFLAKE)}`, {
        describeOnly: true,
      });
      return (statement.getColumns() ?? []).map(driverColumn);
    }
    const { rows } = await this.run(
      `SELECT "COLUMN_NAME", "DATA_TYPE", "IS_NULLABLE", "NUMERIC_PRECISION", "NUMERIC_SCALE", "CHARACTER_MAXIMUM_LENGTH"
       FROM ${this.catalog('COLUMNS')} WHERE "TABLE_SCHEMA" = ? AND "TABLE_NAME" = ? ORDER BY "ORDINAL_POSITION"`,
      { binds: [this.schemaOf(select.object), select.object.name] },
    );
    if (rows.length === 0) throw objectMissing(select.object.name);
    return rows.map(catalogColumn);
  }

  async estimate(object: SourceObjectRef): Promise<number | null> {
    const table = await this.tableRow(object);
    return table && !isView(table.TABLE_TYPE) ? wholeNumber(table.ROW_COUNT) : null;
  }

  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const sql = selectSql(
      select,
      columns.map((entry) => entry.column.name),
      SNOWFLAKE,
      (object) => this.path(object),
      limit,
    );
    const { statement } = await this.run(sql, { streamResult: true });
    const stream = statement.streamRows();
    this.streams.add(stream);
    try {
      let chunk: Row[] = [];
      for await (const raw of stream) {
        chunk.push(plainRow(raw, columns));
        if (chunk.length >= batchSize) {
          yield chunk;
          chunk = [];
        }
      }
      if (chunk.length > 0) yield chunk;
    } finally {
      this.streams.delete(stream);
      stream.destroy();
    }
  }
}

/** What Snowflake's words say is missing: an object it can't see, or a name it can't bind. */
export function snowflakeMissing(detail: string): Missing | null {
  if (/does not exist or not authorized/i.test(detail)) return { kind: 'object' };
  const column = /invalid identifier '("?)(.+?)\1'/i.exec(detail);
  return column ? { kind: 'column', column: column[2]! } : null;
}

export interface SnowflakeConnectorOptions {
  /** Observes the actual driver boundary during a contract run */
  observeDriver?: (driver: SnowflakeDriver) => SnowflakeDriver;
  /** Stands in for `snowflake-sdk`, so tests can supply a fake */
  driver?: SnowflakeDriver;
  /** Stands in for the network checks of a connection test */
  network?: Network;
}

export function createSnowflakeConnector(options: SnowflakeConnectorOptions = {}): Connector {
  const driver = options.observeDriver?.(options.driver ?? realDriver) ?? options.driver ?? realDriver;
  return makeWarehouseConnector(
    {
      kind: 'snowflake',
      endpoint(ctx: ConnectorContext): Endpoint | null {
        return ctx.connection.kind === 'snowflake'
          ? { host: snowflakeHost(ctx.connection.account), port: 443 }
          : null;
      },
      async open(ctx: ConnectorContext): Promise<WarehouseSession> {
        const settings = connectionOf(ctx, 'snowflake');
        const connection = driver.createConnection(driverOptionsFor(settings, ctx.secrets));
        const session = new SnowflakeSession(connection, settings);
        try {
          await connection.connectAsync();
          await session.run(sessionSettings(positive(ctx.timeoutMs, 30000)));
          return session;
        } catch (error) {
          void session.close();
          throw error;
        }
      },
      missing: snowflakeMissing,
    },
    options.network ?? nodeNetwork,
  );
}

export const snowflakeConnector: Connector = createSnowflakeConnector();

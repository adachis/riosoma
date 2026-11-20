/**
 * What the four warehouse connectors share: the query guard, quoting, scrubbing, type mapping,
 * value conversion, and the frame that runs every call.  The frame is driven here by a fake
 * warehouse and a fake network, so each behavior shows up once, apart from any driver.
 */
import { FieldOptions, type SourceSelect } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { sourceKey } from '../registry.js';
import { ConnectorError, type ConnectorContext, type SourceRow } from '../types.js';
import { column } from '../values.js';
import { failure, scrubDetail } from './errors.js';
import {
  hostAndPort,
  httpAddress,
  makeWarehouseConnector,
  type Endpoint,
  type Network,
  type Row,
  type Warehouse,
  type WarehouseSession,
} from './frame.js';
import { describeColumn, type ColumnFacts, type Described } from './mapping.js';
import {
  BIGQUERY,
  CLICKHOUSE,
  DATABRICKS,
  DRUID,
  DUCKDB,
  guard,
  literal,
  quotePath,
  SNOWFLAKE,
  TRINO,
  type Dialect,
} from './sql.js';
import { cellOf, keyPartOf, ownSchemaFirst } from './values.js';
import { serviceAccount } from '../service-account.test-helpers.js';

function thrown(action: () => unknown): ConnectorError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error('expected a connector error');
}

const DIALECTS: Array<[string, Dialect]> = [
  ['snowflake', SNOWFLAKE],
  ['bigquery', BIGQUERY],
  ['databricks', DATABRICKS],
  ['duckdb', DUCKDB],
  ['clickhouse', CLICKHOUSE],
  ['trino', TRINO],
  ['druid', DRUID],
];

describe.each(DIALECTS)('the %s query guard', (_name, dialect) => {
  it.each([
    'SELECT 1; DELETE FROM records',
    'SELECT 1) q; DELETE FROM records; SELECT * FROM (SELECT 1',
    'SELECT (1',
    'SELECT 1)',
    "SELECT 'unfinished",
    'SELECT "unfinished',
    'SELECT 1 /* unfinished',
    'SELECT 1 -- comment\r) q; DELETE FROM records',
    'SELECT 1 /* outer /* inner */ ; DELETE FROM records */',
    "SELECT 'it\\'s'; DELETE FROM records; --'",
    '',
    ' ; ',
    'SELECT 1\0',
  ])('refuses %j', (sql) => {
    const error = thrown(() => guard(sql, dialect));
    expect(error.messageKey).toBe('sources.sync.read');
    expect(error.detail).toMatch(/^the query guard refused this query: /);
  });

  it('wraps a query that stays inside its parentheses', () => {
    expect(guard("SELECT ';)' AS value, (1+2) AS n -- tail", dialect)).toBe(
      "(\nSELECT ';)' AS value, (1+2) AS n -- tail\n) AS q",
    );
    expect(guard('SELECT \'it\'\'s\' AS "odd ""name"', dialect)).toContain("'it''s'");
  });

  it('drops one trailing semicolon, which is how people paste a query', () => {
    expect(guard('  SELECT 1 AS one;  ', dialect)).toBe('(\nSELECT 1 AS one\n) AS q');
  });
});

describe('what each warehouse reads differently', () => {
  it('reads Snowflake line comments and dollar strings as Snowflake does', () => {
    // Without `//` as a comment, the quote after it would hide the statement on the next line.
    expect(() => guard("SELECT 1 // '\n; DELETE FROM records; --'", SNOWFLAKE)).toThrow(ConnectorError);
    expect(guard('SELECT 1 AS n // ) ; not a statement', SNOWFLAKE)).toContain(
      '// ) ; not a statement\n) AS q',
    );
    expect(guard('SELECT $$ ; ) $$ AS body', SNOWFLAKE)).toContain('$$ ; ) $$');
    expect(() => guard('SELECT $$unfinished', SNOWFLAKE)).toThrow(ConnectorError);
    // A dollar sign inside a name is part of the name.
    expect(guard('SELECT price$$ FROM t', SNOWFLAKE)).toContain('price$$');
  });

  it('reads BigQuery comments and quoting as BigQuery does', () => {
    expect(() => guard("SELECT 1 # '\n; DELETE FROM records; --'", BIGQUERY)).toThrow(ConnectorError);
    expect(guard('SELECT `odd;name` FROM t', BIGQUERY)).toContain('`odd;name`');
    // A triple-quoted string ends where the guard can't follow, so it's refused.
    expect(() => guard("SELECT '''a'b''' ; DELETE FROM records; SELECT ''", BIGQUERY)).toThrow(
      ConnectorError,
    );
  });

  it('reads Databricks quoting as Databricks does', () => {
    expect(guard('SELECT `odd;name` FROM t', DATABRICKS)).toContain('`odd;name`');
    expect(() => guard('SELECT """x"""', DATABRICKS)).toThrow(ConnectorError);
  });

  it('reads DuckDB dollar strings, and a dollar sign inside a name as part of the name', () => {
    expect(guard('SELECT $tag$ ; ) $tag$ AS body', DUCKDB)).toContain('$tag$ ; ) $tag$');
    expect(() => guard('SELECT 1 AS a$x$ ; DELETE FROM records; SELECT 1 AS b$x$', DUCKDB)).toThrow(
      ConnectorError,
    );
    // Two slashes divide in DuckDB rather than starting a comment.
    expect(guard('SELECT 7 // 2 AS half', DUCKDB)).toContain('7 // 2');
  });

  it('reads ClickHouse comments, heredocs, and quoted names as ClickHouse does', () => {
    // `#` and a space start a comment, so the quote after one would hide the statement below it.
    expect(() => guard("SELECT 1 # '\n; DELETE FROM records; --'", CLICKHOUSE)).toThrow(ConnectorError);
    expect(guard('SELECT $$ ; ) $$ AS body, $h$ ( $h$ AS other', CLICKHOUSE)).toContain('$h$ ( $h$');
    expect(guard('SELECT `odd;name`, "also;odd" FROM t', CLICKHOUSE)).toContain('`odd;name`');
    // A backslash escapes inside a ClickHouse string, which the guard won't follow.
    expect(() => guard("SELECT 'it\\'s'", CLICKHOUSE)).toThrow(ConnectorError);
  });

  it('reads Trino and Druid quoting, with Druid’s own comments', () => {
    expect(guard('SELECT "odd;name" FROM t', TRINO)).toContain('"odd;name"');
    expect(() => guard("SELECT 1 // '\n; DELETE FROM records; --'", DRUID)).toThrow(ConnectorError);
    expect(guard('SELECT 1 AS n // ) ; not a statement', DRUID)).toContain('// ) ; not a statement\n) AS q');
    expect(() => guard('SELECT `odd;name` FROM t', TRINO)).toThrow(ConnectorError);
  });

  it('treats a backtick as an ordinary character where it quotes nothing', () => {
    expect(() => guard('SELECT `odd;name` FROM t', SNOWFLAKE)).toThrow(ConnectorError);
    expect(() => guard('SELECT `odd;name` FROM t', DUCKDB)).toThrow(ConnectorError);
  });
});

describe('addresses people paste', () => {
  it('finds the host and port, and leaves the scheme, path, and any credentials out', () => {
    expect(hostAndPort('clickhouse.internal', 8123)).toEqual({ host: 'clickhouse.internal', port: 8123 });
    expect(hostAndPort(' https://abc.clickhouse.cloud:8443/play ', 443)).toEqual({
      host: 'abc.clickhouse.cloud',
      port: 8443,
    });
    expect(hostAndPort('https://someone:secret@trino.example.com/ui', 443)).toEqual({
      host: 'trino.example.com',
      port: 443,
    });
    expect(hostAndPort('druid.example.com:9088', 8888)).toEqual({ host: 'druid.example.com', port: 9088 });
    expect(hostAndPort('[2001:db8::1]:8443', 443)).toEqual({ host: '2001:db8::1', port: 8443 });
    expect(hostAndPort('2001:db8::1', 443)).toEqual({ host: '2001:db8::1', port: 443 });
  });

  it('writes an HTTP address, with an IPv6 host in brackets', () => {
    expect(httpAddress({ host: 'db.example.com', port: 8443 }, true)).toBe('https://db.example.com:8443');
    expect(httpAddress({ host: '::1', port: 8123 }, false)).toBe('http://[::1]:8123');
  });
});

describe('quoting names', () => {
  it('quotes every name, doubling or escaping the quote inside it', () => {
    expect(SNOWFLAKE.quote('Mixed "Case"')).toBe('"Mixed ""Case"""');
    expect(SNOWFLAKE.quote('ORDERS')).toBe('"ORDERS"');
    expect(DUCKDB.quote('a"b')).toBe('"a""b"');
    expect(DATABRICKS.quote('a`b')).toBe('`a``b`');
    expect(BIGQUERY.quote('a`b\\c\nd')).toBe('`a\\`b\\\\c\\u000ad`');
    expect(CLICKHOUSE.quote('a`b\\c')).toBe('`a``b\\\\c`');
    expect(TRINO.quote('a"b')).toBe('"a""b"');
    expect(DRUID.quote('a"b')).toBe('"a""b"');
    expect(literal("o'brien")).toBe("'o''brien'");
    expect(() => literal('a\0b')).toThrow(ConnectorError);
    expect(quotePath(['SALES', 'we"ird', 'a table'], SNOWFLAKE)).toBe('"SALES"."we""ird"."a table"');
    expect(quotePath(['my-project', 'events', 'page views'], BIGQUERY)).toBe(
      '`my-project`.`events`.`page views`',
    );
  });
});

const ctxWith = (
  secrets: ConnectorContext['secrets'],
  extra: Partial<ConnectorContext> = {},
): ConnectorContext => ({
  connection: { kind: 'motherduck', database: 'analytics' },
  secrets,
  ...extra,
});

describe('scrubbing driver errors', () => {
  it('scrubs stored secrets, their encoded forms, and every part of a JSON key', () => {
    const key = JSON.stringify(
      serviceAccount({
        project_id: 'placeholder-project',
        private_key_id: 'placeholder-key-id',
        private_key: 'placeholder-private-key',
        client_email: 'reader@placeholder-project.example',
      }),
    );
    const ctx = ctxWith({ token: 'placeholder/token+value', serviceAccountJson: key });
    const error = new Error(
      'refused placeholder/token+value and placeholder%2Ftoken%2Bvalue for reader@placeholder-project.example with placeholder-key-id',
      { cause: new Error('while reading placeholder-project') },
    );
    const detail = scrubDetail(error, ctx) ?? '';
    expect(detail).not.toMatch(/placeholder/);
    expect(detail).toContain('[redacted]');
    expect(detail).toContain('while reading');
  });

  it.each([
    [
      'a private key',
      ['-----BEGIN', 'PRIVATE KEY-----\nplaceholder\n-----END', 'PRIVATE KEY-----'].join(' '),
    ],
    ['a bearer token', 'Authorization: Bearer placeholder.token'],
    ['a token in a connection string', 'md:analytics?motherduck_token=placeholder-value'],
    ['a password setting', 'password=placeholder'],
    ['a JSON credential member', '{"private_key": "placeholder"}'],
    ['an address', 'https://placeholder.example/path?x=1'],
  ])('scrubs %s', (_shape, text) => {
    expect(scrubDetail(new Error(`failed: ${text}`), ctxWith({}))).not.toMatch(/placeholder/);
  });

  it("keeps the driver's code and trims an essay", () => {
    expect(scrubDetail(Object.assign(new Error('refused'), { code: 390100 }), ctxWith({}))).toBe(
      'refused (390100)',
    );
    const long = scrubDetail(new Error('x'.repeat(2_000)), ctxWith({})) ?? '';
    expect(long).toHaveLength(1_001);
    expect(long.endsWith('…')).toBe(true);
  });

  it('names what a failure was, the way the SQL connectors do', () => {
    const select: SourceSelect = { kind: 'object', object: { schema: 'main', name: 'orders' } };
    const never = () => null;
    expect(
      failure(new ConnectorError('sources.test.timeout'), ctxWith({}, { timeoutMs: 20 }), select, never),
    ).toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 20 ms to answer',
    });
    expect(
      failure(
        new ConnectorError('sources.sync.read'),
        ctxWith({}, { signal: AbortSignal.abort() }),
        select,
        never,
      ),
    ).toMatchObject({ messageKey: 'sources.sync.read', detail: 'the call was stopped before it finished' });
    const missing = () => ({ kind: 'object' as const });
    expect(failure(new Error('gone'), ctxWith({}), select, missing)).toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'orders' },
    });
    expect(
      failure(new Error('gone'), ctxWith({}), { kind: 'query', sql: 'SELECT 1' }, missing),
    ).toMatchObject({
      params: { object: '' },
    });
  });
});

const TEXT_ALTERNATIVES = ['longText', 'email', 'url', 'phone', 'singleSelect'];
// A number can also be money or a percentage, which hold the same values.
const NUMBER_ALTERNATIVES = ['currency', 'percent', 'text', 'longText'];

describe('type mapping', () => {
  const facts = (extra: Partial<ColumnFacts> & Pick<ColumnFacts, 'kind'>): ColumnFacts => ({
    name: 'value',
    sourceType: 'TYPE',
    nullable: true,
    ...extra,
  });

  it.each<
    [
      string,
      Partial<ColumnFacts> & Pick<ColumnFacts, 'kind'>,
      string | null,
      Record<string, unknown>,
      string[],
    ]
  >([
    ['an integer', { kind: 'integer' }, 'number', { precision: 0 }, NUMBER_ALTERNATIVES],
    ['a decimal', { kind: 'decimal', scale: 2 }, 'number', { precision: 2 }, NUMBER_ALTERNATIVES],
    ['a wide decimal', { kind: 'decimal', scale: 12 }, 'number', { precision: 8 }, NUMBER_ALTERNATIVES],
    [
      'a decimal of no declared scale',
      { kind: 'decimal' },
      'number',
      { precision: null },
      NUMBER_ALTERNATIVES,
    ],
    ['a float', { kind: 'float' }, 'number', { precision: null }, NUMBER_ALTERNATIVES],
    ['a boolean', { kind: 'boolean' }, 'checkbox', {}, ['text', 'longText']],
    ['a date', { kind: 'date' }, 'date', {}, ['text', 'longText']],
    [
      'a timestamp',
      { kind: 'timestamp' },
      'date',
      { includeTime: true, timeZone: 'UTC' },
      ['text', 'longText'],
    ],
    ['a time', { kind: 'time' }, 'text', {}, TEXT_ALTERNATIVES],
    ['text', { kind: 'text' }, 'text', {}, TEXT_ALTERNATIVES],
    ['long text', { kind: 'text', length: 1_001 }, 'longText', {}, []],
    ['JSON', { kind: 'json' }, 'longText', {}, []],
    ['bytes', { kind: 'binary' }, null, {}, []],
    ['geography', { kind: 'unknown' }, null, {}, []],
  ])('maps %s', (_name, extra, type, options, alternatives) => {
    const { column: mapped } = describeColumn(facts(extra));
    expect(mapped.suggested?.type ?? null).toBe(type);
    expect(mapped.alternatives).toEqual(alternatives);
    if (type) {
      expect(mapped.suggested?.options).toEqual(options);
      expect(
        FieldOptions[type as keyof typeof FieldOptions].safeParse(mapped.suggested?.options).success,
      ).toBe(true);
    }
  });

  it.each<[Partial<ColumnFacts> & Pick<ColumnFacts, 'kind'>, string]>([
    [{ kind: 'integer' }, 'bigint'],
    [{ kind: 'decimal', scale: 4 }, 'numeric(30,4)'],
    [{ kind: 'float' }, 'double precision'],
    [{ kind: 'boolean' }, 'boolean'],
    [{ kind: 'date' }, 'date'],
    [{ kind: 'timestamp' }, 'timestamp with time zone'],
    [{ kind: 'time' }, 'time'],
    [{ kind: 'text' }, 'text'],
    [{ kind: 'text', length: 1_001 }, 'varchar(1001)'],
    [{ kind: 'json' }, 'jsonb'],
    [{ kind: 'binary' }, 'bytea'],
  ])('suggests what the SQL connectors suggest for %j', (extra, postgresType) => {
    const warehouse = describeColumn(facts(extra)).column;
    const sql = column({ name: 'value', type: postgresType, nullable: true }, 'postgres');
    expect({ suggested: warehouse.suggested, alternatives: warehouse.alternatives }).toEqual({
      suggested: sql.suggested,
      alternatives: sql.alternatives,
    });
  });

  it('offers an enumeration as a single select with its labels as choices', () => {
    const labels = ['sad', 'ok', 'happy'];
    const mapped = describeColumn(facts({ kind: 'text', sourceType: "ENUM('sad', 'ok', 'happy')", labels }));
    const sql = column({ name: 'value', type: 'enum', nullable: true, labels }, 'postgres');
    expect(mapped.column).toEqual({ ...sql, sourceType: "ENUM('sad', 'ok', 'happy')" });
    expect(
      FieldOptions.singleSelect.parse(mapped.column.suggested?.options).choices.map((c) => c.name),
    ).toEqual(labels);
  });
});

const of = (kind: ColumnFacts['kind'], extra: Partial<ColumnFacts> = {}): Described =>
  describeColumn({ name: 'value', sourceType: 'TYPE', nullable: true, kind, ...extra });

describe('values in Riosoma forms', () => {
  it('reads numbers, and empties the ones a number field has no form for', () => {
    expect(cellOf('12.50', 'number', of('decimal', { scale: 2 }))).toBe(12.5);
    expect(cellOf(7n, 'number', of('integer'))).toBe(7);
    expect(cellOf(Number.NaN, 'number', of('float'))).toBeNull();
    expect(cellOf('-inf', 'number', of('float'))).toBeNull();
    expect(thrown(() => cellOf('twelve', 'number', of('decimal'))).messageKey).toBe('sources.sync.read');
  });

  it('reads a column of numbers as money or a percentage when its field is one', () => {
    expect(cellOf('929.19', 'currency', of('decimal', { scale: 2 }))).toBe(929.19);
    expect(cellOf('65000000', 'currency', of('integer'))).toBe(65_000_000);
    expect(cellOf('0.2500', 'percent', of('decimal', { scale: 4 }))).toBe(0.25);
    expect(cellOf(null, 'currency', of('decimal', { scale: 2 }))).toBeNull();
    expect(thrown(() => cellOf('twelve', 'currency', of('decimal'))).messageKey).toBe('sources.sync.read');
  });

  it('reads checkboxes the way the SQL connectors do', () => {
    for (const truthy of [true, 1, '1', 't', 'true', 'TRUE', Buffer.from([1])])
      expect(cellOf(truthy, 'checkbox', of('boolean'))).toBe(true);
    for (const falsy of [false, 0, '0', 'f', 'no', Buffer.from([0])])
      expect(cellOf(falsy, 'checkbox', of('boolean'))).toBe(false);
  });

  it('writes a date as a day and a timestamp as an instant in UTC', () => {
    expect(cellOf(new Date(Date.UTC(2024, 2, 5)), 'date', of('date'))).toBe('2024-03-05');
    expect(cellOf('2024-03-05', 'date', of('date'))).toBe('2024-03-05');
    expect(cellOf('2024-03-05 06:07:08.123456789', 'date', of('timestamp'))).toBe('2024-03-05T06:07:08.123Z');
    expect(cellOf('2024-03-05T06:07:08+02:00', 'date', of('timestamp'))).toBe('2024-03-05T04:07:08.000Z');
    expect(cellOf('2024-03-05 06:07:08 -0130', 'date', of('timestamp'))).toBe('2024-03-05T07:37:08.000Z');
    expect(cellOf(new Date(Date.UTC(2024, 2, 5, 6, 7, 8, 500)), 'date', of('timestamp'))).toBe(
      '2024-03-05T06:07:08.500Z',
    );
    expect(cellOf('0024-03-05', 'date', of('date'))).toBe('0024-03-05');
    expect(thrown(() => cellOf('2024-02-30', 'date', of('date'))).messageKey).toBe('sources.sync.read');
    expect(thrown(() => cellOf('2024-03-05 25:00:00', 'date', of('timestamp'))).messageKey).toBe(
      'sources.sync.read',
    );
  });

  it('writes text in the form each class writes it', () => {
    expect(cellOf('{"a": [1, 2.50]}', 'longText', of('json'))).toBe('{"a":[1,2.5]}');
    expect(cellOf('<note/>', 'longText', of('json'))).toBe('<note/>');
    expect(cellOf({ id: 9007199254740993n, raw: Buffer.from('abc') }, 'longText', of('json'))).toBe(
      '{"id":"9007199254740993","raw":"YWJj"}',
    );
    expect(cellOf(true, 'text', of('boolean'))).toBe('true');
    expect(cellOf('2024-03-05 06:07:08', 'text', of('timestamp'))).toBe('2024-03-05T06:07:08.000Z');
    expect(cellOf('9007199254740993', 'text', of('integer'))).toBe('9007199254740993');
    expect(cellOf(Buffer.from('abc'), 'text', of('binary'))).toBe('YWJj');
    expect(cellOf(['red', 'blue'], 'multipleSelect', of('json'))).toEqual(['red', 'blue']);
  });

  it("lists the connection's own schema first, and otherwise keeps the catalog's order", () => {
    const objects = [
      { schema: 'archive', name: 'a' },
      { schema: 'Sales', name: 'b' },
      { schema: null, name: 'c' },
      { schema: 'sales', name: 'd' },
    ];
    expect(ownSchemaFirst(objects, 'sales').map((object) => object.name)).toEqual(['d', 'a', 'b', 'c']);
    const folded = ownSchemaFirst(
      objects,
      'SALES',
      (left, right) => left.toLowerCase() === right.toLowerCase(),
    );
    expect(folded.map((object) => object.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('keeps exact digits in keys, whatever field type a column is read as', () => {
    expect(keyPartOf('12.50', of('decimal', { scale: 2 }))).toBe('12.50');
    expect(keyPartOf('7', of('integer'))).toBe(7);
    expect(keyPartOf(7n, of('integer'))).toBe(7);
    expect(keyPartOf('9007199254740993', of('integer'))).toBe('9007199254740993');
    expect(keyPartOf(18446744073709551615n, of('integer'))).toBe('18446744073709551615');
    expect(keyPartOf('1.5', of('float'))).toBe(1.5);
    expect(keyPartOf(new Date(Date.UTC(2024, 2, 5)), of('date'))).toBe('2024-03-05');
    expect(keyPartOf('x', of('text'))).toBe('x');
    // A number and text that look alike stay apart.
    expect(sourceKey([keyPartOf('1', of('integer')), keyPartOf('1', of('text'))])).toBe('[1,"1"]');
  });
});

const ID = describeColumn({ name: 'id', sourceType: 'BIGINT', nullable: false, kind: 'integer' });
const AMOUNT = describeColumn({
  name: 'amount',
  sourceType: 'DECIMAL(10,2)',
  nullable: true,
  kind: 'decimal',
  scale: 2,
});
const STAMP = describeColumn({ name: 'stamp', sourceType: 'TIMESTAMP', nullable: true, kind: 'timestamp' });
const BYTES = describeColumn({ name: 'bytes', sourceType: 'BLOB', nullable: true, kind: 'binary' });
const rowAt = (index: number): Row => ({
  id: String(index),
  amount: `${index}.50`,
  stamp: `2024-03-05 06:07:0${index % 10}`,
  bytes: Buffer.from([index]),
});

interface FakeOptions {
  open?: () => Promise<void>;
  version?: () => Promise<string>;
  describe?: () => Promise<Described[]>;
  chunks?: Row[][];
  /** Milliseconds before each chunk arrives */
  chunkMs?: number;
  /** A chunk that never arrives, until the session closes */
  hangAt?: number;
  failAt?: { index: number; error: Error };
}

function fakeWarehouse(options: FakeOptions = {}) {
  const log = { opened: 0, closed: 0, limits: [] as Array<number | undefined> };
  const chunks = options.chunks ?? [[rowAt(0), rowAt(1), rowAt(2)], [rowAt(3)], [4, 5, 6, 7, 8].map(rowAt)];
  const warehouse: Warehouse = {
    kind: 'motherduck',
    endpoint: (): Endpoint => ({ host: 'warehouse.example.com', port: 443 }),
    async open() {
      log.opened += 1;
      await options.open?.();
      let closed = false;
      const wakers = new Set<() => void>();
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          wakers.add(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      const session: WarehouseSession = {
        async close() {
          if (closed) return;
          closed = true;
          log.closed += 1;
          for (const wake of wakers) wake();
        },
        version: options.version ?? (async () => 'Fake 1.0'),
        async list() {
          return [{ schema: 'main', name: 'orders', type: 'table', rowEstimate: 9 }];
        },
        async keys() {
          return [['id']];
        },
        describe: options.describe ?? (async () => [ID, AMOUNT, STAMP, BYTES]),
        async estimate() {
          return 9;
        },
        async *rows(_select, _columns, _batchSize, limit) {
          log.limits.push(limit);
          for (const [index, chunk] of chunks.entries()) {
            if (options.hangAt === index) await pause(60_000);
            else if (options.chunkMs) await pause(options.chunkMs);
            if (closed) throw new Error('the fake session was closed');
            if (options.failAt?.index === index) throw options.failAt.error;
            yield chunk;
          }
        },
      };
      return session;
    },
    missing: (detail) => {
      if (/no such table/.test(detail)) return { kind: 'object' };
      const found = /no such column (\w+)/.exec(detail);
      return found ? { kind: 'column', column: found[1]! } : null;
    },
  };
  return { warehouse, log };
}

function fakeNetwork(options: { fail?: 'resolve' | 'connect' | 'tls'; proxied?: boolean } = {}) {
  const calls: string[] = [];
  const step = async (name: 'resolve' | 'connect' | 'tls', call: string) => {
    calls.push(call);
    if (options.fail === name) throw Object.assign(new Error(`${name} failed`), { code: 'EFAKE' });
  };
  const network: Network = {
    proxied: () => options.proxied === true,
    resolve: (host) => step('resolve', `resolve ${host}`),
    connect: (endpoint) => step('connect', `connect ${endpoint.host}:${endpoint.port}`),
    handshake: (endpoint) => step('tls', `handshake ${endpoint.host}:${endpoint.port}`),
  };
  return { network, calls };
}

const CTX: ConnectorContext = {
  connection: { kind: 'motherduck', database: 'analytics' },
  secrets: { token: 'placeholder-token-value' },
  timeoutMs: 2_000,
};
const ORDERS: SourceSelect = { kind: 'object', object: { schema: 'main', name: 'orders' } };

async function readAll(
  connector: ReturnType<typeof makeWarehouseConnector>,
  ctx: ConnectorContext,
  options: Partial<Parameters<typeof connector.read>[2]> = {},
): Promise<SourceRow[][]> {
  const batches: SourceRow[][] = [];
  for await (const batch of connector.read(ctx, ORDERS, {
    columns: ['amount', 'stamp'],
    types: { amount: 'number', stamp: 'date' },
    keyColumns: ['id', 'amount'],
    batchSize: 4,
    ...options,
  }))
    batches.push(batch);
  return batches;
}

describe('the warehouse connection test', () => {
  it('climbs every step, checks the network itself, and closes the session', async () => {
    const { warehouse, log } = fakeWarehouse();
    const { network, calls } = fakeNetwork();
    const result = await makeWarehouseConnector(warehouse, network).test(CTX);
    expect(result).toMatchObject({ ok: true, serverVersion: 'Fake 1.0' });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.steps.every((step) => typeof step.ms === 'number')).toBe(true);
    expect(calls).toEqual([
      'resolve warehouse.example.com',
      'connect warehouse.example.com:443',
      'handshake warehouse.example.com:443',
    ]);
    expect(log.closed).toBe(1);
  });

  it('skips the TLS check for a plain connection, and hands a private authority to the check', async () => {
    const { warehouse } = fakeWarehouse();
    const plain = fakeNetwork();
    const result = await makeWarehouseConnector(
      { ...warehouse, endpoint: () => ({ host: 'db.internal', port: 8123, tls: false }) },
      plain.network,
    ).test(CTX);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(plain.calls).toEqual(['resolve db.internal', 'connect db.internal:8123']);
    const seen: Endpoint[] = [];
    const trusting = fakeNetwork();
    await makeWarehouseConnector(
      { ...warehouse, endpoint: () => ({ host: 'db.internal', port: 8443, tls: { ca: 'PEM' } }) },
      { ...trusting.network, handshake: async (endpoint) => void seen.push(endpoint) },
    ).test(CTX);
    expect(seen).toEqual([{ host: 'db.internal', port: 8443, tls: { ca: 'PEM' } }]);
  });

  it.each(['resolve', 'connect', 'tls'] as const)('stops at a failed %s check', async (failed) => {
    const { warehouse, log } = fakeWarehouse();
    const result = await makeWarehouseConnector(warehouse, fakeNetwork({ fail: failed }).network).test(CTX);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(['resolve', 'connect', 'tls'].indexOf(failed) + 1);
    expect(result.steps.at(-1)).toMatchObject({
      step: failed,
      status: 'failed',
      messageKey: `sources.test.${failed}`,
      detail: `${failed} failed (EFAKE)`,
    });
    expect(log.opened).toBe(0);
  });

  it('skips the network checks behind a proxy, where the driver finds its own way', async () => {
    const { warehouse } = fakeWarehouse();
    const { network, calls } = fakeNetwork({ proxied: true });
    const result = await makeWarehouseConnector(warehouse, network).test(CTX);
    expect(result.ok).toBe(true);
    expect(result.steps.slice(0, 3)).toEqual([
      { step: 'resolve', status: 'skipped', ms: null },
      { step: 'connect', status: 'skipped', ms: null },
      { step: 'tls', status: 'skipped', ms: null },
    ]);
    expect(calls).toEqual([]);
  });

  it('reports a refused sign-in at authentication, without the secret', async () => {
    const { warehouse } = fakeWarehouse({
      open: async () => {
        throw new Error('token placeholder-token-value was refused');
      },
    });
    const result = await makeWarehouseConnector(warehouse, fakeNetwork().network).test(CTX);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
      detail: 'token [redacted] was refused',
    });
    expect(JSON.stringify(result)).not.toContain('placeholder-token-value');
  });

  it("puts a driver's own network failure at the step it belongs to", async () => {
    const { warehouse } = fakeWarehouse({
      open: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND warehouse.example.com'), { code: 'ENOTFOUND' });
      },
    });
    const result = await makeWarehouseConnector(warehouse, fakeNetwork({ proxied: true }).network).test(CTX);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      step: 'resolve',
      status: 'failed',
      messageKey: 'sources.test.resolve',
    });
  });

  it('reports a failed query, a missing secret, and a deadline by their own keys', async () => {
    const query = fakeWarehouse({
      version: async () => {
        throw new Error('the warehouse is suspended');
      },
    });
    const queried = await makeWarehouseConnector(query.warehouse, fakeNetwork().network).test(CTX);
    expect(queried.steps.at(-1)).toMatchObject({ step: 'query', messageKey: 'sources.test.query' });
    expect(query.log.closed).toBe(1);

    const secret = fakeWarehouse({
      open: async () => {
        throw new ConnectorError('sources.secretsMissing', "the token secret isn't stored", {
          secret: 'token',
        });
      },
    });
    const missing = await makeWarehouseConnector(secret.warehouse, fakeNetwork().network).test(CTX);
    expect(missing.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.secretsMissing',
      detail: "the token secret isn't stored",
    });

    const slow = fakeWarehouse({ open: () => new Promise(() => undefined) });
    const timed = await makeWarehouseConnector(slow.warehouse, fakeNetwork().network).test({
      ...CTX,
      timeoutMs: 20,
    });
    expect(timed.steps.at(-1)).toMatchObject({ step: 'authenticate', messageKey: 'sources.test.timeout' });
  });
});

describe('warehouse calls', () => {
  it('reads batches of the size asked for, whatever size the driver delivers', async () => {
    const { warehouse, log } = fakeWarehouse();
    const batches = await readAll(makeWarehouseConnector(warehouse), CTX);
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 1]);
    // Keys come from the key columns, read even when they aren't among the values.
    expect(batches[0]?.[0]).toEqual({
      key: '[0,"0.50"]',
      values: { amount: 0.5, stamp: '2024-03-05T06:07:00.000Z' },
    });
    expect(log.limits).toEqual([undefined]);
    expect(log.closed).toBe(1);
  });

  it('renews the budget after each batch, and holds a batch to it', async () => {
    // Wide margins, because timers fire late on a busy machine: each chunk takes 400 ms against a
    // one-second budget, and three chunks in one batch take 1.2 seconds.
    const paced = fakeWarehouse({ chunks: [[rowAt(0)], [rowAt(1)], [rowAt(2)]], chunkMs: 400 });
    const batches = await readAll(
      makeWarehouseConnector(paced.warehouse),
      { ...CTX, timeoutMs: 1000 },
      { batchSize: 1 },
    );
    expect(batches).toHaveLength(3);

    const slow = fakeWarehouse({ chunks: [[rowAt(0)], [rowAt(1)], [rowAt(2)]], chunkMs: 400 });
    await expect(
      readAll(makeWarehouseConnector(slow.warehouse), { ...CTX, timeoutMs: 1000 }, { batchSize: 10 }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 1000 ms to answer',
    });
    expect(slow.log.closed).toBe(1);
  });

  it('gives up on a chunk that never arrives, and closes the session', async () => {
    const { warehouse, log } = fakeWarehouse({ hangAt: 1 });
    await expect(readAll(makeWarehouseConnector(warehouse), { ...CTX, timeoutMs: 50 })).rejects.toMatchObject(
      {
        messageKey: 'sources.sync.read',
      },
    );
    expect(log.closed).toBe(1);
  });

  it('stops between batches when the caller gives up, and before starting when it already has', async () => {
    const { warehouse, log } = fakeWarehouse();
    const controller = new AbortController();
    const iterable = makeWarehouseConnector(warehouse).read({ ...CTX, signal: controller.signal }, ORDERS, {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
      batchSize: 2,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toHaveLength(2);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(log.closed).toBe(1);

    const early = fakeWarehouse();
    await expect(
      readAll(makeWarehouseConnector(early.warehouse), { ...CTX, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
    });
    expect(early.log.opened).toBe(0);
  });

  it('delivers nothing more from a chunk that makes several batches, once the caller gives up', async () => {
    const { warehouse, log } = fakeWarehouse({ chunks: [[rowAt(0), rowAt(1), rowAt(2)]] });
    const controller = new AbortController();
    const iterable = makeWarehouseConnector(warehouse).read({ ...CTX, signal: controller.signal }, ORDERS, {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
      batchSize: 1,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual([{ key: '[0]', values: { id: '0' } }]);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(log.closed).toBe(1);
  });

  it('names a requested column the source no longer has', async () => {
    const { warehouse, log } = fakeWarehouse();
    await expect(
      readAll(makeWarehouseConnector(warehouse), CTX, { columns: ['amount', 'vanished'] }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'vanished' } });
    expect(log.closed).toBe(1);
  });

  it('scrubs a failure partway through a read', async () => {
    const { warehouse } = fakeWarehouse({
      failAt: { index: 1, error: new Error('lost placeholder-token-value midway') },
    });
    await expect(readAll(makeWarehouseConnector(warehouse), CTX)).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'lost [redacted] midway',
    });
  });

  it('previews converted values, leaves out what Riosoma cannot hold, and stops at the limit', async () => {
    const { warehouse, log } = fakeWarehouse();
    const connector = makeWarehouseConnector(warehouse);
    const preview = await connector.preview(CTX, ORDERS, 2);
    expect(preview.columns.map((entry) => entry.name)).toEqual(['id', 'amount', 'stamp', 'bytes']);
    expect(preview.rows).toEqual([
      [0, 0.5, '2024-03-05T06:07:00.000Z', null],
      [1, 1.5, '2024-03-05T06:07:01.000Z', null],
    ]);
    expect(preview.rowEstimate).toBe(9);
    expect(log.limits).toEqual([2]);
    const queried = await connector.preview(CTX, { kind: 'query', sql: 'SELECT 1' }, 2);
    expect(queried.rowEstimate).toBeNull();
    await expect(connector.preview(CTX, ORDERS, 0)).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
    });
    expect(log.closed).toBe(log.opened);
  });

  it("reads a driver's missing table and column the way the SQL connectors report them", async () => {
    const table = fakeWarehouse({
      describe: async () => {
        throw new Error('no such table orders');
      },
    });
    await expect(makeWarehouseConnector(table.warehouse).describe(CTX, ORDERS)).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'orders' },
    });
    const field = fakeWarehouse({
      describe: async () => {
        throw new Error('no such column total');
      },
    });
    await expect(makeWarehouseConnector(field.warehouse).describe(CTX, ORDERS)).rejects.toMatchObject({
      messageKey: 'sources.sync.columnMissing',
      params: { column: 'total' },
    });
  });

  it('describes columns without the class it reads them by, and lists and keys through the session', async () => {
    const { warehouse, log } = fakeWarehouse();
    const connector = makeWarehouseConnector(warehouse);
    expect(await connector.describe(CTX, ORDERS)).toEqual([
      ID.column,
      AMOUNT.column,
      STAMP.column,
      BYTES.column,
    ]);
    expect(await connector.listObjects(CTX)).toHaveLength(1);
    expect(
      await connector.keyCandidates(
        CTX,
        ORDERS.kind === 'object' ? ORDERS.object : { schema: null, name: '' },
      ),
    ).toEqual([['id']]);
    expect(log.closed).toBe(3);
  });
});

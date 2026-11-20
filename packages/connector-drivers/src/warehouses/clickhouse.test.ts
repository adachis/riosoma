import { strictFixture } from '@riosoma/connectors';
/**
 * ClickHouse against the client's interface, with a fake that records what the connector asks for
 * and answers the way the HTTP interface does in `JSONCompactEachRowWithNamesAndTypes`: names,
 * types, then rows in chunks.  The live suite is `clickhouse.live.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { SourceRow } from '@riosoma/connectors/internal/types.js';
import {
  clickHouseColumn,
  clickHouseConnector,
  clickHouseEndpoint,
  clickHouseMissing,
  clickHouseProjection,
  clickHouseTypeClass,
  clickHouseValues,
  cursorType,
  enumLabels,
} from './clickhouse.js';
import {
  fakeClickHouse,
  network,
  SETTINGS,
  PASSWORD,
  contextFor,
  connector,
  ORDERS,
  ordersAnswer,
  readAll,
  clickHouseContractFixture,
} from './clickhouse.fixture.test-support.js';

describe('clickhouse type mapping', () => {
  it.each([
    ['Int8', 'integer'],
    ['UInt8', 'integer'],
    ['Int16', 'integer'],
    ['UInt16', 'integer'],
    ['Int32', 'integer'],
    ['UInt32', 'integer'],
    ['Int64', 'integer'],
    ['UInt64', 'integer'],
    ['Int128', 'integer'],
    ['UInt128', 'integer'],
    ['Int256', 'integer'],
    ['UInt256', 'integer'],
    ['Float32', 'float'],
    ['Float64', 'float'],
    ['BFloat16', 'float'],
    ['Decimal(10, 2)', 'decimal'],
    ['Decimal32(3)', 'decimal'],
    ['Decimal64(4)', 'decimal'],
    ['Decimal128(6)', 'decimal'],
    ['Decimal256(20)', 'decimal'],
    ['Bool', 'boolean'],
    ['String', 'text'],
    ['FixedString(16)', 'text'],
    ['UUID', 'text'],
    ['IPv4', 'text'],
    ['IPv6', 'text'],
    ["Enum8('a' = 1, 'b' = 2)", 'text'],
    ["Enum16('a' = 1000)", 'text'],
    ['Date', 'date'],
    ['Date32', 'date'],
    ['DateTime', 'timestamp'],
    ["DateTime('Asia/Tokyo')", 'timestamp'],
    ['DateTime64(3)', 'timestamp'],
    ["DateTime64(9, 'America/New_York')", 'timestamp'],
    ['Time', 'time'],
    ['Time64(3)', 'time'],
    ['Array(String)', 'json'],
    ['Map(String, Array(Int64))', 'json'],
    ['Tuple(city String, zip Int32)', 'json'],
    ['Tuple(String, Int32)', 'json'],
    ['Nested(a String, b Int32)', 'json'],
    ['JSON', 'json'],
    ["Object('json')", 'json'],
    ['Dynamic', 'json'],
    ['Variant(String, UInt64)', 'json'],
    ['Point', 'json'],
    ['MultiPolygon', 'json'],
    ['AggregateFunction(uniq, String)', 'unknown'],
    ['IntervalDay', 'unknown'],
    ['Nothing', 'unknown'],
  ])('reads %s as %s', (type, kind) => {
    expect(clickHouseTypeClass(type).kind).toBe(kind);
  });

  it('sees through nullability, dictionaries, and simple aggregates', () => {
    expect(clickHouseTypeClass('Nullable(Int64)')).toEqual({ kind: 'integer', nullable: true });
    expect(clickHouseTypeClass('LowCardinality(String)')).toEqual({ kind: 'text', nullable: false });
    expect(clickHouseTypeClass('LowCardinality(Nullable(String))')).toEqual({ kind: 'text', nullable: true });
    expect(clickHouseTypeClass('SimpleAggregateFunction(sum, UInt64)')).toEqual({
      kind: 'integer',
      nullable: false,
    });
    expect(clickHouseTypeClass('Nullable(Decimal(38, 10))')).toEqual({
      kind: 'decimal',
      nullable: true,
      scale: 10,
    });
    expect(clickHouseTypeClass('Decimal64(4)').scale).toBe(4);
    expect(clickHouseTypeClass('FixedString(3)').length).toBe(3);
  });

  it('reads an enumeration’s labels with their escapes, in order', () => {
    expect(enumLabels("'happy' = 1, 'it\\'s fine' = 2, 'a, b' = 3, 'x''y' = -4, '\\\\' = 5")).toEqual([
      'happy',
      "it's fine",
      'a, b',
      "x'y",
      '\\',
    ]);
  });

  it('suggests the field types the SQL connectors would', () => {
    const suggested = (type: string) => clickHouseColumn('c', type).column.suggested;
    expect(suggested('UInt64')).toEqual({ type: 'number', options: { precision: 0 } });
    expect(suggested('Decimal(10, 2)')).toEqual({ type: 'number', options: { precision: 2 } });
    expect(suggested('Decimal256(20)')).toEqual({ type: 'number', options: { precision: 8 } });
    expect(suggested('Float64')).toEqual({ type: 'number', options: { precision: null } });
    expect(suggested('Bool')).toEqual({ type: 'checkbox', options: {} });
    expect(suggested('Date32')).toEqual({ type: 'date', options: {} });
    expect(suggested("DateTime64(3, 'Europe/Lisbon')")).toEqual({
      type: 'date',
      options: { includeTime: true, timeZone: 'UTC' },
    });
    expect(suggested('String')).toEqual({ type: 'text', options: {} });
    expect(suggested('FixedString(2000)')).toEqual({ type: 'longText', options: {} });
    expect(suggested('Time')).toEqual({ type: 'text', options: {} });
    expect(suggested('Array(String)')).toEqual({ type: 'longText', options: {} });
    expect(suggested('AggregateFunction(uniq, String)')).toBeNull();
    const choice = clickHouseColumn('mood', "Enum8('happy' = 1, 'sad' = 2)").column;
    expect(choice.suggested?.type).toBe('singleSelect');
    expect(JSON.stringify(choice.suggested?.options)).toMatch(/happy[\s\S]*sad/);
    expect(clickHouseColumn('n', 'Nullable(String)').column.nullable).toBe(true);
    expect(clickHouseColumn('n', 'String').column).toMatchObject({ nullable: false, sourceType: 'String' });
  });

  it('writes values in SQL where JSON output depends on the server’s settings', () => {
    const projected = (type: string) => clickHouseProjection(clickHouseColumn('c', type), '`c`');
    expect(projected('Int64')).toBe('toString(`c`)');
    expect(projected('Nullable(UInt256)')).toBe('toString(`c`)');
    expect(projected('Decimal(30, 4)')).toBe('toString(`c`)');
    expect(projected("DateTime64(3, 'Europe/Lisbon')")).toBe("toString(toTimeZone(`c`, 'UTC'))");
    expect(projected('Nullable(DateTime)')).toBe("toString(toTimeZone(`c`, 'UTC'))");
    for (const type of ['Int32', 'String', 'Date', 'Array(Int64)', 'Map(String, String)'])
      expect(projected(type)).toBe('`c`');
  });

  it('keeps wide integers exact, decimals at their scale, and fixed strings without padding', () => {
    const plain = (type: string, value: unknown) => clickHouseValues(clickHouseColumn('c', type))(value);
    expect(plain('UInt64', '42')).toBe(42);
    expect(plain('UInt64', '18446744073709551615')).toBe('18446744073709551615');
    expect(plain('Int8', -3)).toBe(-3);
    expect(plain('Decimal(30, 4)', '12.5')).toBe('12.5000');
    expect(plain('Decimal(30, 4)', '-7')).toBe('-7.0000');
    expect(plain('Decimal(10, 0)', '7')).toBe('7');
    expect(plain('FixedString(4)', 'ab\0\0')).toBe('ab');
    expect(plain('String', 'ab\0')).toBe('ab\0');
  });
});

describe('clickhouse errors', () => {
  it('says which table or column is missing from ClickHouse’s own words', () => {
    expect(
      clickHouseMissing(
        'Code: 60. DB::Exception: Table analytics.gone does not exist. (UNKNOWN_TABLE) (version 25.8)',
      ),
    ).toEqual({ kind: 'object' });
    expect(
      clickHouseMissing('Code: 81. DB::Exception: Database nowhere does not exist. (UNKNOWN_DATABASE)'),
    ).toEqual({
      kind: 'object',
    });
    expect(
      clickHouseMissing(
        'Code: 47. DB::Exception: Unknown expression identifier `nope` in scope SELECT nope FROM t. (UNKNOWN_IDENTIFIER)',
      ),
    ).toEqual({ kind: 'column', column: 'nope' });
    expect(
      clickHouseMissing("Code: 47. DB::Exception: Missing columns: 'gone' while processing query"),
    ).toEqual({
      kind: 'column',
      column: 'gone',
    });
    expect(clickHouseMissing('Code: 516. DB::Exception: reader: Authentication failed')).toBeNull();
  });

  it('climbs every step, and checks TLS with the authority the source trusts', async () => {
    const fake = fakeClickHouse();
    const checks = network();
    const result = await connector(fake, checks).test(contextFor({ caPem: '-----BEGIN CERTIFICATE-----' }));
    expect(result).toMatchObject({ ok: true, serverVersion: 'ClickHouse 25.8.1.1' });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(checks.calls.at(-1)).toBe(
      'handshake abc123.us-east-1.aws.clickhouse.cloud:8443 {"ca":"-----BEGIN CERTIFICATE-----"}',
    );
    expect(fake.log.connects[0]).toEqual({
      url: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443',
      username: 'reader',
      password: PASSWORD,
      database: 'analytics',
      caPem: '-----BEGIN CERTIFICATE-----',
      timeoutMs: 2_000,
    });
    expect(fake.log.closed).toBe(1);
  });

  it('skips TLS on a plain connection, and never sends it an authority', async () => {
    const fake = fakeClickHouse();
    const checks = network();
    const result = await connector(fake, checks).test(
      contextFor({ host: 'clickhouse.internal', port: 8123, secure: false, caPem: 'unused' }),
    );
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(checks.calls).toEqual(['resolve clickhouse.internal', 'connect clickhouse.internal:8123']);
    expect(fake.log.connects[0]).toMatchObject({ url: 'http://clickhouse.internal:8123' });
    expect(fake.log.connects[0]).not.toHaveProperty('caPem');
  });

  it('takes the host and port from a pasted ClickHouse Cloud address, and leaves credentials out', () => {
    expect(
      clickHouseEndpoint({
        ...SETTINGS,
        host: 'https://someone:secret@abc123.clickhouse.cloud:9440/?x=1',
        port: 8443,
      }),
    ).toEqual({ host: 'abc123.clickhouse.cloud', port: 9440, tls: {} });
    expect(clickHouseEndpoint({ ...SETTINGS, host: '[::1]', port: 8123, secure: false })).toEqual({
      host: '::1',
      port: 8123,
      tls: false,
    });
  });

  it.each([
    ['resolve', Object.assign(new Error('getaddrinfo ENOTFOUND abc'), { code: 'ENOTFOUND' })],
    ['connect', Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8443'), { code: 'ECONNREFUSED' })],
    [
      'tls',
      Object.assign(new Error('self-signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
    ],
    [
      'authenticate',
      new Error(`Code: 516. DB::Exception: reader: Authentication failed: password ${PASSWORD} is incorrect`),
    ],
  ])('reports a failure to sign in at %s, without the password', async (step, error) => {
    const result = await connector(fakeClickHouse(undefined, error)).test(contextFor());
    const last = result.steps.at(-1)!;
    expect(last).toMatchObject({ step, status: 'failed', messageKey: `sources.test.${step}` });
    expect(last.detail).not.toContain(PASSWORD);
    expect(result.ok).toBe(false);
  });

  it('says a database it can’t use at the query step, since the sign-in worked', async () => {
    for (const words of [
      'Code: 81. DB::Exception: Database elsewhere does not exist. (UNKNOWN_DATABASE)',
      'Code: 497. DB::Exception: reader: Not enough privileges. (ACCESS_DENIED)',
    ]) {
      const result = await connector(fakeClickHouse(undefined, new Error(words))).test(contextFor());
      expect(result.steps.map((step) => [step.step, step.status])).toEqual([
        ['resolve', 'ok'],
        ['connect', 'ok'],
        ['tls', 'ok'],
        ['authenticate', 'ok'],
        ['query', 'failed'],
      ]);
      expect(result.steps.at(-1)).toMatchObject({
        messageKey: 'sources.test.query',
        detail: expect.stringContaining(words.slice(0, 20)),
      });
    }
  });

  it('asks for the password before anything connects', async () => {
    const fake = fakeClickHouse();
    const result = await connector(fake).test(contextFor({}, { secrets: {} }));
    expect(result.steps.at(-1)).toMatchObject({ step: 'authenticate', messageKey: 'sources.secretsMissing' });
    expect(fake.log.connects).toEqual([]);
  });

  it('turns a missing table into the sync’s own message', async () => {
    const fake = fakeClickHouse(({ sql }) =>
      sql.includes('system.columns')
        ? { names: ['name', 'type'], types: ['String', 'String'], chunks: [] }
        : undefined,
    );
    await expect(connector(fake).describe(contextFor(), ORDERS)).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'orders' },
    });
  });
});

describe('clickhouse catalog', () => {
  it('lists tables and views but no streams, the connection’s database first', async () => {
    const fake = fakeClickHouse(({ sql }) =>
      sql.includes('FROM system.tables')
        ? {
            names: ['database', 'name', 'engine', 'total_rows'],
            types: ['String', 'String', 'String', 'Nullable(UInt64)'],
            chunks: [
              [
                ['archive', 'old_orders', 'MergeTree', '10'],
                ['analytics', 'orders', 'ReplacingMergeTree', '1234'],
                ['analytics', 'daily', 'MaterializedView', null],
                ['analytics', 'recent', 'View', null],
              ],
            ],
          }
        : undefined,
    );
    const objects = await connector(fake).listObjects(contextFor());
    expect(objects).toEqual([
      { schema: 'analytics', name: 'orders', type: 'table', rowEstimate: 1234 },
      { schema: 'analytics', name: 'daily', type: 'view', rowEstimate: null },
      { schema: 'analytics', name: 'recent', type: 'view', rowEstimate: null },
      { schema: 'archive', name: 'old_orders', type: 'table', rowEstimate: 10 },
    ]);
    const listing = fake.log.sent.find((sent) => sent.sql.includes('FROM system.tables'))!.sql;
    expect(listing).toContain("database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')");
    expect(listing).toContain(
      "engine NOT IN ('Kafka', 'RabbitMQ', 'NATS', 'FileLog', 'S3Queue', 'AzureQueue')",
    );
  });

  it('describes a table from system.columns, leaving ephemeral columns out', async () => {
    const fake = fakeClickHouse(ordersAnswer(() => undefined));
    const columns = await connector(fake).describe(contextFor(), ORDERS);
    expect(columns.map((column) => [column.name, column.sourceType, column.suggested?.type])).toEqual([
      ['id', 'UInt64', 'number'],
      ['region', 'LowCardinality(String)', 'text'],
      ['total', 'Decimal(18, 4)', 'number'],
      ['placed', "DateTime64(3, 'Europe/Lisbon')", 'date'],
      ['extra', 'Map(String, String)', 'longText'],
      ['note', 'Nullable(String)', 'text'],
    ]);
    const described = fake.log.sent.find((sent) => sent.sql.includes('system.columns'))!;
    expect(described.sql).toContain("default_kind != 'EPHEMERAL'");
    expect(described.params).toEqual({ database: 'analytics', table: 'orders' });
  });

  it('describes a query by running it for no rows, inside the guard', async () => {
    const fake = fakeClickHouse(({ sql }) =>
      sql.startsWith('SELECT * FROM (')
        ? { names: ['n', 'label'], types: ['UInt64', 'Nullable(String)'] }
        : undefined,
    );
    const columns = await connector(fake).describe(contextFor(), {
      kind: 'query',
      sql: 'SELECT n, label FROM t;',
    });
    expect(columns.map((column) => [column.name, column.nullable, column.suggested?.type])).toEqual([
      ['n', false, 'number'],
      ['label', true, 'text'],
    ]);
    expect(fake.log.sent.at(-1)?.sql).toBe('SELECT * FROM (\nSELECT n, label FROM t\n) AS q LIMIT 0');
    await expect(
      connector(fake).describe(contextFor(), { kind: 'query', sql: 'SELECT 1; DROP TABLE t' }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  });

  it('offers no key, and says so only for a table that exists', async () => {
    const fake = fakeClickHouse(ordersAnswer(() => undefined));
    expect(await connector(fake).keyCandidates(contextFor(), ORDERS.object)).toEqual([]);
    const empty = fakeClickHouse(({ sql }) =>
      sql.includes('system.tables') ? { names: ['engine'], types: ['String'], chunks: [] } : undefined,
    );
    await expect(
      connector(empty).keyCandidates(contextFor(), { schema: 'analytics', name: 'gone' }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing' });
  });
});

describe('clickhouse reads', () => {
  it('previews the first rows with the count the catalog keeps, converting as it goes', async () => {
    const fake = fakeClickHouse(
      ordersAnswer((sql) =>
        sql.includes('LIMIT 2')
          ? {
              names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
              types: ['UInt64', 'String', 'String', 'String', 'Map(String, String)', 'Nullable(String)'],
              chunks: [
                [
                  [7, 'north', '12.5', '2026-02-03 04:05:06.789', { a: 'b' }, 'fragile'],
                  [8, 'south', null, null, {}, null],
                ],
              ],
            }
          : undefined,
      ),
    );
    const preview = await connector(fake).preview(contextFor(), ORDERS, 2);
    expect(preview.rowEstimate).toBe(1234);
    expect(preview.rows).toEqual([
      [7, 'north', 12.5, '2026-02-03T04:05:06.789Z', '{"a":"b"}', 'fragile'],
      [8, 'south', null, null, '{}', null],
    ]);
    const read = fake.log.sent.find((sent) => sent.sql.includes('LIMIT 2'))!.sql;
    expect(read).toBe(
      "SELECT toString(`id`), `region`, toString(`total`), toString(toTimeZone(`placed`, 'UTC')), `extra`, `note` FROM `analytics`.`orders` LIMIT 2",
    );
  });

  it('pages after the last row read, in the sorting key’s order and then the key’s, ties and all', async () => {
    const fake = fakeClickHouse(
      ordersAnswer((sql) => {
        if (!sql.includes('WITH TIES')) return undefined;
        // In the order the read asks for them: the chosen column, the key, then the order's own.
        return {
          names: ['total', 'id', 'region'],
          types: ['String', 'String', 'LowCardinality(String)'],
          chunks: sql.includes('WHERE')
            ? [[['4.5', '4', 'south']]]
            : [
                [
                  ['1.5', '1', 'north'],
                  ['2.5', '2', 'north'],
                ],
                [['3.5', '3', 'south']],
              ],
        };
      }),
    );
    const batches = await readAll(fake, ['total'], ['id'], 3);
    expect(batches.flat().map((row) => [row.key, row.values])).toEqual([
      ['[1]', { total: '1.5000' }],
      ['[2]', { total: '2.5000' }],
      ['[3]', { total: '3.5000' }],
      ['[4]', { total: '4.5000' }],
    ]);
    const reads = fake.log.sent.filter((sent) => sent.sql.includes('WITH TIES'));
    expect(reads.map((sent) => [sent.sql, sent.params])).toEqual([
      [
        'SELECT toString(`total`), toString(`id`), `region` FROM `analytics`.`orders` ORDER BY `region`, `id` LIMIT 3 WITH TIES',
        {},
      ],
      [
        'SELECT toString(`total`), toString(`id`), `region` FROM `analytics`.`orders` ' +
          'WHERE (`region` > {k0:String} OR (`region` = {k0:String} AND `id` > {k1:UInt64})) ' +
          'ORDER BY `region`, `id` LIMIT 3 WITH TIES',
        { k0: 'south', k1: '3' },
      ],
    ]);
  });

  it.each([
    ['ReplacingMergeTree', true],
    ['ReplicatedCollapsingMergeTree', true],
    ['VersionedCollapsingMergeTree', true],
    ['SummingMergeTree', true],
    ['SharedAggregatingMergeTree', true],
    ['MergeTree', false],
    ['ReplicatedMergeTree', false],
    ['Distributed', false],
  ])('reads a %s table with FINAL only when its engine merges rows: %s', async (engine, final) => {
    const fake = fakeClickHouse(
      ordersAnswer((sql) => {
        if (!sql.includes('`orders`') || sql.includes('system.')) return undefined;
        // A preview asks for every column, and a read for the chosen one, its key, and its order.
        return sql.includes('LIMIT 2')
          ? { names: [], types: [], chunks: [[['1', 'north', '1.5', null, {}, null]]] }
          : { names: [], types: [], chunks: [[['1.5', '1', 'north']]] };
      }, engine),
    );
    await readAll(fake, ['total'], ['id'], 3);
    const preview = await connector(fake).preview(contextFor(), ORDERS, 2);
    expect(preview.rows).toHaveLength(1);
    const reads = fake.log.sent.filter(
      (sent) => sent.sql.includes('`orders`') && !sent.sql.includes('system.'),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const { sql } of reads) expect(sql.includes('FROM `analytics`.`orders` FINAL'), sql).toBe(final);
  });

  it('binds each kind of cursor value as a type ClickHouse reads exactly', () => {
    const type = (sourceType: string) => cursorType(clickHouseColumn('c', sourceType));
    expect(type('UInt64')).toBe('UInt64');
    expect(type('LowCardinality(String)')).toBe('String');
    expect(type('Decimal(18, 4)')).toBe('Decimal(18, 4)');
    expect(type('FixedString(4)')).toBe('FixedString(4)');
    expect(type('UUID')).toBe('UUID');
    expect(type('Date32')).toBe('Date32');
    expect(type("DateTime('Europe/Lisbon')")).toBe("DateTime('UTC')");
    expect(type("DateTime64(6, 'America/New_York')")).toBe("DateTime64(6, 'UTC')");
    for (const sourceType of ['Nullable(UInt64)', 'Float64', "Enum8('a' = 1)", 'Time', 'Array(String)'])
      expect(type(sourceType), sourceType).toBeNull();
  });

  it('counts its way through a fixed order when a key can be empty, so no cursor could follow it', async () => {
    const page = (start: number, size: number) => [
      // In the order the read asks for them: the chosen columns, then the key.
      Array.from({ length: size }, (_unused, index) => ['1.5', 'r', null, `n${start + index}`]),
    ];
    const fake = fakeClickHouse(
      ordersAnswer((sql) => {
        if (!sql.includes('ORDER BY `')) return undefined;
        const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1]);
        return {
          names: ['total', 'region', 'extra', 'note'],
          types: ['String', 'String', 'Map(String, String)', 'Nullable(String)'],
          chunks: offset === 0 ? page(0, 3) : page(offset, 2),
        };
      }),
    );
    const batches = await readAll(fake, ['total', 'region', 'extra'], ['note'], 3);
    expect(batches.flat()).toHaveLength(5);
    const reads = fake.log.sent.filter((sent) => sent.sql.includes('ORDER BY `')).map((sent) => sent.sql);
    expect(reads).toEqual([
      'SELECT toString(`total`), `region`, `extra`, `note` FROM `analytics`.`orders` ORDER BY `region`, `id`, `total`, `note` LIMIT 3 OFFSET 0',
      'SELECT toString(`total`), `region`, `extra`, `note` FROM `analytics`.`orders` ORDER BY `region`, `id`, `total`, `note` LIMIT 3 OFFSET 3',
    ]);
    expect(batches[0]?.[0]).toEqual({ key: '["n0"]', values: { total: '1.5000', region: 'r', extra: null } });
  });

  it('reads a view in the order of its columns, since a view has no sorting key', async () => {
    const fake = fakeClickHouse(
      ordersAnswer(
        (sql) =>
          sql.includes('ORDER BY `') ? { names: ['id'], types: ['String'], chunks: [[['1']]] } : undefined,
        'View',
      ),
    );
    await readAll(fake, ['region'], ['placed']);
    expect(fake.log.sent.find((sent) => sent.sql.includes('ORDER BY `'))?.sql).toContain(
      'ORDER BY `placed` LIMIT 50000 WITH TIES',
    );
  });

  it('reads everything in one request when no column sorts', async () => {
    const fake = fakeClickHouse(({ sql }) => {
      if (sql.includes('system.tables'))
        return { names: ['engine', 'total_rows', 'sorting_key'], types: [], chunks: [[['View', null, '']]] };
      if (sql.includes('system.columns'))
        return { names: ['name', 'type'], types: [], chunks: [[['doc', 'JSON']]] };
      if (sql.startsWith('SELECT `doc`')) return { names: ['doc'], types: ['JSON'], chunks: [[[{ a: 1 }]]] };
      return undefined;
    });
    const batches: SourceRow[][] = [];
    for await (const batch of connector(fake).read(contextFor(), ORDERS, {
      columns: ['doc'],
      types: { doc: 'longText' },
      keyColumns: ['doc'],
    }))
      batches.push(batch);
    expect(batches.flat().map((row) => row.values)).toEqual([{ doc: '{"a":1}' }]);
    expect(fake.log.sent.at(-1)?.sql).toBe('SELECT `doc` FROM `analytics`.`orders`');
  });

  it('stops a read in progress when the caller gives up', async () => {
    const controller = new AbortController();
    const fake = fakeClickHouse(
      ordersAnswer((sql) =>
        sql.includes('ORDER BY `')
          ? { names: ['id'], types: ['String'], chunks: [[['1'], ['2'], ['3'], ['4']], [['5']]] }
          : undefined,
      ),
    );
    const read = connector(fake).read(contextFor({}, { signal: controller.signal }), ORDERS, {
      columns: ['region'],
      types: { region: 'text' },
      keyColumns: ['id'],
      batchSize: 2,
    });
    const iterator = read[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toHaveLength(2);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(fake.log.closed).toBe(1);
    expect(fake.log.aborted).toBeGreaterThan(0);
  });

  it('registers itself on import', () => {
    expect(clickHouseConnector.kind).toBe('clickhouse');
  });
});

it('runs every declared contract against the native driver fixture', async () => {
  const fixture = clickHouseContractFixture();
  await strictFixture(
    fixture.connector,
    fixture.context,
    fixture.select,
    fixture.keyColumns,
    fixture.count,
    fixture.boundary,
  );
});

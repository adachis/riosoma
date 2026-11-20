import { strictFixture } from '@riosoma/connectors';
/**
 * Databricks against the driver's interface, with a fake that records what the connector asks for
 * and answers the way `@databricks/sql` does: statements become operations, rows come in chunks
 * until the operation has no more, and values arrive as the driver converts them, with exact
 * digits for decimals and big integers.  The live suite is `databricks.live.test.ts`.
 */
import type { SourceConnection } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import {
  databricksConnector,
  databricksMissing,
  databricksTypeClass,
  httpPathOf,
  workspaceOf,
} from './databricks.js';
import {
  type Rows,
  fakeDatabricks,
  network,
  connector,
  SETTINGS,
  TOKEN,
  contextFor,
  objectSelect,
  querySelect,
  readAll,
  ordersAnswer,
  databricksContractFixture,
} from './databricks.fixture.test-support.js';

describe('databricks connection settings', () => {
  it('takes the workspace and path from what people paste', () => {
    expect(workspaceOf('adb-1.azuredatabricks.net')).toEqual({
      host: 'adb-1.azuredatabricks.net',
      port: 443,
    });
    expect(workspaceOf('https://adb-1.azuredatabricks.net/?o=1')).toEqual({
      host: 'adb-1.azuredatabricks.net',
      port: 443,
    });
    expect(workspaceOf('dbc-1.cloud.databricks.com:8443')).toEqual({
      host: 'dbc-1.cloud.databricks.com',
      port: 8443,
    });
    expect(httpPathOf('sql/1.0/warehouses/abc123')).toBe('/sql/1.0/warehouses/abc123');
    expect(httpPathOf('https://adb-1.azuredatabricks.net/sql/1.0/warehouses/abc123')).toBe(
      '/sql/1.0/warehouses/abc123',
    );
  });

  it('connects with the token, opens a session on the catalog and schema, and sets it to UTC', async () => {
    const fake = fakeDatabricks({ answer: ordersAnswer({ chunks: [] }) });
    await connector(fake).describe(contextFor(), objectSelect('sales', 'orders'));
    expect(fake.log.connects).toEqual([
      {
        host: 'adb-1234567890123456.7.azuredatabricks.net',
        path: '/sql/1.0/warehouses/abc123',
        token: TOKEN,
        timeoutMs: 2_000,
      },
    ]);
    expect(fake.log.sessions).toEqual([{ initialCatalog: 'main', initialSchema: 'sales' }]);
    expect(fake.log.statements[0]?.sql).toBe("SET TIME ZONE 'UTC'");
    expect(fake.log.statements.every((statement) => statement.queryTimeout === 2)).toBe(true);
    // Every call lets go of its operations, its session, and its client.
    expect(fake.log.closedOperations).toBe(fake.log.statements.length);
    expect(fake.log.closedSessions).toBe(1);
    expect(fake.log.closedClients).toBe(1);
  });

  it('registers itself on import', () => {
    expect(databricksConnector.kind).toBe('databricks');
  });
});

describe('databricks type mapping', () => {
  it("reads Spark's type names into classes", () => {
    for (const name of ['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'LONG'])
      expect(databricksTypeClass(name)).toBe('integer');
    expect(databricksTypeClass('DECIMAL')).toBe('decimal');
    expect(databricksTypeClass('decimal(10,2)')).toBe('decimal');
    expect(databricksTypeClass('DOUBLE')).toBe('float');
    expect(databricksTypeClass('FLOAT')).toBe('float');
    expect(databricksTypeClass('BOOLEAN')).toBe('boolean');
    expect(databricksTypeClass('DATE')).toBe('date');
    expect(databricksTypeClass('TIMESTAMP')).toBe('timestamp');
    expect(databricksTypeClass('TIMESTAMP_NTZ')).toBe('timestamp');
    expect(databricksTypeClass('STRING')).toBe('text');
    expect(databricksTypeClass('varchar(20)')).toBe('text');
    expect(databricksTypeClass('ARRAY')).toBe('json');
    expect(databricksTypeClass('array<struct<a:int>>')).toBe('json');
    expect(databricksTypeClass('MAP')).toBe('json');
    expect(databricksTypeClass('STRUCT')).toBe('json');
    expect(databricksTypeClass('VARIANT')).toBe('json');
    expect(databricksTypeClass('BINARY')).toBe('binary');
    expect(databricksTypeClass('INTERVAL_DAY_TIME')).toBe('unknown');
    expect(databricksTypeClass('GEOGRAPHY')).toBe('unknown');
  });

  it("describes a table from Unity Catalog's information schema, as the SQL connectors map types", async () => {
    const fake = fakeDatabricks({
      answer: ordersAnswer({}, [
        { column_name: 'id', data_type: 'BIGINT', full_data_type: 'bigint', is_nullable: 'NO' },
        { column_name: 'total', data_type: 'DECIMAL', full_data_type: 'decimal(10,2)', numeric_scale: 2 },
        { column_name: 'ratio', data_type: 'DOUBLE', full_data_type: 'double' },
        { column_name: 'paid', data_type: 'BOOLEAN', full_data_type: 'boolean' },
        { column_name: 'day', data_type: 'DATE', full_data_type: 'date' },
        { column_name: 'moment', data_type: 'TIMESTAMP', full_data_type: 'timestamp' },
        { column_name: 'local_time', data_type: 'TIMESTAMP_NTZ', full_data_type: 'timestamp_ntz' },
        { column_name: 'note', data_type: 'STRING', full_data_type: 'string' },
        {
          column_name: 'code',
          data_type: 'VARCHAR',
          full_data_type: 'varchar(20)',
          character_maximum_length: 20,
        },
        {
          column_name: 'essay',
          data_type: 'VARCHAR',
          full_data_type: 'varchar(4000)',
          character_maximum_length: 4000,
        },
        { column_name: 'tags', data_type: 'ARRAY', full_data_type: 'array<string>' },
        { column_name: 'address', data_type: 'STRUCT', full_data_type: 'struct<city:string,zip:int>' },
        { column_name: 'raw', data_type: 'BINARY', full_data_type: 'binary' },
        { column_name: 'span', data_type: 'INTERVAL', full_data_type: 'interval day to second' },
      ]),
    });
    const columns = await connector(fake).describe(contextFor(), objectSelect('sales', 'orders'));
    const plain = ['text', 'longText'];
    // A number can also be money or a percentage, which hold the same values.
    const numeric = ['currency', 'percent', 'text', 'longText'];
    const textual = ['longText', 'email', 'url', 'phone', 'singleSelect'];
    expect(
      columns.map((column) => [
        column.name,
        column.sourceType,
        column.nullable,
        column.suggested,
        column.alternatives,
      ]),
    ).toEqual([
      ['id', 'bigint', false, { type: 'number', options: { precision: 0 } }, numeric],
      ['total', 'decimal(10,2)', true, { type: 'number', options: { precision: 2 } }, numeric],
      ['ratio', 'double', true, { type: 'number', options: { precision: null } }, numeric],
      ['paid', 'boolean', true, { type: 'checkbox', options: {} }, plain],
      ['day', 'date', true, { type: 'date', options: {} }, plain],
      ['moment', 'timestamp', true, { type: 'date', options: { includeTime: true, timeZone: 'UTC' } }, plain],
      [
        'local_time',
        'timestamp_ntz',
        true,
        { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        plain,
      ],
      ['note', 'string', true, { type: 'text', options: {} }, textual],
      ['code', 'varchar(20)', true, { type: 'text', options: {} }, textual],
      ['essay', 'varchar(4000)', true, { type: 'longText', options: {} }, []],
      ['tags', 'array<string>', true, { type: 'longText', options: {} }, []],
      ['address', 'struct<city:string,zip:int>', true, { type: 'longText', options: {} }, []],
      ['raw', 'binary', true, null, []],
      ['span', 'interval day to second', true, null, []],
    ]);
    const lookup = fake.log.statements.find((statement) => statement.sql.includes('`columns`'));
    expect(lookup?.sql).toContain('FROM `main`.`information_schema`.`columns`');
    expect(lookup?.sql).toContain(
      'lower(table_schema) = lower(:schema) AND lower(table_name) = lower(:table)',
    );
    expect(lookup?.parameters).toEqual({ schema: 'sales', table: 'orders' });
  });

  it("describes a query from its result's columns, reading no rows", async () => {
    const fake = fakeDatabricks({
      answer: (sql) =>
        sql.includes('AS q LIMIT 0')
          ? {
              columns: [
                { name: 'id', type: 'BIGINT', precision: null, scale: null },
                { name: 'total', type: 'DECIMAL', precision: 10, scale: 2 },
              ],
            }
          : undefined,
    });
    const columns = await connector(fake).describe(
      contextFor(),
      querySelect('SELECT id, total FROM sales.orders'),
    );
    expect(
      columns.map((column) => [column.name, column.sourceType, column.nullable, column.suggested]),
    ).toEqual([
      ['id', 'BIGINT', true, { type: 'number', options: { precision: 0 } }],
      ['total', 'DECIMAL(10,2)', true, { type: 'number', options: { precision: 2 } }],
    ]);
    expect(fake.log.statements.at(-1)?.sql).toBe(
      'SELECT * FROM (\nSELECT id, total FROM sales.orders\n) AS q LIMIT 0',
    );
  });

  it('reports a table the source no longer has', async () => {
    const fake = fakeDatabricks();
    await expect(connector(fake).describe(contextFor(), objectSelect('sales', 'gone'))).rejects.toMatchObject(
      {
        messageKey: 'sources.sync.objectMissing',
        params: { object: 'gone' },
      },
    );
  });

  it("reads Databricks' own words for a missing table or column", () => {
    expect(
      databricksMissing('[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`sales`.`gone` cannot be found.'),
    ).toEqual({
      kind: 'object',
    });
    expect(
      databricksMissing(
        '[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter with name `total` cannot be resolved.',
      ),
    ).toEqual({ kind: 'column', column: 'total' });
    expect(databricksMissing('[INSUFFICIENT_PERMISSIONS] Insufficient privileges')).toBeNull();
  });
});

describe('databricks listing and keys', () => {
  it('lists tables and views from the catalog, the default schema first', async () => {
    const fake = fakeDatabricks({
      answer: (sql) =>
        sql.includes('`information_schema`.`tables`')
          ? {
              chunks: [
                [
                  { table_schema: 'archive', table_name: 'old_orders', table_type: 'EXTERNAL' },
                  { table_schema: 'sales', table_name: 'orders', table_type: 'MANAGED' },
                  { table_schema: 'sales', table_name: 'recent', table_type: 'VIEW' },
                  { table_schema: 'staging', table_name: 'daily', table_type: 'MATERIALIZED_VIEW' },
                ],
              ],
            }
          : undefined,
    });
    expect(await connector(fake).listObjects(contextFor())).toEqual([
      // Unity Catalog keeps no row counts.
      { schema: 'sales', name: 'orders', type: 'table', rowEstimate: null },
      { schema: 'sales', name: 'recent', type: 'view', rowEstimate: null },
      { schema: 'archive', name: 'old_orders', type: 'table', rowEstimate: null },
      { schema: 'staging', name: 'daily', type: 'view', rowEstimate: null },
    ]);
    const listing = fake.log.statements.at(-1);
    expect(listing?.sql).toContain('FROM `main`.`information_schema`.`tables`');
    expect(listing?.sql).toContain(
      "WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name",
    );
  });

  it('reads the catalog the warehouse starts in when the connection names none', async () => {
    const fake = fakeDatabricks({
      answer: (sql) =>
        sql.includes('current_catalog()') ? { chunks: [[{ catalog: 'Analytics' }]] } : undefined,
    });
    await connector(fake).listObjects(
      contextFor({ connection: { ...SETTINGS, catalog: undefined, schema: undefined } as SourceConnection }),
    );
    expect(fake.log.sessions).toEqual([{}]);
    expect(fake.log.statements.at(-1)?.sql).toContain('FROM `Analytics`.`information_schema`.`tables`');
  });

  it('gives the primary key first, in its declared order, then unique keys, and none for a view', async () => {
    const fake = fakeDatabricks({
      answer: (sql, parameters) => {
        if (sql.includes('`information_schema`.`tables`'))
          return {
            chunks: [
              parameters?.table === 'recent'
                ? [{ table_type: 'VIEW' }]
                : parameters?.table === 'gone'
                  ? []
                  : [{ table_type: 'MANAGED' }],
            ],
          };
        if (sql.includes('`table_constraints`'))
          return {
            chunks: [
              [
                { constraint_name: 'orders_pk', column_name: 'region' },
                { constraint_name: 'orders_pk', column_name: 'id' },
                { constraint_name: 'orders_reference', column_name: 'reference' },
              ],
            ],
          };
        return undefined;
      },
    });
    const candidates = (name: string) =>
      connector(fake).keyCandidates(contextFor(), { schema: 'sales', name });
    expect(await candidates('orders')).toEqual([['region', 'id'], ['reference']]);
    const constraints = fake.log.statements.find((statement) =>
      statement.sql.includes('`table_constraints`'),
    );
    expect(constraints?.sql).toContain("tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')");
    expect(constraints?.sql).toContain('kcu.ordinal_position');
    expect(await candidates('recent')).toEqual([]);
    await expect(candidates('gone')).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'gone' },
    });
  });
});

describe('databricks previews and reads', () => {
  it('previews the described columns with a limit, and no estimate', async () => {
    const fake = fakeDatabricks({
      answer: ordersAnswer({ chunks: [[{ id: 7n, total: '12.50', note: 'seven' }]] }),
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('sales', 'orders'), 3);
    expect(preview).toEqual({
      columns: expect.any(Array),
      rows: [[7, 12.5, 'seven']],
      rowEstimate: null,
    });
    expect(fake.log.statements.at(-1)?.sql).toBe(
      'SELECT `id`, `total`, `note` FROM `main`.`sales`.`orders` LIMIT 3',
    );
    expect(fake.log.fetches.at(-1)).toBe(3);
  });

  it('quotes a name with backticks, doubling one inside it', async () => {
    const fake = fakeDatabricks({
      answer: (sql) => {
        if (sql.includes('`information_schema`.`columns`'))
          return { chunks: [[{ column_name: 'odd`name', data_type: 'STRING', full_data_type: 'string' }]] };
        if (sql.includes('LIMIT 1')) return { chunks: [[{ 'odd`name': 'x' }]] };
        return undefined;
      },
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('odd schema', 'we`ird'), 1);
    expect(preview.rows).toEqual([['x']]);
    expect(fake.log.statements.at(-1)?.sql).toBe(
      'SELECT `odd``name` FROM `main`.`odd schema`.`we``ird` LIMIT 1',
    );
  });

  it('refuses a query that carries a second statement, before running anything', async () => {
    const fake = fakeDatabricks();
    for (const sql of [
      'SELECT 1; DROP TABLE sales.orders',
      'SELECT 1) q; DROP TABLE sales.orders; SELECT (1',
      'SELECT """x"""',
    ])
      await expect(connector(fake).preview(contextFor(), querySelect(sql), 5)).rejects.toMatchObject({
        messageKey: 'sources.sync.read',
      });
    expect(fake.log.statements.some((statement) => statement.sql.includes('DROP'))).toBe(false);
  });

  it("converts the driver's values into the forms Riosoma stores", async () => {
    const columns: Rows = [
      { column_name: 'id', data_type: 'BIGINT', full_data_type: 'bigint' },
      { column_name: 'wide', data_type: 'BIGINT', full_data_type: 'bigint' },
      { column_name: 'total', data_type: 'DECIMAL', full_data_type: 'decimal(38,4)', numeric_scale: 4 },
      { column_name: 'ratio', data_type: 'DOUBLE', full_data_type: 'double' },
      { column_name: 'paid', data_type: 'BOOLEAN', full_data_type: 'boolean' },
      { column_name: 'day', data_type: 'DATE', full_data_type: 'date' },
      { column_name: 'moment', data_type: 'TIMESTAMP', full_data_type: 'timestamp' },
      { column_name: 'text_moment', data_type: 'TIMESTAMP', full_data_type: 'timestamp' },
      { column_name: 'tags', data_type: 'ARRAY', full_data_type: 'array<string>' },
      { column_name: 'address', data_type: 'STRUCT', full_data_type: 'struct<city:string>' },
    ];
    const fake = fakeDatabricks({
      answer: ordersAnswer(
        {
          chunks: [
            [
              {
                id: 7n,
                wide: 9007199254740993n,
                total: '12345678901234567890.1200',
                ratio: 0.25,
                paid: true,
                day: new Date(Date.UTC(2024, 2, 5)),
                moment: new Date(Date.UTC(2024, 2, 5, 6, 7, 8, 500)),
                // Without Arrow's native types, a timestamp is text in the session's zone, which is UTC.
                text_moment: '2024-03-05 06:07:08.123',
                tags: ['red', 'blue'],
                address: '{"city":"Lisbon"}',
              },
            ],
          ],
        },
        columns,
      ),
    });
    const batches = await readAll(fake, contextFor(), objectSelect('sales', 'orders'), {
      columns: ['id', 'wide', 'total', 'ratio', 'paid', 'day', 'moment', 'text_moment', 'tags', 'address'],
      types: {
        id: 'number',
        wide: 'text',
        total: 'number',
        ratio: 'number',
        paid: 'checkbox',
        day: 'date',
        moment: 'date',
        text_moment: 'date',
        tags: 'longText',
        address: 'longText',
      },
      keyColumns: ['wide', 'total'],
    });
    expect(batches[0]?.[0]).toEqual({
      key: '["9007199254740993","12345678901234567890.1200"]',
      values: {
        id: 7,
        wide: '9007199254740993',
        total: 12345678901234567000,
        ratio: 0.25,
        paid: true,
        day: '2024-03-05',
        moment: '2024-03-05T06:07:08.500Z',
        text_moment: '2024-03-05T06:07:08.123Z',
        tags: '["red","blue"]',
        address: '{"city":"Lisbon"}',
      },
    });
  });

  it('reads every chunk, in batches of the size asked for', async () => {
    const chunk = (from: number, count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        id: BigInt(from + index),
        total: '1.00',
        note: 'x',
      }));
    const fake = fakeDatabricks({
      answer: ordersAnswer({ chunks: [chunk(0, 3), chunk(3, 3), chunk(6, 3)] }),
    });
    const batches = await readAll(fake, contextFor(), objectSelect('sales', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
      batchSize: 4,
    });
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 1]);
    expect(batches[2]?.[0]?.key).toBe('[8]');
    expect(fake.log.statements.at(-1)?.sql).toBe('SELECT `id` FROM `main`.`sales`.`orders`');
  });

  it('reads key columns that are not among the values, and names a column the table lacks', async () => {
    const fake = fakeDatabricks({ answer: ordersAnswer({ chunks: [[{ note: 'one', id: 1n }]] }) });
    expect(
      await readAll(fake, contextFor(), objectSelect('sales', 'orders'), {
        columns: ['note'],
        types: { note: 'text' },
        keyColumns: ['id'],
      }),
    ).toEqual([[{ key: '[1]', values: { note: 'one' } }]]);
    await expect(
      readAll(fake, contextFor(), objectSelect('sales', 'orders'), {
        columns: ['note', 'vanished'],
        types: { note: 'text' },
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'vanished' } });
  });

  it('renews the budget after each batch, and cancels an operation whose rows never come', async () => {
    const rows = [[{ id: 1n }], [{ id: 2n }], [{ id: 3n }]];
    const options = { columns: ['id'], types: { id: 'number' }, keyColumns: ['id'], batchSize: 1 };
    const paced = fakeDatabricks({ answer: ordersAnswer({ chunks: rows, chunkMs: 40 }) });
    expect(
      await readAll(paced, contextFor({ timeoutMs: 100 }), objectSelect('sales', 'orders'), options),
    ).toHaveLength(3);

    const stuck = fakeDatabricks({ answer: ordersAnswer({ chunks: rows, hangAt: 1 }) });
    await expect(
      readAll(stuck, contextFor({ timeoutMs: 100 }), objectSelect('sales', 'orders'), options),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 100 ms to answer',
    });
    expect(stuck.log.cancels).toBe(1);
    expect(stuck.log.closedSessions).toBe(1);
    expect(stuck.log.closedClients).toBe(1);
  });

  it('stops between batches when the caller gives up, and lets go of everything', async () => {
    const fake = fakeDatabricks({
      answer: ordersAnswer({ chunks: [[{ id: 1n }, { id: 2n }], [{ id: 3n }]] }),
    });
    const controller = new AbortController();
    const iterable = connector(fake).read(
      contextFor({ signal: controller.signal }),
      objectSelect('sales', 'orders'),
      {
        columns: ['id'],
        types: { id: 'number' },
        keyColumns: ['id'],
        batchSize: 1,
      },
    );
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual([{ key: '[1]', values: { id: 1 } }]);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(fake.log.cancels).toBe(1);
    expect(fake.log.closedSessions).toBe(1);
    expect(fake.log.closedClients).toBe(1);
  });

  it('scrubs a token a failed read quotes', async () => {
    const fake = fakeDatabricks({
      answer: ordersAnswer({ fetchError: new Error(`HTTP 403 for Bearer ${TOKEN}`) }),
    });
    const error = await readAll(fake, contextFor(), objectSelect('sales', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
    }).then(
      () => undefined,
      (failure: unknown) => failure as { messageKey?: string; detail?: string },
    );
    expect(error?.messageKey).toBe('sources.sync.read');
    expect(error?.detail).toContain('HTTP 403');
    expect(error?.detail).not.toContain(TOKEN);
  });
});

describe('databricks connection test', () => {
  it('checks the network, signs in, runs a query, and reports the version', async () => {
    const fake = fakeDatabricks();
    const checks = network();
    const result = await connector(fake, checks).test(contextFor());
    expect(result).toMatchObject({ ok: true, serverVersion: 'Databricks (Spark 3.5.0)' });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(checks.endpoints).toEqual([
      'adb-1234567890123456.7.azuredatabricks.net',
      'adb-1234567890123456.7.azuredatabricks.net:443',
    ]);
    expect(fake.log.closedClients).toBe(1);
  });

  it.each(['resolve', 'connect', 'tls'] as const)('stops at a failed %s check', async (step) => {
    const fake = fakeDatabricks();
    const result = await connector(fake, network(step)).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({ step, status: 'failed', messageKey: `sources.test.${step}` });
    expect(fake.log.connects).toHaveLength(0);
  });

  it('stops at authentication when the workspace refuses the token, without quoting it', async () => {
    const fake = fakeDatabricks({
      openError: Object.assign(new Error(`401 Unauthorized: token ${TOKEN} is invalid`), { statusCode: 401 }),
    });
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fake.log.closedClients).toBe(1);
  });

  it('stops at the query when the warehouse refuses one, and names a missing token', async () => {
    const refused = fakeDatabricks({
      answer: (sql) =>
        sql.includes('version()')
          ? { error: new Error('[INSUFFICIENT_PERMISSIONS] no USE CATALOG') }
          : undefined,
    });
    const queried = await connector(refused).test(contextFor());
    expect(queried.steps.at(-1)).toMatchObject({
      step: 'query',
      status: 'failed',
      messageKey: 'sources.test.query',
    });

    const missing = await connector(fakeDatabricks()).test(contextFor({ secrets: {} }));
    expect(missing.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.secretsMissing',
      detail: "the token secret isn't stored",
    });
  });

  it('calls a session that never opens a timeout', async () => {
    const fake = fakeDatabricks({ hangOpen: true });
    const result = await connector(fake).test(contextFor({ timeoutMs: 20 }));
    expect(result.steps.at(-1)).toMatchObject({ step: 'authenticate', messageKey: 'sources.test.timeout' });
  });
});

it('runs every declared contract against the native driver fixture', async () => {
  const fixture = databricksContractFixture();
  await strictFixture(
    fixture.connector,
    fixture.context,
    fixture.select,
    fixture.keyColumns,
    fixture.count,
    fixture.boundary,
  );
});

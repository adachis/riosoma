import { strictFixture } from '@riosoma/connectors';
/**
 * BigQuery against the client's interface, with a fake that records what the connector asks for
 * and answers the way `@google-cloud/bigquery` does: listings come in pages, a job may say it is
 * still running, and result rows are the client's own conversion of the API's raw rows, value
 * wrappers and all.  The live suite is `bigquery.live.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ReadOptions } from '@riosoma/connectors/internal/types.js';
import {
  bigQueryConnector,
  bigQueryMissing,
  bigQueryTypeClass,
  credentialsOf,
  type BigQueryField,
} from './bigquery.js';
import {
  fakeBigQuery,
  clientRows,
  network,
  connector,
  KEY,
  contextFor,
  objectSelect,
  querySelect,
  readAll,
  EVERY_FIELD,
  EVERY_VALUE,
  bigQueryContractFixture,
} from './bigquery.fixture.test-support.js';

describe('bigquery connection settings', () => {
  it('reads a service account key, and creates a client for the project and its location', async () => {
    expect(credentialsOf(KEY).type).toBe('service_account');
    expect(credentialsOf(KEY)).toMatchObject({
      client_email: 'reader@placeholder-project.example',
    });
    const fake = fakeBigQuery({ tables: { 'events.orders': { fields: [{ name: 'id', type: 'INTEGER' }] } } });
    await connector(fake).describe(contextFor(), objectSelect('events', 'orders'));
    expect(fake.log.clients).toEqual([
      { projectId: 'my-project', credentials: credentialsOf(KEY), location: 'US' },
    ]);
    expect(fake.log.authentications).toBe(1);
  });

  it("refuses a key that isn't a service account key, without quoting it", () => {
    expect(() => credentialsOf('{"private_key": "placeholder",')).toThrowError(
      expect.objectContaining({
        messageKey: 'sources.sync.read',
        detail: "the service account key isn't JSON",
      }),
    );
    expect(() => credentialsOf(JSON.stringify({ type: 'authorized_user' }))).toThrowError(
      expect.objectContaining({ messageKey: 'sources.sync.read' }),
    );
  });

  it('registers itself on import', () => {
    expect(bigQueryConnector.kind).toBe('bigquery');
  });
});

describe('bigquery type mapping', () => {
  it("reads BigQuery's type names into classes, a repeated field being an array", () => {
    expect(bigQueryTypeClass({ type: 'INT64' })).toBe('integer');
    expect(bigQueryTypeClass({ type: 'INTEGER' })).toBe('integer');
    expect(bigQueryTypeClass({ type: 'NUMERIC' })).toBe('decimal');
    expect(bigQueryTypeClass({ type: 'BIGNUMERIC' })).toBe('decimal');
    expect(bigQueryTypeClass({ type: 'FLOAT64' })).toBe('float');
    expect(bigQueryTypeClass({ type: 'BOOL' })).toBe('boolean');
    expect(bigQueryTypeClass({ type: 'DATE' })).toBe('date');
    expect(bigQueryTypeClass({ type: 'DATETIME' })).toBe('timestamp');
    expect(bigQueryTypeClass({ type: 'TIMESTAMP' })).toBe('timestamp');
    expect(bigQueryTypeClass({ type: 'TIME' })).toBe('time');
    expect(bigQueryTypeClass({ type: 'STRING' })).toBe('text');
    expect(bigQueryTypeClass({ type: 'JSON' })).toBe('json');
    expect(bigQueryTypeClass({ type: 'RECORD' })).toBe('json');
    expect(bigQueryTypeClass({ type: 'STRING', mode: 'REPEATED' })).toBe('json');
    expect(bigQueryTypeClass({ type: 'BYTES' })).toBe('binary');
    expect(bigQueryTypeClass({ type: 'GEOGRAPHY' })).toBe('unknown');
    expect(bigQueryTypeClass({ type: 'INTERVAL' })).toBe('unknown');
    expect(bigQueryTypeClass({ type: 'RANGE' })).toBe('unknown');
  });

  it('describes a table from its schema, as the SQL connectors map types', async () => {
    const fake = fakeBigQuery({ tables: { 'events.everything': { fields: EVERY_FIELD } } });
    const columns = await connector(fake).describe(contextFor(), objectSelect('events', 'everything'));
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
      ['id', 'INTEGER', false, { type: 'number', options: { precision: 0 } }, numeric],
      ['wide', 'INT64', true, { type: 'number', options: { precision: 0 } }, numeric],
      ['price', 'NUMERIC(10,2)', true, { type: 'number', options: { precision: 2 } }, numeric],
      // Without parameters a NUMERIC declares no scale, so values show as entered.
      ['amount', 'NUMERIC', true, { type: 'number', options: { precision: null } }, numeric],
      ['huge', 'BIGNUMERIC', true, { type: 'number', options: { precision: null } }, numeric],
      ['ratio', 'FLOAT', true, { type: 'number', options: { precision: null } }, numeric],
      ['paid', 'BOOLEAN', true, { type: 'checkbox', options: {} }, plain],
      ['day', 'DATE', true, { type: 'date', options: {} }, plain],
      [
        'local_time',
        'DATETIME',
        true,
        { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        plain,
      ],
      ['moment', 'TIMESTAMP', true, { type: 'date', options: { includeTime: true, timeZone: 'UTC' } }, plain],
      ['clock', 'TIME', true, { type: 'text', options: {} }, textual],
      ['note', 'STRING', true, { type: 'text', options: {} }, textual],
      ['essay', 'STRING(5000)', true, { type: 'longText', options: {} }, []],
      ['doc', 'JSON', true, { type: 'longText', options: {} }, []],
      ['tags', 'ARRAY<STRING>', true, { type: 'longText', options: {} }, []],
      ['address', 'RECORD', true, { type: 'longText', options: {} }, []],
      ['raw', 'BYTES', true, null, []],
      ['place', 'GEOGRAPHY', true, null, []],
      ['span', 'INTERVAL', true, null, []],
    ]);
    expect(fake.log.lookups).toEqual(['events.everything']);
  });

  it('describes a query with a dry run, which reads no data and costs nothing', async () => {
    const fake = fakeBigQuery({
      answer: () => ({
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'note', type: 'STRING' },
        ],
      }),
    });
    const columns = await connector(fake).describe(
      contextFor(),
      querySelect('SELECT id, note FROM events.orders'),
    );
    expect(columns.map((column) => [column.name, column.suggested?.type, column.nullable])).toEqual([
      ['id', 'number', true],
      ['note', 'text', true],
    ]);
    expect(fake.log.dryRuns).toEqual(['SELECT * FROM (\nSELECT id, note FROM events.orders\n) AS q']);
    expect(fake.log.queries).toEqual([]);
  });

  it('reports a table the source no longer has', async () => {
    const fake = fakeBigQuery();
    await expect(
      connector(fake).describe(contextFor(), objectSelect('events', 'gone')),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'gone' },
    });
  });

  it("reads BigQuery's own words for a missing object or column", () => {
    expect(bigQueryMissing('Not found: Table my-project:events.gone was not found in location US')).toEqual({
      kind: 'object',
    });
    expect(bigQueryMissing('Not found: Dataset my-project:gone')).toEqual({ kind: 'object' });
    expect(bigQueryMissing('Unrecognized name: total at [1:8]')).toEqual({ kind: 'column', column: 'total' });
    expect(bigQueryMissing('Name zip not found inside address at [1:16]')).toEqual({
      kind: 'column',
      column: 'zip',
    });
    expect(bigQueryMissing('Access Denied: Project my-project')).toBeNull();
  });
});

describe('bigquery listing', () => {
  it('lists every page of datasets and tables, the default dataset first, with row counts', async () => {
    const fake = fakeBigQuery({
      datasets: [['archive', 'staging'], ['EVENTS']],
      listings: {
        archive: [[{ id: 'old_orders', type: 'TABLE' }]],
        staging: [[]],
        EVENTS: [
          [{ id: 'orders', type: 'TABLE' }],
          [
            { id: 'recent', type: 'VIEW' },
            { id: 'daily', type: 'MATERIALIZED_VIEW' },
          ],
        ],
      },
      tables: {
        'EVENTS.orders': { numRows: '1200', fields: [] },
        'archive.old_orders': { numRows: '5', fields: [] },
      },
    });
    const objects = await connector(fake).listObjects(contextFor());
    expect(objects).toEqual([
      { schema: 'EVENTS', name: 'daily', type: 'view', rowEstimate: null },
      { schema: 'EVENTS', name: 'orders', type: 'table', rowEstimate: 1_200 },
      { schema: 'EVENTS', name: 'recent', type: 'view', rowEstimate: null },
      { schema: 'archive', name: 'old_orders', type: 'table', rowEstimate: 5 },
    ]);
    expect(fake.log.datasetPages).toEqual([{ maxResults: 1_000 }, { maxResults: 1_000, pageToken: '1' }]);
    // A view's count is never looked up, since a view has none.
    expect(fake.log.lookups.sort()).toEqual(['EVENTS.orders', 'archive.old_orders']);
  });
});

describe('bigquery previews and keys', () => {
  const orderFields: BigQueryField[] = [
    { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
    { name: 'total', type: 'NUMERIC', precision: '10', scale: '2' },
    { name: 'raw', type: 'BYTES' },
  ];

  it('previews a table with a limit, leaving out what Riosoma cannot hold', async () => {
    const fake = fakeBigQuery({
      tables: { 'events.orders': { numRows: '1200', fields: orderFields } },
      answer: () => ({ pages: [clientRows(orderFields, [['7', '12.50', 'YWJj']])] }),
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('events', 'orders'), 3);
    expect(preview.columns.map((column) => column.name)).toEqual(['id', 'total', 'raw']);
    expect(preview.rows).toEqual([[7, 12.5, null]]);
    expect(preview.rowEstimate).toBe(1_200);
    expect(fake.log.queries).toEqual([
      { sql: 'SELECT `id`, `total`, `raw` FROM `my-project`.`events`.`orders` LIMIT 3', jobTimeoutMs: 2_000 },
    ]);
    expect(fake.log.pages).toEqual([{ maxResults: 3 }]);
  });

  it('previews a query in its own parentheses, on the default dataset when a name has none', async () => {
    const fields: BigQueryField[] = [{ name: 'one', type: 'INT64' }];
    const fake = fakeBigQuery({ answer: () => ({ fields, pages: [clientRows(fields, [['1']])] }) });
    const preview = await connector(fake).preview(contextFor(), querySelect('SELECT 1 AS one;'), 5);
    expect(preview.rows).toEqual([[1]]);
    expect(preview.rowEstimate).toBeNull();
    expect(fake.log.queries[0]?.sql).toBe('SELECT `one` FROM (\nSELECT 1 AS one\n) AS q LIMIT 5');
  });

  it('quotes names with backticks, escaping one inside a name', async () => {
    const fields: BigQueryField[] = [{ name: 'odd`name', type: 'STRING' }];
    const fake = fakeBigQuery({
      tables: { 'my events.page\\views': { fields } },
      answer: () => ({ pages: [clientRows(fields, [['x']])] }),
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('my events', 'page\\views'), 1);
    expect(preview.rows).toEqual([['x']]);
    expect(fake.log.queries[0]?.sql).toBe(
      'SELECT `odd\\`name` FROM `my-project`.`my events`.`page\\\\views` LIMIT 1',
    );
  });

  it('refuses a query that carries a second statement, before running anything', async () => {
    const fake = fakeBigQuery();
    for (const sql of [
      'SELECT 1; DELETE FROM events.orders',
      "SELECT 1 # '\n; DELETE FROM events.orders; --'",
      "SELECT '''a'b''' ; DELETE FROM events.orders; SELECT ''",
    ])
      await expect(connector(fake).preview(contextFor(), querySelect(sql), 5)).rejects.toMatchObject({
        messageKey: 'sources.sync.read',
      });
    expect(fake.log.dryRuns).toEqual([]);
    expect(fake.log.queries).toEqual([]);
  });

  it('gives the primary key a table declares, and none for a view', async () => {
    const fake = fakeBigQuery({
      tables: {
        'events.orders': { fields: orderFields, primaryKey: ['id', 'region'] },
        'events.plain': { fields: orderFields },
        'events.recent': { type: 'VIEW', fields: orderFields, primaryKey: ['id'] },
      },
    });
    const candidates = (name: string) =>
      connector(fake).keyCandidates(contextFor(), { schema: 'events', name });
    // BigQuery records a primary key without enforcing it, and has no unique keys at all.
    expect(await candidates('orders')).toEqual([['id', 'region']]);
    expect(await candidates('plain')).toEqual([]);
    expect(await candidates('recent')).toEqual([]);
    await expect(candidates('gone')).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'gone' },
    });
  });

  it('reads a table named without a dataset from the default one, and misses without either', async () => {
    const fake = fakeBigQuery({ tables: { 'events.orders': { fields: orderFields } } });
    expect(await connector(fake).describe(contextFor(), objectSelect(null, 'orders'))).toHaveLength(3);
    await expect(
      connector(fake).describe(
        contextFor({ connection: { kind: 'bigquery', projectId: 'my-project' } }),
        objectSelect(null, 'orders'),
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing', params: { object: 'orders' } });
  });
});

describe('bigquery reads', () => {
  const everything = { 'events.everything': { fields: EVERY_FIELD } };
  const everyColumn: ReadOptions = {
    columns: EVERY_FIELD.map((field) => field.name),
    types: {
      id: 'number',
      wide: 'text',
      price: 'number',
      amount: 'text',
      huge: 'text',
      ratio: 'number',
      paid: 'checkbox',
      day: 'date',
      local_time: 'date',
      moment: 'date',
      clock: 'text',
      note: 'text',
      essay: 'longText',
      doc: 'longText',
      tags: 'longText',
      address: 'longText',
      raw: 'text',
      place: 'text',
      span: 'text',
    },
    keyColumns: ['wide', 'price'],
  };

  it("unwraps the client's values into the forms Riosoma stores", async () => {
    const fake = fakeBigQuery({
      tables: everything,
      answer: () => ({ pages: [clientRows(EVERY_FIELD, [EVERY_VALUE])] }),
    });
    const batches = await readAll(fake, contextFor(), objectSelect('events', 'everything'), everyColumn);
    expect(batches[0]?.[0]).toEqual({
      // An INT64 keeps every digit through the client's wrapper, and a NUMERIC through its big decimal.
      key: '["9007199254740993","12.5"]',
      values: {
        id: 7,
        wide: '9007199254740993',
        price: 12.5,
        amount: '0.000000001',
        huge: '123456789012345678901234567890.123456789',
        // NaN has no number form, so the cell is empty.
        ratio: null,
        paid: true,
        day: '2024-03-05',
        local_time: '2024-03-05T06:07:08.123Z',
        moment: '2024-03-05T06:07:08.500Z',
        clock: '06:07:08.120000',
        note: 'a note',
        essay: 'long words',
        doc: '{"a":1}',
        tags: '["red","blue"]',
        address: '{"city":"Lisbon","zip":1000}',
        raw: 'YWJj',
        place: 'POINT(1 2)',
        span: '1-2 3 4:5:6',
      },
    });
  });

  it('reads every page, in batches of the size asked for', async () => {
    const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER' }];
    const page = (from: number, count: number) =>
      clientRows(
        fields,
        Array.from({ length: count }, (_unused, index) => [String(from + index)]),
      );
    const fake = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ pages: [page(0, 3), page(3, 2), page(5, 4)] }),
    });
    const batches = await readAll(fake, contextFor(), objectSelect('events', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
      batchSize: 4,
    });
    expect(batches.map((batch) => batch.map((row) => row.key))).toEqual([
      ['[0]', '[1]', '[2]', '[3]'],
      ['[4]', '[5]', '[6]', '[7]'],
      ['[8]'],
    ]);
    expect(fake.log.pages).toEqual([
      { maxResults: 4 },
      { maxResults: 4, pageToken: '1' },
      { maxResults: 4, pageToken: '2' },
    ]);
    expect(fake.log.queries[0]?.sql).toBe('SELECT `id` FROM `my-project`.`events`.`orders`');
  });

  it('asks again while the job is still running, instead of reading it as empty', async () => {
    const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER' }];
    const fake = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ running: 2, pages: [clientRows(fields, [['1'], ['2']])] }),
    });
    const batches = await readAll(fake, contextFor(), objectSelect('events', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
    });
    expect(batches.flat().map((row) => row.key)).toEqual(['[1]', '[2]']);
    expect(fake.log.pages).toHaveLength(3);
  });

  it('reads key columns that are not among the values, and names a column the table lacks', async () => {
    const fields: BigQueryField[] = [
      { name: 'id', type: 'INTEGER' },
      { name: 'note', type: 'STRING' },
    ];
    const fake = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ pages: [clientRows(fields, [['1', 'one']])] }),
    });
    expect(
      await readAll(fake, contextFor(), objectSelect('events', 'orders'), {
        columns: ['note'],
        types: { note: 'text' },
        keyColumns: ['id'],
      }),
    ).toEqual([[{ key: '[1]', values: { note: 'one' } }]]);
    await expect(
      readAll(fake, contextFor(), objectSelect('events', 'orders'), {
        columns: ['note', 'vanished'],
        types: { note: 'text' },
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'vanished' } });
  });

  it('renews the budget after each batch, and cancels a job whose page never comes', async () => {
    const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER' }];
    const pages = [clientRows(fields, [['1']]), clientRows(fields, [['2']]), clientRows(fields, [['3']])];
    const paced = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ pages, pageMs: 40 }),
    });
    const options = { columns: ['id'], types: { id: 'number' }, keyColumns: ['id'], batchSize: 1 };
    expect(
      await readAll(paced, contextFor({ timeoutMs: 100 }), objectSelect('events', 'orders'), options),
    ).toHaveLength(3);

    const stuck = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ pages, hangAt: 1 }),
    });
    await expect(
      readAll(stuck, contextFor({ timeoutMs: 100 }), objectSelect('events', 'orders'), options),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 100 ms to answer',
    });
    expect(stuck.log.cancels).toBe(1);
  });

  it('stops between batches when the caller gives up, and cancels the job', async () => {
    const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER' }];
    const fake = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({ pages: [clientRows(fields, [['1'], ['2']]), clientRows(fields, [['3']])] }),
    });
    const controller = new AbortController();
    const iterable = connector(fake).read(
      contextFor({ signal: controller.signal }),
      objectSelect('events', 'orders'),
      {
        columns: ['id'],
        types: { id: 'number' },
        keyColumns: ['id'],
        batchSize: 1,
      },
    );
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toHaveLength(1);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(fake.log.cancels).toBe(1);
  });

  it('scrubs the parts of the key a failed read quotes', async () => {
    const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER' }];
    const fake = fakeBigQuery({
      tables: { 'events.orders': { fields } },
      answer: () => ({
        error: new Error(
          'Access Denied: reader@placeholder-project.example lacks bigquery.jobs.get in placeholder-project (key placeholder-key-id)',
        ),
      }),
    });
    const error = await readAll(fake, contextFor(), objectSelect('events', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
    }).then(
      () => undefined,
      (failure: unknown) => failure as { messageKey?: string; detail?: string },
    );
    expect(error?.messageKey).toBe('sources.sync.read');
    expect(error?.detail).toContain('Access Denied');
    expect(error?.detail).not.toMatch(/placeholder/);
  });
});

describe('bigquery connection test', () => {
  it('checks the network, signs in, runs a query, and names the service', async () => {
    const fake = fakeBigQuery();
    const checks = network();
    const result = await connector(fake, checks).test(contextFor());
    expect(result).toMatchObject({ ok: true, serverVersion: 'BigQuery' });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(checks.hosts).toEqual(['bigquery.googleapis.com']);
    expect(fake.log.queries).toEqual([{ sql: 'SELECT 1 AS one', jobTimeoutMs: 2_000 }]);
  });

  it.each(['resolve', 'connect', 'tls'] as const)('stops at a failed %s check', async (step) => {
    const fake = fakeBigQuery();
    const result = await connector(fake, network(step)).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({ step, status: 'failed', messageKey: `sources.test.${step}` });
    expect(fake.log.authentications).toBe(0);
  });

  it('stops at authentication when the key is refused, without quoting the key', async () => {
    const fake = fakeBigQuery({
      authError: new Error('invalid_grant: Invalid JWT Signature for reader@placeholder-project.example'),
    });
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
    });
    expect(result.steps.at(-1)?.detail).toContain('invalid_grant');
    expect(JSON.stringify(result)).not.toMatch(/placeholder/);
  });

  it('stops at authentication for a key that is not JSON, and names a missing one', async () => {
    const broken = await connector(fakeBigQuery()).test(
      contextFor({ secrets: { serviceAccountJson: '{not json' } }),
    );
    expect(broken.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.test.authenticate',
      detail: "the service account key isn't JSON",
    });
    const missing = await connector(fakeBigQuery()).test(contextFor({ secrets: {} }));
    expect(missing.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.secretsMissing',
      detail: "the serviceAccountJson secret isn't stored",
    });
  });

  it('stops at the query when the project refuses one', async () => {
    const fake = fakeBigQuery({
      answer: () => ({
        startError: new Error('Access Denied: User does not have bigquery.jobs.create permission'),
      }),
    });
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({
      step: 'query',
      status: 'failed',
      messageKey: 'sources.test.query',
    });
  });

  it('calls a sign-in that never answers a timeout', async () => {
    const result = await connector(fakeBigQuery({ authHang: true })).test(contextFor({ timeoutMs: 20 }));
    expect(result.steps.at(-1)).toMatchObject({ step: 'authenticate', messageKey: 'sources.test.timeout' });
  });
});

it('runs every declared contract against the native driver fixture', async () => {
  const fixture = bigQueryContractFixture();
  await strictFixture(
    fixture.connector,
    fixture.context,
    fixture.select,
    fixture.keyColumns,
    fixture.count,
    fixture.boundary,
  );
});

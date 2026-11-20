import { strictFixture } from '@riosoma/connectors';
/**
 * Snowflake against the driver's interface, with a small fake that records what the connector asks
 * for and answers the way `snowflake-sdk` does: `execute` returns a statement at once and calls back
 * when it finishes, a streamed result is an async iterable of row objects that a destroy ends, and
 * dates and timestamps arrive as `Date`s.  The live suite is `snowflake.live.test.ts`.
 */
import type { SourceConnection } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { ReadOptions } from '@riosoma/connectors/internal/types.js';
import {
  accountOf,
  createSnowflakeConnector,
  driverOptionsFor,
  snowflakeConnector,
  snowflakeHost,
  snowflakeMissing,
  snowflakeTypeClass,
  storedName,
} from './snowflake.js';
import {
  type Answer,
  fakeSnowflake,
  VERSION_ROW,
  catalogDriver,
  network,
  connector,
  SETTINGS,
  SECRETS,
  contextFor,
  objectSelect,
  querySelect,
  ORDER_COLUMNS,
  readAll,
  snowflakeContractFixture,
} from './snowflake.fixture.test-support.js';

describe('snowflake connection settings', () => {
  it('asks for key-pair authentication with the stored key', () => {
    const options = driverOptionsFor({ ...SETTINGS, auth: 'key-pair' } as never, {
      privateKeyPem: 'placeholder-pem',
      privateKeyPassphrase: 'placeholder-phrase',
    });
    expect(options).toMatchObject({
      account: 'myorg-myaccount',
      username: 'RIO',
      warehouse: 'ANALYTICS',
      database: 'SALES',
      schema: 'PUBLIC',
      role: 'READER',
      authenticator: 'SNOWFLAKE_JWT',
      privateKey: 'placeholder-pem',
      privateKeyPass: 'placeholder-phrase',
      rowMode: 'object',
    });
    // Numbers arrive as the source's digits and JSON as text; dates stay the driver's own `Date`s.
    expect(options.fetchAsString).toEqual(['Number', 'JSON']);
    expect(options.password).toBeUndefined();
  });

  it('asks for a password when that is the authentication', () => {
    const options = driverOptionsFor({ ...SETTINGS, auth: 'password' } as never, {
      password: 'placeholder-password',
    });
    expect(options).toMatchObject({ username: 'RIO', password: 'placeholder-password' });
    expect(options.authenticator).toBeUndefined();
    expect(options.privateKey).toBeUndefined();
  });

  it('names a secret that is missing', () => {
    expect(() => driverOptionsFor({ ...SETTINGS, auth: 'key-pair' } as never, {})).toThrowError(
      expect.objectContaining({
        messageKey: 'sources.secretsMissing',
        detail: "the privateKeyPem secret isn't stored",
        params: { secret: 'privateKeyPem' },
      }),
    );
  });

  it("leaves out a schema and role the connection doesn't name", () => {
    const options = driverOptionsFor({ ...SETTINGS, schema: undefined, role: undefined } as never, SECRETS);
    expect(options.schema).toBeUndefined();
    expect(options.role).toBeUndefined();
  });

  it('takes an account identifier from a pasted address, and finds its host the way the driver does', () => {
    expect(accountOf('https://myorg-myaccount.snowflakecomputing.com/')).toBe('myorg-myaccount');
    expect(snowflakeHost('myorg-myaccount')).toBe('myorg-myaccount.snowflakecomputing.com');
    expect(snowflakeHost('xy12345.us-east-2.aws')).toBe('xy12345.us-east-2.aws.snowflakecomputing.com');
    expect(snowflakeHost('xy12345.us-west-2')).toBe('xy12345.snowflakecomputing.com');
    expect(snowflakeHost('xy12345.cn-north-1')).toBe('xy12345.cn-north-1.snowflakecomputing.cn');
  });

  it('stores a typed name the way Snowflake does', () => {
    expect(storedName('sales')).toBe('SALES');
    expect(storedName('"Mixed Case"')).toBe('Mixed Case');
    expect(storedName('"we""ird"')).toBe('we"ird');
    expect(storedName('odd-name')).toBe('odd-name');
  });

  it('registers itself on import', () => {
    expect(snowflakeConnector.kind).toBe('snowflake');
  });
});

describe('snowflake type mapping', () => {
  it("reads the catalog's names, and the driver's own, into the same classes", () => {
    expect(snowflakeTypeClass('NUMBER', 0)).toBe('integer');
    expect(snowflakeTypeClass('NUMBER', 2)).toBe('decimal');
    expect(snowflakeTypeClass('INTEGER')).toBe('integer');
    expect(snowflakeTypeClass('FLOAT')).toBe('float');
    expect(snowflakeTypeClass('DOUBLE')).toBe('float');
    expect(snowflakeTypeClass('BOOLEAN')).toBe('boolean');
    expect(snowflakeTypeClass('DATE')).toBe('date');
    expect(snowflakeTypeClass('TIME')).toBe('time');
    // Every timestamp is read as an instant: one without a zone as UTC, the zoned ones as themselves.
    expect(snowflakeTypeClass('TIMESTAMP_NTZ')).toBe('timestamp');
    expect(snowflakeTypeClass('TIMESTAMP_LTZ')).toBe('timestamp');
    expect(snowflakeTypeClass('TIMESTAMP_TZ')).toBe('timestamp');
    expect(snowflakeTypeClass('VARCHAR')).toBe('text');
    expect(snowflakeTypeClass('TEXT')).toBe('text');
    expect(snowflakeTypeClass('VARIANT')).toBe('json');
    expect(snowflakeTypeClass('OBJECT')).toBe('json');
    expect(snowflakeTypeClass('ARRAY')).toBe('json');
    expect(snowflakeTypeClass('BINARY')).toBe('binary');
    expect(snowflakeTypeClass('GEOGRAPHY')).toBe('unknown');
    expect(snowflakeTypeClass('VECTOR')).toBe('unknown');
    // The driver's internal names for a query's columns mean the same thing.
    expect(snowflakeTypeClass('fixed', 0)).toBe('integer');
    expect(snowflakeTypeClass('fixed', 3)).toBe('decimal');
    expect(snowflakeTypeClass('real')).toBe('float');
    expect(snowflakeTypeClass('timestamp_ltz')).toBe('timestamp');
  });

  it("describes a table from the database's own catalog, as the SQL connectors map types", async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': {
        rows: [
          {
            COLUMN_NAME: 'ID',
            DATA_TYPE: 'NUMBER',
            IS_NULLABLE: 'NO',
            NUMERIC_PRECISION: '38',
            NUMERIC_SCALE: '0',
          },
          {
            COLUMN_NAME: 'TOTAL',
            DATA_TYPE: 'NUMBER',
            IS_NULLABLE: 'YES',
            NUMERIC_PRECISION: '10',
            NUMERIC_SCALE: '2',
          },
          { COLUMN_NAME: 'RATIO', DATA_TYPE: 'FLOAT', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'PAID', DATA_TYPE: 'BOOLEAN', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'DAY', DATA_TYPE: 'DATE', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'STAMP', DATA_TYPE: 'TIMESTAMP_NTZ', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'MOMENT', DATA_TYPE: 'TIMESTAMP_LTZ', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'CLOCK', DATA_TYPE: 'TIME', IS_NULLABLE: 'YES' },
          {
            COLUMN_NAME: 'NOTE',
            DATA_TYPE: 'TEXT',
            IS_NULLABLE: 'YES',
            CHARACTER_MAXIMUM_LENGTH: '16777216',
          },
          { COLUMN_NAME: 'CODE', DATA_TYPE: 'TEXT', IS_NULLABLE: 'YES', CHARACTER_MAXIMUM_LENGTH: '80' },
          { COLUMN_NAME: 'ESSAY', DATA_TYPE: 'TEXT', IS_NULLABLE: 'YES', CHARACTER_MAXIMUM_LENGTH: '4000' },
          { COLUMN_NAME: 'DOC', DATA_TYPE: 'VARIANT', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'RAW', DATA_TYPE: 'BINARY', IS_NULLABLE: 'YES' },
          { COLUMN_NAME: 'PLACE', DATA_TYPE: 'GEOGRAPHY', IS_NULLABLE: 'YES' },
        ],
      },
    });
    const columns = await connector(fake).describe(contextFor(), objectSelect('PUBLIC', 'ORDERS'));
    const plain = ['text', 'longText'];
    // A number can also be money or a percentage, which hold the same values.
    const numeric = ['currency', 'percent', 'text', 'longText'];
    const textual = ['longText', 'email', 'url', 'phone', 'singleSelect'];
    expect(columns).toEqual([
      {
        name: 'ID',
        sourceType: 'NUMBER(38,0)',
        nullable: false,
        suggested: { type: 'number', options: { precision: 0 } },
        alternatives: numeric,
      },
      {
        name: 'TOTAL',
        sourceType: 'NUMBER(10,2)',
        nullable: true,
        suggested: { type: 'number', options: { precision: 2 } },
        alternatives: numeric,
      },
      {
        name: 'RATIO',
        sourceType: 'FLOAT',
        nullable: true,
        suggested: { type: 'number', options: { precision: null } },
        alternatives: numeric,
      },
      {
        name: 'PAID',
        sourceType: 'BOOLEAN',
        nullable: true,
        suggested: { type: 'checkbox', options: {} },
        alternatives: plain,
      },
      {
        name: 'DAY',
        sourceType: 'DATE',
        nullable: true,
        suggested: { type: 'date', options: {} },
        alternatives: plain,
      },
      {
        name: 'STAMP',
        sourceType: 'TIMESTAMP_NTZ',
        nullable: true,
        suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        alternatives: plain,
      },
      {
        name: 'MOMENT',
        sourceType: 'TIMESTAMP_LTZ',
        nullable: true,
        suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        alternatives: plain,
      },
      {
        name: 'CLOCK',
        sourceType: 'TIME',
        nullable: true,
        suggested: { type: 'text', options: {} },
        alternatives: textual,
      },
      // A VARCHAR declared without a length reports Snowflake's longest, which declares nothing.
      {
        name: 'NOTE',
        sourceType: 'VARCHAR(16777216)',
        nullable: true,
        suggested: { type: 'text', options: {} },
        alternatives: textual,
      },
      {
        name: 'CODE',
        sourceType: 'VARCHAR(80)',
        nullable: true,
        suggested: { type: 'text', options: {} },
        alternatives: textual,
      },
      {
        name: 'ESSAY',
        sourceType: 'VARCHAR(4000)',
        nullable: true,
        suggested: { type: 'longText', options: {} },
        alternatives: [],
      },
      {
        name: 'DOC',
        sourceType: 'VARIANT',
        nullable: true,
        suggested: { type: 'longText', options: {} },
        alternatives: [],
      },
      { name: 'RAW', sourceType: 'BINARY', nullable: true, suggested: null, alternatives: [] },
      { name: 'PLACE', sourceType: 'GEOGRAPHY', nullable: true, suggested: null, alternatives: [] },
    ]);
    // The catalog was the database's own, quoted, with the names bound rather than written in.
    const call = fake.calls.at(-1);
    expect(call?.sql).toContain('FROM "SALES"."INFORMATION_SCHEMA"."COLUMNS"');
    expect(call?.sql).toContain('"TABLE_SCHEMA" = ? AND "TABLE_NAME" = ?');
    expect(call?.binds).toEqual(['PUBLIC', 'ORDERS']);
  });

  it('describes a query without running it', async () => {
    const fake = catalogDriver({
      'AS q': {
        columns: [
          { name: 'ID', type: 'fixed', precision: 38, scale: 0, nullable: false },
          { name: 'NOTE', type: 'text', nullable: true },
        ],
      },
    });
    const columns = await connector(fake).describe(contextFor(), querySelect('SELECT id, note FROM orders'));
    expect(columns).toEqual([
      {
        name: 'ID',
        sourceType: 'NUMBER(38,0)',
        nullable: false,
        suggested: { type: 'number', options: { precision: 0 } },
        alternatives: ['currency', 'percent', 'text', 'longText'],
      },
      {
        name: 'NOTE',
        sourceType: 'VARCHAR',
        nullable: true,
        suggested: { type: 'text', options: {} },
        alternatives: ['longText', 'email', 'url', 'phone', 'singleSelect'],
      },
    ]);
    const call = fake.calls.at(-1);
    expect(call?.describeOnly).toBe(true);
    expect(call?.sql).toBe('SELECT * FROM (\nSELECT id, note FROM orders\n) AS q');
  });

  it('reports a table the source no longer has', async () => {
    const fake = catalogDriver({ INFORMATION_SCHEMA: { rows: [] } });
    await expect(
      connector(fake).describe(contextFor(), objectSelect('PUBLIC', 'GONE')),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'GONE' },
    });
  });
});

describe('snowflake sql', () => {
  it('lists objects from the catalog, own schema first', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."TABLES': {
        // In the catalog's own order, by schema and then name.
        rows: [
          { TABLE_SCHEMA: 'ARCHIVE', TABLE_NAME: 'OLD', TABLE_TYPE: 'BASE TABLE', ROW_COUNT: '2' },
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'EXPENSIVE', TABLE_TYPE: 'VIEW', ROW_COUNT: null },
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', ROW_COUNT: '1200' },
          { TABLE_SCHEMA: 'Staging', TABLE_NAME: 'orders', TABLE_TYPE: 'MATERIALIZED VIEW', ROW_COUNT: '5' },
        ],
      },
    });
    const objects = await connector(fake).listObjects(contextFor());
    expect(objects).toEqual([
      { schema: 'PUBLIC', name: 'EXPENSIVE', type: 'view', rowEstimate: null },
      { schema: 'PUBLIC', name: 'ORDERS', type: 'table', rowEstimate: 1_200 },
      { schema: 'ARCHIVE', name: 'OLD', type: 'table', rowEstimate: 2 },
      { schema: 'Staging', name: 'orders', type: 'view', rowEstimate: null },
    ]);
    const call = fake.calls.at(-1);
    expect(call?.sql).toContain('FROM "SALES"."INFORMATION_SCHEMA"."TABLES"');
    expect(call?.sql).toContain(`"TABLE_SCHEMA" <> 'INFORMATION_SCHEMA'`);
    expect(call?.binds).toBeUndefined();
  });

  it('reads the catalog of the database, and lists the schema, as Snowflake stores their names', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."TABLES': {
        rows: [
          { TABLE_SCHEMA: 'MIXED', TABLE_NAME: 'UPPER', TABLE_TYPE: 'BASE TABLE' },
          { TABLE_SCHEMA: 'Mixed', TABLE_NAME: 'LOWER', TABLE_TYPE: 'BASE TABLE' },
        ],
      },
    });
    const objects = await connector(fake).listObjects(
      contextFor({ connection: { ...SETTINGS, database: 'sales', schema: '"Mixed"' } as SourceConnection }),
    );
    expect(fake.calls.at(-1)?.sql).toContain('FROM "SALES"."INFORMATION_SCHEMA"."TABLES"');
    expect(objects.map((object) => object.schema)).toEqual(['Mixed', 'MIXED']);
    // The driver still gets the settings as they were typed, and reads them the same way.
    expect(fake.connections[0]).toMatchObject({ database: 'sales', schema: '"Mixed"' });
  });

  it('previews an object with a limit', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"."PUBLIC"."ORDERS" LIMIT': { stream: [{ ID: '7', NOTE: 'seven' }] },
      'INFORMATION_SCHEMA"."TABLES': { rows: [{ TABLE_TYPE: 'BASE TABLE', ROW_COUNT: '7' }] },
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('PUBLIC', 'ORDERS'), 3);
    expect(preview.columns.map((column) => column.name)).toEqual(['ID', 'NOTE']);
    expect(preview.rows).toEqual([[7, 'seven']]);
    expect(preview.rowEstimate).toBe(7);
    const read = fake.calls.find((call) => call.streamResult === true);
    expect(read?.sql).toBe('SELECT "ID", "NOTE" FROM "SALES"."PUBLIC"."ORDERS" LIMIT 3');
  });

  it('wraps a query, and drops a semicolon that would end it early', async () => {
    const fake = catalogDriver({
      'SELECT * FROM (': { columns: [{ name: 'ONE', type: 'fixed', precision: 38, scale: 0 }] },
      'AS q LIMIT': { stream: [{ ONE: '1' }] },
    });
    const preview = await connector(fake).preview(contextFor(), querySelect('SELECT 1 AS one;'), 5);
    expect(preview.rows).toEqual([[1]]);
    expect(preview.rowEstimate).toBeNull();
    const sql = fake.calls.map((call) => call.sql).filter((text) => text.includes('LIMIT'));
    expect(sql).toEqual(['SELECT "ONE" FROM (\nSELECT 1 AS one\n) AS q LIMIT 5']);
  });

  it('refuses a query that carries a second statement, before asking Snowflake anything about it', async () => {
    const fake = catalogDriver({});
    await expect(
      connector(fake).preview(
        contextFor(),
        querySelect('SELECT 1) q; DELETE FROM orders; SELECT * FROM (SELECT 1'),
        5,
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(fake.calls.some((call) => call.sql.includes('DELETE'))).toBe(false);
  });

  it('quotes a name that needs it and doubles a quote inside one', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': {
        rows: [{ COLUMN_NAME: 'odd "name"', DATA_TYPE: 'TEXT', IS_NULLABLE: 'YES' }],
      },
      LIMIT: { stream: [{ 'odd "name"': 'x' }] },
    });
    const preview = await connector(fake).preview(contextFor(), objectSelect('we"ird', 'a table'), 1);
    expect(preview.rows).toEqual([['x']]);
    const sql = fake.calls.map((call) => call.sql).join('\n');
    expect(sql).toContain('SELECT "odd ""name""" FROM "SALES"."we""ird"."a table" LIMIT 1');
    // Names in catalog filters are bound, so a quote in one needs no escaping at all.
    expect(fake.calls.find((call) => call.sql.includes('"COLUMNS"'))?.binds).toEqual(['we"ird', 'a table']);
  });

  it('reads the columns asked for from a qualified table', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"."PUBLIC"."ORDERS"': { stream: [{ ID: '1' }, { ID: '2' }] },
    });
    const batches = await readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
      columns: ['ID'],
      types: { ID: 'number' },
      keyColumns: ['ID'],
    });
    expect(batches).toEqual([
      [
        { key: '[1]', values: { ID: 1 } },
        { key: '[2]', values: { ID: 2 } },
      ],
    ]);
    const read = fake.calls.filter((call) => call.streamResult === true);
    expect(read).toHaveLength(1);
    expect(read[0]?.sql).toBe('SELECT "ID" FROM "SALES"."PUBLIC"."ORDERS"');
  });

  it('gives the primary key it declares, in the order it declares it, then its unique keys', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."TABLES': { rows: [{ TABLE_TYPE: 'BASE TABLE', ROW_COUNT: '3' }] },
      'SHOW PRIMARY KEYS': {
        rows: [
          { constraint_name: 'ORDERS_PK', column_name: 'SECOND', key_sequence: '2' },
          { constraint_name: 'ORDERS_PK', column_name: 'FIRST', key_sequence: '1' },
        ],
      },
      'SHOW UNIQUE KEYS': {
        rows: [
          { constraint_name: 'UQ_REFERENCE', column_name: 'REFERENCE', key_sequence: '1' },
          { constraint_name: 'UQ_EMAIL', column_name: 'EMAIL', key_sequence: '1' },
        ],
      },
    });
    const keys = await connector(fake).keyCandidates(contextFor(), { schema: 'PUBLIC', name: 'ORDERS' });
    // Snowflake declares keys without enforcing them, and a composite key stays one candidate.
    expect(keys).toEqual([['FIRST', 'SECOND'], ['EMAIL'], ['REFERENCE']]);
    const sql = fake.calls.map((call) => call.sql);
    expect(sql).toContain('SHOW PRIMARY KEYS IN TABLE "SALES"."PUBLIC"."ORDERS"');
    expect(sql).toContain('SHOW UNIQUE KEYS IN TABLE "SALES"."PUBLIC"."ORDERS"');
  });

  it('gives no key for a view, which declares none', async () => {
    const fake = catalogDriver({ 'INFORMATION_SCHEMA"."TABLES': { rows: [{ TABLE_TYPE: 'VIEW' }] } });
    expect(await connector(fake).keyCandidates(contextFor(), { schema: 'PUBLIC', name: 'RECENT' })).toEqual(
      [],
    );
    expect(fake.calls.some((call) => call.sql.startsWith('SHOW'))).toBe(false);
  });

  it("reports a table a key request can't find as missing", async () => {
    const fake = catalogDriver({ 'INFORMATION_SCHEMA"."TABLES': { rows: [] } });
    await expect(
      connector(fake).keyCandidates(contextFor(), { schema: 'PUBLIC', name: 'GONE' }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing', params: { object: 'GONE' } });
  });

  it("reads Snowflake's own words for a missing object or column", () => {
    expect(
      snowflakeMissing(
        "SQL compilation error:\nObject 'SALES.PUBLIC.GONE' does not exist or not authorized.",
      ),
    ).toEqual({ kind: 'object' });
    expect(
      snowflakeMissing(`SQL compilation error: error line 1 at position 7\ninvalid identifier '"GONE"'`),
    ).toEqual({
      kind: 'column',
      column: 'GONE',
    });
    expect(snowflakeMissing("invalid identifier 'NOTE'")).toEqual({ kind: 'column', column: 'NOTE' });
    expect(snowflakeMissing('Warehouse suspended')).toBeNull();
  });
});

describe('snowflake values and keys', () => {
  const catalog: Answer = {
    rows: [
      {
        COLUMN_NAME: 'ID',
        DATA_TYPE: 'NUMBER',
        NUMERIC_PRECISION: '38',
        NUMERIC_SCALE: '0',
        IS_NULLABLE: 'NO',
      },
      { COLUMN_NAME: 'WIDE', DATA_TYPE: 'NUMBER', NUMERIC_PRECISION: '38', NUMERIC_SCALE: '0' },
      { COLUMN_NAME: 'TOTAL', DATA_TYPE: 'NUMBER', NUMERIC_PRECISION: '18', NUMERIC_SCALE: '2' },
      { COLUMN_NAME: 'RATIO', DATA_TYPE: 'FLOAT' },
      { COLUMN_NAME: 'PAID', DATA_TYPE: 'BOOLEAN' },
      { COLUMN_NAME: 'DAY', DATA_TYPE: 'DATE' },
      { COLUMN_NAME: 'STAMP', DATA_TYPE: 'TIMESTAMP_NTZ' },
      { COLUMN_NAME: 'MOMENT', DATA_TYPE: 'TIMESTAMP_TZ' },
      { COLUMN_NAME: 'CLOCK', DATA_TYPE: 'TIME' },
      { COLUMN_NAME: 'NOTE', DATA_TYPE: 'TEXT' },
      { COLUMN_NAME: 'DOC', DATA_TYPE: 'VARIANT' },
    ],
  };

  // What the driver hands back: digits as text, dates and timestamps as `Date`s, times as text in the
  // session's format, and JSON as the text Snowflake sent.
  const row = {
    ID: '7',
    WIDE: '9007199254740993',
    TOTAL: '12.50',
    RATIO: '2.500000000000000e-01',
    PAID: true,
    DAY: new Date(Date.UTC(2024, 2, 5)),
    STAMP: new Date(Date.UTC(2024, 2, 5, 6, 7, 8, 123)),
    MOMENT: new Date(Date.UTC(2024, 2, 5, 6, 7, 8, 500)),
    CLOCK: '06:07:08.120000000',
    NOTE: 'a note',
    DOC: '{\n  "a": 1\n}',
  };

  const options: ReadOptions = {
    columns: Object.keys(row),
    types: {
      ID: 'number',
      WIDE: 'number',
      TOTAL: 'number',
      RATIO: 'number',
      PAID: 'checkbox',
      DAY: 'date',
      STAMP: 'date',
      MOMENT: 'date',
      CLOCK: 'text',
      NOTE: 'text',
      DOC: 'longText',
    },
    keyColumns: ['ID', 'DAY'],
  };

  it('converts every type to the form Riosoma stores', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': catalog,
      'FROM "SALES"': { stream: [row] },
    });
    const batches = await readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), options);
    expect(batches[0]?.[0]?.values).toEqual({
      ID: 7,
      // A number field holds a double, as it does for the SQL connectors.
      WIDE: 9007199254740992,
      TOTAL: 12.5,
      RATIO: 0.25,
      PAID: true,
      DAY: '2024-03-05',
      STAMP: '2024-03-05T06:07:08.123Z',
      MOMENT: '2024-03-05T06:07:08.500Z',
      CLOCK: '06:07:08.12',
      NOTE: 'a note',
      DOC: '{"a":1}',
    });
    expect(batches[0]?.[0]?.key).toBe('[7,"2024-03-05"]');
  });

  it('keeps the digits a double would lose, in keys and in text', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': catalog,
      'FROM "SALES"': { stream: [row] },
    });
    const batches = await readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
      columns: ['WIDE', 'TOTAL'],
      types: { WIDE: 'text', TOTAL: 'text' },
      keyColumns: ['WIDE', 'TOTAL'],
    });
    expect(batches[0]?.[0]).toEqual({
      key: '["9007199254740993","12.50"]',
      values: { WIDE: '9007199254740993', TOTAL: '12.50' },
    });
  });

  it('streams batches of the size asked for', async () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({ ID: String(index) }));
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { stream: many },
    });
    const batches = await readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
      columns: ['ID'],
      types: { ID: 'number' },
      keyColumns: ['ID'],
      batchSize: 5,
    });
    expect(batches.map((batch) => batch.length)).toEqual([5, 5, 2]);
    expect(batches[2]?.[1]?.key).toBe('[11]');
  });

  it('reports a column the source no longer has, before reading a row', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { stream: [{ ID: '1' }] },
    });
    await expect(
      readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
        columns: ['ID', 'GONE'],
        types: { ID: 'number' },
        keyColumns: ['ID'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'GONE' } });
    expect(fake.calls.some((call) => call.streamResult === true)).toBe(false);
  });

  it("names the column a projection wouldn't bind", async () => {
    // The column went away between describing the table and reading it.
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': {
        rows: [...(ORDER_COLUMNS.rows ?? []), { COLUMN_NAME: 'GONE', DATA_TYPE: 'TEXT' }],
      },
      'SELECT "ID", "GONE"': {
        error: new Error(`SQL compilation error: error line 1 at position 13\ninvalid identifier '"GONE"'`),
      },
    });
    await expect(
      readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
        columns: ['ID', 'GONE'],
        types: { ID: 'number' },
        keyColumns: ['ID'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'GONE' } });
  });

  it('reads key columns that are not among the values, as the SQL connectors do', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { stream: [{ NOTE: 'one', ID: '1' }] },
    });
    const batches = await readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
      columns: ['NOTE'],
      types: { NOTE: 'text' },
      keyColumns: ['ID'],
    });
    expect(batches).toEqual([[{ key: '[1]', values: { NOTE: 'one' } }]]);
    expect(fake.calls.find((call) => call.streamResult === true)?.sql).toBe(
      'SELECT "NOTE", "ID" FROM "SALES"."PUBLIC"."ORDERS"',
    );
  });

  it('lets go of the session after every call', async () => {
    const fake = catalogDriver({ 'INFORMATION_SCHEMA"."TABLES': { rows: [] } });
    await connector(fake).listObjects(contextFor());
    await connector(fake)
      .keyCandidates(contextFor(), { schema: null, name: 'GONE' })
      .catch(() => undefined);
    expect(fake.connections).toHaveLength(2);
    expect(fake.destroyedConnections()).toBe(2);
  });
});

describe('snowflake failures', () => {
  it('scrubs a password the driver echoed into its own error', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."TABLES': {
        error: Object.assign(new Error('login failed for user RIO with password placeholder-password'), {
          code: 401,
        }),
      },
    });
    const ctx = contextFor({
      secrets: { password: 'placeholder-password' },
      connection: { ...SETTINGS, auth: 'password' } as SourceConnection,
    });
    const error = await connector(fake)
      .listObjects(ctx)
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ messageKey: 'sources.sync.read' });
    const detail = (error as { detail?: string }).detail ?? '';
    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain('placeholder-password');
  });

  it('reports a read that the source refused', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { error: new Error('Warehouse suspended') },
    });
    await expect(
      readAll(fake, contextFor(), objectSelect('PUBLIC', 'ORDERS'), {
        columns: ['ID'],
        types: { ID: 'number' },
        keyColumns: ['ID'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read', detail: 'Warehouse suspended' });
  });

  it('stops before it starts when the caller already gave up', async () => {
    const fake = catalogDriver({});
    await expect(
      readAll(fake, contextFor({ signal: AbortSignal.abort() }), objectSelect('PUBLIC', 'ORDERS'), {
        columns: ['ID'],
        types: { ID: 'number' },
        keyColumns: ['ID'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(fake.calls).toHaveLength(0);
    expect(fake.connections).toHaveLength(0);
  });

  it('gives up on a stream that stops answering, and lets go of it', async () => {
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { stream: [], hangStream: true },
    });
    await expect(
      readAll(fake, contextFor({ timeoutMs: 50 }), objectSelect('PUBLIC', 'ORDERS'), {
        columns: ['ID'],
        types: { ID: 'number' },
        keyColumns: ['ID'],
      }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 50 ms to answer',
    });
    // The statement had finished, so ending the read means destroying its stream and the session.
    expect(fake.destroyedStreams()).toBeGreaterThan(0);
    expect(fake.destroyedConnections()).toBe(1);
  });

  it('cancels a statement that never finishes', async () => {
    const fake = catalogDriver({ 'INFORMATION_SCHEMA"."TABLES': { hang: true } });
    await expect(connector(fake).listObjects(contextFor({ timeoutMs: 50 }))).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
    });
    expect(fake.cancels()).toBe(1);
    expect(fake.destroyedConnections()).toBe(1);
  });

  it('stops a read when the caller gives up part way through', async () => {
    const rows = Array.from({ length: 40 }, (_unused, index) => ({ ID: String(index) }));
    const fake = catalogDriver({
      'INFORMATION_SCHEMA"."COLUMNS': ORDER_COLUMNS,
      'FROM "SALES"': { stream: rows },
    });
    const controller = new AbortController();
    const sizes: number[] = [];
    await expect(
      (async () => {
        for await (const batch of connector(fake).read(
          contextFor({ signal: controller.signal, timeoutMs: 5_000 }),
          objectSelect('PUBLIC', 'ORDERS'),
          { columns: ['ID'], types: { ID: 'number' }, keyColumns: ['ID'], batchSize: 5 },
        )) {
          sizes.push(batch.length);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(sizes).toEqual([5]);
    expect(fake.destroyedConnections()).toBe(1);
  });
});

describe('snowflake connection test', () => {
  it('checks the network, authenticates, queries, and reports a version', async () => {
    const fake = catalogDriver({});
    const checks = network();
    const result = await createSnowflakeConnector({ driver: fake.driver, network: checks }).test(
      contextFor(),
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(checks.hosts).toEqual(['myorg-myaccount.snowflakecomputing.com']);
    expect(result.serverVersion).toBe('Snowflake 8.14.1');
    // The session is put into UTC, with every digit of a time and one statement per request, first.
    const first = fake.calls[0]?.sql ?? '';
    expect(first).toContain("TIMEZONE = 'UTC'");
    expect(first).toContain("TIME_OUTPUT_FORMAT = 'HH24:MI:SS.FF9'");
    expect(first).toContain('MULTI_STATEMENT_COUNT = 1');
    expect(first).toContain('STATEMENT_TIMEOUT_IN_SECONDS = 2');
    expect(fake.destroyedConnections()).toBe(1);
  });

  it('stops at authentication when the driver refuses the login', async () => {
    const fake = catalogDriver(
      {},
      Object.assign(new Error('Incorrect username or password was specified.'), { code: 390100 }),
    );
    const result = await connector(fake).test(contextFor());
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
    });
    expect(result.steps.at(-1)?.detail).toContain('Incorrect username or password');
    expect(result.steps).toHaveLength(4);
    expect(result.serverVersion).toBeUndefined();
  });

  it('stops at the query when the warehouse will not run one', async () => {
    const fake = catalogDriver({ CURRENT_VERSION: { error: new Error('Warehouse WH is suspended') } });
    const result = await connector(fake).test(contextFor());
    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['query', 'failed'],
    ]);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.test.query');
    expect(result.steps.at(-1)?.detail).toContain('suspended');
  });

  it("fails the query step for a database or warehouse the role can't use", async () => {
    const noDatabase = catalogDriver({ CURRENT_VERSION: { rows: [{ ...VERSION_ROW, database: null }] } });
    const database = await connector(noDatabase).test(contextFor());
    expect(database.steps.at(-1)).toMatchObject({
      step: 'query',
      messageKey: 'sources.test.query',
      detail: "the database SALES doesn't exist, or this role can't use it",
    });
    const noWarehouse = catalogDriver({ CURRENT_VERSION: { rows: [{ ...VERSION_ROW, warehouse: null }] } });
    const warehouse = await connector(noWarehouse).test(contextFor());
    expect(warehouse.steps.at(-1)).toMatchObject({ step: 'query', messageKey: 'sources.test.query' });
    expect(warehouse.steps.at(-1)?.detail).toContain('ANALYTICS');
  });

  it('calls a login that never answers a timeout', async () => {
    const fake = fakeSnowflake(() => ({ hang: true }));
    const result = await connector(fake).test(contextFor({ timeoutMs: 20 }));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.timeout',
    });
  });

  it('names a secret that is missing', async () => {
    const fake = catalogDriver({});
    const result = await connector(fake).test({ connection: SETTINGS, secrets: {} });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.secretsMissing',
      detail: "the privateKeyPem secret isn't stored",
    });
    expect(fake.connections).toHaveLength(0);
  });

  it('refuses connection settings for another kind of source', async () => {
    const fake = catalogDriver({});
    const result = await connector(fake).test({
      connection: { kind: 'motherduck', database: 'elsewhere' },
      secrets: {},
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.test.authenticate',
      detail: 'the connection settings are for motherduck, not snowflake',
    });
  });
});

it('runs every declared contract against the native driver fixture', async () => {
  const fixture = snowflakeContractFixture();
  await strictFixture(
    fixture.connector,
    fixture.context,
    fixture.select,
    fixture.keyColumns,
    fixture.count,
    fixture.boundary,
  );
});

import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * MotherDuck's engine is DuckDB, so this suite runs the real thing: a temporary DuckDB file that
 * the connector opens and closes per call, exactly as it would a MotherDuck database.  The
 * connection string is injectable, which is what lets a test point the connector at a local file
 * instead of `md:`, so nothing here needs a network or a token.  The live suite is
 * `motherduck.live.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { FieldOptions, type SourceColumn, type SourceObjectRef, type SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type ReadOptions,
  type SourceRow,
} from '../types.js';
import {
  createMotherDuckConnector,
  duckMissing,
  duckTypeClass,
  motherDuckConnectionString,
  motherDuckConnector,
  plainOfDuck,
} from './motherduck.js';

const DATABASE = 'analytics';
const EVERY_TYPE = `CREATE TABLE sales.types(
  tiny TINYINT,
  small SMALLINT,
  integer_ INTEGER,
  big BIGINT,
  huge HUGEINT,
  wide_unsigned UBIGINT,
  dec_small DECIMAL(10,3),
  dec_wide DECIMAL(38,10),
  float_ FLOAT,
  double_ DOUBLE,
  flag BOOLEAN,
  day DATE,
  stamp TIMESTAMP,
  stamp_zone TIMESTAMPTZ,
  stamp_seconds TIMESTAMP_S,
  stamp_millis TIMESTAMP_MS,
  stamp_nanos TIMESTAMP_NS,
  clock TIME,
  note VARCHAR,
  doc JSON,
  ident UUID,
  bits BIT,
  blob_ BLOB,
  list_ INTEGER[],
  shape STRUCT(x INTEGER, y VARCHAR),
  lookup MAP(VARCHAR, INTEGER),
  mood mood,
  span INTERVAL
)`;

const EVERY_VALUE = `INSERT INTO sales.types VALUES (
  1, 2, 3, 9007199254740993, 170141183460469231731687303715884105727, 18446744073709551615,
  12.345, '1234567890123456789012345678.1234567890'::DECIMAL(38,10), 1.5, 2.25,
  true, DATE '2024-03-05', TIMESTAMP '2024-03-05 06:07:08.123456', TIMESTAMPTZ '2024-03-05 06:07:08.5+00',
  TIMESTAMP_S '2024-03-05 06:07:08', TIMESTAMP_MS '2024-03-05 06:07:08.123', TIMESTAMP_NS '2024-03-05 06:07:08.123456789',
  TIME '06:07:08', 'a note', '{"a": 1}'::JSON, '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d'::UUID, '0101'::BIT,
  'abc'::BLOB, [1,2,3], {'x':1,'y':'z'}, map{'k':7}, 'happy'::mood, INTERVAL 3 DAY
)`;

let dir = '';
let path = '';

function contextFor(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    connection: { kind: 'motherduck', database: DATABASE },
    secrets: {},
    timeoutMs: 60_000,
    ...overrides,
  };
}

/**
 * A connector aimed at a DuckDB file, with no token to keep secret.  Calls that are meant to run out
 * of time get a file of their own, so the instance they leave behind holds no lock anyone needs.
 */
function local(databasePath = path): Connector {
  return createMotherDuckConnector({ connectionString: () => databasePath });
}

const objectSelect = (schema: string | null, name: string): SourceSelect => ({
  kind: 'object',
  object: { schema, name },
});
const querySelect = (sql: string): SourceSelect => ({ kind: 'query', sql });

async function readAll(
  connector: Connector,
  ctx: ConnectorContext,
  select: SourceSelect,
  options: ReadOptions,
): Promise<SourceRow[][]> {
  const batches: SourceRow[][] = [];
  for await (const batch of connector.read(ctx, select, options)) batches.push(batch);
  return batches;
}

function byName(columns: SourceColumn[]): Map<string, SourceColumn> {
  return new Map(columns.map((column) => [column.name, column]));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rio-motherduck-'));
  // The file's name becomes DuckDB's catalog name, which is what a MotherDuck database does too.
  path = join(dir, `${DATABASE}.duckdb`);
  const instance = await DuckDBInstance.create(path);
  const session = await instance.connect();
  await session.run('CREATE SCHEMA sales');
  await session.run("CREATE TYPE mood AS ENUM ('sad','ok','happy')");
  await session.run(EVERY_TYPE);
  await session.run(EVERY_VALUE);
  await session.run(
    'CREATE TABLE sales.orders(id BIGINT PRIMARY KEY, region VARCHAR UNIQUE, total DECIMAL(18,2), placed TIMESTAMP, note VARCHAR)',
  );
  await session.run(
    `INSERT INTO sales.orders
       SELECT i, 'region-' || i, i * 1.5, TIMESTAMP '2024-01-01 00:00:00' + to_minutes(i),
              CASE WHEN i % 101 = 7 THEN NULL ELSE 'note ' || i END
         FROM range(12000) AS t(i)`,
  );
  await session.run(
    'CREATE TABLE sales.accounts(ident INTEGER PRIMARY KEY, handle VARCHAR UNIQUE, backup VARCHAR UNIQUE)',
  );
  await session.run("INSERT INTO sales.accounts VALUES (1, 'one', 'uno'), (2, 'two', 'dos')");
  await session.run('CREATE TABLE sales.pairs(left_ INTEGER, right_ INTEGER, PRIMARY KEY(left_, right_))');
  await session.run('INSERT INTO sales.pairs VALUES (1, 1), (1, 2)');
  await session.run('CREATE TABLE main.people(email VARCHAR, name VARCHAR)');
  await session.run("INSERT INTO main.people VALUES ('a@example.com', 'Ada')");
  await session.run('CREATE TABLE sales."Odd ""Name"""("Mixed Case" INTEGER)');
  await session.run('INSERT INTO sales."Odd ""Name""" VALUES (42)');
  await session.run('CREATE VIEW sales.expensive AS SELECT id, total FROM sales.orders WHERE total > 100');
  session.disconnectSync();
  instance.closeSync();
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('motherduck connection string', () => {
  it('carries the token, attaches one database, and keeps queries away from local files', () => {
    expect(
      motherDuckConnectionString(
        { kind: 'motherduck', database: 'analytics' },
        { token: 'placeholder-token' },
      ),
    ).toBe('md:analytics?attach_mode=single&saas_mode=true&motherduck_token=placeholder-token');
  });

  it('escapes a token that could end the query string', () => {
    expect(motherDuckConnectionString({ kind: 'motherduck', database: 'sales' }, { token: 'a/b+c=&' })).toBe(
      'md:sales?attach_mode=single&saas_mode=true&motherduck_token=a%2Fb%2Bc%3D%26',
    );
  });

  it('refuses a database name that could attach something else', () => {
    expect(() =>
      motherDuckConnectionString({ kind: 'motherduck', database: 'good?other=1' }, { token: 'placeholder' }),
    ).toThrowError(ConnectorError);
  });

  it('names the secret that is missing instead of guessing one', () => {
    expect(() => motherDuckConnectionString({ kind: 'motherduck', database: 'analytics' }, {})).toThrowError(
      expect.objectContaining({ messageKey: 'sources.secretsMissing', params: { secret: 'token' } }),
    );
  });

  it('registers itself on import', () => {
    expect(motherDuckConnector.kind).toBe('motherduck');
  });
});

describe('motherduck type mapping', () => {
  it('reads each type DuckDB reports into the class Riosoma holds it as', async () => {
    const instance = await DuckDBInstance.create(path);
    const session = await instance.connect();
    try {
      const prepared = await session.prepare('SELECT * FROM sales.types');
      const classes = Object.fromEntries(
        Array.from({ length: prepared.columnCount }, (_unused, index) => [
          prepared.columnName(index),
          duckTypeClass(prepared.columnType(index)),
        ]),
      );
      expect(classes).toMatchObject({
        tiny: { kind: 'integer' },
        huge: { kind: 'integer' },
        wide_unsigned: { kind: 'integer' },
        dec_wide: { kind: 'decimal', scale: 10 },
        double_: { kind: 'float' },
        flag: { kind: 'boolean' },
        day: { kind: 'date' },
        clock: { kind: 'time' },
        stamp: { kind: 'timestamp' },
        stamp_nanos: { kind: 'timestamp' },
        stamp_zone: { kind: 'timestamp' },
        note: { kind: 'text' },
        ident: { kind: 'text' },
        doc: { kind: 'json' },
        list_: { kind: 'json' },
        shape: { kind: 'json' },
        lookup: { kind: 'json' },
        mood: { kind: 'text', labels: ['sad', 'ok', 'happy'] },
        blob_: { kind: 'binary' },
        // Types Riosoma can't hold are named, not guessed at.
        bits: { kind: 'unknown' },
        span: { kind: 'unknown' },
      });
    } finally {
      session.disconnectSync();
      instance.closeSync();
    }
  });

  it('describes a table with a suggestion, its source type, and alternatives, as the SQL connectors do', async () => {
    const columns = byName(await local().describe(contextFor(), objectSelect('sales', 'types')));
    const expectSuggestion = (name: string, type: string, options: Record<string, unknown> = {}) => {
      expect(columns.get(name)?.suggested, name).toEqual({ type, options });
      expect(FieldOptions[type as keyof typeof FieldOptions].safeParse(options).success, name).toBe(true);
    };
    expectSuggestion('tiny', 'number', { precision: 0 });
    expectSuggestion('big', 'number', { precision: 0 });
    expectSuggestion('huge', 'number', { precision: 0 });
    expectSuggestion('dec_small', 'number', { precision: 3 });
    expectSuggestion('dec_wide', 'number', { precision: 8 });
    expectSuggestion('double_', 'number', { precision: null });
    expectSuggestion('flag', 'checkbox');
    expectSuggestion('day', 'date');
    // Every timestamp is read and shown in UTC, zoned or not, as it is for the SQL connectors.
    expectSuggestion('stamp', 'date', { includeTime: true, timeZone: 'UTC' });
    expectSuggestion('stamp_seconds', 'date', { includeTime: true, timeZone: 'UTC' });
    expectSuggestion('stamp_zone', 'date', { includeTime: true, timeZone: 'UTC' });
    expectSuggestion('clock', 'text');
    expectSuggestion('note', 'text');
    expectSuggestion('doc', 'longText');
    expectSuggestion('ident', 'text');
    expectSuggestion('list_', 'longText');
    expectSuggestion('shape', 'longText');
    expectSuggestion('lookup', 'longText');
    // An enumeration is a single select, its labels the choices.
    expect(columns.get('mood')?.suggested?.type).toBe('singleSelect');
    expect(
      FieldOptions.singleSelect
        .parse(columns.get('mood')?.suggested?.options)
        .choices.map((choice) => choice.name),
    ).toEqual(['sad', 'ok', 'happy']);
    // Nothing Riosoma can't hold is offered as a field at all.
    for (const unsupported of ['blob_', 'bits', 'span']) {
      expect(columns.get(unsupported)?.suggested, unsupported).toBeNull();
      expect(columns.get(unsupported)?.alternatives, unsupported).toEqual([]);
    }
    expect(columns.get('note')?.alternatives).toEqual(['longText', 'email', 'url', 'phone', 'singleSelect']);
    expect(columns.get('tiny')?.alternatives).toEqual(['currency', 'percent', 'text', 'longText']);
    expect(columns.get('doc')?.alternatives).toEqual([]);
    expect(columns.get('note')?.sourceType).toBe('VARCHAR');
    expect(columns.get('doc')?.sourceType).toBe('JSON');
    expect(columns.get('dec_wide')?.sourceType).toBe('DECIMAL(38,10)');
    expect(columns.get('note')?.nullable).toBe(true);
  });

  it('reads nullability from the catalog', async () => {
    const columns = byName(await local().describe(contextFor(), objectSelect('sales', 'orders')));
    expect(columns.get('id')?.nullable).toBe(false);
    expect(columns.get('note')?.nullable).toBe(true);
  });

  it('describes a query without running it', async () => {
    const columns = await local().describe(
      contextFor(),
      querySelect('SELECT id, total, note FROM sales.orders LIMIT 1'),
    );
    expect(columns.map((column) => column.name)).toEqual(['id', 'total', 'note']);
    expect(columns.map((column) => column.suggested?.type)).toEqual(['number', 'number', 'text']);
    expect(columns[0]?.sourceType).toBe('BIGINT');
    // A query declares nothing, so every column reads as nullable.
    expect(columns.every((column) => column.nullable)).toBe(true);
  });

  it('reports a table the source no longer has', async () => {
    await expect(local().describe(contextFor(), objectSelect('sales', 'gone'))).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'gone' },
    });
  });

  it("reads DuckDB's own words for a missing table or column", () => {
    expect(duckMissing('Catalog Error: Table with name gone does not exist!')).toEqual({ kind: 'object' });
    expect(duckMissing('Binder Error: Referenced column "total" not found in FROM clause!')).toEqual({
      kind: 'column',
      column: 'total',
    });
    expect(duckMissing('Out of Memory Error')).toBeNull();
  });
});

describe('motherduck value conversion', () => {
  const everyColumn: ReadOptions = {
    columns: [
      'tiny',
      'integer_',
      'big',
      'huge',
      'wide_unsigned',
      'dec_small',
      'dec_wide',
      'float_',
      'double_',
      'flag',
      'day',
      'stamp',
      'stamp_zone',
      'stamp_seconds',
      'stamp_millis',
      'stamp_nanos',
      'clock',
      'note',
      'doc',
      'ident',
      'bits',
      'blob_',
      'list_',
      'shape',
      'lookup',
      'mood',
    ],
    types: {
      tiny: 'number',
      integer_: 'number',
      big: 'number',
      huge: 'number',
      wide_unsigned: 'number',
      dec_small: 'number',
      dec_wide: 'number',
      float_: 'number',
      double_: 'number',
      flag: 'checkbox',
      day: 'date',
      stamp: 'date',
      stamp_zone: 'date',
      stamp_seconds: 'date',
      stamp_millis: 'date',
      stamp_nanos: 'date',
      clock: 'text',
      note: 'text',
      doc: 'longText',
      ident: 'text',
      bits: 'text',
      blob_: 'longText',
      list_: 'longText',
      shape: 'longText',
      lookup: 'longText',
      mood: 'singleSelect',
    },
    keyColumns: ['ident'],
  };

  it('writes every type in the form Riosoma stores', async () => {
    const batches = await readAll(local(), contextFor(), objectSelect('sales', 'types'), everyColumn);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.values).toEqual({
      tiny: 1,
      integer_: 3,
      // A number field holds a double, as it does for the SQL connectors, and text keeps every digit.
      big: Number('9007199254740993'),
      huge: Number('170141183460469231731687303715884105727'),
      wide_unsigned: Number('18446744073709551615'),
      dec_small: 12.345,
      dec_wide: Number('1234567890123456789012345678.1234567890'),
      float_: 1.5,
      double_: 2.25,
      flag: true,
      day: '2024-03-05',
      stamp: '2024-03-05T06:07:08.123Z',
      stamp_zone: '2024-03-05T06:07:08.500Z',
      stamp_seconds: '2024-03-05T06:07:08.000Z',
      stamp_millis: '2024-03-05T06:07:08.123Z',
      stamp_nanos: '2024-03-05T06:07:08.123Z',
      clock: '06:07:08',
      note: 'a note',
      doc: '{"a":1}',
      ident: '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
      bits: '0101',
      // A binary column has no field type, but reading one anyway gives text a faithful form.
      blob_: Buffer.from('abc').toString('base64'),
      list_: '[1,2,3]',
      shape: '{"x":1,"y":"z"}',
      lookup: '{"k":7}',
      // An enumeration reads as the label itself, which is what a single select matches on.
      mood: 'happy',
    });
    expect(batches[0]?.[0]?.key).toBe(JSON.stringify(['2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d']));
  });

  it('keeps every digit of a wide number in text and in keys', async () => {
    const batches = await readAll(local(), contextFor(), objectSelect('sales', 'types'), {
      columns: ['big', 'huge', 'dec_wide'],
      types: { big: 'text', huge: 'text', dec_wide: 'text' },
      keyColumns: ['huge', 'dec_wide'],
    });
    expect(batches[0]?.[0]).toEqual({
      key: '["170141183460469231731687303715884105727","1234567890123456789012345678.1234567890"]',
      values: {
        big: '9007199254740993',
        huge: '170141183460469231731687303715884105727',
        dec_wide: '1234567890123456789012345678.1234567890',
      },
    });
  });

  it('turns a DuckDB wrapper into a plain value, including one a double cannot hold', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const session = await instance.connect();
    const result = await session.runAndReadAll(
      `SELECT 1.5::DECIMAL(4,1) AS dec, DATE '2024-03-05' AS day, TIMESTAMP '2024-03-05 06:07:08' AS stamp,
              '2024-03-05 06:07:08+00'::TIMESTAMPTZ AS zoned, [1,2]::BIGINT[] AS list,
              170141183460469231731687303715884105727::HUGEINT AS huge, NULL::INTEGER AS nothing`,
    );
    const row = result.getRows()[0] ?? [];
    expect(row.map((value) => plainOfDuck(value))).toEqual([
      '1.5',
      new Date(Date.UTC(2024, 2, 5)),
      new Date(Date.UTC(2024, 2, 5, 6, 7, 8)),
      new Date(Date.UTC(2024, 2, 5, 6, 7, 8)),
      [1, 2],
      '170141183460469231731687303715884105727',
      null,
    ]);
    session.disconnectSync();
    instance.closeSync();
  });
});

describe('motherduck listing', () => {
  it('lists tables and views with a row estimate from the catalog, own schema first', async () => {
    const objects = await local().listObjects(contextFor());
    const names = objects.map((object) => `${object.schema}.${object.name}`);
    expect(names).toContain('sales.orders');
    expect(names).toContain('sales.expensive');
    expect(names).toContain('sales.Odd "Name"');
    expect(names[0]).toBe('main.people');
    expect(objects.some((object) => object.schema === 'information_schema')).toBe(false);
    const orders = objects.find((object) => object.name === 'orders');
    expect(orders?.type).toBe('table');
    expect(orders?.rowEstimate).toBe(12_000);
    const view = objects.find((object) => object.name === 'expensive');
    expect(view?.type).toBe('view');
    expect(view?.rowEstimate).toBeNull();
  });
});

describe('motherduck previews', () => {
  it('previews a table with its columns, rows, and estimate', async () => {
    const preview = await local().preview(contextFor(), objectSelect('sales', 'orders'), 3);
    expect(preview.columns.map((column) => column.name)).toEqual(['id', 'region', 'total', 'placed', 'note']);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows[0]).toEqual([0, 'region-0', 0, '2024-01-01T00:00:00.000Z', 'note 0']);
    expect(preview.rowEstimate).toBe(12_000);
  });

  it('previews a query with no estimate', async () => {
    const preview = await local().preview(
      contextFor(),
      querySelect('SELECT id, note FROM sales.orders WHERE id < 2'),
      5,
    );
    expect(preview.columns.map((column) => column.name)).toEqual(['id', 'note']);
    expect(preview.rows).toEqual([
      [0, 'note 0'],
      [1, 'note 1'],
    ]);
    expect(preview.rowEstimate).toBeNull();
  });

  it('reads a name that needs quoting, with a quote inside it', async () => {
    const preview = await local().preview(contextFor(), objectSelect('sales', 'Odd "Name"'), 5);
    expect(preview.columns.map((column) => column.name)).toEqual(['Mixed Case']);
    expect(preview.rows).toEqual([[42]]);
  });

  it('leaves out values Riosoma cannot hold', async () => {
    const preview = await local().preview(contextFor(), objectSelect('sales', 'types'), 1);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({ blob_: null, bits: null, span: null, mood: 'happy', flag: true });
  });

  it('refuses a limit that would read nothing', async () => {
    await expect(local().preview(contextFor(), objectSelect('sales', 'orders'), 0)).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
    });
  });
});

describe('motherduck keys', () => {
  const candidates = (object: SourceObjectRef) => local().keyCandidates(contextFor(), object);

  it('gives the primary key first, then the unique constraints', async () => {
    expect(await candidates({ schema: 'sales', name: 'accounts' })).toEqual([
      ['ident'],
      ['handle'],
      ['backup'],
    ]);
  });

  it('gives a whole composite key as one candidate', async () => {
    expect(await candidates({ schema: 'sales', name: 'pairs' })).toEqual([['left_', 'right_']]);
  });

  it('gives none for a view, which declares nothing', async () => {
    expect(await candidates({ schema: 'sales', name: 'expensive' })).toEqual([]);
  });

  it('reports a table the source no longer has', async () => {
    await expect(candidates({ schema: 'sales', name: 'gone' })).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'gone' },
    });
  });
});

describe('motherduck reads', () => {
  it('streams batches of the size asked for', async () => {
    const batches = await readAll(local(), contextFor(), objectSelect('sales', 'orders'), {
      columns: ['id', 'total'],
      types: { id: 'number', total: 'number' },
      keyColumns: ['id'],
      batchSize: 5_000,
    });
    expect(batches.map((batch) => batch.length)).toEqual([5_000, 5_000, 2_000]);
    expect(batches[0]?.[0]).toEqual({ key: '[0]', values: { id: 0, total: 0 } });
    expect(batches[2]?.[1_999]?.key).toBe('[11999]');
  });

  it('defaults to batches of five thousand rows', async () => {
    const batches = await readAll(local(), contextFor(), objectSelect('sales', 'orders'), {
      columns: ['id'],
      types: { id: 'number' },
      keyColumns: ['id'],
    });
    expect(batches.map((batch) => batch.length)).toEqual([5_000, 5_000, 2_000]);
  });

  it('reads a query wrapped as a subquery', async () => {
    const batches = await readAll(
      local(),
      contextFor(),
      querySelect('SELECT id, note FROM sales.orders WHERE id % 4000 = 0 ORDER BY id'),
      { columns: ['id', 'note'], types: { id: 'number', note: 'text' }, keyColumns: ['id'], batchSize: 2 },
    );
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(batches[0]?.[0]?.values).toEqual({ id: 0, note: 'note 0' });
  });

  it('reports a column the source no longer has', async () => {
    await expect(
      readAll(local(), contextFor(), objectSelect('sales', 'orders'), {
        columns: ['id', 'vanished'],
        types: { id: 'number' },
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'vanished' } });
  });

  it('reads key columns that are not among the values, as the SQL connectors do', async () => {
    const batches = await readAll(
      local(),
      contextFor(),
      querySelect('SELECT * FROM sales.pairs ORDER BY right_'),
      {
        columns: ['right_'],
        types: { right_: 'number' },
        keyColumns: ['left_', 'right_'],
      },
    );
    expect(batches).toEqual([
      [
        { key: '[1,1]', values: { right_: 1 } },
        { key: '[1,2]', values: { right_: 2 } },
      ],
    ]);
  });

  it('reports a failure part way through a read', async () => {
    await expect(
      readAll(
        local(),
        contextFor(),
        querySelect("SELECT CASE WHEN i = 5 THEN error('boom') ELSE i END AS n FROM range(100) AS t(i)"),
        {
          columns: ['n'],
          types: { n: 'number' },
          keyColumns: ['n'],
        },
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  });

  it('stops before it starts when the caller already gave up', async () => {
    await expect(
      readAll(local(), contextFor({ signal: AbortSignal.abort() }), objectSelect('sales', 'orders'), {
        columns: ['id'],
        types: { id: 'number' },
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  });

  it('stops a long read part way through', async () => {
    const controller = new AbortController();
    const sizes: number[] = [];
    await expect(
      (async () => {
        for await (const batch of local().read(
          contextFor({ signal: controller.signal }),
          objectSelect('sales', 'orders'),
          {
            columns: ['id'],
            types: { id: 'number' },
            keyColumns: ['id'],
            batchSize: 2_000,
          },
        )) {
          sizes.push(batch.length);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    expect(sizes).toEqual([2_000]);
  });

  it('gives up when the source is slower than the deadline', async () => {
    const connector = createMotherDuckConnector({
      connectionString: () => join(dir, 'slow-read.duckdb'),
      openInstance: async (text) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return DuckDBInstance.create(text);
      },
    });
    await expect(
      readAll(connector, contextFor({ timeoutMs: 5 }), objectSelect('sales', 'orders'), {
        columns: ['id'],
        types: { id: 'number' },
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: 'the source took longer than 5 ms to answer',
    });
  });

  it('refuses a query that carries a second statement', async () => {
    await expect(
      readAll(local(), contextFor(), querySelect('SELECT 1 AS one; DROP TABLE sales.orders'), {
        columns: ['one'],
        types: { one: 'number' },
        keyColumns: ['one'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    // The table that query tried to drop is still there.
    const objects = await local().listObjects(contextFor());
    expect(objects.some((object) => object.name === 'orders')).toBe(true);
  });
});

describe('motherduck connection test', () => {
  it('skips the network checks MotherDuck makes itself, then authenticates and queries', async () => {
    const result = await local().test(contextFor());
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'skipped'],
      ['connect', 'skipped'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.steps[3]?.ms).toBeGreaterThanOrEqual(0);
    expect(result.serverVersion).toMatch(/^DuckDB v?\d+\.\d+/);
  });

  it('reports a missing secret at the step it stops at', async () => {
    const result = await createMotherDuckConnector().test({
      connection: { kind: 'motherduck', database: DATABASE },
      secrets: {},
    });
    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'skipped'],
      ['connect', 'skipped'],
      ['tls', 'skipped'],
      ['authenticate', 'failed'],
    ]);
    expect(result.steps[3]).toMatchObject({
      messageKey: 'sources.secretsMissing',
      detail: "the token secret isn't stored",
    });
    expect(result.serverVersion).toBeUndefined();
  });

  it('scrubs a token a driver echoed into its own error', async () => {
    const connector = createMotherDuckConnector({
      connectionString: (_connection, secrets) => `md:x?motherduck_token=${secrets.token ?? ''}`,
      openInstance: async (text) => {
        throw new Error(`cannot open ${text}`);
      },
    });
    const result = await connector.test({
      connection: { kind: 'motherduck', database: 'x' },
      secrets: { token: 'placeholder-secret-value' },
    });
    expect(result.ok).toBe(false);
    expect(result.steps[3]).toMatchObject({ status: 'failed', messageKey: 'sources.test.authenticate' });
    expect(result.steps[3]?.detail).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain('placeholder-secret-value');
  });

  it('calls a deadline what it is', async () => {
    const slow = join(dir, 'slow-test.duckdb');
    const connector = createMotherDuckConnector({
      connectionString: () => slow,
      openInstance: async (text) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return DuckDBInstance.create(text);
      },
    });
    const result = await connector.test(contextFor({ timeoutMs: 5 }));
    expect(result.ok).toBe(false);
    expect(result.steps[3]).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.timeout',
    });
  });

  it('refuses connection settings for another kind of source', async () => {
    const result = await local().test({
      connection: { kind: 'bigquery', projectId: 'elsewhere' },
      secrets: {},
    });
    expect(result.ok).toBe(false);
    expect(result.steps[3]).toMatchObject({
      messageKey: 'sources.test.authenticate',
      detail: 'the connection settings are for bigquery, not motherduck',
    });
  });
});

it('runs every declared contract against the installed engine fixture', async () => {
  const boundary = new FixtureBoundary();
  await strictFixture(
    createMotherDuckConnector({
      connectionString: () => path,
      openInstance: boundary.wrap((filename) => DuckDBInstance.create(filename), 'openInstance'),
    }),
    contextFor({ secrets: { token: crypto.randomUUID() } }),
    { kind: 'object', object: { schema: 'sales', name: 'accounts' } },
    ['ident'],
    2,
    boundary,
  );
});

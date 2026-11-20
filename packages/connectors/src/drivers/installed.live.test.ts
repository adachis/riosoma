import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SourceConnection, type SourceObjectRef } from '@riosoma/contracts';
import { db2Connector } from '../db2.js';
import { informixConnector } from '../informix.js';
import { teradataConnector } from '../teradata.js';
import type { Connector, ConnectorContext, SourceRow } from '../types.js';
import type { DriverId } from './catalog.js';
import { driverEnvironment } from './process.js';
import { useInstalledDriver } from './storage.js';

/**
 * Live runs of the three installed-driver sources, each against a real database, through a driver
 * installed in `RIOSOMA_DRIVERS_DIR` the way the server installs one.  A system runs only when its
 * settings are all set, and it creates and drops only objects named `rio_test_`.
 */
interface LiveSystem {
  connector: Connector;
  driver: DriverId;
  /** The settings that name the database, all required */
  settings: string[];
  connection(env: NodeJS.ProcessEnv): Record<string, unknown>;
  /** The statements that make the test objects, after dropping any a failed run left */
  create: string[];
  drop: string[];
  /** A query that keeps the server busy for longer than the abort test waits */
  slow: string;
  /** How the system spells a name it stores unquoted */
  stored(name: string): string;
  /** What a boolean column reads as, for a system without booleans */
  booleans: 'checkbox' | 'number';
}

const rows = (values: (a: string, b: string, c: string) => string[]) => values('a', 'b', 'c');

const systems: LiveSystem[] = [
  {
    connector: teradataConnector,
    driver: 'teradatasql',
    settings: ['RIOSOMA_TERADATA_HOST', 'RIOSOMA_TERADATA_USER', 'RIOSOMA_TERADATA_PASSWORD'],
    connection: (env) => ({
      kind: 'teradata',
      host: env.RIOSOMA_TERADATA_HOST,
      user: env.RIOSOMA_TERADATA_USER,
      ...(env.RIOSOMA_TERADATA_PORT ? { port: Number(env.RIOSOMA_TERADATA_PORT) } : {}),
      ...(env.RIOSOMA_TERADATA_TLS ? { secure: env.RIOSOMA_TERADATA_TLS !== 'off' } : {}),
    }),
    create: [
      `CREATE MULTISET TABLE rio_test_items (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(24,8),
        title VARCHAR(100), enabled BYTEINT, day DATE, instant TIMESTAMP(3), ratio FLOAT,
        code VARCHAR(20) NOT NULL UNIQUE)`,
      ...rows((a, b, c) => [
        `INSERT INTO rio_test_items VALUES (9007199254740993, 1234567890123456.12345678, 'First', 1,
          DATE '2026-01-01', TIMESTAMP '2026-01-01 12:00:00.000', 0.5, '${a}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740994, 2.5, 'Second', 0, DATE '2026-01-02',
          TIMESTAMP '2026-01-02 12:00:00.000', 1.25, '${b}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740995, NULL, NULL, NULL, NULL, NULL, NULL, '${c}')`,
      ]),
      'CREATE VIEW rio_test_view AS SELECT id, title FROM rio_test_items',
    ],
    drop: ['DROP VIEW rio_test_view', 'DROP TABLE rio_test_items'],
    slow: 'SELECT COUNT(*) AS n FROM DBC.ColumnsV a CROSS JOIN DBC.ColumnsV b CROSS JOIN DBC.ColumnsV c',
    stored: (name) => name,
    booleans: 'number',
  },
  {
    connector: db2Connector,
    driver: 'ibm_db',
    settings: ['RIOSOMA_DB2_HOST', 'RIOSOMA_DB2_DATABASE', 'RIOSOMA_DB2_USER', 'RIOSOMA_DB2_PASSWORD'],
    connection: (env) => ({
      kind: 'db2',
      host: env.RIOSOMA_DB2_HOST,
      port: Number(env.RIOSOMA_DB2_PORT ?? 50000),
      database: env.RIOSOMA_DB2_DATABASE,
      user: env.RIOSOMA_DB2_USER,
      secure: env.RIOSOMA_DB2_TLS === 'on',
    }),
    create: [
      `CREATE TABLE rio_test_items (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(24,8),
        title VARCHAR(100), enabled BOOLEAN, day DATE, instant TIMESTAMP(3), ratio DOUBLE,
        code VARCHAR(20) NOT NULL, CONSTRAINT rio_test_code UNIQUE (code))`,
      ...rows((a, b, c) => [
        `INSERT INTO rio_test_items VALUES (9007199254740993, 1234567890123456.12345678, 'First', TRUE,
          DATE '2026-01-01', TIMESTAMP '2026-01-01 12:00:00.000', 0.5, '${a}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740994, 2.5, 'Second', FALSE, DATE '2026-01-02',
          TIMESTAMP '2026-01-02 12:00:00.000', 1.25, '${b}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740995, NULL, NULL, NULL, NULL, NULL, NULL, '${c}')`,
      ]),
      'CREATE VIEW rio_test_view AS SELECT id, title FROM rio_test_items',
    ],
    drop: ['DROP VIEW rio_test_view', 'DROP TABLE rio_test_items'],
    slow: 'SELECT COUNT(*) AS n FROM SYSCAT.COLUMNS a, SYSCAT.COLUMNS b, SYSCAT.COLUMNS c',
    stored: (name) => name.toUpperCase(),
    booleans: 'checkbox',
  },
  {
    connector: informixConnector,
    driver: 'ibm_db',
    settings: [
      'RIOSOMA_INFORMIX_HOST',
      'RIOSOMA_INFORMIX_DATABASE',
      'RIOSOMA_INFORMIX_USER',
      'RIOSOMA_INFORMIX_PASSWORD',
    ],
    connection: (env) => ({
      kind: 'informix',
      host: env.RIOSOMA_INFORMIX_HOST,
      port: Number(env.RIOSOMA_INFORMIX_PORT ?? 9089),
      database: env.RIOSOMA_INFORMIX_DATABASE,
      user: env.RIOSOMA_INFORMIX_USER,
      secure: env.RIOSOMA_INFORMIX_TLS === 'on',
    }),
    create: [
      `CREATE TABLE rio_test_items (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(24,8),
        title VARCHAR(100), enabled BOOLEAN, day DATE, instant DATETIME YEAR TO FRACTION(3), ratio FLOAT,
        code VARCHAR(20) NOT NULL UNIQUE)`,
      ...rows((a, b, c) => [
        `INSERT INTO rio_test_items VALUES (9007199254740993, 1234567890123456.12345678, 'First', 't',
          MDY(1, 1, 2026), DATETIME(2026-01-01 12:00:00.000) YEAR TO FRACTION(3), 0.5, '${a}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740994, 2.5, 'Second', 'f', MDY(1, 2, 2026),
          DATETIME(2026-01-02 12:00:00.000) YEAR TO FRACTION(3), 1.25, '${b}')`,
        `INSERT INTO rio_test_items VALUES (9007199254740995, NULL, NULL, NULL, NULL, NULL, NULL, '${c}')`,
      ]),
      'CREATE VIEW rio_test_view AS SELECT id, title FROM rio_test_items',
    ],
    drop: ['DROP VIEW rio_test_view', 'DROP TABLE rio_test_items'],
    slow: 'SELECT COUNT(*) AS n FROM syscolumns a, syscolumns b, syscolumns c',
    stored: (name) => name.toLowerCase(),
    booleans: 'checkbox',
  },
];

/**
 * Runs statements through the installed driver in a process of their own, started the way a
 * source's driver process is, since IBM's add-on needs its client's settings when it starts.  The
 * sources themselves only read, so the test objects are made here.
 */
const SETUP = `
process.once('message', async ({ url, kind, options, statements }) => {
  const beat = setInterval(() => undefined, 10);
  try {
    const loaded = await import(url);
    const driver = loaded.default ?? loaded;
    if (kind === 'teradata') {
      const connection = await driver.connectAsync(options);
      const cursor = connection.cursor();
      for (const { sql, optional } of statements)
        try { await cursor.executeAsync(sql); } catch (error) { if (!optional) throw error; }
      cursor.close();
      connection.close();
    } else {
      const database = await driver.open(options);
      for (const { sql, optional } of statements)
        try { await database.query(sql); } catch (error) { if (!optional) throw error; }
      await database.close();
    }
    process.send({ ok: true });
  } catch (error) {
    process.send({ error: String(error?.message ?? error) });
  } finally {
    clearInterval(beat);
  }
});
`;

async function runStatements(
  system: LiveSystem,
  ctx: ConnectorContext,
  statements: Array<{ sql: string; optional?: boolean }>,
): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'drivers-live-'));
  const { url, folder: revision, release } = await useInstalledDriver(system.driver);
  try {
    const script = join(folder, 'setup.mjs');
    await writeFile(script, SETUP);
    const c = ctx.connection as Record<string, unknown>;
    const options =
      c.kind === 'teradata'
        ? {
            host: c.host,
            user: c.user,
            password: ctx.secrets.password,
            tmode: 'TERA',
            sslmode: c.secure ? 'VERIFY-FULL' : 'DISABLE',
            https_port: String(c.port),
            dbs_port: String(c.port),
          }
        : `DATABASE=${String(c.database)};HOSTNAME=${String(c.host)};PORT=${String(c.port)};PROTOCOL=TCPIP;UID=${String(c.user)};PWD=${ctx.secrets.password}${c.secure ? ';SECURITY=SSL' : ''}`;
    const child = fork(script, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: driverEnvironment(system.driver, folder, process.env, revision),
    });
    const answer = await new Promise<{ ok?: boolean; error?: string }>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`setup stopped with ${String(code)}`)));
      child.send({ url, kind: c.kind, options, statements });
    });
    child.kill();
    if (answer.error) throw new Error(answer.error.split(ctx.secrets.password!).join('[redacted]'));
  } finally {
    release();
    await rm(folder, { recursive: true, force: true });
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

for (const system of systems) {
  const configured = system.settings.every((name) => Boolean(process.env[name]));
  describe.skipIf(!configured)(`${system.connector.kind} live source`, () => {
    let ctx: ConnectorContext;
    let items: SourceObjectRef;
    const password = system.settings.find((name) => name.endsWith('_PASSWORD'))!;

    beforeAll(async () => {
      // The shared harness allows outside connections only for an explicitly configured live service.
      vi.stubEnv(`RIOSOMA_TEST_${system.connector.kind.toUpperCase()}`, 'live');
      ctx = {
        connection: SourceConnection.parse(system.connection(process.env)),
        secrets: { password: process.env[password]! },
        timeoutMs: 60_000,
      };
      await runStatements(system, ctx, [
        ...system.drop.map((sql) => ({ sql, optional: true })),
        ...system.create.map((sql) => ({ sql })),
      ]);
      const listed = await system.connector.listObjects(ctx);
      const found = listed.find((object) => same(object.name, 'rio_test_items'));
      expect(found).toBeDefined();
      items = { schema: found!.schema, name: found!.name };
    }, 180_000);

    afterAll(async () => {
      try {
        if (ctx)
          await runStatements(
            system,
            ctx,
            system.drop.map((sql) => ({ sql, optional: true })),
          );
      } finally {
        vi.unstubAllEnvs();
      }
    }, 120_000);

    it('climbs every test step through the installed driver', async () => {
      const result = await system.connector.test(ctx);
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      expect(result.steps.map((step) => step.step)).toEqual([
        'driver',
        'resolve',
        'connect',
        'tls',
        'authenticate',
        'query',
      ]);
      expect(result.serverVersion).toMatch(/\d/);
    }, 120_000);

    it('lists the test table and view with their kinds', async () => {
      const listed = await system.connector.listObjects(ctx);
      expect(listed.find((object) => same(object.name, 'rio_test_items'))).toMatchObject({
        name: system.stored('rio_test_items'),
        type: 'table',
      });
      expect(listed.find((object) => same(object.name, 'rio_test_view'))).toMatchObject({
        name: system.stored('rio_test_view'),
        type: 'view',
        rowEstimate: null,
      });
    }, 120_000);

    it('offers the primary key first and the unique key after it', async () => {
      const keys = await system.connector.keyCandidates(ctx, items);
      expect(keys.map((key) => key.map((name) => name.toLowerCase()))).toEqual([['id'], ['code']]);
    }, 120_000);

    it('describes each column with the field type it suggests', async () => {
      const columns = await system.connector.describe(ctx, { kind: 'object', object: items });
      expect(columns.map((column) => column.name.toLowerCase())).toEqual([
        'id',
        'amount',
        'title',
        'enabled',
        'day',
        'instant',
        'ratio',
        'code',
      ]);
      expect(columns.map((column) => column.suggested?.type ?? null)).toEqual([
        'number',
        'number',
        'text',
        system.booleans,
        'date',
        'date',
        'number',
        'text',
      ]);
      expect(columns[1]!.suggested?.options).toMatchObject({ precision: 8 });
      expect(columns[5]!.suggested?.options).toMatchObject({ includeTime: true });
    }, 120_000);

    it('previews rows converted to their field types', async () => {
      const preview = await system.connector.preview(ctx, { kind: 'object', object: items }, 2);
      expect(preview.rows).toHaveLength(2);
      const first = preview.rows.find((row) => row[2] === 'First')!;
      expect(first).toBeDefined();
      expect(first.slice(2, 7)).toEqual([
        'First',
        system.booleans === 'checkbox' ? true : 1,
        '2026-01-01',
        '2026-01-01T12:00:00.000Z',
        0.5,
      ]);
    }, 120_000);

    it('reads every row in batches, with big integer and decimal keys exact', async () => {
      const batches: SourceRow[][] = [];
      for await (const batch of system.connector.read(
        ctx,
        { kind: 'object', object: items },
        {
          columns: ['amount', 'title', 'day'].map(system.stored),
          types: { [system.stored('amount')]: 'text', [system.stored('title')]: 'text' },
          keyColumns: [system.stored('id'), system.stored('amount')],
          batchSize: 2,
        },
      ))
        batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
      const keys = batches.flat().map((row) => row.key);
      expect(keys.sort()).toEqual(
        [
          JSON.stringify(['9007199254740993', '1234567890123456.12345678']),
          JSON.stringify(['9007199254740994', '2.50000000']),
          JSON.stringify(['9007199254740995', null]),
        ].sort(),
      );
      const first = batches.flat().find((row) => row.key.startsWith('["9007199254740993"'))!;
      expect(first.values[system.stored('amount')]).toBe('1234567890123456.12345678');
    }, 120_000);

    it('previews a query contained in one SELECT', async () => {
      const preview = await system.connector.preview(
        ctx,
        { kind: 'query', sql: "SELECT id, title FROM rio_test_items WHERE code = 'b'" },
        5,
      );
      expect(preview.rows).toEqual([[9007199254740994, 'Second']]);
    }, 120_000);

    it('stops a long read the moment it is aborted', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = system.connector.preview(
        { ...ctx, signal: controller.signal },
        { kind: 'query', sql: system.slow },
        1,
      );
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        await expect(pending).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
      } finally {
        clearTimeout(timer);
      }
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 120_000);
  });
}

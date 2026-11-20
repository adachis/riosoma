import { createPrivateKey } from 'node:crypto';
import { connect as connectTcp, createServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import oracledb from 'oracledb';
import * as Firebird from 'node-firebird';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { SourceConnection, FieldOptions, TEST_STEPS, type SourceSelect } from '@riosoma/contracts';
import { connectorFor, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import './register.test-support.js';
import { objectSql, quote } from '@riosoma/connectors/internal/sql.js';
import { selfSigned } from '@riosoma/connectors/internal/oracle-tls.js';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('sources.test.connect');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** A password no server holds, made up for each run. */
function strayPassword(): string {
  return ['not', 'the', 'password', Math.random().toString(36).slice(2, 8)].join('-');
}

/**
 * The fleet servers each suite runs against, by environment variable: `mysql://`, `mssql://`,
 * `oracle://user:password@host:port/service`, and `firebird://user:password@host:port//path/to.fdb`
 * (or an alias after one slash).  PostgreSQL always runs, on the shared test cluster.
 */
const FLEET = {
  postgres: undefined,
  mysql: process.env.RIOSOMA_TEST_MYSQL_URL,
  sqlserver: process.env.RIOSOMA_TEST_MSSQL_URL,
  oracle: process.env.RIOSOMA_TEST_ORACLE_URL,
  firebird: process.env.RIOSOMA_TEST_FIREBIRD_URL,
};
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, sqlserver: 1433, oracle: 1521, firebird: 3050 };

for (const kind of ['postgres', 'mysql', 'sqlserver', 'oracle', 'firebird'] as const) {
  const fleetUrl = FLEET[kind];
  describe.skipIf(kind !== 'postgres' && !fleetUrl)(`${kind} connector`, () => {
    const connector = connectorFor(kind);
    const suffix = Math.random().toString(36).slice(2, 10);
    const table = `samples_${suffix}`;
    const view = `sample_view_${suffix}`;
    const writer = `attempt_write_${suffix}`;
    const autonomous = `autonomous_write_${suffix}`;
    const writes = `writes_${suffix}`;
    // Firebird 3 has no 128-bit integers, so its exact decimals stop at 18 digits.
    const amount = kind === 'firebird' ? '12345678901234.1200' : '12345678901234567890.1200';
    // Oracle's DATE carries a time of day, so its day arrives as midnight UTC.
    const day = kind === 'oracle' ? '2026-02-03T00:00:00.000Z' : '2026-02-03';
    let schema: string;
    let owner: string | null;
    let ctx: ConnectorContext;
    let select: SourceSelect;
    let execute: (sql: string) => Promise<unknown>;
    let close: () => Promise<void>;
    let db: Awaited<ReturnType<TestPostgres['createDatabase']>> | undefined;
    let qualified: string;
    let qualifiedView: string;
    /** Firebird's major version, which decides whether its time zone and 128-bit types exist */
    let firebirdMajor = 0;
    const q = (name: string) => quote(name, kind);
    beforeAll(async () => {
      let url: URL;
      if (kind === 'postgres') {
        const kit = await startTestPostgres();
        db = await kit.createDatabase('connectors');
        url = new URL(db.url);
        const admin = new pg.Client({ connectionString: db.url });
        await admin.connect();
        execute = (sql) => admin.query(sql);
        close = () => admin.end();
      } else if (kind === 'mysql') {
        url = new URL(fleetUrl!);
        const admin = await mysql.createConnection(fleetUrl!);
        execute = (sql) => admin.query(sql);
        close = () => admin.end();
      } else if (kind === 'sqlserver') {
        url = new URL(fleetUrl!);
        const admin = await new mssql.ConnectionPool({
          server: url.hostname,
          port: Number(url.port || 1433),
          database: decodeURIComponent(url.pathname.slice(1)) || 'master',
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          // The driver refuses an IP address as the TLS name, and the certificate goes unchecked anyway.
          options: { encrypt: true, trustServerCertificate: true, serverName: 'localhost' },
        }).connect();
        execute = (sql) => admin.request().query(sql);
        close = () => admin.close();
      } else if (kind === 'oracle') {
        url = new URL(fleetUrl!);
        const admin = await oracledb.getConnection({
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          connectString: `${url.hostname}:${url.port || 1521}${url.pathname}`,
        });
        execute = async (sql) => {
          await admin.execute(sql);
          await admin.execute('COMMIT');
        };
        close = () => admin.close();
      } else {
        url = new URL(fleetUrl!);
        const admin = await Firebird.attachAsync({
          host: url.hostname,
          port: Number(url.port || 3050),
          database: decodeURIComponent(url.pathname.slice(1)),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        });
        execute = (sql) => admin.queryAsync(sql);
        close = () => admin.detachAsync();
        const [version] = await admin.queryAsync<{ V: string }>(
          "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE",
        );
        firebirdMajor = Number(version?.V.split('.')[0]);
      }
      const database = decodeURIComponent(url.pathname.slice(1)) || 'master';
      ctx = {
        connection: SourceConnection.parse({
          kind,
          host: url.hostname,
          port: Number(url.port || DEFAULT_PORTS[kind]),
          database,
          serviceName: database,
          user: decodeURIComponent(url.username),
          tls: { mode: 'disable' },
          encrypt: true,
          trustServerCertificate: true,
        }),
        secrets: { password: decodeURIComponent(url.password) || 'test' },
        timeoutMs: 5000,
      };
      // MySQL's schema is its database, Oracle's is the user's own, and Firebird has none.
      schema =
        kind === 'mysql'
          ? database
          : kind === 'oracle'
            ? decodeURIComponent(url.username).toUpperCase()
            : `connector_${suffix}`;
      owner = kind === 'firebird' ? null : schema;
      if (kind === 'postgres' || kind === 'sqlserver') await execute(`CREATE SCHEMA ${q(schema)}`);
      qualified = objectSql({ schema: owner, name: table }, kind);
      qualifiedView = objectSql({ schema: owner, name: view }, kind);
      select = { kind: 'object', object: { schema: owner, name: table } };
      if (kind === 'postgres') {
        await execute(`CREATE TYPE ${q(schema)}.status AS ENUM ('pending','ready')`);
        await execute(`CREATE TABLE ${qualified} (
          id bigint, part smallint, label varchar(80) UNIQUE, amount numeric(30,4), ratio double precision,
          flag boolean, day date, stamp timestamp, zoned timestamptz, large varchar(1001), plain text,
          state ${q(schema)}.status, payload jsonb, items integer[], bytes bytea, identifier uuid,
          clock time, cash money, small smallint, arbitrary numeric, doc xml, PRIMARY KEY (id,part))`);
      } else if (kind === 'mysql') {
        await execute(`CREATE TABLE ${qualified} (
          id bigint, part smallint, label varchar(80) UNIQUE, amount decimal(30,4), ratio double,
          flag tinyint(1), day date, stamp datetime, zoned timestamp NULL, large varchar(1001), plain text,
          state enum('pending','ready'), payload json, bytes blob, identifier char(36), clock time,
          small smallint, year_value year, bits bit(1), tags set('red','blue'), geo geometry, PRIMARY KEY (id,part))`);
      } else if (kind === 'sqlserver') {
        await execute(`CREATE TABLE ${qualified} (
          id bigint, part smallint, label varchar(80) UNIQUE, amount decimal(30,4), ratio float,
          flag bit, day date, stamp datetime2, zoned datetimeoffset, large nvarchar(max), plain varchar(80),
          bytes varbinary(max), identifier uniqueidentifier, clock time, cash money, small smallint,
          doc xml, geo geometry, PRIMARY KEY (id,part))`);
      } else if (kind === 'oracle') {
        await execute(`CREATE TABLE ${qualified} (
          "id" NUMBER(20), "part" NUMBER(5), "label" VARCHAR2(80) UNIQUE, "amount" NUMBER(30,4),
          "ratio" BINARY_DOUBLE, "flag" BOOLEAN, "day" DATE, "stamp" TIMESTAMP, "zoned" TIMESTAMP WITH TIME ZONE,
          "local_zoned" TIMESTAMP WITH LOCAL TIME ZONE, "large" CLOB, "plain" VARCHAR2(80), "wide" NVARCHAR2(40),
          "fixed" CHAR(10), "national" NCLOB, "payload" JSON, "bytes" BLOB, "raw_bytes" RAW(8),
          "identifier" VARCHAR2(36), "small" NUMBER(5), "whole" NUMBER, "approximate" FLOAT(20),
          "single" BINARY_FLOAT, PRIMARY KEY ("id","part"))`);
      } else {
        const newer =
          firebirdMajor >= 4
            ? `"zoned" TIMESTAMP WITH TIME ZONE, "zoned_clock" TIME WITH TIME ZONE, "huge" INT128,
          "wide_amount" NUMERIC(38,6), "decimal_float" DECFLOAT(34), "short_float" DECFLOAT(16), "octets" VARBINARY(8),`
            : '';
        await execute(`CREATE TABLE ${qualified} (
          "id" BIGINT NOT NULL, "part" SMALLINT NOT NULL, "label" VARCHAR(80) UNIQUE, "amount" NUMERIC(18,4),
          "ratio" DOUBLE PRECISION, "flag" BOOLEAN, "day" DATE, "stamp" TIMESTAMP, "large" BLOB SUB_TYPE TEXT,
          "plain" VARCHAR(80), "fixed" CHAR(10), "bytes" BLOB SUB_TYPE BINARY, "identifier" CHAR(36),
          "clock" TIME, "small" SMALLINT, "whole" INTEGER, "single" FLOAT, ${newer}
          PRIMARY KEY ("id","part"))`);
      }
      await execute(
        `CREATE VIEW ${qualifiedView} AS SELECT ${['id', 'part', 'label'].map(q).join(',')} FROM ${qualified}`,
      );
      const stamp = (text: string) => (kind === 'oracle' ? `TIMESTAMP '${text}'` : `'${text}'`);
      for (let i = 0; i < 13; i++) {
        const row: Record<string, string> = {
          id: `${9007199254740993n + BigInt(i)}`,
          part: `${i}`,
          label: `'row ${i}'`,
          amount,
          ratio: '1.25',
          flag: kind === 'mysql' || kind === 'sqlserver' ? '1' : 'TRUE',
          day: kind === 'oracle' ? "DATE '2026-02-03'" : "'2026-02-03'",
          stamp:
            kind === 'oracle' || kind === 'firebird' ? stamp('2026-02-03 04:05:06') : "'2026-02-03T04:05:06'",
          large: "'long text'",
          plain: "'plain text'",
          identifier: "'12345678-1234-1234-1234-123456789abc'",
          small: '12',
        };
        if (kind !== 'firebird' || firebirdMajor >= 4)
          row.zoned =
            kind === 'mysql'
              ? "'2026-02-03 04:05:06'"
              : kind === 'postgres' || kind === 'sqlserver'
                ? "'2026-02-03T04:05:06+02:00'"
                : stamp('2026-02-03 04:05:06 +02:00');
        if (kind !== 'oracle') row.clock = "'12:34:56'";
        if (kind === 'postgres' || kind === 'mysql') {
          row.state = "'ready'";
          row.payload = `'${JSON.stringify({ hello: [1, 2] })}'`;
        }
        if (kind === 'postgres')
          Object.assign(row, { items: "'{1,2}'", cash: '12.50', arbitrary: '1.234', doc: "'<sample/>'" });
        if (kind === 'mysql') Object.assign(row, { year_value: '2026', bits: "b'1'", tags: "'red,blue'" });
        if (kind === 'sqlserver') Object.assign(row, { cash: '12.50', doc: "'<sample/>'" });
        if (kind === 'oracle')
          Object.assign(row, {
            local_zoned: stamp('2026-02-03 04:05:06 +02:00'),
            wide: "N'wide text'",
            fixed: "'abc'",
            national: "N'national text'",
            payload: `JSON('${JSON.stringify({ hello: [1, 2] })}')`,
            bytes: "HEXTORAW('DEADBEEF')",
            raw_bytes: "HEXTORAW('0102')",
            whole: '9007199254740993',
            approximate: '1.5',
            single: '1.5',
          });
        if (kind === 'firebird') {
          Object.assign(row, { fixed: "'abc'", bytes: "X'DEADBEEF'", whole: '34', single: '1.5' });
          if (firebirdMajor >= 4)
            Object.assign(row, {
              zoned_clock: "'12:34:56 +02:00'",
              huge: '170141183460469231731687303715884105727',
              wide_amount: '12345678901234567890123456789012.123456',
              decimal_float: '12345678901.2345678901234567890123',
              short_float: '1.5',
              octets: "X'0102'",
            });
        }
        await execute(
          `INSERT INTO ${qualified} (${Object.keys(row).map(q).join(',')}) VALUES (${Object.values(row).join(',')})`,
        );
      }
      if (kind === 'postgres') {
        await execute(`ANALYZE ${qualified}`);
        await execute(
          `CREATE FUNCTION ${q(schema)}.attempt_write() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ${qualified}; RETURN 1; END $$`,
        );
      }
      if (kind === 'oracle') {
        await execute(
          `CREATE FUNCTION ${q(schema)}.${q(writer)} RETURN NUMBER IS BEGIN DELETE FROM ${qualified}; RETURN 1; END;`,
        );
        // An autonomous transaction commits on its own, outside the read-only one.
        await execute(`CREATE TABLE ${q(schema)}.${q(writes)} ("n" NUMBER)`);
        await execute(
          `CREATE FUNCTION ${q(schema)}.${q(autonomous)} RETURN NUMBER IS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO ${q(schema)}.${q(writes)} VALUES (1); COMMIT; RETURN 1; END;`,
        );
        // A read-only transaction refuses a table whose definition changed in the last few
        // seconds (ORA-01466), so the reads wait that long after creating it.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (kind === 'firebird') {
        await execute(
          `CREATE PROCEDURE ${q(writer)} RETURNS ("n" INTEGER) AS BEGIN DELETE FROM ${qualified}; "n" = 1; SUSPEND; END`,
        );
        await execute(`CREATE TABLE ${q(writes)} ("n" INTEGER)`);
        await execute(
          `CREATE PROCEDURE ${q(autonomous)} RETURNS ("n" INTEGER) AS BEGIN IN AUTONOMOUS TRANSACTION DO INSERT INTO ${q(writes)} VALUES (1); "n" = 1; SUSPEND; END`,
        );
      }
    }, 60000);
    afterAll(async () => {
      if (execute && qualified) {
        if (kind === 'postgres') await execute(`DROP SCHEMA ${q(schema)} CASCADE`);
        else {
          if (kind === 'oracle') {
            await execute(`DROP FUNCTION ${q(schema)}.${q(writer)}`);
            await execute(`DROP FUNCTION ${q(schema)}.${q(autonomous)}`);
            await execute(`DROP TABLE ${q(schema)}.${q(writes)} PURGE`);
          }
          if (kind === 'firebird') {
            await execute(`DROP PROCEDURE ${q(writer)}`);
            await execute(`DROP PROCEDURE ${q(autonomous)}`);
            await execute(`DROP TABLE ${q(writes)}`);
          }
          await execute(`DROP VIEW ${qualifiedView}`);
          await execute(`DROP TABLE ${qualified}${kind === 'oracle' ? ' PURGE' : ''}`);
          if (kind === 'sqlserver') await execute(`DROP SCHEMA ${q(schema)}`);
        }
      }
      await close?.();
      await db?.drop();
    }, 60000);
    it('climbs test steps in order and reports a version', async () => {
      const result = await connector.test(ctx);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // Bundled SQL drivers do not need an installation check or the steps for other source kinds.
      expect(result.steps.map((step) => step.step)).toEqual(
        TEST_STEPS.filter(
          (step) =>
            ![
              'driver',
              'tunnel',
              'read',
              'parse',
              'records',
              'paging',
              'collections',
              'document',
              'sheets',
              'tables',
              'lists',
              'workbooks',
              'entities',
              'rows',
              'feed',
              'posts',
            ].includes(step),
        ),
      );
      expect(result.steps.every((step) => step.status !== 'failed')).toBe(true);
      expect(result.serverVersion).toBeTruthy();
      // Firebird requires wire encryption by default, and the connection says it's on.
      if (kind === 'firebird') expect(result.steps.find((step) => step.step === 'tls')?.status).toBe('ok');
    });
    it('stops at a failed SSH tunnel and scrubs its secrets', async () => {
      const result = await connector.test({
        ...ctx,
        connection: SourceConnection.parse({
          ...ctx.connection,
          ssh: { host: '127.0.0.1', port: 22, user: 'test', hostKey: 'invalid-pinned-key' },
        }),
        secrets: { ...ctx.secrets, sshPrivateKeyPem: 'secret-private-key' },
      });
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        step: 'tunnel',
        status: 'failed',
        messageKey: 'sources.test.tunnel',
      });
      expect(JSON.stringify(result)).not.toContain('secret-private-key');
    });
    if (kind === 'mysql') {
      it('negotiates required TLS and rejects an untrusted certificate', async () => {
        const encrypted = await connector.test({
          ...ctx,
          connection: SourceConnection.parse({ ...ctx.connection, tls: { mode: 'require' } }),
        });
        expect(encrypted.ok, JSON.stringify(encrypted)).toBe(true);
        const verified = await connector.test({
          ...ctx,
          connection: SourceConnection.parse({
            ...ctx.connection,
            tls: { mode: 'verify-full', caPem: 'invalid-ca' },
          }),
        });
        expect(verified.ok).toBe(false);
        expect(verified.steps.at(-1)).toMatchObject({
          step: 'tls',
          status: 'failed',
          messageKey: 'sources.test.tls',
        });
      });
    }
    if (kind === 'oracle') {
      it('reaches the service through an Easy Connect string, and stops at TLS on a plain listener', async () => {
        const c = ctx.connection;
        if (c.kind !== 'oracle') throw new Error('not an Oracle connection');
        const easy = SourceConnection.parse({
          kind: 'oracle',
          address: 'easy-connect',
          easyConnect: `${c.host}:${c.port}/${c.serviceName}`,
          user: c.user,
        });
        const reached = await connector.test({ ...ctx, connection: easy });
        expect(reached.ok, JSON.stringify(reached)).toBe(true);
        const refused = await connector.test({
          ...ctx,
          connection: SourceConnection.parse({
            ...easy,
            easyConnect: `tcps://${c.host}:${c.port}/${c.serviceName}`,
          }),
        });
        expect(refused.steps.at(-1)).toMatchObject({ step: 'tls', status: 'failed' });
      });

      it('reads over TLS the driver checks, by authority, name, and a wallet for mutual TLS', async () => {
        const c = ctx.connection;
        if (c.kind !== 'oracle') throw new Error('not an Oracle connection');
        // A TLS listener in front of the fleet's own, since its image can't make a server wallet.
        const server = selfSigned('oracle-tls.test');
        const client = selfSigned('riosoma-client');
        const passphrase = ['wallet', Math.random().toString(36).slice(2, 8)].join('-');
        const encryptedKey = String(
          createPrivateKey(client.key).export({
            type: 'pkcs8',
            format: 'pem',
            cipher: 'aes-256-cbc',
            passphrase,
          }),
        );
        const listeners: TlsServer[] = [];
        const listen = async (mutual: boolean) => {
          const listener = createTlsServer(
            {
              cert: server.cert,
              key: server.key,
              requestCert: mutual,
              rejectUnauthorized: mutual,
              ca: [client.cert],
            },
            (socket) => {
              const upstream = connectTcp(c.port, c.host!);
              for (const end of [socket, upstream]) end.on('error', () => undefined);
              socket.pipe(upstream).pipe(socket);
            },
          );
          listener.on('tlsClientError', () => undefined);
          await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
          listeners.push(listener);
          return (listener.address() as { port: number }).port;
        };
        try {
          const port = await listen(false);
          const mutualPort = await listen(true);
          const over = (tls: Record<string, unknown>, secrets = ctx.secrets, at = port) => ({
            ...ctx,
            secrets,
            connection: SourceConnection.parse({ ...c, host: '127.0.0.1', port: at, tls }),
          });
          const trusted = { caPem: server.cert, serverName: 'oracle-tls.test' };
          const passed = await connector.test(over({ mode: 'verify-full', ...trusted }));
          expect(passed.ok, JSON.stringify(passed)).toBe(true);
          expect(passed.steps.find((step) => step.step === 'tls')?.status).toBe('ok');
          expect(
            (await connector.preview(over({ mode: 'verify-full', ...trusted }), select, 3)).rows,
          ).toHaveLength(3);
          // Checking the chain alone takes any name, and a tcps:// string checks both.
          expect((await connector.test(over({ mode: 'verify-ca', caPem: server.cert }))).ok).toBe(true);
          const easy = await connector.test({
            ...ctx,
            connection: SourceConnection.parse({
              kind: 'oracle',
              address: 'easy-connect',
              easyConnect: `tcps://127.0.0.1:${port}/${c.serviceName}`,
              user: c.user,
              tls: { mode: 'disable', ...trusted },
            }),
          });
          expect(easy.ok, JSON.stringify(easy)).toBe(true);
          // The wrong name, or no authority that trusts the certificate, stops at TLS.
          for (const tls of [
            { mode: 'verify-full', caPem: server.cert },
            { mode: 'verify-full', serverName: 'oracle-tls.test' },
          ]) {
            const failed = await connector.test(over(tls));
            expect(failed.steps.at(-1), JSON.stringify(tls)).toMatchObject({ step: 'tls', status: 'failed' });
          }
          // Mutual TLS takes the wallet's client key, decrypted with its password.
          const wallet = `${server.cert}${client.cert}${encryptedKey}`;
          const mutual = await connector.test(
            over(
              { mode: 'verify-full', serverName: 'oracle-tls.test' },
              { ...ctx.secrets, wallet, walletPassword: passphrase },
              mutualPort,
            ),
          );
          expect(mutual.ok, JSON.stringify(mutual)).toBe(true);
          for (const secrets of [
            { ...ctx.secrets, wallet: server.cert },
            { ...ctx.secrets, wallet, walletPassword: `${passphrase}-other` },
          ]) {
            const failed = await connector.test(
              over({ mode: 'verify-full', serverName: 'oracle-tls.test' }, secrets, mutualPort),
            );
            expect(failed.steps.at(-1)).toMatchObject({ step: 'tls', status: 'failed' });
            expect(JSON.stringify(failed)).not.toContain(passphrase);
          }
        } finally {
          for (const listener of listeners)
            await new Promise<void>((resolve) => listener.close(() => resolve()));
        }
      }, 60000);
    }
    it('lists readable tables and views with catalog estimates', async () => {
      const objects = await connector.listObjects(ctx);
      expect(objects.find((o) => o.schema === owner && o.name === table)).toMatchObject({ type: 'table' });
      expect(objects.find((o) => o.schema === owner && o.name === view)).toMatchObject({
        type: 'view',
        rowEstimate: null,
      });
      expect(
        objects.some((o) => /^(pg_|sys$|information_schema$|system$|rdb\$|mon\$)/i.test(o.schema ?? o.name)),
      ).toBe(false);
    });
    it('returns the composite primary key first, then unique constraints', async () => {
      expect(await connector.keyCandidates(ctx, { schema: owner, name: table })).toEqual([
        ['id', 'part'],
        ['label'],
      ]);
      expect(await connector.keyCandidates(ctx, { schema: owner, name: view })).toEqual([]);
    });
    it('describes mapped types and valid field options for objects and queries', async () => {
      const columns = await connector.describe(ctx, select);
      const byName = new Map(columns.map((col) => [col.name, col]));
      expect(byName.get('id')).toMatchObject({
        nullable: false,
        suggested: { type: 'number', options: { precision: 0 } },
      });
      expect(byName.get('amount')).toMatchObject({
        suggested: { type: 'number', options: { precision: 4 } },
      });
      expect(byName.get('ratio')).toMatchObject({ suggested: { options: { precision: null } } });
      expect(byName.get('flag')?.suggested?.type).toBe('checkbox');
      expect(byName.get('day')?.suggested?.type).toBe('date');
      expect(byName.get('stamp')).toMatchObject({
        suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
      });
      expect(byName.get('large')?.suggested?.type).toBe('longText');
      expect(byName.get('label')?.alternatives).toEqual([
        'longText',
        'email',
        'url',
        'phone',
        'singleSelect',
      ]);
      expect(byName.get('bytes')?.suggested).toBeNull();
      if (kind === 'postgres' || kind === 'mysql')
        expect(byName.get('state')).toMatchObject({
          suggested: { type: 'singleSelect', options: { choices: [{ name: 'pending' }, { name: 'ready' }] } },
        });
      if (kind === 'mysql') expect(byName.get('tags')?.suggested?.type).toBe('multipleSelect');
      if (kind === 'oracle') {
        for (const name of ['day', 'zoned', 'local_zoned'])
          expect(byName.get(name)?.suggested?.options, name).toEqual({ includeTime: true, timeZone: 'UTC' });
        for (const name of ['plain', 'wide', 'fixed'])
          expect(byName.get(name)?.suggested?.type, name).toBe('text');
        for (const name of ['national', 'payload'])
          expect(byName.get(name)?.suggested?.type, name).toBe('longText');
        expect(byName.get('raw_bytes')?.suggested).toBeNull();
        for (const name of ['whole', 'approximate', 'single'])
          expect(byName.get(name)?.suggested, name).toEqual({ type: 'number', options: { precision: null } });
      }
      if (kind === 'firebird') {
        expect(byName.get('clock')?.suggested?.type).toBe('text');
        expect(byName.get('fixed')?.suggested?.type).toBe('text');
        expect(byName.get('whole')?.suggested).toEqual({ type: 'number', options: { precision: 0 } });
        expect(byName.get('single')?.suggested).toEqual({ type: 'number', options: { precision: null } });
        if (firebirdMajor >= 4) {
          expect(byName.get('zoned')?.suggested?.options).toEqual({ includeTime: true, timeZone: 'UTC' });
          expect(byName.get('zoned_clock')?.suggested?.type).toBe('text');
          expect(byName.get('huge')?.suggested).toEqual({ type: 'number', options: { precision: 0 } });
          expect(byName.get('wide_amount')?.suggested).toEqual({ type: 'number', options: { precision: 6 } });
          for (const name of ['decimal_float', 'short_float'])
            expect(byName.get(name)?.suggested, name).toEqual({
              type: 'number',
              options: { precision: null },
            });
          expect(byName.get('octets')?.suggested).toBeNull();
        }
      }
      for (const col of columns)
        if (col.suggested)
          expect(
            FieldOptions[col.suggested.type as keyof typeof FieldOptions].safeParse(col.suggested.options)
              .success,
            col.name,
          ).toBe(true);
      const queried = await connector.describe(ctx, { kind: 'query', sql: `SELECT * FROM ${qualified}` });
      expect(queried.map((col) => col.suggested)).toEqual(columns.map((col) => col.suggested));
    });
    it('previews objects and queries with converted values and limits', async () => {
      for (const selected of [select, { kind: 'query' as const, sql: `SELECT * FROM ${qualified}` }]) {
        const preview = await connector.preview(ctx, selected, 3);
        expect(preview.rows).toHaveLength(3);
        const row = Object.fromEntries(
          preview.columns.map((col, index) => [col.name, preview.rows[0]![index]]),
        );
        expect(row).toMatchObject({
          flag: true,
          day,
          stamp: '2026-02-03T04:05:06.000Z',
          ratio: 1.25,
          bytes: null,
        });
        if (kind === 'postgres' || kind === 'mysql') expect(row).toMatchObject({ state: 'ready' });
        if (kind === 'postgres' || kind === 'mysql' || kind === 'oracle')
          expect(row).toMatchObject({ payload: '{"hello":[1,2]}' });
        if (kind === 'postgres') expect(row.items).toBe('[1,2]');
        if (kind === 'mysql') expect(row.tags).toEqual(['red', 'blue']);
        if (kind === 'oracle' || (kind === 'firebird' && firebirdMajor >= 4))
          expect(row.zoned).toBe('2026-02-03T02:05:06.000Z');
        if (kind === 'oracle')
          expect(row).toMatchObject({
            local_zoned: '2026-02-03T02:05:06.000Z',
            large: 'long text',
            wide: 'wide text',
            fixed: 'abc       ',
            national: 'national text',
            raw_bytes: null,
            whole: Number('9007199254740993'),
            approximate: 1.5,
            single: 1.5,
          });
        if (kind === 'firebird') {
          expect(row).toMatchObject({ large: 'long text', clock: '12:34:56.0000', whole: 34, single: 1.5 });
          if (firebirdMajor >= 4)
            expect(row).toMatchObject({
              zoned_clock: '12:34:56.0000 +02:00',
              huge: Number('170141183460469231731687303715884105727'),
              wide_amount: Number('12345678901234567890123456789012.123456'),
              decimal_float: Number('12345678901.2345678901234567890123'),
              short_float: 1.5,
              octets: null,
            });
        }
      }
    });
    it('streams several batches with exact composite and decimal keys', async () => {
      const batches: SourceRow[][] = [];
      for await (const batch of connector.read(ctx, select, {
        columns: ['id', 'label', 'amount', 'flag', 'day', 'stamp'],
        types: {
          id: 'text',
          label: 'singleSelect',
          amount: 'number',
          flag: 'checkbox',
          day: 'date',
          stamp: 'date',
        },
        keyColumns: ['id', 'part'],
        batchSize: 4,
      }))
        batches.push(batch);
      expect(batches.map((batch) => batch.length)).toEqual([4, 4, 4, 1]);
      expect(new Set(batches.flat().map((row) => row.key))).toEqual(
        new Set(
          Array.from({ length: 13 }, (_, i) => JSON.stringify([String(9007199254740993n + BigInt(i)), i])),
        ),
      );
      expect(batches.flat().find((row) => row.values.label === 'row 0')?.values).toMatchObject({
        id: '9007199254740993',
        flag: true,
        day,
        stamp: '2026-02-03T04:05:06.000Z',
      });
      for await (const batch of connector.read(
        ctx,
        { kind: 'query', sql: `SELECT ${q('amount')} FROM ${qualified}` },
        { columns: ['amount'], types: { amount: 'text' }, keyColumns: ['amount'], batchSize: 2 },
      )) {
        expect(batch[0]?.key).toBe(JSON.stringify([amount]));
        expect(batch[0]?.values.amount).toBe(amount);
        break;
      }
      if (kind === 'oracle' || (kind === 'firebird' && firebirdMajor >= 4)) {
        // Whole numbers past 2^53 stay exact, as keys and as text, even without a declared precision.
        const [wide, digits] =
          kind === 'oracle'
            ? ['whole', '9007199254740993']
            : ['huge', '170141183460469231731687303715884105727'];
        for await (const batch of connector.read(ctx, select, {
          columns: [wide],
          types: { [wide]: 'text' },
          keyColumns: [wide],
          batchSize: 20,
        })) {
          expect(batch[0]?.key).toBe(JSON.stringify([digits]));
          expect(batch[0]?.values[wide]).toBe(digits);
        }
      }
    });
    it('rejects writes, multiple statements, and wrapper escapes', async () => {
      for (const sql of [
        `DELETE FROM ${qualified}`,
        `SELECT 1; DELETE FROM ${qualified}`,
        `SELECT 1) q; DELETE FROM ${qualified}; SELECT * FROM (SELECT 1`,
      ])
        await expect(connector.preview(ctx, { kind: 'query', sql }, 1)).rejects.toMatchObject({
          messageKey: 'sources.sync.read',
        });
      // A function or procedure that writes fails: in PostgreSQL and Firebird because the
      // transaction is read-only, and in Oracle because a query may not change data at all.
      const writing = {
        postgres: `SELECT ${q(schema)}.attempt_write()`,
        oracle: `SELECT ${q(schema)}.${q(writer)}() AS n FROM dual`,
        firebird: `SELECT * FROM ${q(writer)}`,
        mysql: undefined,
        sqlserver: undefined,
      }[kind];
      if (writing)
        await expect(connector.preview(ctx, { kind: 'query', sql: writing }, 1)).rejects.toMatchObject({
          messageKey: 'sources.sync.read',
        });
      const preview = await connector.preview(ctx, select, 20);
      expect(preview.rows).toHaveLength(13);
    });
    if (kind === 'oracle' || kind === 'firebird') {
      it('shows how far the read-only transaction reaches for an autonomous transaction', async () => {
        const count = async () =>
          (
            await connector.preview(
              ctx,
              {
                kind: 'query',
                sql: `SELECT COUNT(*) AS ${q('n')} FROM ${objectSql({ schema: owner, name: writes }, kind)}`,
              },
              1,
            )
          ).rows[0]![0];
        const call =
          kind === 'oracle'
            ? `SELECT ${q(schema)}.${q(autonomous)}() AS n FROM dual`
            : `SELECT * FROM ${q(autonomous)}`;
        if (kind === 'firebird') {
          // Firebird starts an autonomous transaction read-only when its parent is, so it's refused.
          await expect(connector.preview(ctx, { kind: 'query', sql: call }, 1)).rejects.toMatchObject({
            messageKey: 'sources.sync.read',
          });
          expect(await count()).toBe(0);
        } else {
          // Oracle runs it in a transaction of its own, which isn't read-only, so it writes.  Only
          // a login that may not run such a function keeps it out, which the help says.
          await connector.preview(ctx, { kind: 'query', sql: call }, 1);
          expect(await count()).toBe(1);
        }
      });
    }
    if (kind === 'postgres')
      it('preserves the source read failure when closing its cursor also fails', async () => {
        const batches = connector.read(
          ctx,
          {
            kind: 'query',
            sql: 'SELECT id, (1 / (id - 2))::text AS name FROM generate_series(1, 3) id',
          },
          {
            columns: ['id', 'name'],
            types: { id: 'number', name: 'text' },
            keyColumns: ['id'],
            batchSize: 1,
          },
        );
        const iterator = batches[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toHaveLength(1);
        await expect(iterator.next()).rejects.toMatchObject({
          messageKey: 'sources.sync.read',
          detail: expect.stringContaining('division by zero'),
        });
      });

    it.runIf(kind === 'postgres')('distinguishes a missing database from refused credentials', async () => {
      const result = await connector.test({
        ...ctx,
        connection: {
          ...ctx.connection,
          database: `missing_timeout_${suffix}`,
        } as ConnectorContext['connection'],
      });
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({
        step: 'authenticate',
        status: 'failed',
        messageKey: 'sources.test.databaseMissing',
      });
    });

    it('reports missing objects and requested columns', async () => {
      await expect(
        connector.describe(ctx, { kind: 'object', object: { schema: owner, name: 'no_such_table' } }),
      ).rejects.toMatchObject({
        messageKey: 'sources.sync.objectMissing',
        params: { object: 'no_such_table' },
      });
      const iterable = connector.read(ctx, select, {
        columns: ['no_such_column'],
        types: {},
        keyColumns: ['id'],
      });
      const iterator = iterable[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({
        messageKey: 'sources.sync.columnMissing',
        params: { column: 'no_such_column' },
      });
    });
    it('honors abort between batches', async () => {
      const controller = new AbortController();
      const iterable = connector.read({ ...ctx, signal: controller.signal }, select, {
        columns: ['id'],
        types: { id: 'text' },
        keyColumns: ['id'],
        batchSize: 2,
      });
      const iterator = iterable[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toHaveLength(2);
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    });
    it('stops testing on resolution, connection, and authentication failures', async () => {
      const badHost = await connector.test({
        ...ctx,
        connection: { ...ctx.connection, host: 'missing-source.invalid' } as ConnectorContext['connection'],
      });
      expect(badHost.steps).toHaveLength(1);
      expect(badHost.steps[0]).toMatchObject({
        step: 'resolve',
        messageKey: 'sources.test.resolve',
        status: 'failed',
      });
      const refused = await connector.test({
        ...ctx,
        connection: { ...ctx.connection, port: await closedPort() } as ConnectorContext['connection'],
      });
      expect(refused.steps.at(-1)).toMatchObject({
        step: 'connect',
        messageKey: 'sources.test.connect',
        status: 'failed',
      });
      // The shared local cluster trusts passwords, but still rejects an unknown role.
      const stray = strayPassword();
      const badLogin = await connector.test({
        ...ctx,
        connection: { ...ctx.connection, user: `missing_${suffix}` } as ConnectorContext['connection'],
        secrets: { password: stray },
      });
      expect(badLogin.steps.at(-1)).toMatchObject({
        step: 'authenticate',
        messageKey: 'sources.test.authenticate',
        status: 'failed',
      });
      expect(JSON.stringify(badLogin)).not.toContain(stray);
      if (kind !== 'postgres') {
        const wrongPassword = await connector.test({ ...ctx, secrets: { password: stray } });
        expect(wrongPassword.steps.at(-1)).toMatchObject({
          step: 'authenticate',
          messageKey: 'sources.test.authenticate',
        });
        expect(JSON.stringify(wrongPassword)).not.toContain(stray);
      }
    });
    {
      it('interrupts a long query and enforces the statement deadline', async () => {
        // SQL Server can't wait inside a derived table, so it counts a large cross join instead.
        const sql = {
          postgres: 'SELECT pg_sleep(10)',
          mysql: 'SELECT SLEEP(10)',
          sqlserver:
            'SELECT COUNT_BIG(*) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c',
          oracle: 'SELECT COUNT(*) AS n FROM all_objects a CROSS JOIN all_objects b CROSS JOIN all_objects c',
          firebird: 'SELECT COUNT(*) AS n FROM RDB$FIELDS a CROSS JOIN RDB$FIELDS b CROSS JOIN RDB$FIELDS c',
        }[kind];
        const controller = new AbortController();
        const pending = connector.preview({ ...ctx, signal: controller.signal }, { kind: 'query', sql }, 1);
        const timer = setTimeout(() => controller.abort(), 100);
        try {
          await expect(pending).rejects.toBeInstanceOf(Error);
        } finally {
          clearTimeout(timer);
        }
        await expect(
          connector.preview({ ...ctx, timeoutMs: 100 }, { kind: 'query', sql }, 1),
        ).rejects.toBeInstanceOf(Error);
        // The source is still there for the next call.
        expect((await connector.preview(ctx, select, 1)).rows).toHaveLength(1);
      }, 30000);
    }
  });
}

describe('password authentication', () => {
  let kit: TestPostgres;
  const password = ['correct', 'password', Math.random().toString(36).slice(2, 8)].join('-');
  beforeAll(async () => {
    kit = await startTestPostgres({ password });
  }, 30000);
  afterAll(async () => {
    await kit?.stop();
  });
  it('reports a refused password at the authentication step', async () => {
    const url = new URL(kit.url);
    const stray = strayPassword();
    const ctx: ConnectorContext = {
      connection: SourceConnection.parse({
        kind: 'postgres',
        host: url.hostname,
        port: Number(url.port),
        database: 'postgres',
        user: 'postgres',
        tls: { mode: 'disable' },
      }),
      secrets: { password: stray },
    };
    const result = await connectorFor('postgres').test(ctx);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.test.authenticate',
      status: 'failed',
    });
    expect(JSON.stringify(result)).not.toContain(stray);
  });
});

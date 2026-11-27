import { accountContracts } from './connector_live_accounts.mjs';
export { LIVE_CONNECTOR_SETTINGS } from './connector_live_settings.mjs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceConnection } from '../packages/contracts/dist/index.js';
import { connectorFor } from '../packages/connectors/dist/index.js';
import { createDriverConnectors } from '../packages/connector-drivers/dist/index.js';
import { startTestPostgres } from '../packages/testkit/dist/index.js';

const requireDriver = createRequire(new URL('../packages/connectors/package.json', import.meta.url));
const requireDriverPackage = createRequire(
  new URL('../packages/connector-drivers/package.json', import.meta.url),
);
const driverConnectors = new Map(createDriverConnectors().map((connector) => [connector.kind, connector]));
const ports = { postgres: 5432, mysql: 3306, sqlserver: 1433, oracle: 1521, firebird: 3050 };
const settings = {
  postgres: process.env.RIOSOMA_TEST_DATABASE_URL,
  mysql: process.env.RIOSOMA_TEST_MYSQL_URL,
  sqlserver: process.env.RIOSOMA_TEST_MSSQL_URL,
  oracle: process.env.RIOSOMA_TEST_ORACLE_URL,
  firebird: process.env.RIOSOMA_TEST_FIREBIRD_URL,
};

/** Records statements at the installed driver's boundary, after connector translation. */
function traceMethods(target, names, trace) {
  const restores = [];
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function (...args) {
      if (/end|close|detach|destroy|disconnect/i.test(name)) {
        const result = Reflect.apply(original, this, args);
        if (result && typeof result.then === 'function')
          return result.then((value) => {
            trace.closed++;
            return value;
          });
        trace.closed++;
        return result;
      } else {
        const statement = typeof args[0] === 'string' ? args[0] : (args[0]?.sql ?? args[0]?.text);
        if (statement) trace.requests.push(statement);
      }
      return Reflect.apply(original, this, args);
    };
    restores.push(() => {
      target[name] = original;
    });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

async function waitForOracleFixture(admin, table, rowCount) {
  // A read-only snapshot can lag newly committed DDL by about a second.  Check the fixture with
  // a fresh transaction on each attempt so the contract starts with all its seeded rows visible.
  const deadline = performance.now() + 5_000;
  for (;;) {
    let stale;
    await admin.execute('SET TRANSACTION READ ONLY');
    try {
      const result = await admin.execute(`SELECT * FROM ${table}`);
      if (result.rows?.length === rowCount) return;
    } catch (error) {
      if (error?.code !== 'ORA-01466') throw error;
      stale = error;
    } finally {
      await admin.rollback();
    }
    if (performance.now() >= deadline)
      throw stale ?? new Error('Oracle contract fixture rows did not become visible.');
    await delay(50);
  }
}

async function sqlContracts(kinds) {
  const adapters = [];
  let pendingCleanup;
  try {
    for (const kind of kinds) {
      if (kind !== 'postgres' && !settings[kind]) continue;
      let kit;
      let database;
      let admin;
      let execute;
      let close;
      const restores = [];
      const trace = { requests: [], closed: 0 };
      pendingCleanup = async () => {
        await close?.().catch(() => undefined);
        for (const restore of restores.reverse()) restore();
        try {
          await database?.drop();
        } finally {
          await kit?.stop();
        }
      };
      let url;
      if (kind === 'postgres') {
        kit = settings.postgres
          ? await startTestPostgres()
          : await startTestPostgres({ password: randomBytes(24).toString('hex') });
        database = await kit.createDatabase('contract');
        url = new URL(database.url);
        const pg = requireDriver('pg');
        restores.push(traceMethods(pg.Client.prototype, ['query', 'end'], trace));
        admin = new pg.Client({ connectionString: database.url });
        await admin.connect();
        execute = (text) => admin.query(text);
        close = () => admin.end();
      } else {
        url = new URL(settings[kind]);
        if (kind === 'mysql') {
          const mysql = requireDriverPackage('mysql2');
          restores.push(
            traceMethods(mysql.Connection.prototype, ['query', 'execute', 'end', 'destroy'], trace),
          );
          const mysqlPromise = requireDriverPackage('mysql2/promise');
          admin = await mysqlPromise.createConnection(settings[kind]);
          execute = (text) => admin.query(text);
          close = () => admin.end();
        } else if (kind === 'sqlserver') {
          const mssql = requireDriverPackage('mssql');
          restores.push(traceMethods(mssql.Request.prototype, ['query'], trace));
          restores.push(traceMethods(mssql.ConnectionPool.prototype, ['close'], trace));
          admin = await new mssql.ConnectionPool({
            server: url.hostname,
            port: Number(url.port || ports[kind]),
            database: decodeURIComponent(url.pathname.slice(1)) || 'master',
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            options: { encrypt: true, trustServerCertificate: true, serverName: 'localhost' },
          }).connect();
          execute = (text) => admin.request().query(text);
          close = () => admin.close();
        } else if (kind === 'oracle') {
          const oracle = requireDriverPackage('oracledb');
          const original = oracle.getConnection;
          oracle.getConnection = async (...args) => {
            const connection = await original(...args);
            traceMethods(connection, ['execute', 'close'], trace);
            return connection;
          };
          restores.push(() => {
            oracle.getConnection = original;
          });
          admin = await oracle.getConnection({
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            connectString: `${url.hostname}:${url.port || ports[kind]}${url.pathname}`,
          });
          execute = async (text) => {
            await admin.execute(text);
            await admin.commit();
          };
          close = () => admin.close();
        } else {
          const firebird = requireDriverPackage('node-firebird');
          for (const module of ['database', 'transaction', 'connection'])
            restores.push(
              traceMethods(
                requireDriverPackage(`node-firebird/lib/wire/${module}.js`).prototype,
                ['queryAsync', 'executeAsync', 'detachAsync', 'disconnect'],
                trace,
              ),
            );
          admin = await firebird.attachAsync({
            host: url.hostname,
            port: Number(url.port || ports[kind]),
            database: decodeURIComponent(url.pathname.slice(1)),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          });
          execute = (text) => admin.queryAsync(text);
          close = () => admin.detachAsync();
        }
      }
      const schema =
        kind === 'postgres'
          ? 'public'
          : kind === 'sqlserver'
            ? 'dbo'
            : kind === 'mysql'
              ? decodeURIComponent(url.pathname.slice(1))
              : kind === 'oracle'
                ? decodeURIComponent(url.username).toUpperCase()
                : null;
      const table = `contract_${randomBytes(6).toString('hex')}`;
      const quote = (name) =>
        kind === 'mysql'
          ? `\`${name.replaceAll('`', '``')}\``
          : kind === 'sqlserver'
            ? `[${name.replaceAll(']', ']]')}]`
            : `"${name.replaceAll('"', '""')}"`;
      const qualified = [schema, table]
        .filter((part) => part !== null)
        .map(quote)
        .join('.');
      const connector = driverConnectors.get(kind) ?? connectorFor(kind);
      const context = {
        connection: SourceConnection.parse({
          kind,
          host: url.hostname,
          port: Number(url.port || ports[kind]),
          database: decodeURIComponent(url.pathname.slice(1)),
          serviceName: decodeURIComponent(url.pathname.slice(1)),
          user: decodeURIComponent(url.username),
          tls: { mode: 'disable' },
          encrypt: true,
          trustServerCertificate: true,
        }),
        secrets: { password: decodeURIComponent(url.password) || 'test' },
        timeoutMs: 10_000,
      };
      const select = { kind: 'object', object: { schema, name: table } };
      const rows = [1, 2, 3].map((id) => ({ id, title: `item-${id}` }));
      const drop = () => execute(`DROP TABLE ${qualified}`);
      try {
        await execute(
          `CREATE TABLE ${qualified} (${quote('id')} INTEGER NOT NULL PRIMARY KEY, ${quote('title')} VARCHAR(80))`,
        );
        for (const row of rows)
          await execute(
            `INSERT INTO ${qualified} (${quote('id')}, ${quote('title')}) VALUES (${row.id}, '${row.title}')`,
          );
        if (kind === 'oracle') {
          try {
            await waitForOracleFixture(admin, qualified, rows.length);
          } catch (error) {
            await drop().catch(() => undefined);
            throw error;
          }
        }
        let beforeTimeout = 0;
        const probe = (text) => async (ctx) => {
          trace.requests.length = 0;
          const session = await connector.session(ctx);
          try {
            // Small seeded IDs arrive as either numbers or exact numeric strings, depending on the driver.
            const result = await session.select(text, []);
            return {
              rows: result.map((row) => ({ id: Number(row.id), title: row.title })),
              requests: [...trace.requests],
            };
          } finally {
            await session.close();
          }
        };
        const projection = `${quote('id')}, ${quote('title')}`;
        const filter = `${quote('id')} = 2`;
        const sort = `${quote('id')} DESC`;
        adapters.push({
          connector,
          context,
          select,
          keys: [['id']],
          types: { id: { type: 'number', options: { precision: 0 } }, title: { type: 'text', options: {} } },
          read: {
            columns: ['id', 'title'],
            types: { id: 'number', title: 'text' },
            keyColumns: ['id'],
            batchSize: 1,
          },
          expectedRows: rows.map((values) => ({ key: JSON.stringify([values.id]), values })),
          filter: {
            run: probe(`SELECT ${projection} FROM ${qualified} WHERE ${filter}`),
            expectedRows: [rows[1]],
            requestIncludes: [filter],
          },
          sort: {
            run: probe(`SELECT ${projection} FROM ${qualified} ORDER BY ${sort}`),
            expectedRows: [...rows].reverse(),
            requestIncludes: [sort],
          },
          failure: (ctx) =>
            connector.describe(ctx, { kind: 'object', object: { schema, name: `${table}_missing` } }),
          timeout: async (ctx) => {
            beforeTimeout = trace.closed;
            const session = await connector.session(ctx);
            try {
              await session.select(
                kind === 'postgres'
                  ? 'SELECT pg_sleep(0.25)'
                  : kind === 'mysql'
                    ? 'SELECT SLEEP(0.25)'
                    : kind === 'firebird'
                      ? 'SELECT COUNT(*) FROM RDB$TYPES a CROSS JOIN RDB$TYPES b CROSS JOIN RDB$TYPES c CROSS JOIN RDB$TYPES d'
                      : kind === 'oracle'
                        ? 'SELECT COUNT(*) FROM all_objects a CROSS JOIN all_objects b CROSS JOIN all_objects c'
                        : 'SELECT COUNT_BIG(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c',
                [],
              );
            } finally {
              await session.close();
            }
          },
          executions: () => trace.requests.filter((text) => /SELECT\s+[12](?=\s*(?:;|\)|$))/.test(text)),
          stopped: async () => {
            const until = Date.now() + 1000;
            while (trace.closed <= beforeTimeout && Date.now() < until)
              await new Promise((fulfill) => setTimeout(fulfill, 10));
            return trace.closed > beforeTimeout;
          },
          cleanup: async () => {
            try {
              await drop();
            } finally {
              await close();
              for (const restore of restores.reverse()) restore();
              await database?.drop();
              await kit?.stop();
            }
          },
        });
        pendingCleanup = undefined;
      } catch (error) {
        await pendingCleanup();
        pendingCleanup = undefined;
        throw error;
      }
    }
  } catch (error) {
    await pendingCleanup?.();
    for (const adapter of adapters) await adapter.cleanup().catch(() => undefined);
    throw error;
  }
  return adapters;
}

export async function contracts() {
  return [
    ...Object.keys(settings).filter((kind) => kind === 'postgres' || settings[kind]).map((kind) => ({
      connector: { kind }, prepare: async () => (await sqlContracts([kind]))[0],
    })),
    ...accountContracts(),
  ];
}

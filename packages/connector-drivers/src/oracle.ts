import { randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import oracledb from 'oracledb';
import NTTCP from 'oracledb/lib/thin/sqlnet/ntTcp.js';
import {
  ORACLE_NAME,
  isHostName,
  oracleTarget,
  oracleTlsMode,
  type EasyConnect,
  type SourceColumn,
  type SourceSelect,
} from '@riosoma/contracts';
import type { Endpoint } from '@riosoma/db';
import { makeConnector, type Row, type Session } from '@riosoma/connectors/internal/common.js';
import { walletContent } from '@riosoma/connectors/internal/oracle-tls.js';
import { column } from '@riosoma/connectors/internal/values.js';
import { fromSql, objectSql, positive, projection, quote } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type ConnectorContext } from '@riosoma/connectors/internal/types.js';

/**
 * The type Oracle declares for a column, written the way `column()` reads it: `number(10,2)`,
 * `number` for one without a precision, `float(126)`, `timestamp(6) with time zone`, `varchar2(80)`.
 */
export function oracleType(
  meta: Pick<oracledb.Metadata, 'dbType' | 'dbTypeName' | 'precision' | 'scale' | 'byteSize'>,
): string {
  const name = (meta.dbTypeName ?? meta.dbType.name).toLowerCase();
  if (name === 'number') {
    const precision = meta.precision ?? 0;
    const scale = meta.scale ?? 0;
    if (scale === -127) return precision ? `float(${precision})` : 'number';
    if (scale === 0) return precision ? `number(${precision})` : 'number(*,0)';
    return `number(${precision || '*'},${scale})`;
  }
  if (['varchar2', 'nvarchar2', 'char', 'nchar', 'raw'].includes(name))
    return `${name}(${meta.byteSize ?? 0})`;
  if (name.startsWith('timestamp')) return name.replace(/^timestamp/, `timestamp(${meta.precision ?? 6})`);
  return name;
}

/**
 * The connect descriptor for one address and the service a source names, built from checked parts
 * so the driver never reads text a person typed: no host list, no parameters, no alias.
 */
export function oracleDescriptor(address: Endpoint, target: EasyConnect, tls: boolean): string {
  if (
    !isHostName(address.host) ||
    !Number.isSafeInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535 ||
    !ORACLE_NAME.test(target.service) ||
    (target.instance !== undefined && !ORACLE_NAME.test(target.instance)) ||
    (target.server !== undefined && !/^(dedicated|shared|pooled)$/.test(target.server))
  )
    throw new ConnectorError('sources.sync.read', 'The source names an address Oracle can’t take.');
  return `(DESCRIPTION=(RETRY_COUNT=0)(ADDRESS=(PROTOCOL=${tls ? 'TCPS' : 'TCP'})(HOST=${address.host})(PORT=${
    address.port
  }))(CONNECT_DATA=(SERVICE_NAME=${target.service})${target.server ? `(SERVER=${target.server.toUpperCase()})` : ''}${
    target.instance ? `(INSTANCE_NAME=${target.instance})` : ''
  }))`;
}

/**
 * A listener can answer a connection with a redirect to another address, which the driver follows
 * on its own, past the tunnel and the host a source shows.  Every transport the driver opens
 * passes through `connect`, and one opened for a redirect, which is the only kind that carries the
 * address it came from, is refused.
 */
export const REDIRECT_REFUSED =
  'Oracle’s listener redirected the connection to another address, and Riosoma connects only to the address a source names.  Connect to the listener of the instance itself, rather than a SCAN or connection manager address.';

/** Where one TLS connection's socket goes: the database's host for the name check, and the address to dial. */
export interface Route {
  host: string;
  port: number;
  dial: Endpoint;
  used: boolean;
}
const routes = new Map<string, Route>();
const ROUTE_TOKEN = /^riosoma-route-[0-9a-f]{32}\.invalid$/;

type Transport = {
  atts?: { httpsProxy?: unknown };
  stream?: Socket;
  connected?: boolean;
};
type Address = { originHost?: string; hostname?: string; port?: number | string; httpsProxy?: string };
const transport = NTTCP.prototype as unknown as {
  connect?: (this: Transport, address: Address) => Promise<void>;
  ntConnect?: (this: Transport, address: Address) => Promise<void>;
};
// An upgrade that renames or drops either method would let redirects or the driver's own sockets
// through unchecked, so it stops the connector from loading at all.
if (typeof transport.connect !== 'function' || typeof transport.ntConnect !== 'function')
  throw new Error(
    'This oracledb has no transport the Oracle connector can hold to the address a source names.',
  );
const transportConnect = transport.connect;
const ntConnect = transport.ntConnect;
transport.connect = function (address) {
  if (address?.originHost !== undefined)
    return Promise.reject(new ConnectorError('sources.test.connect', REDIRECT_REFUSED));
  return transportConnect.call(this, address);
};
export const ROUTE_UNUSED =
  'The Oracle driver opened a connection of its own instead of the one Riosoma opens to the source’s address, so Riosoma closed it.  This version of the driver doesn’t work with Riosoma’s Oracle sources.';

/**
 * Connects with the route registered under the token in the attributes' HTTPS proxy setting, and
 * removes it after.  A connection the driver made without taking the route skipped the address or
 * tunnel it names, so it's closed and refused, and a driver that stopped passing the token along
 * fails here rather than quietly connecting elsewhere.
 */
export async function connectOverRoute(
  attributes: oracledb.ConnectionAttributes,
  route: Route | undefined,
  connect: (attributes: oracledb.ConnectionAttributes) => Promise<oracledb.Connection> = (settings) =>
    oracledb.getConnection(settings),
): Promise<oracledb.Connection> {
  const token = route ? attributes.httpsProxy : undefined;
  if (route && (!token || !ROUTE_TOKEN.test(token)))
    throw new ConnectorError('sources.test.connect', ROUTE_UNUSED);
  try {
    if (token && route) routes.set(token, route);
    const connection = await connect(attributes);
    if (route && !route.used) {
      await connection.close().catch(() => undefined);
      throw new ConnectorError('sources.test.connect', ROUTE_UNUSED);
    }
    return connection;
  } finally {
    if (token) routes.delete(token);
  }
}

/**
 * The driver takes a certificate's name only from the connect descriptor's host, and opens its own
 * socket to it.  For a TLS source, the driver is given a route token where its HTTPS proxy would
 * go, which keeps it from resolving the host itself, and this opens the one socket that route
 * allows, straight to the database or its tunnel, in this process.  Nothing listens anywhere, so
 * nothing else can take the socket, and a second socket for the same route is refused.
 */
transport.ntConnect = async function (address) {
  const token = this.atts?.httpsProxy;
  if (typeof token !== 'string' || !ROUTE_TOKEN.test(token)) return ntConnect.call(this, address);
  const route = routes.get(token);
  if (
    !route ||
    route.used ||
    address.httpsProxy !== undefined ||
    address.hostname !== route.host ||
    Number(address.port) !== route.port
  )
    throw new ConnectorError('sources.test.connect', REDIRECT_REFUSED);
  route.used = true;
  this.stream = await new Promise<Socket>((resolve, reject) => {
    const socket = connectTcp(route.dial.port, route.dial.host);
    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
  // The driver adds its own handlers once it's connected.
  this.stream.on('error', () => undefined);
  this.connected = true;
};

/** Waits for a promise, but no longer than `ms`, and never throws. */
function settle(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    promise.then(
      () => resolve(),
      () => resolve(),
    );
  });
}

// Whole numbers past 2^53 and exact decimals arrive as text, and so does a CLOB, one value at a time.
const EXACT = new Set([oracledb.DB_TYPE_NUMBER, oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB]);
function fetchTypeHandler(meta: oracledb.Metadata): oracledb.FetchType | undefined {
  return EXACT.has(meta.dbType) ? { type: oracledb.STRING } : undefined;
}

async function open(ctx: ConnectorContext, endpoint: Endpoint): Promise<Session> {
  const c = ctx.connection;
  if (c.kind !== 'oracle') throw new ConnectorError('sources.sync.read');
  const target = oracleTarget(c);
  const mode = oracleTlsMode(c);
  const ms = positive(ctx.timeoutMs, 30000);
  const statementMs = positive(ctx.statementTimeoutMs, ms);
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const attributes: oracledb.ConnectionAttributes = {
    user: c.user,
    password: ctx.secrets.password ?? '',
    connectString: oracleDescriptor(endpoint, target, false),
    connectTimeout: seconds,
    transportConnectTimeout: seconds,
    retryCount: 0,
    stmtCacheSize: 0,
  };
  let route: Route | undefined;
  if (mode !== 'disable') {
    // The driver checks the certificate against the database's own host, or the name the source
    // gives, even through a tunnel, and its socket goes where the route says.
    const named = { host: c.tls.serverName ?? target.host, port: target.port };
    const wallet = walletContent(
      c.tls.caPem,
      ctx.secrets.wallet,
      ctx.secrets.walletPassword,
      mode === 'verify-ca',
    );
    Object.assign(attributes, {
      connectString: oracleDescriptor(named, target, true),
      httpsProxy: `riosoma-route-${randomBytes(16).toString('hex')}.invalid`,
      sslServerDNMatch: mode === 'verify-full',
      ...(wallet ? { walletContent: wallet } : {}),
    });
    route = { ...named, dial: endpoint, used: false };
  }
  const connection = await connectOverRoute(attributes, route);
  // Each round trip gives up after the statement timeout, and the driver interrupts the server.
  connection.callTimeout = statementMs;
  let busy = 0;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // A call in flight holds the connection, so it's interrupted before the connection closes.
      if (busy) await settle(connection.break(), 2000);
      await settle(connection.close(), 5000);
    })());
  async function execute<T = Row>(
    sql: string,
    binds: readonly unknown[] = [],
    options: oracledb.ExecuteOptions = {},
  ): Promise<oracledb.Result<T>> {
    if (closing) throw new ConnectorError('sources.sync.read');
    busy++;
    try {
      return await connection.execute<T>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchTypeHandler,
        ...options,
      });
    } finally {
      busy--;
    }
  }
  let transaction = false;
  // A read-only transaction refuses every change and reads one consistent snapshot.
  async function begin() {
    if (transaction) return;
    await execute('SET TRANSACTION READ ONLY');
    transaction = true;
  }
  async function describe(select: SourceSelect): Promise<SourceColumn[]> {
    await begin();
    const result = await execute(`SELECT * FROM ${fromSql(select, 'oracle')} WHERE 1 = 0`);
    return (result.metaData ?? []).map((meta) =>
      column({ name: meta.name, type: oracleType(meta), nullable: meta.nullable !== false }, 'oracle'),
    );
  }
  return {
    close,
    async version() {
      await execute('SELECT 1 AS ok FROM dual');
      return `Oracle Database ${connection.oracleServerVersionString}`;
    },
    async list() {
      await begin();
      // Oracle's own schemas hold its dictionary and tools, and the recycle bin, nested tables,
      // overflow segments, and temporary tables hold nothing to sync.
      const rows = (
        await execute<Row>(`SELECT schema_name, name, kind, estimate FROM (
          SELECT owner AS schema_name, table_name AS name, 'table' AS kind, num_rows AS estimate FROM all_tables
          WHERE dropped = 'NO' AND nested = 'NO' AND secondary = 'N' AND temporary = 'N'
          AND (iot_type IS NULL OR iot_type = 'IOT')
          UNION ALL SELECT owner, view_name, 'view', NULL FROM all_views
        ) WHERE schema_name NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y')
        ORDER BY schema_name, name`)
      ).rows!;
      return rows.map((row) => ({
        schema: String(row.SCHEMA_NAME),
        name: String(row.NAME),
        type: row.KIND === 'view' ? ('view' as const) : ('table' as const),
        rowEstimate: row.ESTIMATE === null || row.ESTIMATE === undefined ? null : Number(row.ESTIMATE),
      }));
    },
    async keys(object) {
      await begin();
      // Reading the object first gives the usual error when it's missing.
      await execute(`SELECT * FROM ${objectSql(object, 'oracle')} WHERE 1 = 0`);
      const rows = (
        await execute<Row>(
          `SELECT c.constraint_name AS "constraint", cc.column_name AS "column"
          FROM all_constraints c JOIN all_cons_columns cc
          ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name
          WHERE c.owner = NVL(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND c.table_name = :2
          AND c.constraint_type IN ('P', 'U') AND c.status = 'ENABLED'
          ORDER BY CASE c.constraint_type WHEN 'P' THEN 0 ELSE 1 END, c.constraint_name, cc.position`,
          [object.schema, object.name],
        )
      ).rows!;
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const name = String(row.constraint);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(String(row.column));
      }
      return [...groups.values()];
    },
    describe,
    async reset() {
      if (!transaction) return;
      transaction = false;
      await connection.rollback();
    },
    async select(text, params) {
      if (transaction) throw new ConnectorError('sources.sync.read');
      await execute('SET TRANSACTION READ ONLY');
      try {
        return (await execute<Row>(text, params)).rows ?? [];
      } finally {
        if (!closing) await connection.rollback().catch(() => undefined);
      }
    },
    async *rows(select, columns, batchSize, limit) {
      await begin();
      // Columns Riosoma can't hold, like BLOBs, are never fetched.
      const list =
        columns
          .map((col) => {
            const name = quote(col.name, 'oracle');
            return `${col.suggested ? projection(col, name, 'oracle') : 'NULL'} AS ${name}`;
          })
          .join(', ') || '*';
      const { resultSet } = await execute<Row>(
        `SELECT ${list} FROM ${fromSql(select, 'oracle')}${limit ? ` FETCH FIRST ${limit} ROWS ONLY` : ''}`,
        [],
        { resultSet: true, fetchArraySize: batchSize, prefetchRows: batchSize },
      );
      if (!resultSet) throw new ConnectorError('sources.sync.read');
      try {
        for (;;) {
          busy++;
          let rows: Row[];
          try {
            rows = await resultSet.getRows(batchSize);
          } finally {
            busy--;
          }
          if (rows.length) yield rows;
          if (rows.length < batchSize) break;
        }
      } finally {
        if (!closing) await resultSet.close().catch(() => undefined);
      }
    },
  };
}

export const oracle = makeConnector('oracle', open);

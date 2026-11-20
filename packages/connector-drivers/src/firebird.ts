import type { Readable } from 'node:stream';
import * as Firebird from 'node-firebird';
import Connection from 'node-firebird/lib/wire/connection.js';
import Const from 'node-firebird/lib/wire/const.js';
import type { SourceColumn, SourceObject, SourceSelect } from '@riosoma/contracts';
import type { Endpoint } from '@riosoma/db';
import { makeConnector, type Row, type Session } from '@riosoma/connectors/internal/common.js';
import { column } from '@riosoma/connectors/internal/values.js';
import { fromSql, objectSql, positive, projection, quote } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type ConnectorContext } from '@riosoma/connectors/internal/types.js';

/** What a prepared statement says about one of its columns. */
export interface FirebirdVar {
  type: number;
  subType?: number;
  scale?: number;
  length?: number;
  nullable?: boolean;
  alias?: string;
  field?: string;
}

/** Bytes a character can take in each multibyte character set, by Firebird's ID for it. */
const BYTES_PER_CHARACTER: Record<number, number> = {
  3: 3,
  4: 4,
  5: 2,
  6: 2,
  44: 2,
  56: 2,
  57: 2,
  64: 2,
  67: 2,
  69: 4,
};
const INTEGERS: Record<number, [string, number]> = {
  500: ['smallint', 4],
  496: ['integer', 9],
  580: ['bigint', 18],
  32752: ['int128', 38],
};

/**
 * The type Firebird declares for a column, written the way `column()` reads it.  A prepared
 * statement names the storage, so an exact number's precision is its storage's: `numeric(18,4)`.
 */
export function firebirdType(v: FirebirdVar): string {
  const type = v.type & ~1;
  const integer = INTEGERS[type];
  if (integer) {
    const scale = -(v.scale ?? 0);
    if (scale > 0 || v.subType === 1 || v.subType === 2)
      return `${v.subType === 2 ? 'decimal' : 'numeric'}(${integer[1]},${scale})`;
    return integer[0];
  }
  switch (type) {
    case 482:
      return 'float';
    case 480:
    case 530:
      return 'double precision';
    case 32760:
      return 'decfloat(16)';
    case 32762:
      return 'decfloat(34)';
    case 32764:
      return 'boolean';
    case 570:
      return 'date';
    case 560:
      return 'time';
    case 32756:
    case 32750:
      return 'time with time zone';
    case 510:
      return 'timestamp';
    case 32754:
    case 32748:
      return 'timestamp with time zone';
    case 448:
    case 452: {
      const varying = type === 448;
      // OCTETS holds bytes rather than characters.
      if (v.subType === 1) return `${varying ? 'varbinary' : 'binary'}(${v.length ?? 0})`;
      const characters = Math.floor((v.length ?? 0) / (BYTES_PER_CHARACTER[v.subType ?? 0] ?? 1));
      return `${varying ? 'varchar' : 'char'}(${characters})`;
    }
    case 520:
      return v.subType === 1
        ? 'blob sub_type text'
        : v.subType === 0
          ? 'blob sub_type binary'
          : `blob sub_type ${v.subType}`;
    case 540:
      return 'array';
    default:
      return 'unknown';
  }
}

/** The driver's connection, for closing it at once when a read is abandoned mid-statement. */
interface WireConnection {
  _isDetach: boolean;
  _isClosed?: boolean;
  _isOpened?: boolean;
  _retry_connection_id?: ReturnType<typeof setTimeout>;
  _rejectPending?(error: Error): void;
  _socket?: { destroy(): void };
}

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

const SRP: ReadonlySet<string> = new Set(Const.AUTH_PLUGIN_SRP_LIST);
// The sign-in below drives these steps and wraps one of them, so a driver that renamed or dropped
// any of them would sign in unchecked, and stops the connector from loading instead.
for (const step of ['connect', 'attach', 'sendOpContAuth', '_rejectPending'] as const)
  if (typeof (Connection.prototype as unknown as Record<string, unknown>)[step] !== 'function')
    throw new Error(
      `This node-firebird has no ${step}, which the Firebird connector checks the sign-in with.`,
    );
export const LEGACY_REFUSED =
  'Firebird asked to sign in with Legacy_Auth, which sends a hash of the password, and this source requires wire encryption, so Riosoma signs in only with SRP.  Give the user an SRP password on the server, or set the source’s wire encryption to When the server offers it.';
export const NOT_ENCRYPTED =
  'Firebird didn’t agree to a secure connection before signing in.  Its WireCrypt setting may be Disabled, or it may be older than Firebird 3.';

type Options = Parameters<Connection['connect']>[0];

/** Stops a connection at once, without a detach, a reconnect, or a callback still waiting. */
function stop(cnx: Connection) {
  const wire = cnx as unknown as WireConnection;
  wire._isDetach = true;
  clearTimeout(wire._retry_connection_id);
  wire._socket?.destroy();
}

/**
 * Connects, signs in, and attaches, the steps the driver's own `attach` takes, so a required
 * source can check what the server agreed to between them.  With `required`, the driver offers
 * only the SRP `plugin`, which sends a proof rather than anything a password can be read from,
 * refuses to answer a request to sign in with Legacy_Auth, and stops before attaching, whose
 * request can carry the password, unless the server accepted SRP on protocol 13 or later and wire
 * encryption is on.  The driver's own reconnect, which would sign in again unchecked, is off
 * twice over: the options say the connection is pooled, which its close handler reads as no
 * reconnect, and a handler that runs before the driver's own marks the connection detached when
 * its socket closes, which the driver's handler returns on first.
 */
function attachOnce(options: Options, required: boolean, plugin: string | undefined, ms: number) {
  return new Promise<Firebird.Database>((resolve, reject) => {
    let settled = false;
    const settings = { ...options, pluginName: required ? plugin : undefined };
    const cnx: Connection = new Connection(
      String(settings.host),
      Number(settings.port),
      (error) => {
        if (error) return fail(error);
        if (settled) return;
        if (required) {
          const send = cnx.sendOpContAuth.bind(cnx);
          cnx.sendOpContAuth = (data, encoding, pluginName) => {
            if (SRP.has(pluginName)) return send(data, encoding, pluginName);
            fail(new Error(LEGACY_REFUSED));
          };
        }
        cnx.connect(settings, (error, accept) => {
          if (error) return fail(error);
          if (
            required &&
            !(
              accept &&
              accept.protocolVersion >= Const.PROTOCOL_VERSION13 &&
              SRP.has(accept.pluginName) &&
              accept.sessionKey
            )
          )
            return fail(new Error(NOT_ENCRYPTED));
          cnx.attach(settings, (error, db) => {
            if (error || !db) return fail(error ?? new Error(NOT_ENCRYPTED));
            settled = true;
            clearTimeout(timer);
            resolve(db as unknown as Firebird.Database);
          });
        });
      },
      settings,
    );
    // Only the driver's close handler reads this, where it means no reconnect.
    (settings as { isPool?: boolean }).isPool = true;
    const wire = cnx as unknown as WireConnection & { error?: Error };
    (
      wire._socket as unknown as { prependListener(event: 'close', listener: () => void): void }
    ).prependListener('close', () => {
      if (wire._isDetach) return;
      // Closed the way the driver's own handler marks it, so later calls fail at once.
      wire._isDetach = true;
      wire._isClosed = true;
      wire._isOpened = false;
      wire._rejectPending?.(wire.error ?? new Error('Firebird closed the connection.'));
    });
    const timer = setTimeout(() => fail(new Error('Firebird timed out while signing in.')), ms);
    timer.unref();
    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop(cnx);
      reject(error);
    }
  });
}

/** Signs in, trying the SRP variant the server names when it won't take SHA-256, as Firebird 3's default does. */
export async function attachFirebird(
  options: Options,
  required: boolean,
  ms: number,
): Promise<Firebird.Database> {
  try {
    return await attachOnce(options, required, Const.AUTH_PLUGIN_SRP256, ms);
  } catch (error) {
    const named = /but support : (\S+)/.exec(error instanceof Error ? error.message : '')?.[1];
    if (!required || !named || !SRP.has(named)) throw error;
    return attachOnce(options, required, named, ms);
  }
}

async function open(ctx: ConnectorContext, endpoint: Endpoint): Promise<Session> {
  const c = ctx.connection;
  if (c.kind !== 'firebird') throw new ConnectorError('sources.sync.read');
  // The driver fills a missing password from the environment, or with Firebird's well-known default.
  const password = ctx.secrets.password;
  if (!password) throw new Error('No password is stored for this source.');
  const ms = positive(ctx.timeoutMs, 30000);
  const statementMs = positive(ctx.statementTimeoutMs, ms);
  // The options are given whole, so none of them falls back to the process's environment.
  const db = await attachFirebird(
    {
      host: endpoint.host,
      port: endpoint.port,
      database: c.database,
      user: c.user,
      password,
      role: c.role,
      encoding: 'UTF8',
      wireCrypt: Firebird.WIRE_CRYPT_ENABLE,
      numericMode: Firebird.NUMERIC_MODE_STRING,
      blobAsText: true,
      lowercase_keys: false,
      statementCacheSize: 0,
    },
    c.wireCrypt === 'required',
    ms,
  );
  const wire = (db as unknown as { connection: WireConnection }).connection;
  let busy = 0;
  let closing: Promise<void> | undefined;
  let transaction: Firebird.Transaction | undefined;
  const streams = new Set<Readable>();
  /** Drops the socket without asking the server, which is still busy with the abandoned statement. */
  const drop = () => {
    wire._isDetach = true;
    clearTimeout(wire._retry_connection_id);
    wire._rejectPending?.(new ConnectorError('sources.sync.read'));
    wire._socket?.destroy();
  };
  const close = () =>
    (closing ??= (async () => {
      for (const stream of streams) stream.destroy(new ConnectorError('sources.sync.read'));
      // A statement still running is canceled on the server, so it stops working on it.
      if (busy) await settle(db.cancelAsync(), 1000);
      else {
        // The driver counts a finished read's cleanup as pending, so the detach goes ahead regardless.
        if (transaction) await settle(transaction.rollbackAsync(), 1000);
        await settle(db.detachAsync(true), 2000);
      }
      drop();
    })());
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (closing) throw new ConnectorError('sources.sync.read');
    busy++;
    try {
      return await action();
    } finally {
      busy--;
    }
  }
  try {
    const [row] = await run(() =>
      db.queryAsync<Row>("SELECT RDB$GET_CONTEXT('SYSTEM', 'WIRE_ENCRYPTED') AS ENCRYPTED FROM RDB$DATABASE"),
    );
    // The handshake already said so, and the server confirms it.
    if (c.wireCrypt === 'required' && row?.ENCRYPTED !== 'TRUE') throw new Error(NOT_ENCRYPTED);
  } catch (error) {
    await close();
    throw error;
  }
  // A read-only snapshot refuses every change and reads the whole table as of one moment.
  async function begin(): Promise<Firebird.Transaction> {
    transaction ??= await run(() =>
      db.transactionAsync({ readOnly: true, isolation: Firebird.ISOLATION_REPEATABLE_READ }),
    );
    return transaction;
  }
  async function describe(select: SourceSelect): Promise<SourceColumn[]> {
    const tx = await begin();
    // Preparing the statement describes it without reading a row.
    const statement = await run(() => tx.newStatementAsync(`SELECT * FROM ${fromSql(select, 'firebird')}`));
    try {
      const output = (statement as unknown as { output?: FirebirdVar[] }).output ?? [];
      return output.map((v) =>
        column(
          { name: v.alias || v.field || '', type: firebirdType(v), nullable: v.nullable !== false },
          'firebird',
        ),
      );
    } finally {
      await run(() => statement.releaseAsync()).catch(() => undefined);
    }
  }
  return {
    close,
    async version() {
      const [row] = await run(() =>
        db.queryAsync<Row>("SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS VERSION FROM RDB$DATABASE"),
      );
      return `Firebird ${String(row?.VERSION)}`;
    },
    async list(): Promise<SourceObject[]> {
      const tx = await begin();
      // Tables, views, and external tables the user may read.  Firebird keeps no row counts, but a
      // unique index's selectivity from its last statistics is one over the rows it indexed.
      const rows = await run(() =>
        tx.queryAsync<Row>(`SELECT TRIM(r.RDB$RELATION_NAME) AS NAME,
          IIF(r.RDB$VIEW_BLR IS NULL, 0, 1) AS IS_VIEW,
          (SELECT MIN(i.RDB$STATISTICS) FROM RDB$RELATION_CONSTRAINTS k
            JOIN RDB$INDICES i ON i.RDB$INDEX_NAME = k.RDB$INDEX_NAME
            WHERE k.RDB$RELATION_NAME = r.RDB$RELATION_NAME AND k.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
          ) AS SELECTIVITY
          FROM RDB$RELATIONS r
          WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0 AND COALESCE(r.RDB$RELATION_TYPE, 0) IN (0, 1, 2)
          AND (CURRENT_USER = 'SYSDBA' OR CURRENT_ROLE = 'RDB$ADMIN' OR r.RDB$OWNER_NAME = CURRENT_USER
            OR EXISTS (SELECT 1 FROM RDB$USER_PRIVILEGES p WHERE p.RDB$RELATION_NAME = r.RDB$RELATION_NAME
              AND p.RDB$PRIVILEGE = 'S' AND p.RDB$USER IN (CURRENT_USER, CURRENT_ROLE, 'PUBLIC')))
          ORDER BY 1`),
      );
      return rows.map((row) => {
        const selectivity = Number(row.SELECTIVITY);
        return {
          schema: null,
          name: String(row.NAME),
          type: row.IS_VIEW ? ('view' as const) : ('table' as const),
          rowEstimate:
            !row.IS_VIEW && Number.isFinite(selectivity) && selectivity > 0
              ? Math.round(1 / selectivity)
              : null,
        };
      });
    },
    async keys(object) {
      const tx = await begin();
      // Preparing a read of the object gives the usual error when it's missing.
      const statement = await run(() =>
        tx.newStatementAsync(`SELECT * FROM ${objectSql(object, 'firebird')}`),
      );
      await run(() => statement.releaseAsync()).catch(() => undefined);
      const rows = await run(() =>
        tx.queryAsync<Row>(
          `SELECT TRIM(k.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME, TRIM(s.RDB$FIELD_NAME) AS COLUMN_NAME
          FROM RDB$RELATION_CONSTRAINTS k JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = k.RDB$INDEX_NAME
          WHERE k.RDB$RELATION_NAME = ? AND k.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
          ORDER BY IIF(k.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY', 0, 1), k.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION`,
          [object.name],
        ),
      );
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const name = String(row.CONSTRAINT_NAME);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(String(row.COLUMN_NAME));
      }
      return [...groups.values()];
    },
    describe,
    async reset() {
      const tx = transaction;
      transaction = undefined;
      if (tx) await run(() => tx.rollbackAsync());
    },
    async select(text, params) {
      if (transaction) throw new ConnectorError('sources.sync.read');
      const tx = await begin();
      try {
        return await run(() => tx.queryAsync<Row>(text, [...params], { timeout: statementMs }));
      } finally {
        transaction = undefined;
        if (!closing) await run(() => tx.rollbackAsync()).catch(() => undefined);
      }
    },
    async *rows(select, columns, batchSize, limit) {
      const tx = await begin();
      // Columns Riosoma can't hold, like binary BLOBs, are never fetched.
      const list =
        columns
          .map((col) => {
            const name = quote(col.name, 'firebird');
            return `${col.suggested ? projection(col, name, 'firebird') : 'NULL'} AS ${name}`;
          })
          .join(', ') || '*';
      if (closing) throw new ConnectorError('sources.sync.read');
      const stream = tx.queryStream(
        `SELECT ${list} FROM ${fromSql(select, 'firebird')}${limit ? ` FETCH FIRST ${limit} ROWS ONLY` : ''}`,
        [],
        { highWaterMark: batchSize, timeout: statementMs },
      );
      streams.add(stream);
      busy++;
      try {
        let batch: Row[] = [];
        for await (const row of stream) {
          batch.push(row as Row);
          if (batch.length === batchSize) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length) yield batch;
      } finally {
        busy--;
        streams.delete(stream);
        stream.destroy();
      }
    },
  };
}

export const firebird = makeConnector('firebird', open);

import { createConnection as socketConnection } from 'node:net';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import mysql, { type FieldPacket, type RowDataPacket } from 'mysql2';
import type { SourceColumn, SourceSelect } from '@riosoma/contracts';
import type { Endpoint } from '@riosoma/db';
import { makeConnector, type Row, type Session } from '@riosoma/connectors/internal/common.js';
import { column } from '@riosoma/connectors/internal/values.js';
import { fromSql, objectSql, positive, quote } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type ConnectorContext } from '@riosoma/connectors/internal/types.js';

export function enumLabels(type: string): string[] {
  const labels: string[] = [];
  const expression = /'((?:[^'\\]|\\.|'')*)'/g;
  for (const match of type.matchAll(expression))
    labels.push(
      match[1]!
        .replace(/''/g, "'")
        .replace(
          /\\(.)/g,
          (_match, value: string) => ({ n: '\n', r: '\r', t: '\t', '0': '\0' })[value] ?? value,
        ),
    );
  return labels;
}
function fieldType(field: FieldPacket): string {
  const types: Record<number, string> = {
    0: 'decimal',
    1: 'tinyint',
    2: 'smallint',
    3: 'int',
    4: 'float',
    5: 'double',
    7: 'timestamp',
    8: 'bigint',
    9: 'mediumint',
    10: 'date',
    11: 'time',
    12: 'datetime',
    13: 'year',
    15: 'varchar',
    16: 'bit',
    245: 'json',
    246: 'decimal',
    247: 'enum',
    248: 'set',
    249: 'tinytext',
    250: 'mediumtext',
    251: 'longtext',
    252: 'text',
    253: 'varchar',
    254: 'char',
    255: 'geometry',
  };
  const type = types[field.columnType ?? field.type ?? -1] ?? 'unknown';
  if ((field.characterSet ?? field.charsetNr) === 63 && /char|text/.test(type)) return 'binary';
  if (type === 'bit') return `bit(${field.columnLength ?? field.length ?? 1})`;
  return type;
}
async function open(ctx: ConnectorContext, endpoint: Endpoint): Promise<Session> {
  const c = ctx.connection;
  if (c.kind !== 'mysql') throw new ConnectorError('sources.sync.read');
  const databaseName = c.database;
  const ms = positive(ctx.timeoutMs, 30000);
  const statementMs = positive(ctx.statementTimeoutMs, ms);
  const tls = c.tls;
  const connection = mysql.createConnection({
    host: tls.serverName ?? c.host,
    port: endpoint.port,
    database: c.database,
    user: c.user,
    password: ctx.secrets.password,
    // Keep the logical host for certificate verification while dialing the forwarded endpoint.
    stream: () => socketConnection(endpoint),
    connectTimeout: ms,
    multipleStatements: false,
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ssl:
      tls.mode === 'disable'
        ? undefined
        : {
            ca: tls.caPem,
            cert: tls.clientCertPem,
            key: ctx.secrets.clientKeyPem,
            rejectUnauthorized: tls.mode === 'verify-ca' || tls.mode === 'verify-full',
            verifyIdentity: tls.mode === 'verify-full',
          },
  });
  connection.on('error', () => undefined);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      connection.destroy();
    }
  };
  try {
    await new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve())),
    );
    if (tls.mode === 'verify-full') {
      // The driver omits its identity check for IP literals.
      const stream = (connection as unknown as { stream: TLSSocket }).stream;
      const error = checkServerIdentity(tls.serverName ?? c.host, stream.getPeerCertificate(true));
      if (error) throw error;
    }
  } catch (error) {
    await close();
    if (tls.mode === 'prefer' && (error as { code?: string }).code === 'HANDSHAKE_NO_SSL_SUPPORT') {
      return open({ ...ctx, connection: { ...c, tls: { ...tls, mode: 'disable' } } }, endpoint);
    }
    throw error;
  }
  const query = async (sql: string, values: unknown[] = []) =>
    connection.promise().query<RowDataPacket[]>({ sql, timeout: ms }, values);
  let transaction = false;
  let limited = false;
  async function limits() {
    if (limited) return;
    await query("SET time_zone = '+00:00'");
    const [rows] = await query('SELECT VERSION() AS version');
    if (/mariadb/i.test(String(rows[0]?.version)))
      await query(`SET SESSION max_statement_time = ${statementMs / 1000}`);
    else await query(`SET SESSION max_execution_time = ${statementMs}`);
    limited = true;
  }
  async function begin() {
    if (transaction) return;
    await limits();
    await query('START TRANSACTION READ ONLY');
    transaction = true;
  }
  async function describe(select: SourceSelect): Promise<SourceColumn[]> {
    await begin();
    const [, fields] = await query(`SELECT * FROM ${fromSql(select, 'mysql')} LIMIT 0`);
    return Promise.all(
      fields.map(async (field) => {
        const [metadata] =
          field.orgTable && field.orgName
            ? await query(
                `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS length, NUMERIC_SCALE AS scale
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
                [field.db ?? field.schema ?? databaseName, field.orgTable, field.orgName],
              )
            : [[]];
        const info = metadata[0];
        const type = info ? String(info.type) : fieldType(field);
        return column(
          {
            name: field.name,
            type,
            nullable: info ? info.nullable === 'YES' : !(typeof field.flags === 'number' && field.flags & 1),
            scale: info?.scale === null ? undefined : Number(info?.scale ?? field.decimals),
            length:
              info?.length === null
                ? undefined
                : Number(info?.length ?? (field.columnLength ?? field.length ?? 0) / 4),
            labels: /^(enum|set)\(/i.test(type) ? enumLabels(type) : undefined,
          },
          'mysql',
        );
      }),
    );
  }
  return {
    close,
    async version() {
      return String((await query('SELECT VERSION() AS version'))[0][0]!.version);
    },
    async list() {
      const [rows] =
        await query(`SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimate
        FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY TABLE_SCHEMA,TABLE_NAME`);
      const readable = [];
      for (const row of rows) {
        try {
          await query(
            `SELECT * FROM ${objectSql({ schema: String(row.schema_name), name: String(row.name) }, 'mysql')} LIMIT 0`,
          );
        } catch (error) {
          if (
            ['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR'].includes(
              String((error as { code?: string }).code),
            )
          )
            continue;
          throw error;
        }
        readable.push({
          schema: String(row.schema_name),
          name: String(row.name),
          type: row.type === 'VIEW' ? ('view' as const) : ('table' as const),
          rowEstimate: row.type === 'VIEW' || row.estimate === null ? null : Number(row.estimate),
        });
      }
      return readable;
    },
    async keys(object) {
      await query(`SELECT * FROM ${objectSql(object, 'mysql')} LIMIT 0`);
      const [rows] = await query(
        `SELECT tc.CONSTRAINT_NAME AS constraint_name, k.COLUMN_NAME AS column_name
        FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.KEY_COLUMN_USAGE k
        ON k.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME=tc.TABLE_NAME AND k.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA=? AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE')
        ORDER BY (tc.CONSTRAINT_TYPE='PRIMARY KEY') DESC,tc.CONSTRAINT_NAME,k.ORDINAL_POSITION`,
        [object.schema ?? c.database, object.name],
      );
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const name = String(row.constraint_name);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(String(row.column_name));
      }
      return [...groups.values()];
    },
    describe,
    async reset() {
      if (!transaction) return;
      transaction = false;
      await query('COMMIT');
    },
    // Values travel as a prepared statement's parameters, so no server setting changes their meaning.
    async select(text, params) {
      if (transaction) throw new ConnectorError('sources.sync.read');
      await limits();
      await query('START TRANSACTION READ ONLY');
      try {
        const [rows] = await connection
          .promise()
          .execute<RowDataPacket[]>({ sql: text, timeout: statementMs + 1_000 }, [...params]);
        await query('COMMIT');
        return rows as Row[];
      } catch (error) {
        if (!closed) await query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
    async *rows(select, columns, batchSize, limit) {
      await begin();
      const projection = columns.map((col) => quote(col.name, 'mysql')).join(', ') || '*';
      const stream = connection
        .query(`SELECT ${projection} FROM ${fromSql(select, 'mysql')}${limit ? ` LIMIT ${limit}` : ''}`)
        .stream({ highWaterMark: batchSize });
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
        stream.destroy();
      }
    },
  };
}
export const mysqlConnector = makeConnector('mysql', open);

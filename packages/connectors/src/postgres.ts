import pg from 'pg';
import {
  DatabaseProfile,
  type SourceColumn,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
} from '@riosoma/contracts';
import { connectDatabase, passwordSource, type Endpoint } from '@riosoma/db';
import { registerConnector } from './registry.js';
import { makeConnector, scrub, type Row, type Session } from './common.js';
import { column } from './values.js';
import { fromSql, objectSql, positive, projection, quote } from './sql.js';
import { ConnectorError, type ConnectorContext } from './types.js';

export function postgresProfile(ctx: ConnectorContext): DatabaseProfile {
  const c = ctx.connection;
  if (c.kind !== 'postgres') throw new ConnectorError('sources.sync.read');
  return DatabaseProfile.parse({
    ...c,
    auth: { ...c.auth, password: ctx.secrets.password, clientSecret: ctx.secrets.clientSecret },
    tls: { ...c.tls, clientKeyPem: ctx.secrets.clientKeyPem },
    ssh: c.ssh
      ? { ...c.ssh, privateKeyPem: ctx.secrets.sshPrivateKeyPem, passphrase: ctx.secrets.sshPassphrase }
      : undefined,
  });
}
const parsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format !== 'binary' && [1082, 1114, 1184].includes(oid)) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  },
};

async function open(ctx: ConnectorContext, endpoint: Endpoint): Promise<Session> {
  const profile = postgresProfile(ctx);
  const ms = positive(ctx.timeoutMs, 30000);
  const statementMs = positive(ctx.statementTimeoutMs, ms);
  const secrets = { ...ctx.secrets };
  const password = passwordSource(profile);
  const database = await connectDatabase(
    { ...profile, ssh: undefined },
    {
      endpoint,
      max: 1,
      connectTimeoutMs: ms,
      queryTimeoutMs: ms,
      statementTimeoutMs: ms,
      password:
        typeof password === 'function'
          ? async () => {
              const token = await password();
              secrets.token = token;
              return token;
            }
          : password,
    },
  );
  let client: pg.PoolClient;
  try {
    client = await database.pool.connect();
  } catch (error) {
    await database.close();
    if (error instanceof Error) error.message = scrub(error, { ...ctx, secrets });
    throw error;
  }
  client.on('error', () => undefined);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      client.release(true);
      await database.close();
    }
  };
  async function query(text: string, values: unknown[] = []) {
    try {
      return await client.query<Row>({
        text,
        values,
        types: parsers,
        queryMode: 'extended',
      } as pg.QueryConfig);
    } catch (error) {
      if (error instanceof Error) error.message = scrub(error, { ...ctx, secrets });
      throw error;
    }
  }
  let transaction = false;
  async function begin() {
    if (transaction) return;
    await query('BEGIN READ ONLY');
    transaction = true;
    await query(`SET LOCAL statement_timeout = ${ms}`);
    await query("SET LOCAL TIME ZONE 'UTC'");
  }
  async function describe(select: SourceSelect): Promise<SourceColumn[]> {
    await begin();
    const result = await query(`SELECT * FROM ${fromSql(select, 'postgres')} LIMIT 0`);
    const columns: SourceColumn[] = [];
    for (const field of result.fields) {
      const info = (
        await query(
          `SELECT format_type($1::oid, $2::int) AS type,
        COALESCE((SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=$3 AND attnum=$4), true) AS nullable,
        (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=$1) AS labels`,
          [field.dataTypeID, field.dataTypeModifier, field.tableID, field.columnID],
        )
      ).rows[0]!;
      columns.push(
        column(
          {
            name: field.name,
            type: String(info.type),
            nullable: Boolean(info.nullable),
            labels: Array.isArray(info.labels) ? info.labels.map(String) : undefined,
          },
          'postgres',
        ),
      );
    }
    return columns;
  }
  return {
    close,
    async version() {
      return String((await query('SELECT version() AS version')).rows[0]!.version);
    },
    async list(): Promise<SourceObject[]> {
      const result = await query(`SELECT n.nspname AS schema, c.relname AS name,
        CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS type,
        CASE WHEN c.relkind='v' OR c.reltuples<0 THEN NULL ELSE c.reltuples END AS estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%'
        AND n.nspname <> 'information_schema' AND has_schema_privilege(n.oid,'USAGE')
        AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname`);
      return result.rows.map((r) => ({
        schema: String(r.schema),
        name: String(r.name),
        type: r.type === 'view' ? 'view' : 'table',
        rowEstimate: r.estimate === null ? null : Number(r.estimate),
      }));
    },
    async keys(object: SourceObjectRef) {
      // Resolving the object also produces the normal missing-object error.
      await query(`SELECT * FROM ${objectSql(object, 'postgres')} LIMIT 0`);
      const rows = (
        await query(
          `SELECT con.conname, json_agg(a.attname ORDER BY k.ord) AS columns
        FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
        WHERE con.conrelid=$1::regclass AND con.contype IN ('p','u') AND c.relkind IN ('r','p')
        GROUP BY con.oid,con.conname,con.contype ORDER BY (con.contype='p') DESC,con.conname`,
          [objectSql(object, 'postgres')],
        )
      ).rows;
      return rows.map((r) => r.columns as string[]);
    },
    describe,
    async reset() {
      if (!transaction) return;
      transaction = false;
      await query('COMMIT');
    },
    async select(text, params) {
      if (transaction) throw new ConnectorError('sources.sync.read');
      try {
        // One round trip opens the transaction with its limits.
        await client.query(
          `BEGIN READ ONLY; SET LOCAL statement_timeout = ${statementMs}; SET LOCAL TIME ZONE 'UTC'`,
        );
      } catch (error) {
        if (error instanceof Error) error.message = scrub(error, { ...ctx, secrets });
        throw error;
      }
      try {
        const result = await query(text, [...params]);
        await query('COMMIT');
        return result.rows;
      } catch (error) {
        if (!closed) await query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
    async *rows(select, columns, batchSize, limit) {
      await begin();
      const list =
        columns
          .map(
            (c) => `${projection(c, quote(c.name, 'postgres'), 'postgres')} AS ${quote(c.name, 'postgres')}`,
          )
          .join(', ') || '*';
      await query(
        `DECLARE source_rows NO SCROLL CURSOR FOR SELECT ${list} FROM ${fromSql(select, 'postgres')}${limit ? ` LIMIT ${limit}` : ''}`,
      );
      let readFailed = false;
      try {
        for (;;) {
          const result = await query(`FETCH FORWARD ${batchSize} FROM source_rows`);
          if (!result.rows.length) break;
          yield result.rows;
        }
      } catch (error) {
        readFailed = true;
        throw error;
      } finally {
        // Cursor cleanup in an aborted transaction would hide the source's original failure.
        if (!closed && !readFailed) await query('CLOSE source_rows');
      }
    },
  };
}
export const postgres = makeConnector('postgres', open);
registerConnector(postgres);

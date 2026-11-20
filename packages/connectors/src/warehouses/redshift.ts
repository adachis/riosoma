import pg from 'pg';
import type { SourceColumn, SourceSelect } from '@riosoma/contracts';
import { makeConnector, scrub, type Session } from '../common.js';
import { element } from '../files/s3.js';
import { registerConnector } from '../registry.js';
import { fromSql, positive, quote } from '../sql.js';
import { column } from '../values.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { AwsClient, type AwsOptions } from './aws.js';

export async function redshiftCredentials(
  ctx: ConnectorContext,
  options: AwsOptions = {},
): Promise<{ user: string; password: string }> {
  const c = ctx.connection;
  if (c.kind !== 'redshift') throw new ConnectorError('sources.sync.read');
  if (c.auth === 'password') return { user: c.user!, password: ctx.secrets.password ?? '' };
  const client = new AwsClient(ctx, c.region, options);
  if (c.deployment === 'serverless') {
    const answer = await client.json<{ dbUser: string; dbPassword: string }>(
      'redshift-serverless',
      'RedshiftServerless.GetCredentials',
      {
        dbName: c.database,
        workgroupName: c.workgroup,
        durationSeconds: 900,
      },
    );
    if (!answer.dbUser || !answer.dbPassword) throw new ConnectorError('sources.secretsMissing');
    return { user: answer.dbUser, password: answer.dbPassword };
  }
  const body = new URLSearchParams({
    Action: 'GetClusterCredentials',
    Version: '2012-12-01',
    ClusterIdentifier: c.clusterIdentifier!,
    DbName: c.database,
    DbUser: c.user!,
    AutoCreate: 'false',
    DurationSeconds: '900',
  });
  const answer = await client.request('redshift', body.toString(), {
    'content-type': 'application/x-www-form-urlencoded',
  });
  const user = element(answer, 'DbUser');
  const password = element(answer, 'DbPassword');
  if (!user || !password) throw new ConnectorError('sources.secretsMissing');
  return { user, password };
}

/** SUPER stays JSON text, and geometry becomes text with its spatial reference intact. */
export function redshiftColumn(name: string, type: string, nullable = true): SourceColumn {
  if (type.toLowerCase() === 'geometry')
    return {
      name,
      sourceType: type,
      nullable,
      suggested: { type: 'longText', options: {} },
      alternatives: [],
    };
  const spec = column({ name, type: type.toLowerCase() === 'super' ? 'json' : type, nullable }, 'postgres');
  return { ...spec, sourceType: type };
}

export interface RedshiftOptions extends AwsOptions {
  client?: (config: pg.ClientConfig) => pg.Client;
  ca?: () => Promise<string>;
}

let cachedCa: { text: string; until: number } | undefined;
async function amazonCa(): Promise<string> {
  if (cachedCa && cachedCa.until > Date.now()) return cachedCa.text;
  const response = await fetch('https://s3.amazonaws.com/redshift-downloads/amazon-trust-ca-bundle.crt', {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new ConnectorError('sources.test.tls');
  const text = await response.text();
  if (text.length > 64_000 || !text.includes('-----BEGIN CERTIFICATE-----'))
    throw new ConnectorError('sources.test.tls');
  cachedCa = { text, until: Date.now() + 86_400_000 };
  return text;
}

export function createRedshiftConnector(options: RedshiftOptions = {}) {
  const connector = makeConnector('postgres', async (ctx, endpoint): Promise<Session> => {
    const c = ctx.connection;
    if (c.kind !== 'redshift') throw new ConnectorError('sources.sync.read');
    const credentials = await redshiftCredentials(ctx, options);
    const safe = { ...ctx, secrets: { ...ctx.secrets, password: credentials.password } };
    const ms = positive(ctx.statementTimeoutMs, positive(ctx.timeoutMs, 30_000));
    const client = (options.client ?? ((config) => new pg.Client(config)))({
      ...endpoint,
      database: c.database,
      ...credentials,
      ssl: { rejectUnauthorized: true, servername: c.host, ca: await (options.ca ?? amazonCa)() },
      connectionTimeoutMillis: ctx.timeoutMs ?? 30_000,
      query_timeout: ms,
      types: { getTypeParser: () => (value: string) => value },
    });
    client.on('error', () => undefined);
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await client.end();
      }
    };
    async function query(text: string, values: readonly unknown[] = []) {
      try {
        return await client.query({ text, values: [...values], queryMode: 'extended' } as pg.QueryConfig);
      } catch (error) {
        throw new ConnectorError('sources.sync.read', scrub(error, safe));
      }
    }
    try {
      await client.connect();
      await query(`SET statement_timeout TO ${ms}`);
      await query("SET timezone TO 'UTC'");
    } catch (error) {
      await close().catch(() => undefined);
      throw new ConnectorError('sources.sync.read', scrub(error, safe));
    }
    async function readOnly(text: string, params: readonly string[] = []) {
      await query('BEGIN READ ONLY');
      try {
        return await query(text, params);
      } finally {
        if (!closed) await query('ROLLBACK');
      }
    }
    async function describe(select: SourceSelect): Promise<SourceColumn[]> {
      if (select.kind === 'object') {
        const { rows } = await query(
          `SELECT column_name, data_type, is_nullable, ordinal_position,
          numeric_precision, numeric_scale, character_maximum_length FROM svv_columns
          WHERE table_catalog = current_database() AND table_schema = $1 AND table_name = $2
          UNION ALL SELECT columnname, external_type, is_nullable, columnnum, NULL, NULL, NULL
          FROM svv_external_columns e
          WHERE redshift_database_name = current_database() AND schemaname = $1 AND tablename = $2 AND NOT EXISTS
          (SELECT 1 FROM svv_columns c WHERE c.table_catalog = current_database() AND c.table_schema = $1 AND c.table_name = $2)
          ORDER BY ordinal_position`,
          [select.object.schema ?? 'public', select.object.name],
        );
        if (!rows.length) throw new ConnectorError('sources.sync.objectMissing');
        return rows.map((r) => {
          let type = String(r.data_type);
          if (/^(numeric|decimal)$/i.test(type) && r.numeric_precision != null && r.numeric_scale != null)
            type += `(${Number(r.numeric_precision)},${Number(r.numeric_scale)})`;
          else if (
            /^(character varying|varchar|character|char)$/i.test(type) &&
            r.character_maximum_length != null
          )
            type += `(${Number(r.character_maximum_length)})`;
          return redshiftColumn(
            String(r.column_name),
            type,
            !['NO', 'false'].includes(String(r.is_nullable)),
          );
        });
      }
      const result = await readOnly(`SELECT * FROM ${fromSql(select, 'postgres')} LIMIT 0`);
      const columns: SourceColumn[] = [];
      for (const field of result.fields) {
        const type = await query('SELECT format_type($1::oid, $2::int) AS type', [
          field.dataTypeID,
          field.dataTypeModifier,
        ]);
        columns.push(redshiftColumn(field.name, String(type.rows[0]?.type ?? 'unknown')));
      }
      return columns;
    }
    return {
      close,
      describe,
      async version() {
        return String((await query('SELECT version() AS version')).rows[0]?.version);
      },
      async list() {
        const { rows } =
          await query(`SELECT table_schema AS schema, table_name AS name, table_type AS type FROM svv_tables
          WHERE table_catalog = current_database() AND table_schema NOT IN ('pg_catalog', 'information_schema')
          UNION SELECT schemaname, tablename, 'EXTERNAL TABLE' FROM svv_external_tables e
          WHERE redshift_database_name = current_database() AND NOT EXISTS (SELECT 1 FROM svv_tables t WHERE t.table_catalog = current_database()
            AND t.table_schema = e.schemaname AND t.table_name = e.tablename) ORDER BY 1, 2`);
        return rows.map((r) => ({
          schema: String(r.schema),
          name: String(r.name),
          type: /VIEW/.test(String(r.type)) ? ('view' as const) : ('table' as const),
          rowEstimate: null,
        }));
      },
      // Redshift constraints are informational, so they cannot establish unique record keys.
      async keys() {
        return [];
      },
      async select(text, params) {
        return (await readOnly(text, params)).rows;
      },
      async *rows(select, columns, batchSize, limit) {
        await query('BEGIN READ ONLY');
        const projection = columns
          .map((col) => {
            const name = quote(col.name, 'postgres');
            return col.sourceType.toLowerCase() === 'super'
              ? `JSON_SERIALIZE(${name}) AS ${name}`
              : col.sourceType.toLowerCase() === 'geometry'
                ? `ST_AsEWKT(${name}, 17) AS ${name}`
                : name;
          })
          .join(', ');
        try {
          await query(
            `DECLARE source_rows CURSOR FOR SELECT ${projection} FROM ${fromSql(select, 'postgres')}${limit ? ` LIMIT ${limit}` : ''}`,
          );
          for (;;) {
            const result = await query(`FETCH FORWARD ${batchSize} FROM source_rows`);
            if (!result.rows.length) break;
            yield result.rows;
          }
        } finally {
          if (!closed) await query('ROLLBACK');
        }
      },
    };
  });
  return { ...connector, kind: 'redshift' as const };
}

export const redshiftConnector = createRedshiftConnector();
registerConnector(redshiftConnector);

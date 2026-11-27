import { isIP } from 'node:net';
import mssql from 'mssql';
import type { SourceColumn, SourceSelect } from '@riosoma/contracts';
import type { Endpoint } from '@riosoma/db';
import { makeConnector, type Row, type Session } from '@riosoma/connectors/internal/common.js';
import { column } from '@riosoma/connectors/internal/values.js';
import { fromSql, objectSql, positive, projection, quote } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError, type ConnectorContext } from '@riosoma/connectors/internal/types.js';

async function open(ctx: ConnectorContext, endpoint: Endpoint): Promise<Session> {
  const c = ctx.connection;
  if (c.kind !== 'sqlserver') throw new ConnectorError('sources.sync.read');
  const ms = positive(ctx.timeoutMs, 30000);
  let authentication: mssql.config['authentication'];
  if (c.auth.method === 'azure-entra') {
    authentication =
      c.auth.credential === 'service-principal'
        ? {
            type: 'azure-active-directory-service-principal-secret',
            options: {
              clientId: c.auth.clientId ?? '',
              tenantId: c.auth.tenantId ?? '',
              clientSecret: ctx.secrets.clientSecret ?? '',
            },
          }
        : { type: 'azure-active-directory-default', options: { clientId: c.auth.clientId } };
  }
  const pool = new mssql.ConnectionPool({
    server: endpoint.host,
    port: endpoint.port,
    database: c.database,
    user: c.user,
    password: ctx.secrets.password,
    authentication,
    connectionTimeout: ms,
    requestTimeout: positive(ctx.statementTimeoutMs, ms),
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      encrypt: c.encrypt,
      trustServerCertificate: c.trustServerCertificate,
      serverName: tlsName(c),
      useUTC: true,
      abortTransactionOnError: true,
    },
  });
  pool.on('error', () => undefined);
  try {
    await pool.connect();
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
  const active = new Set<mssql.Request>();
  let closing: Promise<void> | undefined;
  const close = () => {
    for (const request of active) request.cancel();
    return (closing ??= pool.close());
  };
  async function query(sql: string, values: Record<string, string> = {}) {
    const request = pool.request();
    for (const [name, value] of Object.entries(values)) request.input(name, mssql.NVarChar, value);
    active.add(request);
    try {
      return (await request.query<Row>(sql)).recordset;
    } finally {
      active.delete(request);
    }
  }
  // Fabric warehouses refuse this view with error 15871 but answer the procedure that does the same
  // job, so a session that's refused once asks the procedure from then on.
  let byProcedure = false;
  async function describeRows(statement: string): Promise<Row[]> {
    if (!byProcedure)
      try {
        return await query(
          `SELECT name,system_type_name,is_nullable,error_number,error_message
          FROM sys.dm_exec_describe_first_result_set(@statement,NULL,0) WHERE is_hidden=0 OR error_number IS NOT NULL ORDER BY column_ordinal`,
          { statement },
        );
      } catch (error) {
        if ((error as { number?: number }).number !== 15871) throw error;
        byProcedure = true;
      }
    try {
      const rows = await query('EXEC sp_describe_first_result_set @tsql=@statement', { statement });
      return rows.filter((r) => !r.is_hidden);
    } catch (error) {
      // The procedure raises a query's own error, such as 208 for a missing table, and then a
      // general one (11501 or 11529) that says only that the query can't be described.
      throw (error as { precedingErrors?: unknown[] }).precedingErrors?.[0] ?? error;
    }
  }
  async function describe(select: SourceSelect): Promise<SourceColumn[]> {
    const rows = await describeRows(`SELECT * FROM ${fromSql(select, 'sqlserver')}`);
    return rows.map((r) => {
      if (r.error_number) {
        const error = new Error(String(r.error_message));
        Object.assign(error, { number: Number(r.error_number) });
        throw error;
      }
      return column(
        { name: String(r.name), type: String(r.system_type_name), nullable: Boolean(r.is_nullable) },
        'sqlserver',
      );
    });
  }
  return {
    close,
    async version() {
      return String((await query('SELECT @@VERSION AS version'))[0]!.version);
    },
    async list() {
      const rows = await query(`SELECT s.name AS schema_name,o.name,o.type,
        CASE WHEN o.type='V' THEN NULL ELSE (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=o.object_id AND p.index_id IN (0,1)) END AS estimate
        FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
        WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA')
        AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1 ORDER BY s.name,o.name`);
      return rows.map((r) => ({
        schema: String(r.schema_name),
        name: String(r.name),
        // sys.objects.type is char(2), so a view comes back as 'V ' with its padding.
        type: String(r.type).trim() === 'V' ? ('view' as const) : ('table' as const),
        rowEstimate: r.estimate === null ? null : Number(r.estimate),
      }));
    },
    async keys(object) {
      await query(`SELECT TOP (0) * FROM ${objectSql(object, 'sqlserver')}`);
      const rows = await query(
        `SELECT k.name AS constraint_name,c.name AS column_name FROM sys.key_constraints k
        JOIN sys.index_columns ic ON ic.object_id=k.parent_object_id AND ic.index_id=k.unique_index_id
        JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE k.parent_object_id=OBJECT_ID(@object) AND ic.key_ordinal>0
        ORDER BY CASE WHEN k.type='PK' THEN 0 ELSE 1 END,k.name,ic.key_ordinal`,
        { object: objectSql(object, 'sqlserver') },
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
    // SQL Server has no read-only transactions, so a live read is a lone SELECT, canceled by the
    // driver at the session's request timeout.  Its values arrive as literals, never parameters.
    async select(text, params) {
      if (params.length) throw new ConnectorError('sources.sync.read');
      return query(text);
    },
    async *rows(select, columns, batchSize, limit) {
      // Numeric wire values are rounded by the driver before row events; project exact text.
      const list =
        columns
          .map((col) => {
            const name = quote(col.name, 'sqlserver');
            const projected = projection(col, name, 'sqlserver');
            return projected === name ? name : `${projected} AS ${name}`;
          })
          .join(', ') || '*';
      const request = pool.request();
      active.add(request);
      const stream = request.toReadableStream({ highWaterMark: batchSize });
      const finished = request
        .query(`SELECT ${limit ? `TOP (${limit}) ` : ''}${list} FROM ${fromSql(select, 'sqlserver')}`)
        .catch((error: unknown) => {
          stream.destroy(error instanceof Error ? error : new ConnectorError('sources.sync.read'));
        });
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
        request.cancel();
        stream.destroy();
        await finished;
        active.delete(request);
      }
    },
  };
}
export const sqlserver = makeConnector('sqlserver', open);
/**
 * The name TLS checks the certificate against.  The driver refuses an IP address here, so a
 * connection by address needs `serverName`, unless it doesn't verify certificates at all, when any
 * name will do.
 */
function tlsName(c: {
  host: string;
  serverName?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}) {
  if (c.serverName) return c.serverName;
  if (!isIP(c.host)) return c.host;
  return c.trustServerCertificate || !c.encrypt ? 'localhost' : undefined;
}

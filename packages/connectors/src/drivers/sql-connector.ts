import type { SourceColumn, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { makeConnector, scrub, type Row, type Session } from '../common.js';
import { fromSql, objectSql, positive, quote } from '../sql.js';
import { column } from '../values.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { driverProcess, type DriverColumn } from './process.js';
import { installedDriverUrl } from './storage.js';

export type InstalledKind = 'teradata' | 'db2' | 'informix';
export interface CatalogQueries {
  version: string;
  objects: string;
  /**
   * The key columns of one table, as `constraint_name` and `column_name`.  With `schema` true its
   * parameters are the schema and the table's name, and otherwise the name alone, in the user's own
   * schema.  A parameter can't stand in for a missing schema, since Informix can't take one in a
   * function like `COALESCE`.
   */
  keys(schema: boolean): string;
  /**
   * The names of a table's boolean columns, as `column_name`, for a system whose driver describes
   * them as small integers.  Its parameters are those of `keys`.
   */
  booleans?(schema: boolean): string;
}

/**
 * Whether IBM's client could be handed this source's sign-in.  Its connection string takes each
 * value as written up to the next semicolon, with no way to escape one, so a value with a semicolon
 * or a control character can't reach the server as itself.
 */
function ibmCanSend(ctx: ConnectorContext): boolean {
  if (ctx.connection.kind !== 'db2' && ctx.connection.kind !== 'informix') return true;
  const { host, database, user } = ctx.connection;
  return [host, database, user, ctx.secrets.password].every(
    (value) => value === undefined || (!value.includes(';') && ![...value].some((c) => c.charCodeAt(0) < 32)),
  );
}

export function installedSqlConnector(kind: InstalledKind, catalog: CatalogQueries): Connector {
  async function open(ctx: ConnectorContext): Promise<Session> {
    if (ctx.connection.kind !== kind) throw new ConnectorError('sources.sync.read');
    if (!ibmCanSend(ctx)) throw new ConnectorError('sources.test.ibmSemicolon');
    const process = await driverProcess(ctx);
    let readOnly = false;
    const execute = (sql: string, params: unknown[] = []) =>
      process.call<DriverColumn[]>('execute', { sql, params });
    const fetch = (size: number) => process.call<Row[]>('fetch', { size });
    async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
      await execute(sql, params);
      const result: Row[] = [];
      try {
        for (;;) {
          const batch = await fetch(1000);
          for (const row of batch)
            result.push(
              Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value])),
            );
          if (batch.length < 1000) return result;
        }
      } finally {
        await process.call('clear');
      }
    }
    const source = (select: SourceSelect) => {
      if (select.kind === 'object' && select.filter) throw new ConnectorError('sources.sync.read');
      if (kind === 'informix' && select.kind === 'query' && /[{}]/.test(select.sql))
        throw new ConnectorError('sources.sync.read');
      return fromSql(select, kind);
    };
    const selectSql = (select: SourceSelect, projection: string, limit?: number, empty = false) => {
      const top =
        limit && kind !== 'db2' ? `${kind === 'teradata' ? 'TOP' : 'FIRST'} ${positive(limit, 50)} ` : '';
      return `SELECT ${top}${projection} FROM ${source(select)}${empty ? ' WHERE 1=0' : ''}${limit && kind === 'db2' ? ` FETCH FIRST ${positive(limit, 50)} ROWS ONLY` : ''}${kind === 'db2' ? ' FOR READ ONLY' : ''}`;
    };
    async function begin() {
      if (readOnly) return;
      if (kind === 'informix') {
        await process.call('begin');
        await execute('SET TRANSACTION READ ONLY');
        await process.call('clear');
      }
      readOnly = true;
    }
    const tableParams = (object: SourceObjectRef) =>
      object.schema === null ? [object.name] : [object.schema, object.name];
    async function describe(select: SourceSelect): Promise<SourceColumn[]> {
      await begin();
      const metadata = await execute(selectSql(select, '*', undefined, true));
      await process.call('clear');
      // A table's catalog names the booleans its driver reads as small integers.  A query's can't.
      const booleans = new Set<string>();
      if (catalog.booleans && select.kind === 'object')
        for (const row of await query(
          catalog.booleans(select.object.schema !== null),
          tableParams(select.object),
        ))
          booleans.add(String(row.column_name).trim().toLowerCase());
      return metadata.map((info) =>
        column(booleans.has(info.name.toLowerCase()) ? { ...info, type: 'BOOLEAN' } : info, kind),
      );
    }
    const keys = async (object: SourceObjectRef) => {
      await begin();
      await query(`SELECT * FROM ${objectSql(object, kind)} WHERE 1=0`);
      const rows = await query(catalog.keys(object.schema !== null), tableParams(object));
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const name = String(row.constraint_name).trim();
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(String(row.column_name).trim());
      }
      return [...groups.values()];
    };
    return {
      close: process.close,
      async version() {
        return String((await query(catalog.version))[0]?.version ?? kind);
      },
      async list() {
        const rows = await query(catalog.objects);
        return rows.map((row) => ({
          schema: String(row.schema_name).trim(),
          name: String(row.name).trim(),
          type: String(row.type).trim() === 'V' ? ('view' as const) : ('table' as const),
          rowEstimate:
            row.estimate === null || row.estimate === undefined || Number(row.estimate) < 0
              ? null
              : Number(row.estimate),
        }));
      },
      keys,
      describe,
      async select() {
        throw new ConnectorError('sources.kindUnavailable');
      },
      async *rows(select, columns, batchSize, limit) {
        await begin();
        const projection =
          columns
            .map((col) => {
              const ref = quote(col.name, kind);
              // Text casts happen before the native driver can round keys or exact decimals.
              return /^(bigint|int8|serial8|bigserial|decimal|numeric|number|decfloat|money)/i.test(
                col.sourceType,
              )
                ? `CAST(${ref} AS VARCHAR(128)) AS ${ref}`
                : ref;
            })
            .join(', ') || '*';
        await execute(selectSql(select, projection, limit));
        try {
          for (;;) {
            const batch = await fetch(Math.min(positive(batchSize, 5000), 50000));
            if (!batch.length) break;
            yield batch;
          }
        } finally {
          await process.call('clear');
        }
      },
    };
  }
  const connector = makeConnector(kind, open);
  delete connector.session;
  return {
    ...connector,
    async test(ctx) {
      try {
        await installedDriverUrl(kind === 'teradata' ? 'teradatasql' : 'ibm_db', ctx.driversDir);
      } catch (error) {
        return {
          ok: false,
          steps: [
            {
              step: 'driver',
              status: 'failed',
              ms: 0,
              messageKey:
                error instanceof ConnectorError ? error.messageKey : 'sources.drivers.invalidInstall',
              detail: scrub(error, ctx),
            },
          ],
        };
      }
      if (!ibmCanSend(ctx))
        return {
          ok: false,
          steps: [
            { step: 'driver', status: 'ok', ms: 0 },
            { step: 'authenticate', status: 'failed', ms: 0, messageKey: 'sources.test.ibmSemicolon' },
          ],
        };
      const result = await connector.test(ctx);
      return { ...result, steps: [{ step: 'driver', status: 'ok', ms: 0 }, ...result.steps] };
    },
  };
}

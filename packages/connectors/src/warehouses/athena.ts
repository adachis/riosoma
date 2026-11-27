import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AthenaConnection, SourceObject, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { registerConnector } from '../registry.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { AwsClient, awsEndpoint, type AwsOptions } from './aws.js';
import { makeWarehouseConnector, type Row, type WarehouseSession } from './frame.js';
import { connectionOf } from './errors.js';
import { describeColumn, type Described } from './mapping.js';
import { guard, selectSql, TRINO } from './sql.js';
import { trinoColumn } from './trino.js';
import { cellOf } from './values.js';

interface ColumnInfo {
  Name: string;
  Type: string;
  Nullable?: string;
  Precision?: number;
  Scale?: number;
}
interface Results {
  ResultSet?: {
    ResultSetMetadata?: { ColumnInfo?: ColumnInfo[] };
    Rows?: Array<{ Data?: Array<{ VarCharValue?: string }> }>;
  };
  NextToken?: string;
}
interface Execution {
  QueryExecution?: {
    Status?: { State?: string; StateChangeReason?: string };
    Statistics?: { DataScannedInBytes?: number };
  };
}
interface GlueColumn {
  Name: string;
  Type: string;
}
interface GlueTable {
  Name: string;
  TableType?: string;
  StorageDescriptor?: { Columns?: GlueColumn[] };
  PartitionKeys?: GlueColumn[];
}

export function athenaColumn(info: ColumnInfo): Described {
  const type = info.Type;
  if (/^(array|map|struct|row)(<|\(|$)/i.test(type))
    return describeColumn({ name: info.Name, sourceType: type, nullable: true, kind: 'json' });
  const signature =
    type === 'string'
      ? 'varchar'
      : type === 'int'
        ? 'integer'
        : type === 'float'
          ? 'real'
          : type === 'decimal' && info.Precision !== undefined
            ? `decimal(${info.Precision},${info.Scale ?? 0})`
            : type;
  const described = trinoColumn(info.Name, signature, info.Nullable !== 'NOT_NULL');
  return { ...described, column: { ...described.column, sourceType: signature } };
}

export interface AthenaOptions extends AwsOptions {
  pollMs?: number;
}

class AthenaSession implements WarehouseSession {
  private readonly client: AwsClient;
  private readonly stopped = new AbortController();
  private active: string | undefined;
  private closed = false;
  private catalogId: string | undefined;
  private catalogChecked = false;

  constructor(
    private readonly ctx: ConnectorContext,
    private readonly settings: AthenaConnection,
    private readonly options: AthenaOptions,
  ) {
    this.client = new AwsClient(ctx, settings.region, options);
  }

  private api<T>(operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.client.json('athena', `AmazonAthena.${operation}`, body, signal ?? this.stopped.signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopped.abort();
    if (this.active) {
      // Cancellation uses its own budget because the read's signal may already have expired.
      const client = new AwsClient(
        { ...this.ctx, signal: undefined, timeoutMs: 5_000 },
        this.settings.region,
        this.options,
      );
      await client
        .json('athena', 'AmazonAthena.StopQueryExecution', { QueryExecutionId: this.active })
        .catch(() => undefined);
    }
  }

  async checkLimit(signal?: AbortSignal): Promise<void> {
    const result = await this.api<{
      WorkGroup?: { Configuration?: { BytesScannedCutoffPerQuery?: number } };
    }>('GetWorkGroup', { WorkGroup: this.settings.workgroup }, signal);
    const cutoff = result.WorkGroup?.Configuration?.BytesScannedCutoffPerQuery;
    if (!Number.isSafeInteger(cutoff) || cutoff! < 1 || cutoff! > this.settings.maxScannedBytes)
      throw new ConnectorError('sources.athena.workgroupLimit');
  }

  private async start(sql: string): Promise<string> {
    await this.checkLimit();
    const result = await this.api<{ QueryExecutionId?: string }>('StartQueryExecution', {
      ClientRequestToken: randomUUID(),
      QueryString: sql,
      WorkGroup: this.settings.workgroup,
      QueryExecutionContext: { Catalog: this.settings.catalog, Database: this.settings.database },
      ResultConfiguration: { OutputLocation: this.settings.resultsLocation },
      ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: false } },
    });
    if (!result.QueryExecutionId) throw new ConnectorError('sources.sync.read');
    this.active = result.QueryExecutionId;
    const deadline = AbortSignal.timeout(this.ctx.statementTimeoutMs ?? this.ctx.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([
      deadline,
      this.stopped.signal,
      ...(this.ctx.signal ? [this.ctx.signal] : []),
    ]);
    try {
      for (;;) {
        const execution = (
          await this.api<Execution>('GetQueryExecution', { QueryExecutionId: this.active }, signal)
        ).QueryExecution;
        const scanned = execution?.Statistics?.DataScannedInBytes;
        if (
          scanned !== undefined &&
          (!Number.isSafeInteger(scanned) || scanned > this.settings.maxScannedBytes)
        )
          throw new ConnectorError('sources.athena.scanLimit');
        const state = execution?.Status?.State;
        if (state === 'SUCCEEDED') {
          if (scanned === undefined) throw new ConnectorError('sources.athena.scanLimit');
          return this.active;
        }
        if (state === 'FAILED' || state === 'CANCELLED')
          throw new ConnectorError('sources.sync.read', execution?.Status?.StateChangeReason);
        if (state !== 'QUEUED' && state !== 'RUNNING') throw new ConnectorError('sources.sync.read');
        await delay(this.options.pollMs ?? 250, undefined, { signal });
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async *pages(sql: string): AsyncGenerator<{ columns: Described[]; rows: Row[] }> {
    const id = await this.start(sql);
    let next: string | undefined;
    let first = true;
    let columns: Described[] = [];
    const seen = new Set<string>();
    try {
      do {
        const page = await this.api<Results>('GetQueryResults', {
          QueryExecutionId: id,
          MaxResults: 1_000,
          ...(next ? { NextToken: next } : {}),
        });
        const info = page.ResultSet?.ResultSetMetadata?.ColumnInfo;
        if (first) {
          if (!info) throw new ConnectorError('sources.sync.read');
          columns = info.map(athenaColumn);
        }
        const rows = (page.ResultSet?.Rows ?? []).slice(first ? 1 : 0).map((row) =>
          Object.fromEntries(
            columns.map((col, i) => {
              const value = row.Data?.[i]?.VarCharValue ?? null;
              return [col.column.name, col.kind === 'timestamp' ? cellOf(value, 'date', col) : value];
            }),
          ),
        );
        first = false;
        yield { columns, rows };
        next = page.NextToken;
        if (next && seen.has(next)) throw new ConnectorError('sources.sync.read');
        if (next) seen.add(next);
      } while (next);
    } finally {
      this.active = undefined;
    }
  }

  async version(): Promise<string> {
    for await (const _page of this.pages('SELECT 1 AS connected')) {
      /* Reading the result proves access to the results location. */
    }
    return 'Athena';
  }

  private async hasListedGlueCatalog(name: string): Promise<boolean> {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.api<{
        DataCatalogsSummary?: Array<{ CatalogName?: string; Type?: string }>;
        NextToken?: string;
      }>('ListDataCatalogs', { MaxResults: 50, ...(token ? { NextToken: token } : {}) });
      const match = page.DataCatalogsSummary?.find((entry) => entry.CatalogName === name);
      if (match) return match.Type === 'GLUE';
      token = page.NextToken;
      if (token && seen.has(token)) throw new ConnectorError('sources.sync.read');
      if (token) seen.add(token);
    } while (token);
    return false;
  }

  private async glueCatalog(): Promise<{ CatalogId?: string }> {
    if (!this.catalogChecked) {
      // AwsDataCatalog is the account's built-in Glue catalog, and GetDataCatalog can reject it.
      if (this.settings.catalog !== 'AwsDataCatalog') {
        try {
          const result = await this.api<{
            DataCatalog?: { Type?: string; Parameters?: Record<string, string> };
          }>('GetDataCatalog', { Name: this.settings.catalog });
          if (result.DataCatalog?.Type !== 'GLUE') throw new ConnectorError('sources.athena.glueCatalog');
          this.catalogId = result.DataCatalog.Parameters?.['catalog-id'];
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            error.messageKey === 'sources.sync.read' &&
            /\bnot found\b/i.test(error.detail ?? '')
          ) {
            if (!(await this.hasListedGlueCatalog(this.settings.catalog)))
              throw new ConnectorError('sources.athena.glueCatalog');
          } else {
            throw error;
          }
        }
      }
      this.catalogChecked = true;
    }
    return this.catalogId ? { CatalogId: this.catalogId } : {};
  }

  private path(object: SourceObjectRef): string[] {
    return [this.settings.catalog, object.schema ?? this.settings.database, object.name];
  }
  async list(): Promise<SourceObject[]> {
    const tables: SourceObject[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.json<{ TableList?: GlueTable[]; NextToken?: string }>(
        'glue',
        'AWSGlue.GetTables',
        {
          ...(await this.glueCatalog()),
          DatabaseName: this.settings.database,
          MaxResults: 100,
          ...(token ? { NextToken: token } : {}),
        },
        this.stopped.signal,
      );
      tables.push(
        ...(result.TableList ?? []).map((table) => ({
          schema: this.settings.database,
          name: table.Name,
          type: table.TableType === 'VIRTUAL_VIEW' ? ('view' as const) : ('table' as const),
          rowEstimate: null,
        })),
      );
      token = result.NextToken;
      if (token && seen.has(token)) throw new ConnectorError('sources.sync.read');
      if (token) seen.add(token);
    } while (token);
    return tables;
  }

  async describe(select: SourceSelect): Promise<Described[]> {
    if (select.kind === 'object') {
      const result = await this.client.json<{ Table?: GlueTable }>(
        'glue',
        'AWSGlue.GetTable',
        {
          ...(await this.glueCatalog()),
          DatabaseName: select.object.schema ?? this.settings.database,
          Name: select.object.name,
        },
        this.stopped.signal,
      );
      if (!result.Table) throw new ConnectorError('sources.sync.objectMissing');
      return [...(result.Table.StorageDescriptor?.Columns ?? []), ...(result.Table.PartitionKeys ?? [])].map(
        athenaColumn,
      );
    }
    for await (const page of this.pages(`SELECT * FROM ${guard(select.sql, TRINO)} LIMIT 0`))
      return page.columns;
    throw new ConnectorError('sources.sync.read');
  }
  async keys(): Promise<string[][]> {
    return [];
  }
  async estimate(): Promise<null> {
    return null;
  }
  async *rows(
    select: SourceSelect,
    columns: readonly Described[],
    _batchSize: number,
    limit?: number,
  ): AsyncGenerator<Row[]> {
    const sql = selectSql(
      select,
      columns.map((c) => c.column.name),
      TRINO,
      (object) => this.path(object),
      limit,
    );
    for await (const page of this.pages(sql)) yield page.rows;
  }
  async select(sql: string, params: readonly string[]): Promise<Row[]> {
    if (params.length) throw new ConnectorError('sources.sync.read');
    const rows: Row[] = [];
    // Live SQL is generated internally, and values have already been quoted by its renderer.
    for await (const page of this.pages(sql)) rows.push(...page.rows);
    return rows;
  }
}

export function createAthenaConnector(options: AthenaOptions = {}): Connector {
  const open = async (ctx: ConnectorContext, signal = ctx.signal) => {
    const session = new AthenaSession(ctx, connectionOf(ctx, 'athena'), options);
    try {
      await session.checkLimit(signal);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  };
  return {
    ...makeWarehouseConnector(
      {
        kind: 'athena',
        endpoint: (ctx) => ({
          host: awsEndpoint('athena', connectionOf(ctx, 'athena').region).hostname,
          port: 443,
        }),
        open,
        missing: (detail) => (/EntityNotFoundException/.test(detail) ? { kind: 'object' } : null),
      },
      options.endpoint
        ? { proxied: () => true, resolve: async () => {}, connect: async () => {}, handshake: async () => {} }
        : undefined,
    ),
    async session(ctx) {
      // The pool cancels each read by closing its session, so a past caller cannot cancel a later read.
      const session = await open({ ...ctx, signal: undefined }, ctx.signal);
      return {
        close: () => session.close(),
        describe: async (select) => (await session.describe(select)).map((c) => c.column),
        select: (sql, params) => session.select(sql, params),
      };
    },
  };
}

export const athenaConnector = createAthenaConnector();
registerConnector(athenaConnector);

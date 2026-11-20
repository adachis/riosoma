import { ContractTransport as FixtureBoundary } from '@riosoma/connectors';
/**
 * Databricks against the driver's interface, with a fake that records what the connector asks for
 * and answers the way `@databricks/sql` does: statements become operations, rows come in chunks
 * until the operation has no more, and values arrive as the driver converts them, with exact
 * digits for decimals and big integers.  The live suite is `databricks.live.test.ts`.
 */
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import type { ConnectorContext, ReadOptions, SourceRow } from '@riosoma/connectors/internal/types.js';
import {
  createDatabricksConnector,
  type DatabricksColumn,
  type DatabricksConnect,
  type DatabricksDriver,
} from './databricks.js';
import type { Network } from '@riosoma/connectors/internal/warehouses/frame.js';
import type { ContractFixture } from '../contract/fixture.test-support.js';

export type Rows = Record<string, unknown>[];

export interface Answer {
  columns?: DatabricksColumn[];
  /** What each fetch hands back, in turn */
  chunks?: Rows[];
  error?: Error;
  fetchError?: Error;
  /** A fetch that never answers */
  hangAt?: number;
  /** Milliseconds before each fetch answers */
  chunkMs?: number;
}

export interface FakeOptions {
  answer?: (sql: string, parameters: Record<string, string> | undefined) => Answer | undefined;
  connectError?: Error;
  openError?: Error;
  hangOpen?: boolean;
}

export const DEFAULTS: Array<[string, Answer]> = [
  ['SET TIME ZONE', { chunks: [[{ key: 'spark.sql.session.timeZone', value: 'UTC' }]] }],
  ['current_catalog()', { chunks: [[{ catalog: 'main' }]] }],
  ['version()', { chunks: [[{ version: '3.5.0 0123abcd' }]] }],
];

export function fakeDatabricks(options: FakeOptions = {}) {
  const log = {
    connects: [] as DatabricksConnect[],
    sessions: [] as Array<{ initialCatalog?: string; initialSchema?: string }>,
    statements: [] as Array<{ sql: string; parameters?: Record<string, string>; queryTimeout: number }>,
    fetches: [] as number[],
    cancels: 0,
    closedOperations: 0,
    closedSessions: 0,
    closedClients: 0,
  };
  const driver: DatabricksDriver = {
    createClient() {
      return {
        async connect(settings) {
          log.connects.push(settings);
          if (options.connectError) throw options.connectError;
        },
        async openSession(settings) {
          log.sessions.push(settings);
          if (options.hangOpen) await new Promise(() => undefined);
          if (options.openError) throw options.openError;
          return {
            async execute(sql, settings) {
              log.statements.push({ sql, ...settings });
              const answer =
                options.answer?.(sql, settings.parameters) ??
                DEFAULTS.find(([fragment]) => sql.includes(fragment))?.[1] ??
                {};
              if (answer.error) throw answer.error;
              let fetched = 0;
              let stop: (() => void) | undefined;
              return {
                async columns() {
                  return answer.columns ?? [];
                },
                async fetchChunk(maxRows) {
                  log.fetches.push(maxRows);
                  const index = fetched;
                  fetched += 1;
                  if (answer.hangAt === index)
                    await new Promise<void>((_resolve, reject) => {
                      stop = () => reject(new Error('the operation was canceled'));
                    });
                  if (answer.chunkMs) await new Promise((resolve) => setTimeout(resolve, answer.chunkMs));
                  if (answer.fetchError) throw answer.fetchError;
                  return answer.chunks?.[index] ?? [];
                },
                async hasMoreRows() {
                  return fetched < (answer.chunks?.length ?? 0);
                },
                async cancel() {
                  log.cancels += 1;
                  stop?.();
                },
                async close() {
                  log.closedOperations += 1;
                },
              };
            },
            async close() {
              log.closedSessions += 1;
            },
          };
        },
        async close() {
          log.closedClients += 1;
        },
      };
    },
  };
  return { driver, log };
}

export function network(fail?: 'resolve' | 'connect' | 'tls'): Network & { endpoints: string[] } {
  const endpoints: string[] = [];
  const check = async (step: string) => {
    if (fail === step) throw new Error(`${step} failed`);
  };
  return {
    endpoints,
    proxied: () => false,
    resolve: async (host) => {
      endpoints.push(host);
      await check('resolve');
    },
    connect: async (endpoint) => {
      endpoints.push(`${endpoint.host}:${endpoint.port}`);
      await check('connect');
    },
    handshake: () => check('tls'),
  };
}

export const connector = (fake: ReturnType<typeof fakeDatabricks>, checks: Network = network()) =>
  createDatabricksConnector({ driver: fake.driver, network: checks });

export const SETTINGS: SourceConnection = {
  kind: 'databricks',
  host: 'adb-1234567890123456.7.azuredatabricks.net',
  httpPath: '/sql/1.0/warehouses/abc123',
  catalog: 'main',
  schema: 'sales',
};

export const TOKEN = 'placeholder-access-token';

export function contextFor(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return { connection: SETTINGS, secrets: { token: TOKEN }, timeoutMs: 2_000, ...overrides };
}

export const objectSelect = (schema: string | null, name: string): SourceSelect => ({
  kind: 'object',
  object: { schema, name },
});
export const querySelect = (sql: string): SourceSelect => ({ kind: 'query', sql });

export async function readAll(
  fake: ReturnType<typeof fakeDatabricks>,
  ctx: ConnectorContext,
  select: SourceSelect,
  options: ReadOptions,
): Promise<SourceRow[][]> {
  const batches: SourceRow[][] = [];
  for await (const batch of connector(fake).read(ctx, select, options)) batches.push(batch);
  return batches;
}

/** The catalog's description of `sales.orders`: an ID, a decimal total, and a note. */
export const ORDER_COLUMNS: Rows = [
  { column_name: 'id', data_type: 'BIGINT', full_data_type: 'bigint', is_nullable: 'NO' },
  {
    column_name: 'total',
    data_type: 'DECIMAL',
    full_data_type: 'decimal(10,2)',
    is_nullable: 'YES',
    numeric_scale: 2,
  },
  { column_name: 'note', data_type: 'STRING', full_data_type: 'string', is_nullable: 'YES' },
];

/** Answers the catalog's column lookup for `sales.orders`, and the data read after it. */
export function ordersAnswer(read: Answer, columns: Rows = ORDER_COLUMNS) {
  return (sql: string): Answer | undefined => {
    if (sql.includes('`information_schema`.`columns`')) return { chunks: [columns] };
    if (sql.includes('FROM `main`.`sales`.`orders`')) return read;
    return undefined;
  };
}

/** The fixture the shared contract runs against, here and through the connector service. */
export function databricksContractFixture(): ContractFixture {
  const boundary = new FixtureBoundary();
  const fake = fakeDatabricks({
    answer: (sql) => {
      if (sql.includes('`information_schema`.`columns`')) return { chunks: [[ORDER_COLUMNS[0]!]] };
      if (sql.includes('`information_schema`.`tables`'))
        return { chunks: [[{ table_schema: 'sales', table_name: 'orders', table_type: 'MANAGED' }]] };
      if (sql.includes('`table_constraints`'))
        return { chunks: [[{ constraint_name: 'pk', column_name: 'id' }]] };
      if (!sql.includes('`orders`')) return undefined;
      const ids = /`id` = 2/.test(sql) ? [2] : /`id` DESC/.test(sql) ? [3, 2, 1] : [1, 2, 3];
      return {
        columns: [{ name: 'id', type: 'BIGINT', precision: 19, scale: 0 }],
        chunks: [ids.map((id) => ({ id: BigInt(id) }))],
      };
    },
  });
  return {
    connector: createDatabricksConnector({
      driver: boundary.wrap(fake.driver),
      network: boundary.wrap(network()),
    }),
    context: contextFor({ secrets: { token: crypto.randomUUID() } }),
    select: { kind: 'object', object: { schema: 'sales', name: 'orders' } },
    keyColumns: ['id'],
    count: 3,
    boundary,
  };
}

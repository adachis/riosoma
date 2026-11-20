import { ContractTransport as FixtureBoundary } from '@riosoma/connectors';
/**
 * ClickHouse against the client's interface, with a fake that records what the connector asks for
 * and answers the way the HTTP interface does in `JSONCompactEachRowWithNamesAndTypes`: names,
 * types, then rows in chunks.  The live suite is `clickhouse.live.test.ts`.
 */
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';
import { createClickHouseConnector, type ClickHouseConnect, type ClickHouseDriver } from './clickhouse.js';
import type { Network } from '@riosoma/connectors/internal/warehouses/frame.js';
import type { ContractFixture } from '../contract/fixture.test-support.js';

export interface Answer {
  names?: string[];
  types?: string[];
  chunks?: unknown[][][];
  error?: Error;
}

export interface Sent {
  sql: string;
  params: Record<string, string>;
}

export function fakeClickHouse(
  answer: (sent: Sent) => Answer | undefined = () => undefined,
  openError?: Error,
) {
  const log = { connects: [] as ClickHouseConnect[], sent: [] as Sent[], closed: 0, aborted: 0 };
  const driver: ClickHouseDriver = {
    createClient(options) {
      log.connects.push(options);
      return {
        async query(sql, params, signal) {
          const sent = { sql, params };
          log.sent.push(sent);
          signal.addEventListener('abort', () => (log.aborted += 1), { once: true });
          if (openError && /signed_in/.test(sql)) throw openError;
          const found = answer(sent) ?? defaults(sql);
          if (found.error) throw found.error;
          return {
            names: found.names ?? [],
            types: found.types ?? [],
            chunks: (async function* () {
              for (const chunk of found.chunks ?? []) yield chunk;
            })(),
          };
        },
        async close() {
          log.closed += 1;
        },
      };
    },
  };
  return { driver, log };
}

export function defaults(sql: string): Answer {
  if (/signed_in/.test(sql)) return { names: ['signed_in'], types: ['UInt8'], chunks: [[[1]]] };
  if (/version\(\)/.test(sql)) return { names: ['version'], types: ['String'], chunks: [[['25.8.1.1']]] };
  return {};
}

export function network(fail?: 'resolve' | 'connect' | 'tls'): Network & { calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string, call: string) => {
    calls.push(call);
    if (fail === name) throw Object.assign(new Error(`${name} failed`), { code: 'EFAKE' });
  };
  return {
    calls,
    proxied: () => false,
    resolve: (host) => step('resolve', `resolve ${host}`),
    connect: (endpoint) => step('connect', `connect ${endpoint.host}:${endpoint.port}`),
    handshake: (endpoint) =>
      step('tls', `handshake ${endpoint.host}:${endpoint.port} ${JSON.stringify(endpoint.tls)}`),
  };
}

export const SETTINGS: Extract<SourceConnection, { kind: 'clickhouse' }> = {
  kind: 'clickhouse',
  host: 'abc123.us-east-1.aws.clickhouse.cloud',
  port: 8443,
  database: 'analytics',
  user: 'reader',
  secure: true,
};
// Built from parts, so the stand-in never reads as a stored secret.
export const PASSWORD = ['stand', 'in', 'password', '42'].join('-');

export function contextFor(
  connection: Partial<typeof SETTINGS> = {},
  rest: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    connection: { ...SETTINGS, ...connection },
    secrets: { password: PASSWORD },
    timeoutMs: 2_000,
    ...rest,
  };
}

export const connector = (
  fake: ReturnType<typeof fakeClickHouse>,
  checks: Network = network(),
  pageRows?: number,
) => createClickHouseConnector({ driver: fake.driver, network: checks, ...(pageRows ? { pageRows } : {}) });

export const ORDERS = {
  kind: 'object' as const,
  object: { schema: 'analytics', name: 'orders' },
} satisfies SourceSelect;

/** Answers the catalog about `analytics.orders`, sorted by its region and ID, and its rows for `read`. */
export function ordersAnswer(read: (sql: string) => Answer | undefined, engine = 'MergeTree') {
  return ({ sql, params }: Sent): Answer | undefined => {
    if (sql.includes('FROM system.tables') && params.table === 'orders')
      return {
        names: ['engine', 'total_rows', 'sorting_key'],
        types: ['String', 'Nullable(UInt64)', 'String'],
        chunks: [[[engine, '1234', 'region, id']]],
      };
    if (sql.includes('FROM system.columns'))
      return {
        names: ['name', 'type'],
        types: ['String', 'String'],
        chunks: [
          [
            ['id', 'UInt64'],
            ['region', 'LowCardinality(String)'],
            ['total', 'Decimal(18, 4)'],
            ['placed', "DateTime64(3, 'Europe/Lisbon')"],
            ['extra', 'Map(String, String)'],
            ['note', 'Nullable(String)'],
          ],
        ],
      };
    return read(sql);
  };
}

export async function readAll(
  fake: ReturnType<typeof fakeClickHouse>,
  columns: string[],
  keys = ['id'],
  pageRows?: number,
) {
  const batches: SourceRow[][] = [];
  for await (const batch of connector(fake, network(), pageRows).read(contextFor(), ORDERS, {
    columns,
    types: Object.fromEntries(columns.map((name) => [name, 'text'])),
    keyColumns: keys,
    batchSize: 3,
  }))
    batches.push(batch);
  return batches;
}

/** The fixture the shared contract runs against, here and through the connector service. */
export function clickHouseContractFixture(): ContractFixture {
  const boundary = new FixtureBoundary();
  const fake = fakeClickHouse(({ sql, params }) => {
    if (sql.includes('system.tables'))
      return params.table
        ? { names: ['engine', 'total_rows', 'sorting_key'], chunks: [[['MergeTree', '3', 'id']]] }
        : {
            names: ['database', 'name', 'engine', 'total_rows'],
            chunks: [[['analytics', 'orders', 'MergeTree', '3']]],
          };
    if (sql.includes('system.columns')) return { names: ['name', 'type'], chunks: [[['id', 'UInt64']]] };
    if (!/["`]orders["`]/.test(sql)) return undefined;
    const ids = /["`]id["`] = 2/.test(sql)
      ? ['2']
      : /["`]id["`] DESC/.test(sql)
        ? ['3', '2', '1']
        : ['1', '2', '3'];
    return { names: ['id'], types: ['UInt64'], chunks: [ids.map((id) => [id])] };
  });
  return {
    connector: createClickHouseConnector({
      driver: boundary.wrap(fake.driver),
      network: boundary.wrap(network()),
    }),
    context: contextFor(),
    select: { kind: 'object', object: { schema: 'analytics', name: 'orders' } },
    keyColumns: ['id'],
    count: 3,
    boundary,
  };
}

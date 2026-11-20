import { ContractTransport as FixtureBoundary } from '@riosoma/connectors';
/**
 * BigQuery against the client's interface, with a fake that records what the connector asks for
 * and answers the way `@google-cloud/bigquery` does: listings come in pages, a job may say it is
 * still running, and result rows are the client's own conversion of the API's raw rows, value
 * wrappers and all.  The live suite is `bigquery.live.test.ts`.
 */
import { BigQuery } from '@google-cloud/bigquery';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import type { ConnectorContext, ReadOptions, SourceRow } from '@riosoma/connectors/internal/types.js';
import {
  createBigQueryConnector,
  type BigQueryDriver,
  type BigQueryField,
  type BigQueryTableSummary,
  type ListPage,
} from './bigquery.js';
import type { Network } from '@riosoma/connectors/internal/warehouses/frame.js';
import { serviceAccount } from '../service-account.test-helpers.js';
import type { ContractFixture } from '../contract/fixture.test-support.js';

export type Rows = Record<string, unknown>[];

export interface FakeTable {
  type?: string;
  numRows?: string | null;
  fields: BigQueryField[];
  primaryKey?: string[];
}

export interface QueryAnswer {
  /** Pages of rows, each converted by the client as the API would send them */
  pages?: Rows[];
  /** How many times the job says it is still running before its first page */
  running?: number;
  /** Milliseconds before each page arrives */
  pageMs?: number;
  /** A page that never arrives */
  hangAt?: number;
  error?: Error;
  startError?: Error;
  /** The columns a dry run reports */
  fields?: BigQueryField[];
}

export interface FakeOptions {
  datasets?: string[][];
  listings?: Record<string, BigQueryTableSummary[][]>;
  tables?: Record<string, FakeTable>;
  answer?: (sql: string) => QueryAnswer;
  authError?: Error;
  authHang?: boolean;
}

export function fakeBigQuery(options: FakeOptions = {}) {
  const log = {
    clients: [] as Array<Record<string, unknown>>,
    authentications: 0,
    datasetPages: [] as ListPage[],
    tablePages: [] as Array<[string, ListPage]>,
    lookups: [] as string[],
    dryRuns: [] as string[],
    queries: [] as Array<{ sql: string; jobTimeoutMs: number }>,
    pages: [] as ListPage[],
    cancels: 0,
  };
  const paged = <T>(pages: T[][], page: ListPage) => {
    const index = page.pageToken ? Number(page.pageToken) : 0;
    return { items: pages[index] ?? [], pageToken: index + 1 < pages.length ? String(index + 1) : null };
  };
  const driver: BigQueryDriver = {
    createClient(settings) {
      log.clients.push(settings);
      return {
        async authenticate() {
          log.authentications += 1;
          if (options.authHang) await new Promise(() => undefined);
          if (options.authError) throw options.authError;
        },
        async datasets(page) {
          log.datasetPages.push(page);
          return paged(options.datasets ?? [['events']], page);
        },
        async tables(dataset, page) {
          log.tablePages.push([dataset, page]);
          return paged(options.listings?.[dataset] ?? [[]], page);
        },
        async table(dataset, table) {
          log.lookups.push(`${dataset}.${table}`);
          const found = options.tables?.[`${dataset}.${table}`];
          if (!found)
            throw Object.assign(new Error(`Not found: Table my-project:${dataset}.${table}`), { code: 404 });
          return {
            type: found.type ?? 'TABLE',
            numRows: found.numRows ?? null,
            fields: found.fields,
            primaryKey: found.primaryKey ?? [],
          };
        },
        async dryRun(sql) {
          log.dryRuns.push(sql);
          const answer = options.answer?.(sql) ?? {};
          if (answer.startError) throw answer.startError;
          return answer.fields ?? [];
        },
        async query(sql, settings) {
          log.queries.push({ sql, ...settings });
          const answer = options.answer?.(sql) ?? {};
          if (answer.startError) throw answer.startError;
          let running = answer.running ?? 0;
          return {
            async results(page) {
              log.pages.push(page);
              const index = page.pageToken ? Number(page.pageToken) : 0;
              if (answer.hangAt === index) await new Promise(() => undefined);
              if (answer.pageMs) await new Promise((resolve) => setTimeout(resolve, answer.pageMs));
              if (answer.error) throw answer.error;
              if (running > 0) {
                running -= 1;
                return { complete: false, rows: [], pageToken: null };
              }
              const pages = answer.pages ?? [[]];
              return {
                complete: true,
                rows: pages[index] ?? [],
                pageToken: index + 1 < pages.length ? String(index + 1) : null,
              };
            },
            async cancel() {
              log.cancels += 1;
            },
          };
        },
      };
    },
  };
  return { driver, log };
}

export interface SchemaField {
  name: string;
  type?: string;
  mode?: string;
  fields?: SchemaField[];
}

/** Fields in the shape the API's schema takes, which is all the client's conversion reads. */
export function schemaOf(fields: readonly BigQueryField[]): SchemaField[] {
  return fields.map((field) => ({
    name: field.name,
    ...(field.type ? { type: field.type } : {}),
    ...(field.mode ? { mode: field.mode } : {}),
    ...(field.fields ? { fields: schemaOf(field.fields) } : {}),
  }));
}

/** Rows as the client hands them back: its own conversion of the API's raw rows for these fields. */
export function clientRows(fields: BigQueryField[], raw: Array<Array<unknown>>): Rows {
  return BigQuery.mergeSchemaWithRows_(
    { fields: schemaOf(fields) },
    raw.map((values) => ({ f: values.map((v) => ({ v })) })),
    { wrapIntegers: true, parseJSON: false },
  ) as Rows;
}

export function network(fail?: 'resolve' | 'connect' | 'tls'): Network & { hosts: string[] } {
  const hosts: string[] = [];
  const check = async (step: string) => {
    if (fail === step) throw new Error(`${step} failed`);
  };
  return {
    hosts,
    proxied: () => false,
    resolve: async (host) => {
      hosts.push(host);
      await check('resolve');
    },
    connect: () => check('connect'),
    handshake: () => check('tls'),
  };
}

export const connector = (fake: ReturnType<typeof fakeBigQuery>, checks: Network = network()) =>
  createBigQueryConnector({ driver: fake.driver, network: checks });

export const KEY = JSON.stringify(
  serviceAccount({
    project_id: 'placeholder-project',
    private_key_id: 'placeholder-key-id',
    private_key: 'placeholder-private-key',
    client_email: 'reader@placeholder-project.example',
  }),
);

export const SETTINGS: SourceConnection = {
  kind: 'bigquery',
  projectId: 'my-project',
  location: 'US',
  dataset: 'events',
};

export function contextFor(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return { connection: SETTINGS, secrets: { serviceAccountJson: KEY }, timeoutMs: 2_000, ...overrides };
}

export const objectSelect = (schema: string | null, name: string): SourceSelect => ({
  kind: 'object',
  object: { schema, name },
});
export const querySelect = (sql: string): SourceSelect => ({ kind: 'query', sql });

export async function readAll(
  fake: ReturnType<typeof fakeBigQuery>,
  ctx: ConnectorContext,
  select: SourceSelect,
  options: ReadOptions,
): Promise<SourceRow[][]> {
  const batches: SourceRow[][] = [];
  for await (const batch of connector(fake).read(ctx, select, options)) batches.push(batch);
  return batches;
}

/** Every type BigQuery has, as a table's schema reports them. */
export const EVERY_FIELD: BigQueryField[] = [
  { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'wide', type: 'INT64' },
  { name: 'price', type: 'NUMERIC', precision: '10', scale: '2' },
  { name: 'amount', type: 'NUMERIC' },
  { name: 'huge', type: 'BIGNUMERIC' },
  { name: 'ratio', type: 'FLOAT' },
  { name: 'paid', type: 'BOOLEAN' },
  { name: 'day', type: 'DATE' },
  { name: 'local_time', type: 'DATETIME' },
  { name: 'moment', type: 'TIMESTAMP' },
  { name: 'clock', type: 'TIME' },
  { name: 'note', type: 'STRING' },
  { name: 'essay', type: 'STRING', maxLength: '5000' },
  { name: 'doc', type: 'JSON' },
  { name: 'tags', type: 'STRING', mode: 'REPEATED' },
  {
    name: 'address',
    type: 'RECORD',
    fields: [
      { name: 'city', type: 'STRING' },
      { name: 'zip', type: 'INTEGER' },
    ],
  },
  { name: 'raw', type: 'BYTES' },
  { name: 'place', type: 'GEOGRAPHY' },
  { name: 'span', type: 'INTERVAL' },
];

/** One row with every type, as the API sends it: text for everything, timestamps in microseconds. */
export const EVERY_VALUE: unknown[] = [
  '7',
  '9007199254740993',
  '12.50',
  '0.000000001',
  '123456789012345678901234567890.123456789',
  'NaN',
  'true',
  '2024-03-05',
  '2024-03-05T06:07:08.123456',
  '1709618828500000',
  '06:07:08.120000',
  'a note',
  'long words',
  '{"a": 1}',
  [{ v: 'red' }, { v: 'blue' }],
  { f: [{ v: 'Lisbon' }, { v: '1000' }] },
  Buffer.from('abc').toString('base64'),
  'POINT(1 2)',
  '1-2 3 4:5:6',
];

/** The fixture the shared contract runs against, here and through the connector service. */
export function bigQueryContractFixture(): ContractFixture {
  const boundary = new FixtureBoundary();
  const fields: BigQueryField[] = [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }];
  const fake = fakeBigQuery({
    datasets: [['events']],
    listings: { events: [[{ id: 'orders', type: 'TABLE' }]] },
    tables: { 'events.orders': { fields, numRows: '3', primaryKey: ['id'] } },
    answer: (sql) => ({
      fields,
      pages: [
        clientRows(
          fields,
          (/`id` = 2/.test(sql) ? ['2'] : /`id` DESC/.test(sql) ? ['3', '2', '1'] : ['1', '2', '3']).map(
            (id) => [id],
          ),
        ),
      ],
    }),
  });
  return {
    connector: createBigQueryConnector({
      driver: boundary.wrap(fake.driver),
      network: boundary.wrap(network()),
    }),
    context: contextFor(),
    select: { kind: 'object', object: { schema: 'events', name: 'orders' } },
    keyColumns: ['id'],
    count: 3,
    boundary,
  };
}

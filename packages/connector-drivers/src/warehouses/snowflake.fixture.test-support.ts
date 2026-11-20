import { ContractTransport as FixtureBoundary } from '@riosoma/connectors';
/**
 * Snowflake against the driver's interface, with a small fake that records what the connector asks
 * for and answers the way `snowflake-sdk` does: `execute` returns a statement at once and calls back
 * when it finishes, a streamed result is an async iterable of row objects that a destroy ends, and
 * dates and timestamps arrive as `Date`s.  The live suite is `snowflake.live.test.ts`.
 */
import type { SourceConnection, SourceSecrets, SourceSelect } from '@riosoma/contracts';
import type { ConnectorContext, ReadOptions, SourceRow } from '@riosoma/connectors/internal/types.js';
import type { Network } from '@riosoma/connectors/internal/warehouses/frame.js';
import {
  createSnowflakeConnector,
  type Bind,
  type SnowflakeColumn,
  type SnowflakeDriver,
  type SnowflakeExecute,
  type SnowflakeOptions,
  type SnowflakeRowStream,
  type SnowflakeStatement,
} from './snowflake.js';
import type { ContractFixture } from '../contract/fixture.test-support.js';

export type Rows = Record<string, unknown>[];

export interface ColumnSpec {
  name: string;
  type: string;
  precision?: number;
  scale?: number;
  nullable?: boolean;
}

export interface Answer {
  rows?: Rows;
  columns?: ColumnSpec[];
  stream?: Rows;
  error?: unknown;
  /** Never finishes, so a deadline has something to bite on */
  hang?: boolean;
  /** Finishes, then streams nothing until destroyed, so a read's deadline bites mid-row */
  hangStream?: boolean;
}

export interface Call {
  sql: string;
  binds?: Bind[];
  streamResult?: boolean;
  describeOnly?: boolean;
}

export interface FakeSnowflake {
  driver: SnowflakeDriver;
  calls: Call[];
  connections: SnowflakeOptions[];
  cancels(): number;
  /** Streams destroyed */
  destroyedStreams(): number;
  /** Connections destroyed */
  destroyedConnections(): number;
}

export function columnOf(spec: ColumnSpec): SnowflakeColumn {
  return {
    getName: () => spec.name,
    getType: () => spec.type,
    getPrecision: () => spec.precision ?? 0,
    getScale: () => spec.scale ?? 0,
    isNullable: () => spec.nullable ?? true,
  };
}

/** A stream that, like a Node stream, ends a pending read when destroyed. */
export function rowStream(rows: Rows, hang: boolean, onDestroy: () => void): SnowflakeRowStream {
  let destroyed: { error: Error | undefined } | undefined;
  let wake: (() => void) | undefined;
  return {
    destroy(error?: Error) {
      if (destroyed) return;
      destroyed = { error };
      onDestroy();
      wake?.();
    },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          if (hang && !destroyed)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          if (destroyed?.error) throw destroyed.error;
          if (destroyed || index >= rows.length) return { done: true, value: undefined };
          index += 1;
          return { done: false, value: rows[index - 1] ?? {} };
        },
      };
    },
  };
}

/** A driver that answers from `answer`, and remembers everything the connector asked it for. */
export function fakeSnowflake(answer: (sql: string) => Answer, connectError?: unknown): FakeSnowflake {
  const calls: Call[] = [];
  const connections: SnowflakeOptions[] = [];
  let cancels = 0;
  let destroyedStreams = 0;
  let destroyedConnections = 0;
  const driver: SnowflakeDriver = {
    createConnection(options) {
      connections.push(options);
      return {
        async connectAsync() {
          if (connectError !== undefined) throw connectError;
        },
        execute(execute: SnowflakeExecute): SnowflakeStatement {
          calls.push({
            sql: execute.sqlText,
            binds: execute.binds,
            streamResult: execute.streamResult,
            describeOnly: execute.describeOnly,
          });
          const found = answer(execute.sqlText);
          const statement: SnowflakeStatement = {
            getColumns: () => found.columns?.map((spec) => columnOf(spec)),
            streamRows: () =>
              rowStream(found.stream ?? [], found.hangStream === true, () => {
                destroyedStreams += 1;
              }),
            cancel: () => {
              cancels += 1;
            },
          };
          // The driver answers on a later tick, which is what the connector has to cope with.
          queueMicrotask(() => {
            if (found.hang === true) return;
            execute.complete(found.error, statement, found.stream === undefined ? found.rows : undefined);
          });
          return statement;
        },
        destroy(done) {
          destroyedConnections += 1;
          done();
        },
      };
    },
  };
  return {
    driver,
    calls,
    connections,
    cancels: () => cancels,
    destroyedStreams: () => destroyedStreams,
    destroyedConnections: () => destroyedConnections,
  };
}

export const VERSION_ROW = { version: '8.14.1', database: 'SALES', warehouse: 'ANALYTICS' };

/** Every session sets itself up and reports on itself the same way. */
export const CATALOG: Record<string, Answer> = {
  'ALTER SESSION': { rows: [] },
  CURRENT_VERSION: { rows: [VERSION_ROW] },
};

/** A driver that answers from a table of SQL fragments, the first match winning and a test's own answers first. */
export function catalogDriver(answers: Record<string, Answer> = {}, connectError?: unknown): FakeSnowflake {
  return fakeSnowflake((sql) => {
    for (const [fragment, answer] of Object.entries({ ...CATALOG, ...answers })) {
      if (sql.includes(fragment)) return answer;
    }
    return { rows: [] };
  }, connectError);
}

/** The network checks of a connection test, which pass and remember the host they looked at. */
export function network(): Network & { hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    proxied: () => false,
    resolve: async (host) => {
      hosts.push(host);
    },
    connect: async () => undefined,
    handshake: async () => undefined,
  };
}

export const connector = (fake: FakeSnowflake) =>
  createSnowflakeConnector({ driver: fake.driver, network: network() });

export const SETTINGS: SourceConnection = {
  kind: 'snowflake',
  account: 'myorg-myaccount',
  user: 'RIO',
  warehouse: 'ANALYTICS',
  database: 'SALES',
  schema: 'PUBLIC',
  role: 'READER',
  auth: 'key-pair',
};

export const SECRETS: SourceSecrets = { privateKeyPem: 'placeholder-private-key' };

export function contextFor(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return { connection: SETTINGS, secrets: SECRETS, timeoutMs: 2_000, ...overrides };
}

export const objectSelect = (schema: string | null, name: string): SourceSelect => ({
  kind: 'object',
  object: { schema, name },
});
export const querySelect = (sql: string): SourceSelect => ({ kind: 'query', sql });

/** The catalog's description of ORDERS: an integer ID and a text note. */
export const ORDER_COLUMNS: Answer = {
  rows: [
    {
      COLUMN_NAME: 'ID',
      DATA_TYPE: 'NUMBER',
      IS_NULLABLE: 'NO',
      NUMERIC_PRECISION: '38',
      NUMERIC_SCALE: '0',
    },
    { COLUMN_NAME: 'NOTE', DATA_TYPE: 'TEXT', IS_NULLABLE: 'YES', CHARACTER_MAXIMUM_LENGTH: '16777216' },
  ],
};

export async function readAll(
  fake: FakeSnowflake,
  ctx: ConnectorContext,
  select: SourceSelect,
  options: ReadOptions,
): Promise<SourceRow[][]> {
  const batches: SourceRow[][] = [];
  for await (const batch of connector(fake).read(ctx, select, options)) batches.push(batch);
  return batches;
}

/** The fixture the shared contract runs against, here and through the connector service. */
export function snowflakeContractFixture(): ContractFixture {
  const boundary = new FixtureBoundary();
  const rows = [1, 2, 3].map((id) => ({ ID: String(id), NOTE: `item${id}` }));
  const fake = fakeSnowflake((sql) => {
    if (sql.includes('CURRENT_VERSION')) return { rows: [VERSION_ROW] };
    if (sql.includes('"COLUMNS"')) return ORDER_COLUMNS;
    if (sql.includes('"TABLES"'))
      return {
        rows: [{ TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', ROW_COUNT: '3' }],
      };
    if (sql.startsWith('SHOW PRIMARY'))
      return { rows: [{ constraint_name: 'pk', column_name: 'ID', key_sequence: '1' }] };
    if (!sql.includes('ORDERS')) return { rows: [] };
    const selected = /"ID" = 2/.test(sql)
      ? rows.slice(1, 2)
      : /"ID" DESC/.test(sql)
        ? [...rows].reverse()
        : rows;
    return {
      columns: [
        { name: 'ID', type: 'fixed', precision: 38, scale: 0, nullable: false },
        { name: 'NOTE', type: 'text' },
      ],
      stream: selected,
    };
  });
  return {
    connector: createSnowflakeConnector({
      driver: boundary.wrap(fake.driver),
      network: boundary.wrap(network()),
    }),
    context: contextFor({ secrets: { privateKeyPem: crypto.randomUUID() } }),
    select: { kind: 'object', object: { schema: 'PUBLIC', name: 'ORDERS' } },
    keyColumns: ['ID'],
    count: 3,
    boundary,
  };
}

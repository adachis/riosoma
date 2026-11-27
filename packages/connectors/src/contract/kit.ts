import { isDeepStrictEqual } from 'node:util';
import type { SourceColumn, SourceSelect } from '@riosoma/contracts';
import type { Connector, ConnectorContext, ConnectorError, ReadOptions, SourceRow } from '../types.js';
import { pacesCaughtUp } from '../rest/http.js';
import { declaredCapabilities, requiredCapabilities, type ContractCapability } from './capabilities.js';
import {
  assertBatch,
  assertColumns,
  assertFailure,
  assertKeys,
  assertObjects,
  assertSecretFree,
  ContractViolation,
  invariant,
} from './assertions.js';

export interface PushdownProbe {
  run(ctx: ConnectorContext): Promise<{ rows: unknown[]; requests: string[] }>;
  expectedRows: unknown[];
  /** Fragments in requests actually received by the fixture or the service's query history. */
  requestIncludes: string[];
}

export interface ConnectorContract {
  connector: Connector;
  context: ConnectorContext;
  select: Extract<SourceSelect, { kind: 'object' }>;
  /** Expected suggestions verify native types mapped into the shared field classes. */
  types: Record<string, SourceColumn['suggested']>;
  keys: string[][];
  read: ReadOptions;
  expectedRows: SourceRow[];
  filter?: PushdownProbe;
  sort?: PushdownProbe;
  /** A service or fixture failure that deliberately exercises its diagnostic path. */
  failure(ctx: ConnectorContext): Promise<unknown>;
  /** A pending operation that honors ctx.timeoutMs.  The fixture can delay its transport. */
  timeout?(ctx: ConnectorContext): Promise<unknown>;
  /** Confirms that a timed out request released its session, cursor, or transport. */
  stopped?(): Promise<boolean> | boolean;
  /** Native query syntaxes supply their own two-operation input. */
  multipleStatements?: string;
  /** Forbidden-query executions captured at the transport or driver boundary */
  executions?(): readonly unknown[];
  /** Logs from the connector's logger, when it uses one other than console. */
  logs?: readonly unknown[];
}

export interface ContractResult {
  connector: Connector['kind'];
  capabilitiesPassed: ContractCapability[];
}

async function bounded<T>(action: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ContractViolation('timeout.watchdog')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejects(action: () => Promise<unknown>, ctx: ConnectorContext): Promise<unknown> {
  try {
    await bounded(action, 2_000);
  } catch (error) {
    assertFailure(error, ctx);
    return error;
  }
  throw new ContractViolation('errors.expectedFailure');
}

async function pushdown(probe: PushdownProbe | undefined, ctx: ConnectorContext, name: string) {
  invariant(probe && probe.requestIncludes.length > 0 && probe.expectedRows.length > 0, `${name}.probe`);
  const result = await probe.run(ctx);
  invariant(isDeepStrictEqual(result.rows, probe.expectedRows), `${name}.rows`);
  invariant(
    probe.requestIncludes.every((fragment) => result.requests.some((sent) => sent.includes(fragment))),
    `${name}.pushdown`,
  );
}

/** Runs the same assertions on fixture adapters and live adapters. Only declared claims run. */
export async function runConnectorContract(spec: ConnectorContract): Promise<ContractResult> {
  const { connector, context: ctx, select } = spec;
  invariant(ctx.connection.kind === connector.kind, 'context.kind');
  const caps = declaredCapabilities(connector.kind);
  const passed = new Set<ContractCapability>();
  const logs: unknown[] = [];
  const restores: Array<() => void> = [];
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      logs.push(args);
    };
    restores.push(() => {
      console[method] = original;
    });
  }
  try {
    if (caps.list) {
      const objects = await connector.listObjects(ctx);
      assertObjects(objects);
      invariant(
        objects.some(
          (object) => object.schema === select.object.schema && object.name === select.object.name,
        ),
        'list.selectedObject',
      );
      passed.add('list');
    }
    if (caps.describe) {
      const columns = await connector.describe(ctx, select);
      assertColumns(columns);
      invariant(Object.keys(spec.types).length > 0, 'describe.expectedTypes');
      for (const [name, expected] of Object.entries(spec.types))
        invariant(
          isDeepStrictEqual(columns.find((column) => column.name === name)?.suggested, expected),
          'describe.nativeMapping',
        );
      passed.add('describe');
    }
    if (caps.keys) {
      const keys = await connector.keyCandidates(ctx, select.object);
      assertKeys(keys);
      invariant(isDeepStrictEqual(keys, spec.keys), 'keys.expected');
      passed.add('keys');
    }
    if (caps.read) {
      const seen = new Set<string>();
      const rows: SourceRow[] = [];
      let batches = 0;
      invariant(spec.expectedRows.length > (spec.read.batchSize ?? 5_000), 'paging.fixtureSize');
      for await (const batch of connector.read(ctx, select, spec.read)) {
        assertBatch(batch, spec.read, seen);
        rows.push(...batch);
        invariant(rows.length <= spec.expectedRows.length, 'paging.termination');
        batches++;
      }
      // Streams need not promise an order.  Sort pushdown has its own ordered probe.
      const ordered = (items: SourceRow[]) => [...items].sort((a, b) => a.key.localeCompare(b.key));
      invariant(isDeepStrictEqual(ordered(rows), ordered(spec.expectedRows)), 'read.expectedRows');
      passed.add('read');
      if (caps.paging) {
        invariant(batches > 1, 'paging.pages');
        passed.add('paging');
      }
    }
    // A kind without queries must reject the same input rather than silently treating it as a table.
    const sql =
      spec.multipleStatements ??
      (caps.query === 'graphql'
        ? 'query First { items { id } } query Second { items { id } }'
        : 'SELECT 1; SELECT 2');
    if (caps.query === 'native') invariant(spec.multipleStatements, 'query.nativeProbe');
    const multi: SourceSelect = { kind: 'query', sql };
    // GraphQL takes the written query in connection settings, rather than in SourceSelect.
    const queryContext =
      caps.query === 'graphql' ? { ...ctx, connection: { ...ctx.connection, query: sql } } : ctx;
    const querySelect = caps.query === 'graphql' ? select : multi;
    invariant(spec.executions, 'query.evidence');
    const refused = async (action: () => Promise<unknown>) => {
      const before = [...spec.executions!()];
      await rejects(action, queryContext);
      invariant(isDeepStrictEqual(spec.executions!(), before), 'query.executed');
    };
    await refused(() => connector.describe(queryContext, querySelect));
    await refused(() => connector.preview(queryContext, querySelect, 1));
    if (caps.read)
      await refused(async () => {
        for await (const batch of connector.read(queryContext, querySelect, spec.read)) void batch;
      });
    if (caps.query) passed.add('query');
    if (caps.filter) {
      await pushdown(spec.filter, ctx, 'filter');
      passed.add('filter');
    }
    if (caps.sort) {
      await pushdown(spec.sort, ctx, 'sort');
      passed.add('sort');
    }
    if (caps.secrets) {
      await rejects(() => spec.failure(ctx), ctx);
      passed.add('secrets');
    }
    if (caps.timeout) {
      invariant(spec.timeout && spec.stopped, 'timeout.probe');
      const timed = { ...ctx, timeoutMs: 10, statementTimeoutMs: 10 };
      // Requests that earlier steps left waiting for their turn under an API's pace would push the
      // probe's own request past its 10 ms budget, and a call that times out before it sends
      // anything leaves no request to stop.  The probe starts once those turns have come.
      await pacesCaughtUp();
      const started = performance.now();
      const error = await rejects(() => spec.timeout!(timed), timed);
      invariant(
        ['sources.test.timeout', 'sources.live.timeout'].includes((error as ConnectorError).messageKey) ||
          (error as ConnectorError).params?.reason === 'timeout',
        'timeout.classification',
      );
      const elapsed = performance.now() - started;
      invariant(elapsed >= 8, 'timeout.prematureFailure');
      invariant(elapsed <= timed.timeoutMs + 100, 'timeout.duration');
      invariant(await spec.stopped(), 'timeout.cleanup');
      passed.add('timeout');
    }
    assertSecretFree([...logs, ...(spec.logs ?? [])], ctx);
    invariant(
      requiredCapabilities(connector.kind).every((name) => passed.has(name)),
      'capabilities.complete',
    );
    return { connector: connector.kind, capabilitiesPassed: [...passed].sort() };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

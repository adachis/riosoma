import { contractAdapter } from './adapter.js';
import { runConnectorContract } from './kit.js';
import type { ContractTransport } from './transport.js';
import type { SourceSelect } from '@riosoma/contracts';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { assertBatch, assertColumns, assertKeys, assertObjects, invariant } from './assertions.js';
import { declaredCapabilities } from './capabilities.js';

/** A protocol fixture's ordinary operations, supplementing its syntax-specific scenario tests. */
export async function exerciseFixture(
  connector: Connector,
  context: ConnectorContext,
  select: Extract<SourceSelect, { kind: 'object' }>,
  keyColumns: string[],
  expectedCount: number,
): Promise<void> {
  const capabilities = declaredCapabilities(connector.kind);
  if (capabilities.list) assertObjects(await connector.listObjects(context));
  const columns = await connector.describe(context, select);
  assertColumns(columns);
  if (capabilities.keys) assertKeys(await connector.keyCandidates(context, select.object));
  if (!capabilities.read) return;
  const supported = columns.filter((column) => column.suggested !== null);
  const options = {
    columns: supported.map((column) => column.name),
    types: Object.fromEntries(supported.map((column) => [column.name, column.suggested!.type])),
    keyColumns,
    batchSize: 1,
  };
  const seen = new Set<string>();
  let count = 0;
  for await (const batch of connector.read(context, select, options)) {
    assertBatch(batch, options, seen);
    count += batch.length;
    invariant(count <= expectedCount, 'fixture.termination');
  }
  invariant(count === expectedCount, 'fixture.rows');
}

/** Compares a known fixture's preview with a complete, separately executed snapshot stream */
export async function strictFixture(
  connector: Connector,
  context: ConnectorContext,
  select: Extract<SourceSelect, { kind: 'object' }>,
  keyColumns: string[],
  expectedCount: number,
  boundary: ContractTransport,
  timeoutCall?: (ctx: ConnectorContext) => Promise<unknown>,
) {
  boundary.context = context;
  const preview = await connector.preview(context, select, expectedCount + 1);
  invariant(preview.rows.length === expectedCount, 'fixture.expectedCount');
  const columns = preview.columns.filter((column) => column.suggested);
  const index = (name: string) => preview.columns.findIndex((column) => column.name === name);
  const expectedRows = preview.rows.map((row) => ({
    key: JSON.stringify(keyColumns.map((name) => row[index(name)])),
    values: Object.fromEntries(columns.map((column) => [column.name, row[index(column.name)] ?? null])),
  }));
  try {
    return await runConnectorContract(
      contractAdapter({
        connector,
        context,
        select,
        columns,
        keys: await connector.keyCandidates(context, select.object),
        read: {
          columns: columns.map((column) => column.name),
          keyColumns,
          batchSize: 1,
          types: Object.fromEntries(columns.map((column) => [column.name, column.suggested!.type])),
        },
        expectedRows,
        requests: () => boundary.requests,
        failure: async (ctx) => {
          boundary.mode = 'failure';
          try {
            return await connector.preview(ctx, select, 1);
          } finally {
            boundary.reset();
          }
        },
        timeout: async (ctx) => {
          boundary.mode = 'slow';
          boundary.stopped = false;
          try {
            if (timeoutCall) return await timeoutCall(ctx);
            const test = await connector.test(ctx);
            invariant(!test.ok, 'timeout.expectedFailure');
            const step = test.steps.find((step) => step.status === 'failed');
            invariant(step?.messageKey, 'timeout.classification');
            throw new ConnectorError(step.messageKey, step.detail);
          } finally {
            boundary.mode = 'normal';
          }
        },
        stopped: async () => {
          // This checks that a timed-out request is closed, not how fast: a loaded machine can take
          // longer than a second to see the close.
          const until = Date.now() + 5000;
          while (!boundary.stopped && Date.now() < until)
            await new Promise((resolve) => setTimeout(resolve, 10));
          return boundary.stopped;
        },
      }),
    );
  } finally {
    boundary.reset();
  }
}

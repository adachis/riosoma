import type { SourceKind, SourceSelect } from '@riosoma/contracts';
import type { Connector, ConnectorContext, ReadOptions } from '../types.js';
import {
  assertBatch,
  assertColumns,
  assertFailure,
  assertKeys,
  assertObjects,
  assertSecretFree,
  invariant,
} from './assertions.js';
import { declaredCapabilities } from './capabilities.js';

export type ContractObservations = Map<SourceKind, Set<string>>;

/** Applies shared invariants to the real calls made by an existing protocol fixture suite. */
export function observeConnector<T extends Connector>(
  connector: T,
  observations: ContractObservations,
  onCall: () => void = () => undefined,
): T {
  const note = (operation: string) => {
    const passed = observations.get(connector.kind) ?? new Set<string>();
    passed.add(operation);
    observations.set(connector.kind, passed);
  };
  const caps = declaredCapabilities(connector.kind);
  function multiple(select: SourceSelect): boolean {
    // The explicit runner supplies syntax-specific guard probes.  Observation recognizes this safe pair.
    return select.kind === 'query' && /^SELECT 1; SELECT 2$/i.test(select.sql.trim());
  }
  async function call<R>(
    ctx: ConnectorContext,
    operation: string,
    action: () => Promise<R>,
    check: (value: R) => void,
  ): Promise<R> {
    onCall();
    let value: R;
    try {
      value = await action();
    } catch (error) {
      assertFailure(error, ctx);
      note('errors');
      throw error;
    }
    check(value);
    note(operation);
    return value;
  }
  // Preserve extended APIs such as firstPage and documentQuery, and the caller's connector type.
  return {
    ...connector,
    test: (ctx: ConnectorContext) =>
      call(
        ctx,
        'test',
        () => connector.test(ctx),
        (value) => assertSecretFree(value, ctx),
      ),
    listObjects: (ctx: ConnectorContext) =>
      call(ctx, 'list', () => connector.listObjects(ctx), assertObjects),
    describe: (ctx: ConnectorContext, select: SourceSelect) =>
      call(
        ctx,
        'describe',
        () => connector.describe(ctx, select),
        (columns) => {
          invariant(!multiple(select), 'query.multipleStatements');
          assertColumns(columns);
        },
      ),
    keyCandidates: (ctx: ConnectorContext, object: Parameters<Connector['keyCandidates']>[1]) =>
      call(ctx, 'keys', () => connector.keyCandidates(ctx, object), assertKeys),
    preview: (ctx: ConnectorContext, select: SourceSelect, limit: number) =>
      call(
        ctx,
        'preview',
        () => connector.preview(ctx, select, limit),
        (preview) => {
          invariant(!multiple(select), 'query.multipleStatements');
          assertColumns(preview.columns);
          note('describe');
          invariant(preview.rows.length <= limit, 'preview.limit');
          invariant(
            preview.rows.every((row) => row.length === preview.columns.length),
            'preview.width',
          );
        },
      ),
    async *read(ctx: ConnectorContext, select: SourceSelect, options: ReadOptions) {
      onCall();
      const seen = new Set<string>();
      let batches = 0;
      try {
        for await (const batch of connector.read(ctx, select, options)) {
          invariant(!multiple(select), 'query.multipleStatements');
          // A caller may deliberately choose nonunique keys.  Controlled paging probes require uniqueness.
          assertBatch(batch, options, seen, false);
          batches++;
          yield batch;
        }
      } catch (error) {
        assertFailure(error, ctx);
        note('errors');
        throw error;
      }
      invariant(caps.read, 'read.undeclared');
      note('read');
      if (caps.paging && batches > 1) note('paging');
    },
  } as T;
}

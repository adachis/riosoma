import type { CellValue } from '@riosoma/contracts';
import type { LiveTarget } from '../live/reader.js';
import type { Fragment } from '../live/fragment.js';
import { connectorFor } from '../registry.js';
import { ConnectorError } from '../types.js';
import { ALL, and, parseSelector, simplify, type Predicate } from './query.js';

export async function documentRows(
  target: LiveTarget,
  where: Predicate,
  order: Fragment[],
  limit: number,
  reads: readonly { id: string; column: string; type: string }[],
) {
  const connector = connectorFor(target.kind);
  if (!connector.documentQuery) throw new ConnectorError('sources.live.unsupported');
  return connector.documentQuery(target.context, target.select, {
    predicate: where,
    reads,
    order: order.flatMap((o) => (o.documentOrder ? [o.documentOrder] : [])),
    limit,
    columns: [...new Set([...reads.map((r) => r.column), ...target.keyColumns])],
    types: Object.fromEntries(reads.map((r) => [r.column, r.type])),
    keyColumns: [...target.keyColumns],
  });
}
export function keyPredicate(target: LiveTarget, keys: readonly string[]): Predicate {
  const terms = keys.map((key) => {
    const parts = JSON.parse(key) as CellValue[];
    if (!Array.isArray(parts) || parts.length !== target.keyColumns.length)
      throw new ConnectorError('sources.sync.keyEmpty');
    return and(
      ...parts.map((value, i): Predicate => {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
          throw new ConnectorError('sources.sync.keyEmpty');
        return {
          op: 'eq',
          field: target.keyColumns[i]!,
          value,
          ...(target.kind === 'cosmosdb' ? { key: true } : {}),
        };
      }),
    );
  });
  return terms.length === 1 ? terms[0]! : { op: 'or', terms };
}
export async function documentKeys(
  target: LiveTarget,
  request: { where: Fragment | null; order: readonly Fragment[]; limit: number },
) {
  if (request.where && !request.where.document) throw new ConnectorError('sources.live.unsupported');
  const rows = await documentRows(
    target,
    request.where?.document ?? ALL,
    [...request.order],
    request.limit + 1,
    [],
  );
  const keys = rows.slice(0, request.limit).map((row) => row.key);
  if (new Set(keys).size !== keys.length) throw new ConnectorError('sources.sync.keyDuplicate');
  if (!request.order.length) keys.sort();
  return { keys, truncated: rows.length > request.limit };
}

/** Firestore expands conjunctions over disjunctions before applying its query limit. */
export function documentKeyBatchSize(target: LiveTarget, where: Predicate = ALL): number {
  if (target.kind !== 'firestore') return 50;
  const branches = (p: Predicate): number => {
    if (!('terms' in p)) return 1;
    const counts = p.terms.map(branches);
    return p.op === 'and'
      ? counts.reduce((a, b) => Math.min(31, a * b), 1)
      : counts.reduce((a, b) => Math.min(31, a + b), 0);
  };
  const source = target.select.kind === 'object' ? parseSelector(target.select.filter) : ALL;
  return Math.max(1, Math.floor(30 / Math.max(1, branches(simplify(and(source, where))))));
}

import type { CellValue } from '@riosoma/contracts';
import { positive } from '../sql.js';
import type { Fragment } from '../live/fragment.js';
import type { LiveTarget } from '../live/reader.js';
import { connectorFor, sourceKey } from '../registry.js';
import { ConnectorError } from '../types.js';
import { cellOf, keyPartOf } from '../warehouses/values.js';
import type { Described } from '../warehouses/mapping.js';
import { engineColumn, sampledColumn, searchValue, type Predicate, type SearchOrder } from './search.js';
import { simplify } from './live.js';

/**
 * How many keys one native request may name.  Each key becomes a group of comparisons in the
 * engine's own filter, and an engine counts those: Typesense refuses a filter with more candidates
 * than it allows, which is a hundred by default.
 */
const KEY_BATCH = 25;

/**
 * An engine's columns by name, described once a minute at most.  A search engine has no catalog to
 * ask: it samples its documents, which costs a round trip a live read can't afford three times.
 */
const DESCRIBE_MS = 60_000;
const described = new Map<string, { at: number; columns: Promise<Map<string, Described>> }>();

function keyPredicate(target: LiveTarget, keys: readonly string[]): Predicate {
  return {
    op: 'or',
    args: keys.map((key) => {
      const parts: unknown = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== target.keyColumns.length)
        throw new ConnectorError('sources.sync.keyEmpty');
      return {
        op: 'and',
        args: target.keyColumns.map((column, at) => ({ op: 'eq', column, value: parts[at] })),
      };
    }),
  };
}

export async function nativeRows(
  target: LiveTarget,
  where: Predicate,
  order: SearchOrder[] = [],
  limit?: number,
  documentIds?: readonly string[],
) {
  const predicate = simplify(where);
  if (predicate.op === 'false') return [];
  const read = connectorFor(target.kind).search;
  if (!read) throw new ConnectorError('sources.live.unsupported');
  const rows: Array<Record<string, unknown>> = [];
  for await (const page of read(target.context, target.select, {
    where: predicate,
    order,
    limit,
    documentIds,
  }))
    rows.push(...page);
  return rows;
}

async function rowsForKeys(target: LiveTarget, keys: readonly string[], where: Predicate = { op: 'true' }) {
  const matches = keyPredicate(target, keys);
  if (target.kind === 'typesense' && target.keyColumns.length === 1 && target.keyColumns[0] === 'id') {
    const ids = keys.map((key) => (JSON.parse(key) as unknown[])[0]);
    if (ids.some((id) => typeof id !== 'string')) throw new ConnectorError('sources.sync.keyEmpty');
    // A backtick is a delimiter and a trailing backslash escapes the one that would close the value,
    // so neither has a form a Typesense filter can compare.  Such an ID is fetched directly instead.
    if (ids.some((id) => (id as string).includes('`') || (id as string).includes('\\')))
      return nativeRows(target, where, [], undefined, ids as string[]);
  }
  return nativeRows(target, { op: 'and', args: [where, matches] });
}

function valueOf(target: LiveTarget, row: Record<string, unknown>, name: string) {
  return target.kind === 'typesense' ? searchValue(row, name) : row[name];
}

function keyOf(target: LiveTarget, row: Record<string, unknown>, types: Map<string, Described>) {
  const parts = target.keyColumns.map((name) =>
    keyPartOf(valueOf(target, row, name), types.get(name) ?? engineColumn(name, 'keyword')),
  );
  if (!parts.length || parts.some((part) => part === null || part === ''))
    throw new ConnectorError('sources.sync.keyEmpty');
  return sourceKey(parts);
}

async function columns(target: LiveTarget): Promise<Map<string, Described>> {
  const key = JSON.stringify([target.id, target.version, target.select]);
  const cached = described.get(key);
  if (cached && Date.now() - cached.at < DESCRIBE_MS) return cached.columns;
  const types = (async () => {
    const all = await connectorFor(target.kind).describe(target.context, target.select);
    // A described column reaches here as a plain column, so the class it was read by is derived
    // again: the schemaless engines keep arrays that arrive after their sample as JSON text.
    return new Map(
      all.map((column) => [
        column.name,
        target.kind === 'meilisearch'
          ? { ...sampledColumn(column), arraysAsJson: true }
          : {
              ...engineColumn(column.name, column.sourceType),
              column,
              arraysAsJson: target.kind === 'elasticsearch' || target.kind === 'opensearch',
            },
      ]),
    );
  })();
  described.set(key, { at: Date.now(), columns: types });
  if (described.size > 500) described.delete(described.keys().next().value!);
  // A description that failed is forgotten, so the next read tries again rather than caching it.
  types.catch(() => {
    if (described.get(key)?.columns === types) described.delete(key);
  });
  return types;
}

export async function searchKeys(
  target: LiveTarget,
  request: { where: Fragment | null; order: readonly Fragment[]; limit: number },
) {
  if (request.where && !request.where.native) throw new ConnectorError('sources.live.unsupported');
  const limit = positive(request.limit, 250_000);
  const types = await columns(target);
  const rows = await nativeRows(
    target,
    request.where?.native ?? { op: 'true' },
    request.order.map((part) => {
      if (!part.nativeOrder) throw new ConnectorError('sources.live.unsupported');
      return part.nativeOrder;
    }),
    limit + 1,
  );
  const keys = rows.slice(0, limit).map((row) => keyOf(target, row, types));
  if (new Set(keys).size !== keys.length) throw new ConnectorError('sources.sync.keyDuplicate');
  return { keys, truncated: rows.length > limit };
}

export async function searchRows(
  target: LiveTarget,
  keys: readonly string[],
  reads: ReadonlyArray<{ id: string; column: string; type: string }>,
) {
  const out = new Map<string, Record<string, CellValue>>();
  if (!keys.length) return out;
  const types = await columns(target);
  for (let at = 0; at < keys.length; at += KEY_BATCH) {
    const rows = await rowsForKeys(target, keys.slice(at, at + KEY_BATCH));
    for (const row of rows)
      out.set(
        keyOf(target, row, types),
        Object.fromEntries(
          reads.map((read) => {
            if (!types.has(read.column))
              throw new ConnectorError('sources.sync.columnMissing', undefined, { column: read.column });
            return [read.id, cellOf(valueOf(target, row, read.column), read.type, types.get(read.column)!)];
          }),
        ),
      );
  }
  return out;
}

export async function searchMatching(target: LiveTarget, keys: readonly string[], where: Fragment) {
  if (!where.native) throw new ConnectorError('sources.live.unsupported');
  const out = new Set<string>();
  if (!keys.length) return out;
  const types = await columns(target);
  for (let at = 0; at < keys.length; at += KEY_BATCH) {
    const rows = await rowsForKeys(target, keys.slice(at, at + KEY_BATCH), where.native);
    for (const row of rows) out.add(keyOf(target, row, types));
  }
  return out;
}

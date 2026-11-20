import { odataName, type ODataConnector, type ODataQuery } from '../api/odata.js';
import { odataText, odataLiteral } from './odata.js';
import { documentKeys, documentRows, keyPredicate, documentKeyBatchSize } from '../nosql/reader.js';
import { searchKeys, searchMatching, searchRows } from '../http-engines/reader.js';
import { ALL, and } from '../nosql/query.js';
import {
  isNoSqlKind,
  isSearchSource,
  type CellValue,
  type SourceColumn,
  type SourceKind,
  type SourceSelect,
} from '@riosoma/contracts';
import { readError, scrub } from '../common.js';
import { connectorFor, sourceKey } from '../registry.js';
import { aliasedFromSql, positive, projection, quote } from '../sql.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { convert, keyValue, type Dialect } from '../values.js';
import { classify } from './classify.js';
import { joined, render, sqlf, text, value, type Fragment } from './fragment.js';
import { livePool } from './pool.js';
import { LIVE_ALIAS, type LiveDialect } from './translate.js';

/** Where a live table reads: the source, its settings' version, what to read, and its key. */
export interface LiveTarget {
  /** The source's ID, which names its pool */
  id: string;
  /** Changes whenever the source's settings or secrets do */
  version: string;
  kind: SourceKind;
  /** Connection and secrets, with each statement's timeout as `timeoutMs` */
  context: ConnectorContext;
  select: SourceSelect;
  keyColumns: readonly string[];
}

const DESCRIBE_MS = 60_000;
const described = new Map<string, { at: number; columns: Promise<SourceColumn[]> }>();

/**
 * How a live read writes its request for this kind: the kind itself for the engines that take a
 * typed predicate, and a SQL dialect for the databases.  Anything else can't be read live.
 */
export function liveDialect(kind: SourceKind): LiveDialect {
  if (isNoSqlKind(kind) || isSearchSource(kind)) return kind;
  return sqlDialect(kind);
}

function sqlDialect(kind: SourceKind): Dialect {
  if (
    kind === 'postgres' ||
    kind === 'mysql' ||
    kind === 'sqlserver' ||
    kind === 'redshift' ||
    kind === 'athena'
  )
    return kind;
  throw new ConnectorError('sources.live.unsupported');
}

function poolFor(target: LiveTarget) {
  const { signal: _signal, ...context } = target.context;
  return livePool(target.id, target.version, target.kind, context);
}

/**
 * What a failed live read tells people: the source can't be reached, a read ran past its time, or
 * the same messages a sync gives for a missing table or column.  The driver's words stay in
 * `detail`, with anything secret taken out.
 */
export function liveError(error: unknown, ctx: ConnectorContext, select?: SourceSelect): ConnectorError {
  if (error instanceof ConnectorError) {
    if (error.messageKey === 'sources.test.timeout')
      return new ConnectorError('sources.live.timeout', error.detail);
    if (/^sources\.(live|sync|athena)\./.test(error.messageKey))
      return new ConnectorError(error.messageKey, error.detail && scrub(error.detail, ctx), error.params);
  }
  const e = error as { code?: string; errno?: number; number?: number; message?: string };
  const detail = scrub(error, ctx);
  if (
    e.code === '57014' ||
    e.code === 'ER_QUERY_TIMEOUT' ||
    e.code === 'ETIMEOUT' ||
    e.code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    e.errno === 3024 ||
    e.errno === 1969
  )
    return new ConnectorError('sources.live.timeout', detail);
  if (
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ECONNCLOSED|ESOCKET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|PROTOCOL_CONNECTION_LOST|57P0[123]|08\d{3})$/.test(
      e.code ?? '',
    )
  )
    return new ConnectorError('sources.live.unreachable', detail);
  return readError(error, ctx, select);
}

async function run(target: LiveTarget, statement: Fragment): Promise<Array<Record<string, unknown>>> {
  const dialect = sqlDialect(target.kind);
  const { text: sql, params } = render(statement, dialect);
  try {
    return await poolFor(target).use((session) => session.select(sql, params), target.context.signal);
  } catch (error) {
    throw liveError(error, target.context, target.select);
  }
}

/** The source's columns, described once a minute at most, since describing takes a round trip each. */
export async function liveColumns(target: LiveTarget): Promise<SourceColumn[]> {
  if (isNoSqlKind(target.kind) || isSearchSource(target.kind))
    return connectorFor(target.kind).describe(target.context, target.select);
  const key = JSON.stringify([target.id, target.version, target.select]);
  const cached = described.get(key);
  if (cached && Date.now() - cached.at < DESCRIBE_MS) return cached.columns;
  const columns = (async () => {
    try {
      if (target.kind === 'odata') return connectorFor('odata').describe(target.context, target.select);
      return await poolFor(target).use((session) => session.describe(target.select), target.context.signal);
    } catch (error) {
      throw liveError(error, target.context, target.select);
    }
  })();
  described.set(key, { at: Date.now(), columns });
  if (described.size > 500) described.delete(described.keys().next().value!);
  columns.catch(() => {
    if (described.get(key)?.columns === columns) described.delete(key);
  });
  return columns;
}

function columnsNamed(all: readonly SourceColumn[], names: readonly string[]): SourceColumn[] {
  const byName = new Map(all.map((column) => [column.name, column]));
  return names.map((name) => {
    const column = byName.get(name);
    if (!column) throw new ConnectorError('sources.sync.columnMissing', undefined, { column: name });
    return column;
  });
}

function ref(name: string, dialect: Dialect): string {
  return `${quote(LIVE_ALIAS, dialect)}.${quote(name, dialect)}`;
}

function selectList(columns: readonly SourceColumn[], dialect: Dialect): Fragment {
  return text(
    columns
      .map(
        (column) =>
          `${projection(column, ref(column.name, dialect), dialect)} AS ${quote(column.name, dialect)}`,
      )
      .join(', '),
  );
}

function keyOf(row: Record<string, unknown>, keys: readonly SourceColumn[]): string {
  const parts = keys.map((column) => keyValue(row[column.name], column));
  if (parts.some((part) => part === null || part === undefined || part === ''))
    throw new ConnectorError('sources.sync.keyEmpty');
  return sourceKey(parts);
}

/**
 * The ordered keys of every row the condition admits, in the order given and then by key, so the
 * order is the same every time.  At most `limit` of them, and `truncated` when there were more.
 */
export async function liveKeys(
  target: LiveTarget,
  request: { where: Fragment | null; order: readonly Fragment[]; limit: number },
): Promise<{ keys: string[]; truncated: boolean }> {
  if (isNoSqlKind(target.kind)) return documentKeys(target, request);
  if (isSearchSource(target.kind)) return searchKeys(target, request);
  const limit = positive(request.limit, 250_000);
  if (target.kind === 'odata') {
    const keys = columnsNamed(await liveColumns(target), target.keyColumns);
    const rows = await nativeRows(target, {
      columns: target.keyColumns,
      top: limit + 1,
      ...(request.where ? { filter: odataText(request.where) } : {}),
      order: [...request.order.map(odataText), ...target.keyColumns.map((name) => `${odataName(name)} asc`)],
    });
    const out = rows.slice(0, limit).map((row) => keyOf(row, keys));
    if (new Set(out).size !== out.length) throw new ConnectorError('sources.sync.keyDuplicate');
    return { keys: out, truncated: rows.length > limit };
  }
  const dialect = sqlDialect(target.kind);
  const keys = columnsNamed(await liveColumns(target), target.keyColumns);
  const order = [...request.order, ...keys.map((column) => text(`${ref(column.name, dialect)} ASC`))];
  const statement = sqlf`SELECT ${text(dialect === 'sqlserver' ? `TOP (${limit + 1}) ` : '')}${selectList(keys, dialect)} FROM ${text(
    aliasedFromSql(target.select, dialect, LIVE_ALIAS),
  )}${request.where ? sqlf` WHERE ${request.where}` : text('')} ORDER BY ${joined(order, ', ')}${text(
    dialect === 'sqlserver' ? '' : ` LIMIT ${limit + 1}`,
  )}`;
  const rows = await run(target, statement);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, limit)) {
    const key = keyOf(row, keys);
    if (seen.has(key)) throw new ConnectorError('sources.sync.keyDuplicate', undefined, { key });
    seen.add(key);
    out.push(key);
  }
  return { keys: out, truncated: rows.length > limit };
}

/** A key's part as a parameter the source compares with its key column. */
function keyParam(part: unknown, column: SourceColumn, dialect: Dialect): Fragment {
  if (dialect === 'athena') {
    if (!['string', 'number', 'boolean'].includes(typeof part))
      throw new ConnectorError('sources.sync.keyEmpty');
    const form = String(part);
    switch (classify(column.sourceType, dialect)) {
      case 'integer':
        return sqlf`CAST(${value(form)} AS bigint)`;
      case 'float':
        return sqlf`CAST(${value(form)} AS double)`;
      case 'boolean':
        return sqlf`CAST(${value(form)} AS boolean)`;
      case 'date':
        return sqlf`CAST(${value(form)} AS date)`;
      case 'instant':
        return sqlf`from_iso8601_timestamp(${value(form)})`;
      case 'wall':
        return sqlf`CAST(${value(form.slice(0, 23).replace('T', ' '))} AS timestamp)`;
      case 'decimal': {
        const type = column.sourceType.toLowerCase();
        if (!/^(decimal|numeric)\(\d+,\s*\d+\)$/.test(type))
          throw new ConnectorError('sources.sync.keyEmpty');
        return sqlf`CAST(${value(form)} AS ${text(type)})`;
      }
      default:
        return value(form);
    }
  }
  if (typeof part === 'boolean')
    return value(dialect === 'postgres' || dialect === 'redshift' ? String(part) : part ? '1' : '0');
  if (typeof part !== 'string' && typeof part !== 'number') throw new ConnectorError('sources.sync.keyEmpty');
  const form = String(part);
  // Moments are keyed as UTC instants, and a column without an offset takes the same wall time.
  if (classify(column.sourceType, dialect) === 'wall' && /^\d{4}-\d{2}-\d{2}T/.test(form))
    return value(form.slice(0, 23).replace('T', dialect === 'sqlserver' ? 'T' : ' '));
  return value(form);
}

/**
 * The rows with these keys, by key, with each value read as its field's type and filed under the
 * field's ID, since two fields may show one column as different types.  A key the source no longer
 * has is missing from the answer.
 */
export async function liveRows(
  target: LiveTarget,
  keys: readonly string[],
  reads: ReadonlyArray<{ id: string; column: string; type: string }>,
): Promise<Map<string, Record<string, CellValue>>> {
  const out = new Map<string, Record<string, CellValue>>();
  if (!keys.length) return out;
  if (isNoSqlKind(target.kind)) {
    const batchSize = documentKeyBatchSize(target);
    for (let start = 0; start < keys.length; start += batchSize) {
      const selected = keys.slice(start, start + batchSize);
      const rows = await documentRows(target, keyPredicate(target, selected), [], selected.length, reads);
      for (const row of rows)
        out.set(row.key, Object.fromEntries(reads.map((read) => [read.id, row.values[read.id] ?? null])));
    }
    return out;
  }
  if (target.kind === 'odata') {
    const all = await liveColumns(target);
    const keyColumns = columnsNamed(all, target.keyColumns);
    const wanted = columnsNamed(all, [
      ...new Set([...reads.map((read) => read.column), ...target.keyColumns]),
    ]);
    const byName = new Map(all.map((column) => [column.name, column]));
    for (let start = 0; start < keys.length; start += 50) {
      const rows = await nativeRows(target, {
        columns: wanted.map((column) => column.name),
        top: 1_000_001,
        filter: nativeKeyMatch(keys.slice(start, start + 50), keyColumns),
      });
      for (const row of rows)
        out.set(
          keyOf(row, keyColumns),
          Object.fromEntries(
            reads.map((read) => [read.id, convert(row[read.column], read.type, byName.get(read.column)!)]),
          ),
        );
    }
    return out;
  }
  if (isSearchSource(target.kind)) return searchRows(target, keys, reads);
  const dialect = sqlDialect(target.kind);
  const all = await liveColumns(target);
  const keyColumns = columnsNamed(all, target.keyColumns);
  const wanted = columnsNamed(all, [...new Set([...reads.map((read) => read.column), ...target.keyColumns])]);
  const byName = new Map(all.map((column) => [column.name, column]));
  for (let start = 0; start < keys.length; start += 500) {
    const rows = await run(
      target,
      sqlf`SELECT ${selectList(wanted, dialect)} FROM ${text(
        aliasedFromSql(target.select, dialect, LIVE_ALIAS),
      )} WHERE ${keyMatch(keys.slice(start, start + 500), keyColumns, dialect)}`,
    );
    for (const row of rows) {
      const values: Record<string, CellValue> = {};
      for (const read of reads)
        values[read.id] = convert(row[read.column], read.type, byName.get(read.column)!);
      out.set(keyOf(row, keyColumns), values);
    }
  }
  return out;
}

/** A condition admitting exactly the rows with these keys. */
function keyMatch(keys: readonly string[], keyColumns: readonly SourceColumn[], dialect: Dialect): Fragment {
  const matches = keys.map((key) => {
    const parts = JSON.parse(key) as unknown[];
    if (!Array.isArray(parts) || parts.length !== keyColumns.length)
      throw new ConnectorError('sources.sync.keyEmpty');
    return parts.map((part, index) => keyParam(part, keyColumns[index]!, dialect));
  });
  if (keyColumns.length === 1)
    return sqlf`${text(ref(keyColumns[0]!.name, dialect))} IN (${joined(
      matches.map((parts) => parts[0]!),
      ', ',
    )})`;
  return sqlf`(${joined(
    matches.map(
      (parts) =>
        sqlf`(${joined(
          parts.map((part, index) => sqlf`${text(ref(keyColumns[index]!.name, dialect))} = ${part}`),
          ' AND ',
        )})`,
    ),
    ' OR ',
  )})`;
}

/** Which of these keys name rows that also meet a condition, such as a reader's record rules. */
export async function liveMatching(
  target: LiveTarget,
  keys: readonly string[],
  where: Fragment,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  if (isNoSqlKind(target.kind)) {
    if (!where.document) throw new ConnectorError('sources.live.unsupported');
    const batchSize = documentKeyBatchSize(target, where.document);
    for (let start = 0; start < keys.length; start += batchSize) {
      const selected = keys.slice(start, start + batchSize);
      const rows = await documentRows(
        target,
        and(keyPredicate(target, selected), where.document ?? ALL),
        [],
        selected.length,
        [],
      );
      for (const row of rows) out.add(row.key);
    }
    return out;
  }
  if (target.kind === 'odata') {
    const columns = columnsNamed(await liveColumns(target), target.keyColumns);
    for (let start = 0; start < keys.length; start += 50) {
      const rows = await nativeRows(target, {
        columns: target.keyColumns,
        top: 1_000_001,
        filter: `(${nativeKeyMatch(keys.slice(start, start + 50), columns)}) and (${odataText(where)})`,
      });
      for (const row of rows) out.add(keyOf(row, columns));
    }
    return out;
  }
  if (isSearchSource(target.kind)) return searchMatching(target, keys, where);
  const dialect = sqlDialect(target.kind);
  const keyColumns = columnsNamed(await liveColumns(target), target.keyColumns);
  for (let start = 0; start < keys.length; start += 500) {
    const rows = await run(
      target,
      sqlf`SELECT ${selectList(keyColumns, dialect)} FROM ${text(
        aliasedFromSql(target.select, dialect, LIVE_ALIAS),
      )} WHERE ${keyMatch(keys.slice(start, start + 500), keyColumns, dialect)} AND ${where}`,
    );
    for (const row of rows) out.add(keyOf(row, keyColumns));
  }
  return out;
}

/** Forgets every described source, as tests do between sources that reuse names. */
export function forgetLiveColumns(): void {
  described.clear();
}

async function nativeRows(target: LiveTarget, query: ODataQuery) {
  const connector = connectorFor('odata') as ODataConnector;
  if (typeof connector.query !== 'function') throw new ConnectorError('sources.live.unsupported');
  return connector.query(target.context, target.select, query);
}
function nativeKeyMatch(keys: readonly string[], columns: readonly SourceColumn[]): string {
  return keys
    .map((key) => {
      const parts: unknown = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== columns.length)
        throw new ConnectorError('sources.sync.keyEmpty');
      return `(${columns.map((column, index) => `${odataName(column.name)} eq ${odataLiteral(parts[index], column.sourceType)}`).join(' and ')})`;
    })
    .join(' or ');
}

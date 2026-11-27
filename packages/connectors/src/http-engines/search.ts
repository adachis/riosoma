import {
  searchFilterProblem,
  type SearchSourceKind,
  type SourceColumn,
  type SourceSelect,
  type SourceObjectRef,
} from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { Sampler, valueAt } from '../rest/records.js';
import { describeColumn, type Described, type TypeClass } from '../warehouses/mapping.js';
import type { WarehouseSession } from '../warehouses/frame.js';
import { type EngineHttp, record, records, nameOf, type Row } from './http.js';

export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: 'true' | 'false' }
  | {
      op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'exists';
      column: string;
      value?: unknown;
      format?: 'strict_date_optional_time';
    };
export interface SearchOrder {
  column: string;
  direction: 'asc' | 'desc';
}
export interface SearchRequest {
  where?: Predicate;
  order?: SearchOrder[];
  limit?: number;
  /** Typesense IDs whose backticks or backslashes have no form its filter grammar can compare */
  documentIds?: readonly string[];
}

export function elasticFilter(p: Predicate): Row {
  if (p.op === 'true') return { match_all: {} };
  if (p.op === 'false') return { match_none: {} };
  if (p.op === 'and' || p.op === 'or')
    return {
      bool:
        p.op === 'and'
          ? { filter: p.args.map(elasticFilter) }
          : { should: p.args.map(elasticFilter), minimum_should_match: 1 },
    };
  if (p.op === 'not') return { bool: { must_not: [elasticFilter(p.arg)] } };
  if ('column' in p) {
    if (p.op === 'exists') return { exists: { field: p.column } };
    if (p.op === 'eq') return { term: { [p.column]: p.value } };
    return { range: { [p.column]: { [p.op]: p.value, ...(p.format ? { format: p.format } : {}) } } };
  }
  throw new ConnectorError('sources.live.unsupported');
}

export function searchFilter(p: Predicate, kind: 'meilisearch' | 'typesense'): string {
  if (p.op === 'true') return '';
  if (p.op === 'false') throw new ConnectorError('sources.live.unsupported');
  if (p.op === 'and' || p.op === 'or') {
    const join =
      kind === 'meilisearch' ? (p.op === 'and' ? ' AND ' : ' OR ') : p.op === 'and' ? ' && ' : ' || ';
    return `(${p.args.map((part) => searchFilter(part, kind)).join(join)})`;
  }
  if (p.op === 'not')
    return kind === 'meilisearch' ? `NOT (${searchFilter(p.arg, kind)})` : `!(${searchFilter(p.arg, kind)})`;
  if (!('column' in p) || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(p.column))
    throw new ConnectorError('sources.live.unsupported');
  if (p.op === 'exists') {
    if (kind === 'typesense') throw new ConnectorError('sources.live.unsupported');
    return `${p.column} EXISTS AND ${p.column} IS NOT NULL`;
  }
  const operator = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[p.op];
  if (typeof p.value !== 'number' && typeof p.value !== 'boolean' && typeof p.value !== 'string')
    throw new ConnectorError('sources.live.unsupported');
  // Typesense reads a backtick-quoted value as it stands: a backslash inside one is only an escape
  // before a backtick, so doubling it would look for a value the source never held, and a value
  // ending in one would swallow the closing backtick.  Neither has a form its grammar can read,
  // which is why a document ID holding one is fetched directly instead (see `rowsForKeys`).
  if (
    kind === 'typesense' &&
    typeof p.value === 'string' &&
    (p.value.includes('`') || p.value.endsWith('\\'))
  )
    throw new ConnectorError('sources.live.unsupported');
  const value =
    typeof p.value === 'string'
      ? kind === 'meilisearch'
        ? JSON.stringify(p.value)
        : `\`${p.value}\``
      : String(p.value);
  return `${p.column}${kind === 'typesense' ? ':' : ' '}${operator}${kind === 'typesense' ? '' : ' '}${value}`;
}

export function engineColumn(name: string, type: string): Described {
  const kind: TypeClass = /^(byte|short|integer|long|unsigned_long|int32|int64)$/.test(type)
    ? 'integer'
    : /^(half_float|float|double|scaled_float|number)$/.test(type)
      ? 'float'
      : /^(date|date_nanos|datetime)$/.test(type)
        ? 'timestamp'
        : /^(bool|boolean)$/.test(type)
          ? 'boolean'
          : type === 'geo_point' || type === 'geopoint'
            ? 'location'
            : /^(object|nested|json|mixed)$|\[\]$/.test(type)
              ? 'json'
              : 'text';
  const described = describeColumn({
    name,
    sourceType: type,
    nullable: name !== '_id' && name !== 'id',
    kind,
  });
  if (kind === 'json') described.column.suggested = { type: 'json', options: {} };
  return described;
}

export function sampled(rows: Row[]): Described[] {
  const sampler = new Sampler({ flattenDepth: 0, arrays: 'json' });
  rows.forEach((row) => sampler.add(row));
  return sampler.describe().map(({ column }) => sampledColumn(column));
}

/** Sampled strings can represent timestamps, so conversion keeps the sample's field suggestion. */
export function sampledColumn(column: SourceColumn): Described {
  return {
    column: column.sourceType === 'json' ? { ...column, suggested: { type: 'json', options: {} } } : column,
    kind:
      column.suggested?.type === 'date'
        ? 'timestamp'
        : column.suggested?.type === 'number'
          ? 'float'
          : column.suggested?.type === 'checkbox'
            ? 'boolean'
            : column.sourceType === 'json' || column.sourceType === 'mixed'
              ? 'json'
              : 'text',
  };
}

/** A literal dotted key wins even when its value is null and a nested path also exists. */
export function searchValue(row: Row, name: string): unknown {
  return Object.hasOwn(row, name) ? row[name] : valueAt(row, name);
}

function objectName(select: SourceSelect): string {
  if (select.kind !== 'object' || select.filter) throw new ConnectorError('sources.filterUnsupported');
  return encodeURIComponent(select.object.name);
}

/**
 * The query types a native filter may use, each with the keys inside it that hold another query.
 * An allowlist rather than names to refuse: a script rides along under keys nobody listed, like
 * `terms_set`'s `minimum_should_match_script`, and a `wrapper` query carries its own as base64 no
 * scan can read.  So the types that run code, and the ones that hide it, are simply absent here.
 */
const QUERY_TYPES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    // A comparison query's body names fields and values, which the engine only compares.
    match_all: [],
    match_none: [],
    ids: [],
    exists: [],
    term: [],
    terms: [],
    range: [],
    match: [],
    match_bool_prefix: [],
    match_phrase: [],
    match_phrase_prefix: [],
    multi_match: [],
    combined_fields: [],
    query_string: [],
    simple_query_string: [],
    prefix: [],
    wildcard: [],
    regexp: [],
    fuzzy: [],
    distance_feature: [],
    geo_bounding_box: [],
    geo_distance: [],
    geo_shape: [],
    // A compound query holds other queries at these keys and nowhere else.
    bool: ['filter', 'must', 'must_not', 'should'],
    boosting: ['positive', 'negative'],
    constant_score: ['filter'],
    dis_max: ['queries'],
    has_child: ['query'],
    has_parent: ['query'],
    nested: ['query'],
  } satisfies Record<string, readonly string[]>),
);

/**
 * Keys that hold code wherever they sit.  A leaf query's body names fields, which no walk can tell
 * apart from a script, so a key shaped like one is refused outright instead of being judged by its
 * position.  A field of someone's own named `script_name` still passes: it is neither of these.
 */
const SCRIPTED = /(?:^|_)script$|^(?:script_score|script_fields|runtime_mappings)$/;

/**
 * Keys whose bodies hold whole queries where this walk doesn't follow them: an inner hit's sort can
 * carry a nested filter, and a highlight a `highlight_query`, either of which could be a wrapper or
 * a percolate query.  The connector never reads inner hits or highlights, so both are refused
 * wherever they sit, like a script.  A field named either can't be used in a native filter.
 */
const UNREAD = new Set(['inner_hits', 'highlight']);

/** A filter this deep is no filter a person wrote, and walking it further could exhaust the stack. */
const QUERY_DEPTH = 64;

function baseQuery(select: SourceSelect): Row {
  if (select.kind !== 'object' || !select.nativeFilter) return { match_all: {} };
  let query: Row;
  try {
    query = record(JSON.parse(select.nativeFilter));
  } catch {
    throw new ConnectorError('sources.engines.filter');
  }
  checkQueries(query, 0);
  return query;
}

/** A query position, which both engines take as one query or as a list of them. */
function checkQueries(value: unknown, depth: number): void {
  if (Array.isArray(value)) {
    for (const item of value) checkQuery(item, depth + 1);
    return;
  }
  checkQuery(value, depth);
}

function checkQuery(value: unknown, depth: number): void {
  if (depth > QUERY_DEPTH || !value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectorError('sources.engines.filter');
  const entries = Object.entries(value);
  // A query names its type, so an object naming none names a type this filter may not use.
  if (!entries.length) throw new ConnectorError('sources.engines.filter');
  for (const [type, body] of entries) {
    const nested = QUERY_TYPES.get(type);
    if (!nested) throw new ConnectorError('sources.engines.filter');
    checkBody(body, nested, depth + 1);
  }
}

/** A query type's own body: its declared keys hold queries, and the rest are only scanned. */
function checkBody(body: unknown, nested: readonly string[], depth: number): void {
  if (depth > QUERY_DEPTH) throw new ConnectorError('sources.engines.filter');
  if (Array.isArray(body)) {
    for (const item of body) checkBody(item, [], depth + 1);
    return;
  }
  if (!body || typeof body !== 'object') return;
  for (const [key, inner] of Object.entries(body)) {
    if (SCRIPTED.test(key) || UNREAD.has(key)) throw new ConnectorError('sources.engines.filter');
    if (nested.includes(key)) checkQueries(inner, depth + 1);
    else checkBody(inner, [], depth + 1);
  }
}

const TYPESENSE_DEFAULT_SORTABLE = new Set(['int32', 'int64', 'float', 'bool']);
const TYPESENSE_SORTABLE = new Set([...TYPESENSE_DEFAULT_SORTABLE, 'string']);

/** Typesense sorts on scalar numeric/bool fields by default, and on string fields only when `sort: true`. */
function typesenseSortable(field: Row): boolean {
  const name = typeof field.name === 'string' ? field.name : '';
  const type = typeof field.type === 'string' ? field.type : '';
  if (!name || name === 'id' || !TYPESENSE_SORTABLE.has(type)) return false;
  if (typeof field.sort === 'boolean') return field.sort;
  return TYPESENSE_DEFAULT_SORTABLE.has(type);
}

export class SearchSession implements WarehouseSession {
  readonly kind: SearchSourceKind;
  constructor(readonly http: EngineHttp) {
    this.kind = http.settings.kind as SearchSourceKind;
  }
  close() {
    return this.http.close();
  }
  async version() {
    const objects = await this.list();
    if (objects[0])
      for await (const _rows of this.pages({ kind: 'object', object: objects[0] }, 1, { limit: 1 })) break;
    return this.kind;
  }
  async estimate() {
    return null;
  }
  async list() {
    const { http, kind } = this;
    if (kind === 'elasticsearch' || kind === 'opensearch') {
      const catalog = record(await http.json('/_alias'));
      const found = new Map<string, 'table' | 'view'>();
      for (const [name, entry] of Object.entries(catalog)) {
        if (!name.startsWith('.')) found.set(name, 'table');
        for (const alias of Object.keys(record(record(entry).aliases)))
          if (!alias.startsWith('.')) found.set(alias, 'view');
      }
      return [...found].map(([name, type]) => ({ schema: null, name, type, rowEstimate: null }));
    }
    if (kind === 'typesense')
      return records(await http.json('/collections')).map((entry) => ({
        schema: null,
        name: nameOf(entry.name),
        type: 'collection' as const,
        rowEstimate: typeof entry.num_documents === 'number' ? entry.num_documents : null,
      }));
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const page = record(await http.json(`/indexes?offset=${offset}&limit=100`));
      const entries = records(page.results);
      out.push(
        ...entries.map((entry) => ({
          schema: null,
          name: nameOf(entry.uid),
          type: 'collection' as const,
          rowEstimate: null,
        })),
      );
      if (entries.length < 100) return out;
    }
  }
  async keys(object: SourceObjectRef): Promise<string[][]> {
    if (this.kind === 'meilisearch') {
      const index = record(await this.http.json(`/indexes/${encodeURIComponent(object.name)}`));
      return typeof index.primaryKey === 'string' ? [[index.primaryKey]] : [];
    }
    return [this.kind === 'typesense' ? ['id'] : ['_index', '_id']];
  }
  async describe(select: SourceSelect): Promise<Described[]> {
    const name = objectName(select);
    if (this.kind === 'elasticsearch' || this.kind === 'opensearch') {
      const result = record(await this.http.json(`/${name}/_mapping`));
      const columns = new Map<string, Described>();
      for (const index of Object.values(result)) {
        const mapping = record(record(index).mappings);
        for (const [name, value] of Object.entries(record(mapping.properties ?? {}))) {
          const type = record(value).type ?? 'object';
          const column = engineColumn(name, nameOf(type));
          const previous = columns.get(name);
          columns.set(
            name,
            previous && previous.column.sourceType !== type ? engineColumn(name, 'mixed') : column,
          );
        }
      }
      if (!columns.has('_index')) columns.set('_index', engineColumn('_index', 'keyword'));
      if (!columns.has('_id')) columns.set('_id', engineColumn('_id', 'keyword'));
      // Mappings describe element types without cardinality, so sampled arrays need JSON fields.
      for await (const page of this.pages(select, 500, { limit: 1_000 })) {
        for (const row of page) {
          for (const [name, column] of columns) {
            const value = row[name];
            if (
              Array.isArray(value) &&
              column.kind !== 'json' &&
              !(
                column.kind === 'location' &&
                value.length === 2 &&
                value.every((coordinate) => typeof coordinate === 'number')
              )
            )
              columns.set(name, engineColumn(name, `${column.column.sourceType}[]`));
          }
        }
      }
      return [...columns.values()].map((column) => ({ ...column, arraysAsJson: true }));
    }
    if (this.kind === 'typesense') {
      const schema = record(await this.http.json(`/collections/${name}`));
      const fields = records(schema.fields).filter((field) => field.name !== 'id');
      return [
        ...fields
          .filter(typesenseSortable)
          .map((field) => engineColumn(nameOf(field.name), nameOf(field.type))),
        ...fields
          .filter((field) => !typesenseSortable(field))
          .map((field) => engineColumn(nameOf(field.name), nameOf(field.type))),
        engineColumn('id', 'string'),
      ];
    }
    const rows: Row[] = [];
    for await (const page of this.pages(select, 500, { limit: 1_000 })) rows.push(...page);
    // Meilisearch documents carry no schema, so a field a sample read as a number, a date, or text
    // can hold an array in a later document.  Read such a cell as JSON text, the way Elasticsearch
    // and OpenSearch do, so one document's array fails that cell instead of the whole read.
    return sampled(rows).map((column) => ({ ...column, arraysAsJson: true }));
  }
  async *rows(select: SourceSelect, columns: readonly Described[], size: number, limit?: number) {
    for await (const page of this.pages(select, size, { limit }))
      yield this.kind === 'typesense'
        ? page.map((row) => ({
            ...row,
            ...Object.fromEntries(columns.map(({ column }) => [column.name, searchValue(row, column.name)])),
          }))
        : page;
  }

  async *pages(select: SourceSelect, size: number, request: SearchRequest = {}): AsyncGenerator<Row[]> {
    const name = objectName(select);
    const { http, kind } = this;
    const maximum = request.limit ?? Infinity;
    let read = 0;
    // A Typesense filter shares one string with the record rules (see `filterBy` below), so one
    // whose groups or backticks don't close is refused here as well as when the table is saved.
    if (
      kind === 'typesense' &&
      select.kind === 'object' &&
      select.nativeFilter &&
      searchFilterProblem(select.nativeFilter, kind) !== null
    )
      throw new ConnectorError('sources.engines.filterGroup');
    if (request.documentIds) {
      if (kind !== 'typesense') throw new ConnectorError('sources.live.unsupported');
      const found = new Map<string, Row>();
      for (const id of new Set(request.documentIds)) {
        try {
          const row = record(await http.json(`/collections/${name}/documents/${encodeURIComponent(id)}`));
          if (row.id !== id) throw new ConnectorError('sources.engines.response');
          found.set(id, row);
        } catch (error) {
          if (!(error instanceof ConnectorError && error.params?.status === 404)) throw error;
        }
      }
      if (!found.size) return;
      if (
        (select.kind === 'object' && select.nativeFilter) ||
        (request.where && request.where.op !== 'true')
      ) {
        // Direct retrieval has no filter option.  Intersect with the engine's filtered results
        // so source filters and record rules still decide which requested IDs may be returned.
        const { documentIds: _ids, limit: _limit, ...filtered } = request;
        for await (const page of this.pages(select, size, filtered)) {
          const matches = page.filter((row) => found.delete(nameOf(row.id))).slice(0, maximum - read);
          read += matches.length;
          if (matches.length) yield matches;
          if (!found.size || read >= maximum) return;
        }
      } else {
        const rows = [...found.values()].slice(0, maximum);
        for (let at = 0; at < rows.length; at += size) yield rows.slice(at, at + size);
      }
      return;
    }
    if (kind === 'elasticsearch' || kind === 'opensearch') {
      if (
        kind === 'elasticsearch' &&
        request.order?.some((order) => order.column === '_id' || order.column === '_index')
      )
        throw new ConnectorError('sources.live.unsupported');
      const opened = record(
        await http.json(
          kind === 'elasticsearch'
            ? `/${name}/_pit?keep_alive=2m&allow_partial_search_results=false`
            : `/${name}/_search/point_in_time?keep_alive=2m&allow_partial_pit_creation=false`,
          {},
        ),
      );
      let pit = nameOf(opened.id ?? opened.pit_id);
      let after: unknown;
      try {
        if (opened._shards && Number(record(opened._shards).failed) > 0)
          throw new ConnectorError('sources.engines.partial');
        while (read < maximum) {
          const count = Math.min(size, 1_000, maximum - read);
          const query = baseQuery(select);
          const body = record(
            await http.json('/_search?allow_partial_search_results=false', {
              size: count,
              pit: { id: pit, keep_alive: '2m' },
              track_total_hits: false,
              query: request.where ? { bool: { filter: [query, elasticFilter(request.where)] } } : query,
              sort: [
                ...(request.order ?? []).map((order) => ({
                  [order.column]: { order: order.direction, missing: '_last' },
                })),
                // Both engines keep a point in time's own position as a final tiebreaker, which is
                // the one sort that is unique per document and costs nothing.  Sorting by document
                // ID instead needs fielddata, which both refuse by default.
                '_shard_doc',
              ],
              ...(after ? { search_after: after } : {}),
            }),
          );
          if (typeof body.pit_id === 'string') pit = body.pit_id;
          if (body.timed_out === true || (body._shards && Number(record(body._shards).failed) > 0))
            throw new ConnectorError('sources.engines.partial');
          const hits = records(record(body.hits).hits);
          if (!hits.length) return;
          const next = hits.at(-1)!.sort;
          if (!Array.isArray(next) || JSON.stringify(next) === JSON.stringify(after))
            throw new ConnectorError('sources.engines.paging');
          after = next;
          read += hits.length;
          yield hits.map((hit) => ({
            ...record(hit._source),
            _id: nameOf(hit._id),
            _index: nameOf(hit._index),
          }));
          if (hits.length < count) return;
        }
      } finally {
        await http
          .json(
            kind === 'elasticsearch' ? '/_pit' : '/_search/point_in_time',
            kind === 'elasticsearch' ? { id: pit } : { pit_id: [pit] },
            'DELETE',
            true,
          )
          .catch(() => undefined);
      }
      return;
    }
    const parts = [
      select.kind === 'object' ? select.nativeFilter : undefined,
      request.where ? searchFilter(request.where, kind) : undefined,
    ].filter((part): part is string => Boolean(part));
    // Typesense takes one filter string, so the native filter and the record rules each sit in their
    // own parentheses, joined by &&.  That holds only while the native filter keeps its groups and
    // backtick-quoted values to itself.  Its tokenizer toggles on every backtick and never refuses
    // an unclosed one, so an open backtick would swallow the rules into one value, and a group
    // closed early would end the one they sit in.  Either would exempt documents from the rules,
    // which is why such a filter is refused at the top of this read and when a table is saved.
    const filterBy = parts.map((part) => `(${part})`).join(' && ');
    if (kind === 'typesense' && request.order?.length) {
      if (request.order.some((order) => order.column === 'id'))
        throw new ConnectorError('sources.live.unsupported');
      const schema = record(await http.json(`/collections/${name}`));
      const sortable = new Set(
        records(schema.fields)
          .filter(typesenseSortable)
          .map((field) => nameOf(field.name)),
      );
      if (request.order.some((order) => !sortable.has(order.column)))
        throw new ConnectorError('sources.live.unsupported');
    }
    while (read < maximum) {
      const count = Math.min(size, 250, maximum - read);
      let rows: Row[];
      let total: number | undefined;
      if (kind === 'meilisearch') {
        const live = Boolean(request.order?.length);
        const page = record(
          await http.json(`/indexes/${name}/${live ? 'search' : 'documents/fetch'}`, {
            offset: read,
            limit: count,
            // Meilisearch binds AND tighter than OR, so parentheses don't keep an admin's filter
            // text inside them: `a) OR (b` would close the group the record rules sit in and
            // exempt rows from them.  An array is ANDed with each string parsed on its own.
            ...(parts.length ? { filter: parts } : {}),
            ...(live ? { q: '', sort: request.order!.map((s) => `${s.column}:${s.direction}`) } : {}),
          }),
        );
        rows = records(live ? page.hits : page.results);
        total = typeof page.total === 'number' ? page.total : undefined;
        if (live && rows.length < count && Number(page.estimatedTotalHits) >= read + rows.length) {
          const settings = record(await http.json(`/indexes/${name}/settings/pagination`));
          if (read + rows.length >= Number(settings.maxTotalHits))
            throw new ConnectorError('sources.engines.searchLimit');
        }
      } else {
        const params = new URLSearchParams({
          q: '*',
          per_page: String(count),
          offset: String(read),
          ...(filterBy ? { filter_by: filterBy } : {}),
          ...(request.order?.length
            ? { sort_by: request.order.map((s) => `${s.column}:${s.direction}`).join(',') }
            : {}),
        });
        const page = record(await http.json(`/collections/${name}/documents/search?${params}`));
        if (page.search_cutoff === true) throw new ConnectorError('sources.engines.partial');
        rows = records(page.hits).map((hit) => record(hit.document));
        total = typeof page.found === 'number' ? page.found : undefined;
      }
      read += rows.length;
      if (rows.length) yield rows;
      if (rows.length < count) {
        if (total !== undefined && read < total) throw new ConnectorError('sources.engines.paging');
        return;
      }
    }
  }
}

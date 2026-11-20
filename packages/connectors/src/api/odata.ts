import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { RestConnection, RestEndpoint, type SourceColumn, type SourceSelect } from '@riosoma/contracts';
import { createRestConnector, endpointUrl, type RestConnectorOptions } from '../rest/connector.js';
import { isRecordObject, Leaf, parseJson } from '../rest/records.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';

export interface ODataEntity {
  name: string;
  columns: SourceColumn[];
  keys: string[];
}
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function odataName(name: string): string {
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new ConnectorError('sources.odata.metadata');
  return name;
}

export function parseMetadata(xml: string): ODataEntity[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new ConnectorError('sources.odata.metadata');
  const document = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
  }).parse(xml);
  const schemas = array<Record<string, unknown>>(document?.Edmx?.DataServices?.Schema);
  if (!schemas.length) throw new ConnectorError('sources.odata.metadata');
  const types = new Map<string, Record<string, unknown>>();
  const aliases = new Map<string, string>();
  for (const schema of schemas) {
    if (typeof schema['@_Alias'] === 'string') aliases.set(schema['@_Alias'], String(schema['@_Namespace']));
    for (const type of array<Record<string, unknown>>(schema.EntityType as Record<string, unknown>[]))
      types.set(`${schema['@_Namespace']}.${type['@_Name']}`, type);
  }
  const qualified = (name: string) => {
    const at = name.lastIndexOf('.');
    return `${aliases.get(name.slice(0, at)) ?? name.slice(0, at)}.${name.slice(at + 1)}`;
  };
  const describe = (name: string, seen = new Set<string>()): { columns: SourceColumn[]; keys: string[] } => {
    name = qualified(name);
    if (seen.has(name) || seen.size > 20) throw new ConnectorError('sources.odata.metadata');
    seen.add(name);
    const type = types.get(name);
    if (!type) throw new ConnectorError('sources.odata.metadata');
    const inherited =
      typeof type['@_BaseType'] === 'string' ? describe(type['@_BaseType'], seen) : { columns: [], keys: [] };
    const columns = [...inherited.columns];
    for (const prop of array<Record<string, unknown>>(type.Property as Record<string, unknown>[])) {
      const sourceType = String(prop['@_Type'] ?? 'Edm.String');
      const suggested =
        sourceType === 'Edm.Boolean'
          ? 'checkbox'
          : /^Edm\.(Byte|SByte|Int16|Int32|Single|Double)$/.test(sourceType)
            ? 'number'
            : /^Edm\.(Date|DateTimeOffset)$/.test(sourceType)
              ? 'date'
              : /^Edm\.(String|Guid|Int64|Decimal|TimeOfDay|Duration)$/.test(sourceType)
                ? 'text'
                : null;
      columns.push({
        name: odataName(String(prop['@_Name'])),
        sourceType,
        nullable: prop['@_Nullable'] !== 'false',
        suggested: suggested
          ? { type: suggested, options: sourceType === 'Edm.DateTimeOffset' ? { includeTime: true } : {} }
          : null,
        alternatives: /^Edm\.(Int64|Decimal)$/.test(sourceType) ? ['number'] : [],
      });
    }
    const key = type.Key as Record<string, unknown> | undefined;
    const keys = key
      ? array<Record<string, unknown>>(key.PropertyRef as Record<string, unknown>[]).map((entry) =>
          odataName(String(entry['@_Name'])),
        )
      : inherited.keys;
    return { columns, keys };
  };
  const entities: ODataEntity[] = [];
  for (const schema of schemas)
    for (const container of array<Record<string, unknown>>(
      schema.EntityContainer as Record<string, unknown>[],
    ))
      for (const set of array<Record<string, unknown>>(container.EntitySet as Record<string, unknown>[]))
        entities.push({ name: odataName(String(set['@_Name'])), ...describe(String(set['@_EntityType'])) });
  return entities;
}

export interface ODataQuery {
  filter?: string;
  order?: readonly string[];
  columns?: readonly string[];
  top: number;
}
export interface ODataConnector extends Connector {
  query(
    ctx: ConnectorContext,
    select: SourceSelect,
    query: ODataQuery,
  ): Promise<Array<Record<string, unknown>>>;
}

export function createODataConnector(options: RestConnectorOptions = {}): ODataConnector {
  const xml = createRestConnector({ ...options, accept: 'application/xml' });
  const reader = (columns: readonly SourceColumn[] = []) =>
    createRestConnector({
      ...options,
      accept: 'application/json;IEEE754Compatible=true',
      document(_ctx, _url, value) {
        if (!isRecordObject(value) || !Array.isArray(value.value))
          throw new ConnectorError('sources.rest.records');
        if (value['@odata.nextLink'] != null && typeof value['@odata.nextLink'] !== 'string')
          throw new ConnectorError('sources.rest.records');
        if (!value.value.length && value['@odata.nextLink'])
          throw new ConnectorError('sources.rest.pagingLoop');
        const rows = value.value.map((record) => {
          if (!isRecordObject(record)) throw new ConnectorError('sources.rest.records');
          const typed = { ...record };
          for (const column of columns) {
            const cell = record[column.name];
            if (cell === undefined || cell === null) continue;
            const text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
            if (column.sourceType === 'Edm.Decimal' || column.sourceType === 'Edm.Int64')
              typed[column.name] = new Leaf(
                text,
                column.sourceType === 'Edm.Decimal' ? 'decimal' : 'long',
                cell,
                text,
              );
            else if (column.sourceType === 'Edm.String' || column.sourceType === 'Edm.Guid')
              typed[column.name] = new Leaf(text, 'uuid', cell, text);
            else if (column.sourceType === 'Edm.Date' || column.sourceType === 'Edm.DateTimeOffset')
              typed[column.name] = new Leaf({ date: text }, 'date', cell, text);
          }
          return typed;
        });
        return { ...value, value: rows, next: value['@odata.nextLink'] };
      },
    });
  const rest = reader();
  function context(
    ctx: ConnectorContext,
    name = '$metadata',
  ): ConnectorContext & { connection: RestConnection } {
    if (ctx.connection.kind !== 'odata') throw new ConnectorError('sources.kindUnavailable');
    return {
      ...ctx,
      connection: RestConnection.parse({
        ...ctx.connection,
        kind: 'rest',
        endpoints: [
          RestEndpoint.parse({
            name,
            path: name,
            records: 'value',
            paging: { style: 'next-url', nextPath: 'next' },
          }),
        ],
      }),
    };
  }
  const metadata = async (ctx: ConnectorContext) => {
    const mapped = context(ctx);
    const url = endpointUrl(mapped.connection.baseUrl, { path: '$metadata', query: [] });
    return parseMetadata((await xml.request(mapped, url)).toString('utf8'));
  };
  const entity = async (ctx: ConnectorContext, select: SourceSelect) => {
    if (select.kind !== 'object') throw new ConnectorError('sources.rest.noQueries');
    const found = (await metadata(ctx)).find((entry) => entry.name === select.object.name);
    if (!found)
      throw new ConnectorError('sources.sync.objectMissing', undefined, { object: select.object.name });
    return found;
  };
  return {
    kind: 'odata',
    async test(ctx) {
      try {
        const first = (await metadata(ctx))[0];
        if (!first) throw new ConnectorError('sources.odata.metadata');
        return rest.test(context(ctx, first.name));
      } catch (error) {
        return {
          ok: false,
          steps: [
            {
              step: 'entities',
              status: 'failed',
              ms: 0,
              messageKey:
                error instanceof ConnectorError
                  ? error.params?.reason === 'timeout'
                    ? 'sources.test.timeout'
                    : error.messageKey
                  : 'sources.odata.metadata',
            },
          ],
        };
      }
    },
    async listObjects(ctx) {
      return (await metadata(ctx)).map((entry) => ({
        schema: null,
        name: entry.name,
        type: 'table',
        rowEstimate: null,
      }));
    },
    async describe(ctx, select) {
      return (await entity(ctx, select)).columns;
    },
    async keyCandidates(ctx, object) {
      const found = await entity(ctx, { kind: 'object', object });
      return found.keys.length ? [found.keys] : [];
    },
    async preview(ctx, select, limit) {
      const found = await entity(ctx, select);
      const preview = await reader(found.columns).preview(context(ctx, found.name), select, limit);
      const byName = new Map(preview.columns.map((column, index) => [column.name, index]));
      return {
        ...preview,
        columns: found.columns,
        rows: preview.rows.map((row) =>
          found.columns.map((column) => row[byName.get(column.name) ?? -1] ?? null),
        ),
      };
    },
    async *read(ctx, select, readOptions) {
      const found = await entity(ctx, select);
      yield* reader(found.columns).read(context(ctx, found.name), select, readOptions);
    },
    async query(ctx, select, query) {
      const deadline = AbortSignal.timeout(ctx.timeoutMs ?? 30_000);
      ctx = { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline };
      const found = await entity(ctx, select);
      const mapped = context(ctx, found.name);
      const wanted = query.columns ?? found.columns.map((column) => column.name);
      for (const name of wanted)
        if (!found.columns.some((column) => column.name === name))
          throw new ConnectorError('sources.sync.columnMissing', undefined, { column: name });
      if (!Number.isSafeInteger(query.top) || query.top < 1 || query.top > 1_000_001)
        throw new ConnectorError('sources.sync.read');
      let url: URL | null = endpointUrl(mapped.connection.baseUrl, { path: found.name, query: [] });
      url.searchParams.set('$select', wanted.map(odataName).join(','));
      url.searchParams.set('$top', String(query.top));
      if (query.filter) url.searchParams.set('$filter', query.filter);
      if (query.order?.length) url.searchParams.set('$orderby', query.order.join(','));
      const seen = new Set<string>();
      const rows: Array<Record<string, unknown>> = [];
      while (url && rows.length < query.top) {
        if (seen.has(url.href) || seen.size >= 10_000) throw new ConnectorError('sources.rest.pagingLoop');
        seen.add(url.href);
        const document = parseJson((await rest.request(mapped, url)).toString('utf8'));
        if (
          !isRecordObject(document) ||
          !Array.isArray(document.value) ||
          !document.value.every(isRecordObject)
        )
          throw new ConnectorError('sources.rest.records');
        rows.push(...document.value.slice(0, query.top - rows.length));
        const next: unknown = document['@odata.nextLink'];
        if (next != null && typeof next !== 'string') throw new ConnectorError('sources.rest.records');
        if (next && !document.value.length) throw new ConnectorError('sources.rest.pagingLoop');
        url = typeof next === 'string' && next ? new URL(next, url) : null;
        if (url && (url.origin !== new URL(mapped.connection.baseUrl).origin || url.username || url.password))
          throw new ConnectorError('sources.rest.nextElsewhere');
      }
      return rows;
    },
  };
}

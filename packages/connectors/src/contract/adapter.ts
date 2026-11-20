import type { SourceColumn, SourceSelect } from '@riosoma/contracts';
import type { Connector, ConnectorContext, ReadOptions, SourceRow } from '../types.js';
import type { ODataConnector } from '../api/odata.js';
import { declaredCapabilities } from './capabilities.js';
import { ContractViolation, invariant } from './assertions.js';
import type { ConnectorContract, PushdownProbe } from './kit.js';

export interface ContractAdapterInput {
  connector: Connector;
  context: ConnectorContext;
  select: Extract<SourceSelect, { kind: 'object' }>;
  columns: SourceColumn[];
  keys: string[][];
  read: ReadOptions;
  expectedRows: SourceRow[];
  requests(): readonly string[];
  failure: ConnectorContract['failure'];
  timeout?: ConnectorContract['timeout'];
  stopped?: ConnectorContract['stopped'];
}

/** Builds capability probes from a fixture's independently checked projection and transport trace */
export function contractAdapter(input: ContractAdapterInput): ConnectorContract {
  const { connector, context, select, columns, keys, read, expectedRows } = input;
  const caps = declaredCapabilities(connector.kind);
  const kind = connector.kind;
  const quote = (name: string) =>
    kind === 'mysql' || kind === 'bigquery' || kind === 'databricks'
      ? '`' + name.replaceAll('`', '``') + '`'
      : kind === 'sqlserver'
        ? '[' + name.replaceAll(']', ']]') + ']'
        : '"' + name.replaceAll('"', '""') + '"';
  const table = [select.object.schema, select.object.name]
    .filter((name): name is string => name !== null)
    .map(quote)
    .join('.');
  const field =
    read.columns.find(
      (name) =>
        expectedRows.some(
          (row) => typeof row.values[name] === 'number' || typeof row.values[name] === 'string',
        ) && new Set(expectedRows.map((row) => row.values[name])).size > 1,
    ) ?? read.keyColumns[0];
  const chosen = expectedRows[1]?.values[field ?? ''];
  const literal = typeof chosen === 'number' ? String(chosen) : `'${String(chosen).replaceAll("'", "''")}'`;
  const ascending = [...expectedRows].sort((a, b) => {
    const left = a.values[field!]!;
    const right = b.values[field!]!;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const filtered = expectedRows.filter((row) => row.values[field!] === chosen);
  const values = (rows: SourceRow[]) => rows.map((row) => row.values);
  const requests = () =>
    input.requests().map((request) => {
      try {
        return decodeURIComponent(request);
      } catch {
        return request;
      }
    });
  const preview = async (ctx: ConnectorContext, selected: SourceSelect) => {
    const result = await connector.preview(ctx, selected, expectedRows.length + 1);
    return result.rows.map((row) =>
      Object.fromEntries(
        read.columns.map((name) => [
          name,
          row[result.columns.findIndex((column) => column.name === name)] ?? null,
        ]),
      ),
    );
  };
  function probe(sort: boolean): PushdownProbe {
    invariant(field && (typeof chosen === 'number' || typeof chosen === 'string'), 'pushdown.fixture');
    const partition = expectedRows[0]?.values[read.keyColumns[0] ?? ''];
    const partitionValue =
      typeof partition === 'string' || typeof partition === 'number' || typeof partition === 'boolean'
        ? partition
        : null;
    const expected = sort ? [...ascending].reverse() : filtered;
    const probeColumns = [...new Set([field, ...read.keyColumns])];
    const projected = (rows: Record<string, unknown>[]) =>
      rows.map((row) => Object.fromEntries(probeColumns.map((name) => [name, row[name] ?? null])));
    const markers: Partial<Record<Connector['kind'], [string, string]>> = {
      dynamodb: ['FilterExpression', 'ScanIndexForward'],
      couchdb: ['selector', 'sort'],
      couchbase: ['WHERE', 'ORDER BY'],
      cosmosdb: ['WHERE', 'ORDER BY'],
      firestore: ['fieldFilter', 'orderBy'],
      elasticsearch: ['query', 'sort'],
      opensearch: ['query', 'sort'],
      meilisearch: ['filter', 'sort'],
      typesense: ['filter_by', 'sort_by'],
      neo4j: ['WHERE', 'ORDER BY'],
      influxdb: ['WHERE', 'ORDER BY'],
    };
    const fragments =
      kind === 'dynamodb' && sort
        ? ['ScanIndexForward', 'false']
        : caps.query === 'sql'
          ? [sort ? 'ORDER BY' : 'WHERE', field, sort ? 'DESC' : String(chosen)]
          : kind === 'odata'
            ? [sort ? '$orderby' : '$filter', `${field} ${sort ? 'desc' : `eq ${literal}`}`]
            : [
                markers[kind]?.[sort ? 1 : 0] ?? field,
                field,
                sort
                  ? kind === 'firestore'
                    ? 'DESCENDING'
                    : ['couchbase', 'cosmosdb', 'neo4j', 'influxdb'].includes(kind)
                      ? 'DESC'
                      : 'desc'
                  : String(chosen),
              ];
    return {
      expectedRows: projected(values(expected)),
      requestIncludes: fragments,
      async run(ctx) {
        const before = requests().length;
        let result: unknown[];
        if (caps.query === 'sql') {
          result = await preview(ctx, {
            kind: 'query',
            sql: `SELECT * FROM ${table} ${
              sort ? `ORDER BY ${quote(field!)} DESC` : `WHERE ${quote(field!)} = ${literal}`
            }`,
          });
        } else if (kind === 'odata') {
          result = await (connector as ODataConnector).query(ctx, select, {
            top: expectedRows.length + 1,
            columns: read.columns,
            ...(sort ? { order: [`${field} desc`] } : { filter: `${field} eq ${literal}` }),
          });
        } else if (connector.documentQuery) {
          result = values(
            await connector.documentQuery(ctx, select, {
              ...read,
              limit: expectedRows.length + 1,
              predicate: sort
                ? kind === 'dynamodb' && read.keyColumns.length > 1
                  ? { op: 'eq', field: read.keyColumns[0]!, value: partitionValue }
                  : { op: 'and', terms: [] }
                : {
                    op: 'eq',
                    field: field!,
                    value: chosen,
                    ...(typeof chosen === 'number' ? { numeric: true } : {}),
                  },
              order: sort ? [{ field: field!, direction: 'desc' }] : [],
            }),
          );
        } else if (connector.search) {
          const raw: Record<string, unknown>[] = [];
          for await (const batch of connector.search(ctx, select, {
            where: sort ? { op: 'true' } : { op: 'eq', column: field!, value: chosen },
            order: sort ? [{ column: field!, direction: 'desc' }] : [],
            limit: expectedRows.length + 1,
          }))
            raw.push(...batch);
          result = raw.map((row) =>
            Object.fromEntries(read.columns.map((name) => [name, row[name] ?? null])),
          );
        } else if (kind === 'mongodb') {
          result = await preview(ctx, { ...select, filter: JSON.stringify({ [field!]: chosen }) });
        } else if (kind === 'neo4j') {
          result = await preview(ctx, {
            kind: 'query',
            sql: `MATCH (n:\`${select.object.name.replaceAll('`', '``')}\`) ${
              sort ? '' : `WHERE n.\`${field}\` = ${literal} `
            }RETURN ${read.columns
              .map((name) => (name === '_id' ? 'elementId(n) AS _id' : `n.\`${name}\` AS \`${name}\``))
              .join(', ')}${sort ? ` ORDER BY \`${field}\` DESC` : ''}`,
          });
        } else if (kind === 'influxdb') {
          result = await preview(ctx, {
            kind: 'query',
            sql: `SELECT * FROM ${table} ${
              sort ? `ORDER BY ${quote(field!)} DESC` : `WHERE ${quote(field!)} = ${literal}`
            }`,
          });
        } else {
          throw new ContractViolation('pushdown.unavailable');
        }
        return { rows: projected(result as Record<string, unknown>[]), requests: requests().slice(before) };
      },
    };
  }
  const multipleStatements =
    kind === 'neo4j'
      ? 'RETURN 1; RETURN 2'
      : caps.query === 'graphql'
        ? 'query First { items { id } } query Second { items { id } }'
        : 'SELECT 1; SELECT 2';
  return {
    connector,
    context,
    select,
    keys,
    read,
    expectedRows,
    types: Object.fromEntries(
      columns
        .filter((column) => read.columns.includes(column.name))
        .map((column) => [column.name, column.suggested]),
    ),
    executions: () =>
      requests().filter(
        (request) =>
          request.includes(multipleStatements) ||
          (caps.query === 'graphql'
            ? /query\s+(?:First|Second)\b/.test(request)
            : caps.query === 'native' && kind === 'neo4j'
              ? /RETURN\s+[12](?=\s*(?:;|['"\n)}]|$))/.test(request)
              : /SELECT\s+[12](?=\s*(?:;|['"\n)}]|$))/.test(request)),
      ),
    multipleStatements,
    ...(caps.filter ? { filter: probe(false) } : {}),
    ...(caps.sort ? { sort: probe(true) } : {}),
    failure: input.failure,
    timeout: input.timeout,
    stopped: input.stopped,
  };
}

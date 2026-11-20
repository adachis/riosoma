import { RestConnection, RestEndpoint, type GraphQlConnection, type SourceColumn } from '@riosoma/contracts';
import { createRestConnector, type RestConnectorOptions } from '../rest/connector.js';
import { isRecordObject, parseJson, valueAt } from '../rest/records.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';

/** Reject write operations before a query can leave the server, ignoring comments and string contents */
export function readOnlyGraphQuery(query: string): boolean {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < query.length) {
    const rest = query.slice(offset);
    const ignored = /^(?:[\s,\uFEFF]+|#[^\r\n]*)/.exec(rest);
    if (ignored) {
      offset += ignored[0].length;
      continue;
    }
    if (rest.startsWith('"""')) {
      let end = offset + 3;
      while (end < query.length && (query.slice(end, end + 3) !== '"""' || query[end - 1] === '\\')) end++;
      if (end >= query.length) return false;
      offset = end + 3;
      continue;
    }
    if (rest[0] === '"') {
      const string = /^"(?:[^"\\\r\n]|\\.)*"/.exec(rest);
      if (!string) return false;
      offset += string[0].length;
      continue;
    }
    const token = /^(?:[_A-Za-z][_0-9A-Za-z]*|[!$():=@[\]{|}]|\.\.\.|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      rest,
    );
    if (!token) return false;
    tokens.push(token[0]);
    offset += token[0].length;
  }
  let depth = 0;
  let parentheses = 0;
  let operations = 0;
  let start = true;
  for (const token of tokens) {
    if (depth === 0 && parentheses === 0 && start) {
      if (!['query', 'fragment', '{'].includes(token)) return false;
      if (token !== 'fragment') operations++;
      start = false;
    }
    if (token === '(') parentheses++;
    if (token === ')') parentheses--;
    if (parentheses < 0) return false;
    if (parentheses > 0) continue;
    if (token === '{') depth++;
    if (token === '}') {
      depth--;
      if (depth === 0) start = true;
    }
    if (depth < 0) return false;
  }
  return depth === 0 && parentheses === 0 && operations === 1;
}

const INTROSPECTION =
  'query { __schema { types { name fields { name type { kind name ofType { kind name ofType { kind name } } } } } } }';

export interface GraphQlConnector extends Connector {
  suggest(ctx: ConnectorContext): Promise<SourceColumn[]>;
}

/** A related connection is completed independently to keep the parent query's complexity bounded. */
export interface GraphQlNestedConnection {
  path: string;
  parentKey: string;
  parentVariable: string;
  query: string;
  variables?: Record<string, unknown>;
  connection: string;
  cursorVariable: string;
}

export interface GraphQlConnectorOptions extends RestConnectorOptions {
  nestedConnections?: readonly GraphQlNestedConnection[];
}

function graphError(document: unknown): ConnectorError | undefined {
  if (!isRecordObject(document) || !Array.isArray(document.errors) || !document.errors.length) return;
  const errors = document.errors.filter(isRecordObject);
  const limited = errors.some((error) => valueAt(error, 'extensions.code') === 'RATELIMITED');
  return new ConnectorError(limited ? 'sources.rest.rateLimited' : 'sources.graphql.errors');
}

function cursorOf(nodes: unknown[], info: unknown): string | null {
  if (!isRecordObject(info) || typeof info.hasNextPage !== 'boolean')
    throw new ConnectorError('sources.graphql.pageInfo');
  if (!info.hasNextPage) return null;
  if (!nodes.length) throw new ConnectorError('sources.rest.pagingLoop');
  if (typeof info.endCursor !== 'string' || !info.endCursor)
    throw new ConnectorError('sources.graphql.pageInfo');
  return info.endCursor;
}

export function createGraphQlConnector(options: GraphQlConnectorOptions = {}): GraphQlConnector {
  function setup(ctx: ConnectorContext, introspection = false) {
    if (ctx.connection.kind !== 'graphql') throw new ConnectorError('sources.kindUnavailable');
    const config: GraphQlConnection = ctx.connection;
    if (
      !readOnlyGraphQuery(config.query) ||
      options.nestedConnections?.some((nested) => !readOnlyGraphQuery(nested.query))
    )
      throw new ConnectorError('sources.graphql.queryOnly');
    const paging = config.paging;
    const endpoint = RestEndpoint.parse({
      name: 'query',
      records: 'rows',
      maxPages: config.maxPages,
      paging:
        paging.style === 'none' ? { style: 'none' } : { style: 'cursor', cursorPath: 'next', param: 'page' },
    });
    const context = {
      ...ctx,
      connection: RestConnection.parse({
        kind: 'rest',
        baseUrl: config.baseUrl,
        auth: config.auth,
        endpoints: [endpoint],
        requestsPerSecond: config.requestsPerSecond,
      }),
    };
    const connector = createRestConnector({
      ...options,
      responseError(ctx, status, body, hidden, canRenewToken, headers) {
        // App permissions take precedence, including on additional connection pages.
        const error = options.responseError?.(ctx, status, body, hidden, canRenewToken, headers);
        if (error) return error;
        // Sign-in refusals keep the transport's advice for the configured credential.
        if (status === 401 || status === 403) return;
        // Throttling and temporary outages use the transport's bounded retries.
        if (status === 429 || status === 503) return;
        let document: unknown;
        try {
          document = parseJson(body.toString('utf8').replace(/^\uFEFF/, ''));
        } catch {
          return;
        }
        return graphError(document);
      },
      queryBody(_ctx, url) {
        const variables = { ...config.variables };
        if (paging.style !== 'none') {
          const page = url.searchParams.get('page');
          if (paging.style === 'cursor' && page !== null) variables[paging.variable] = page;
          if (paging.style === 'offset') {
            const offset = Number(page ?? config.variables[paging.variable] ?? 0);
            if (!Number.isSafeInteger(offset) || offset < 0)
              throw new ConnectorError('sources.rest.pagingLoop');
            variables[paging.variable] = offset;
            variables[paging.sizeVariable] = paging.size;
          }
        }
        return JSON.stringify({
          query: introspection ? INTROSPECTION : config.query,
          variables: introspection ? {} : variables,
        });
      },
      async document(_ctx, url, document, request) {
        if (options.document) document = await options.document(_ctx, url, document, request);
        if (!isRecordObject(document)) throw new ConnectorError('sources.graphql.errors');
        const error = graphError(document);
        if (error) throw error;
        const rows = valueAt(document, config.records);
        if (!Array.isArray(rows)) throw new ConnectorError('sources.rest.records');
        for (const row of rows) {
          for (const nested of options.nestedConnections ?? []) {
            const initial = valueAt(row, nested.path);
            if (!isRecordObject(initial) || !Array.isArray(initial.nodes))
              throw new ConnectorError('sources.rest.records');
            const nodes = [...initial.nodes];
            let cursor = cursorOf(nodes, initial.pageInfo);
            const seen = new Set<string>();
            let pages = 1;
            while (cursor !== null) {
              if (seen.has(cursor)) throw new ConnectorError('sources.rest.pagingLoop');
              if (pages >= config.maxPages)
                throw new ConnectorError('sources.rest.pageLimit', undefined, { pages: config.maxPages });
              seen.add(cursor);
              const parent = valueAt(row, nested.parentKey);
              if (typeof parent !== 'string' || !parent) throw new ConnectorError('sources.rest.records');
              const body = await request(
                new URL(config.baseUrl),
                JSON.stringify({
                  query: nested.query,
                  variables: {
                    ...nested.variables,
                    [nested.parentVariable]: parent,
                    [nested.cursorVariable]: cursor,
                  },
                }),
              );
              let next: unknown;
              try {
                next = parseJson(body.toString('utf8').replace(/^\uFEFF/, ''));
              } catch {
                throw new ConnectorError('sources.rest.notJson');
              }
              const error = graphError(next);
              if (error) throw error;
              const connection = valueAt(next, nested.connection);
              if (!isRecordObject(connection) || !Array.isArray(connection.nodes))
                throw new ConnectorError('sources.rest.records');
              if (nodes.length + connection.nodes.length > endpoint.maxRecords)
                throw new ConnectorError('sources.rest.recordLimit', undefined, {
                  records: endpoint.maxRecords,
                });
              nodes.push(...connection.nodes);
              pages++;
              cursor = cursorOf(connection.nodes, connection.pageInfo);
            }
            initial.nodes = nodes;
          }
        }
        let next: string | null = null;
        if (paging.style !== 'none') {
          const info = valueAt(document, paging.pageInfo);
          if (!isRecordObject(info) || typeof info.hasNextPage !== 'boolean')
            throw new ConnectorError('sources.graphql.pageInfo');
          if (info.hasNextPage) {
            if (!rows.length) throw new ConnectorError('sources.rest.pagingLoop');
            if (paging.style === 'cursor') {
              if (typeof info.endCursor !== 'string' || !info.endCursor)
                throw new ConnectorError('sources.graphql.pageInfo');
              next = info.endCursor;
            } else
              next = String(
                Number(url.searchParams.get('page') ?? config.variables[paging.variable] ?? 0) + rows.length,
              );
          }
        }
        return { rows, next };
      },
    });
    return { connector, context };
  }
  return {
    kind: 'graphql',
    async test(ctx) {
      try {
        const { connector, context } = setup(ctx);
        return await connector.test(context);
      } catch (error) {
        return {
          ok: false,
          steps: [
            {
              step: 'query',
              status: 'failed',
              ms: 0,
              messageKey: error instanceof ConnectorError ? error.messageKey : 'sources.test.query',
            },
          ],
        };
      }
    },
    async listObjects(ctx) {
      setup(ctx);
      return [{ schema: null, name: 'query', type: 'endpoint', rowEstimate: null }];
    },
    async describe(ctx, select) {
      const { connector, context } = setup(ctx);
      return connector.describe(context, select);
    },
    async preview(ctx, select, limit) {
      const { connector, context } = setup(ctx);
      return connector.preview(context, select, limit);
    },
    async keyCandidates(ctx, object) {
      const { connector, context } = setup(ctx);
      return connector.keyCandidates(context, object);
    },
    async *read(ctx, select, readOptions) {
      const { connector, context } = setup(ctx);
      yield* connector.read(context, select, readOptions);
    },
    async suggest(ctx) {
      const { connector, context } = setup(ctx, true);
      const body = await connector.request(context, new URL(context.connection.baseUrl));
      const document: unknown = JSON.parse(body.toString('utf8'));
      const types = valueAt(document, 'data.__schema.types');
      if (!Array.isArray(types)) throw new ConnectorError('sources.graphql.introspection');
      const columns: SourceColumn[] = [];
      for (const type of types) {
        if (
          !isRecordObject(type) ||
          typeof type.name !== 'string' ||
          type.name.startsWith('__') ||
          !Array.isArray(type.fields)
        )
          continue;
        for (const field of type.fields) {
          if (!isRecordObject(field) || typeof field.name !== 'string' || !isRecordObject(field.type))
            continue;
          let scalar = field.type;
          while (isRecordObject(scalar.ofType)) scalar = scalar.ofType;
          const sourceType = String(scalar.name ?? '');
          const suggested =
            sourceType === 'Boolean' ? 'checkbox' : ['Int', 'Float'].includes(sourceType) ? 'number' : 'text';
          columns.push({
            name: `${type.name}.${field.name}`,
            sourceType,
            nullable: field.type.kind !== 'NON_NULL',
            suggested: { type: suggested, options: {} },
            alternatives: [],
          });
          if (columns.length >= 500) return columns;
        }
      }
      return columns;
    },
  };
}

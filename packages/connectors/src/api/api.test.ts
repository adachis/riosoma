import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SourceConnection, type GraphQlConnection, type SourceSelect } from '@riosoma/contracts';
import { createGraphQlConnector, readOnlyGraphQuery } from './graphql.js';
import { createODataConnector, parseMetadata } from './odata.js';
import type { FileNetwork, FileRequest } from '../files/network.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { planOData, odataRuleTranslates, odataText, odataLiteral } from '../live/odata.js';
import { exerciseFixture } from '../contract/fixture.js';

const baseUrl = 'https://192.0.2.1/service';
const object = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });
const sockets = { connect: async () => {}, handshake: async () => {} };
function network(
  handler: (request: FileRequest) => unknown,
  status = 200,
  headers: Record<string, string> = {},
): FileNetwork {
  return {
    allowsAddress: () => true,
    check: async () => ({ address: '192.0.2.1', family: 4 }),
    request: vi.fn(async (request) => {
      const value = handler(request);
      return {
        url: request.url,
        status,
        headers,
        close() {},
        body: (async function* () {
          yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
        })(),
      };
    }),
  };
}
function graph(patch: Partial<GraphQlConnection> = {}): ConnectorContext {
  return {
    connection: SourceConnection.parse({
      kind: 'graphql',
      baseUrl,
      query:
        'query($after: String) { items(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }',
      records: 'data.items.nodes',
      paging: { style: 'cursor', pageInfo: 'data.items.pageInfo', variable: 'after' },
      requestsPerSecond: 100,
      ...patch,
    }),
    secrets: {},
  };
}
async function rows(stream: AsyncIterable<SourceRow[]>): Promise<SourceRow[]> {
  const result: SourceRow[] = [];
  for await (const batch of stream) result.push(...batch);
  return result;
}
const read = { columns: ['id'], keyColumns: ['id'], types: { id: 'number' } };

describe('GraphQL queries', () => {
  it('rejects writes and multiple operations while accepting comments, strings, and object defaults', () => {
    expect(readOnlyGraphQuery('mutation { remove }')).toBe(false);
    expect(readOnlyGraphQuery('query { id } mutation { remove }')).toBe(false);
    expect(readOnlyGraphQuery('subscription { changes }')).toBe(false);
    expect(readOnlyGraphQuery('query A { id } query B { id }')).toBe(false);
    expect(
      readOnlyGraphQuery('query Q($filter: Filter = { name: "mutation" }) { items(filter: $filter) { id } }'),
    ).toBe(true);
    expect(readOnlyGraphQuery('# mutation\n{ items(name: "subscription") { id } }')).toBe(true);
    expect(readOnlyGraphQuery('fragment Fields on Item { id } query { items { ...Fields } }')).toBe(true);
  });
  it('sends variables and follows pageInfo cursors with sealed header authentication', async () => {
    const secret = randomBytes(20).toString('hex');
    const seen: unknown[] = [];
    const net = network((request) => {
      expect(request.method).toBe('POST');
      expect(request.headers['X-Key']).toBe(secret);
      const body = JSON.parse(request.body!);
      seen.push(body.variables);
      const second = body.variables.after === 'next';
      return {
        data: {
          items: {
            nodes: [{ id: second ? 2 : 1 }],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next' },
          },
        },
      };
    });
    const connector = createGraphQlConnector({ network: net, sockets });
    const ctx = graph({ auth: { method: 'header', name: 'X-Key' }, variables: { first: 1 } });
    ctx.secrets = { apiKey: secret };
    expect((await rows(connector.read(ctx, object('query'), read))).map((row) => row.values.id)).toEqual([
      1, 2,
    ]);
    expect(seen).toEqual([{ first: 1 }, { first: 1, after: 'next' }]);
    expect((await connector.test(ctx)).ok).toBe(true);
  });
  it('advances offsets and refuses partial GraphQL errors and repeating cursors', async () => {
    const ctx = graph({
      paging: {
        style: 'offset',
        pageInfo: 'data.items.pageInfo',
        variable: 'offset',
        sizeVariable: 'limit',
        size: 1,
      },
    });
    const net = network((request) => {
      const variables = JSON.parse(request.body!).variables;
      expect(variables.limit).toBe(1);
      return {
        data: {
          items: { nodes: [{ id: variables.offset + 1 }], pageInfo: { hasNextPage: variables.offset === 0 } },
        },
      };
    });
    expect(
      (await rows(createGraphQlConnector({ network: net }).read(ctx, object('query'), read))).map(
        (row) => row.values.id,
      ),
    ).toEqual([1, 2]);
    for (const document of [
      { errors: [{ message: 'partial' }], data: { items: { nodes: [{ id: 1 }] } } },
      { data: { items: { nodes: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'repeat' } } } },
    ]) {
      await expect(
        rows(
          createGraphQlConnector({ network: network(() => document) }).read(graph(), object('query'), read),
        ),
      ).rejects.toHaveProperty(
        'messageKey',
        document.errors ? 'sources.graphql.errors' : 'sources.rest.pagingLoop',
      );
    }
  });
  it('reads field suggestions from introspection', async () => {
    const connector = createGraphQlConnector({
      network: network((request) => {
        expect(JSON.parse(request.body!).query).toContain('__schema');
        return {
          data: {
            __schema: {
              types: [
                {
                  name: 'Item',
                  fields: [
                    { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
                  ],
                },
              ],
            },
          },
        };
      }),
    });
    expect(await connector.suggest(graph())).toMatchObject([
      { name: 'Item.id', nullable: false, suggested: { type: 'number' } },
    ]);
  });

  it('classifies HTTP 400 GraphQL errors without exposing service messages or retrying ordinary refusals', async () => {
    const secret = randomBytes(20).toString('hex');
    const net = network(() => ({ errors: [{ message: `Invalid field ${secret}` }] }), 400);
    const ctx = graph({ auth: { method: 'header', name: 'X-Key' } });
    ctx.secrets = { apiKey: secret };
    const error = await rows(createGraphQlConnector({ network: net }).read(ctx, object('query'), read)).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      messageKey: 'sources.graphql.errors',
    });
    expect(JSON.stringify(error).includes('Invalid field')).toBe(false);
    expect(JSON.stringify(error).includes(secret)).toBe(false);
    expect(net.request).toHaveBeenCalledTimes(1);
  });

  it('refuses a GraphQL retry wait beyond the transport bound', async () => {
    const net = network(() => ({ errors: [{ message: 'Wait', extensions: { code: 'RATELIMITED' } }] }), 400, {
      'retry-after': '60',
    });
    await expect(
      rows(createGraphQlConnector({ network: net, maxRetryWaitMs: 1 }).read(graph(), object('query'), read)),
    ).rejects.toHaveProperty('messageKey', 'sources.rest.rateLimited');
    expect(net.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, code: undefined },
    { status: 429, code: 'TEMPORARILY_UNAVAILABLE' },
    { status: 503, code: undefined },
    { status: 503, code: 'TEMPORARILY_UNAVAILABLE' },
  ])('retries HTTP $status GraphQL errors with code $code', async ({ status, code }) => {
    const net = network(() => ({
      data: { items: { nodes: [{ id: 1 }], pageInfo: { hasNextPage: false } } },
    }));
    vi.mocked(net.request).mockResolvedValueOnce({
      url: new URL(baseUrl),
      status,
      headers: { 'retry-after': '0' },
      close() {},
      body: (async function* () {
        yield Buffer.from(JSON.stringify({ errors: [{ extensions: { code } }] }));
      })(),
    });
    const connector = createGraphQlConnector({ network: net, retries: 1 });
    expect((await rows(connector.read(graph(), object('query'), read))).map((row) => row.values.id)).toEqual([
      1,
    ]);
    expect(net.request).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(net.request).mock.calls;
    expect(calls[1]![0].body).toBe(calls[0]![0].body);
  });
});

// A recorded OData v4 metadata shape keeps the sample service out of test execution
const metadata = `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Sample" Alias="S"><EntityType Name="Item"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Int32" Nullable="false"/><Property Name="name" Type="Edm.String"/><Property Name="amount" Type="Edm.Decimal"/></EntityType><EntityContainer Name="Default"><EntitySet Name="Items" EntityType="S.Item"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
const odataCtx: ConnectorContext = {
  connection: SourceConnection.parse({ kind: 'odata', baseUrl, requestsPerSecond: 100 }),
  secrets: {},
};

it('runs the shared fixture operations against GraphQL and OData', async () => {
  const graphConnector = createGraphQlConnector({
    sockets,
    network: network(() => ({
      data: { items: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }], pageInfo: { hasNextPage: false } } },
    })),
  });
  await exerciseFixture(
    graphConnector,
    graph(),
    { kind: 'object', object: { schema: null, name: 'query' } },
    ['id'],
    3,
  );
  const odataConnector = createODataConnector({
    sockets,
    network: network((request) =>
      request.url.pathname.endsWith('$metadata') ? metadata : { value: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ),
  });
  await exerciseFixture(
    odataConnector,
    odataCtx,
    { kind: 'object', object: { schema: null, name: 'Items' } },
    ['id'],
    3,
  );
});

describe('OData entities', () => {
  it('describes typed fields, aliases, and keys without rounding decimals', () => {
    expect(parseMetadata(metadata)).toMatchObject([
      {
        name: 'Items',
        keys: ['id'],
        columns: [
          { name: 'id', nullable: false, suggested: { type: 'number' } },
          { name: 'name', suggested: { type: 'text' } },
          { name: 'amount', suggested: { type: 'text' }, alternatives: ['number'] },
        ],
      },
    ]);
    expect(() => parseMetadata('<!DOCTYPE x [<!ENTITY e "x">]><x/>')).toThrow();
  });
  it('follows literal nextLink keys and requests XML metadata and exact JSON numbers', async () => {
    const net = network((request) => {
      if (request.url.pathname.endsWith('$metadata')) {
        expect(request.headers.accept).toBe('application/xml');
        return metadata;
      }
      expect(request.headers.accept).toContain('IEEE754Compatible=true');
      return request.url.searchParams.has('$skiptoken')
        ? { value: [{ id: 2 }] }
        : { value: [{ id: 1 }], '@odata.nextLink': 'Items?$skiptoken=2' };
    });
    const connector = createODataConnector({ network: net, sockets });
    expect((await rows(connector.read(odataCtx, object('Items'), read))).map((row) => row.values.id)).toEqual(
      [1, 2],
    );
    expect(await connector.keyCandidates(odataCtx, { schema: null, name: 'Items' })).toEqual([['id']]);
  });
  it('pushes down live options and refuses a next link on another origin', async () => {
    const net = network((request) => {
      if (request.url.pathname.endsWith('$metadata')) return metadata;
      expect(Object.fromEntries(request.url.searchParams)).toEqual({
        $select: 'id,name',
        $top: '2',
        $filter: 'id gt 0',
        $orderby: 'id desc',
      });
      return { value: [{ id: 2, name: 'Second' }], '@odata.nextLink': 'https://192.0.2.2/Items' };
    });
    await expect(
      createODataConnector({ network: net }).query(odataCtx, object('Items'), {
        columns: ['id', 'name'],
        top: 2,
        filter: 'id gt 0',
        order: ['id desc'],
      }),
    ).rejects.toHaveProperty('messageKey', 'sources.rest.nextElsewhere');
  });
  it('rejects live empty-page continuations and keeps fractional keys numeric', async () => {
    const net = network((request) =>
      request.url.pathname.endsWith('$metadata')
        ? metadata
        : { value: [], '@odata.nextLink': 'Items?$skiptoken=next' },
    );
    await expect(
      createODataConnector({ network: net }).query(odataCtx, object('Items'), { top: 2 }),
    ).rejects.toHaveProperty('messageKey', 'sources.rest.pagingLoop');
    expect(odataLiteral('1.5', 'Edm.Double')).toBe('1.5');
    expect(odataLiteral('1e-7', 'Edm.Single')).toBe('1e-7');
    expect(() => odataLiteral('1 or true', 'Edm.Double')).toThrow();
  });
  it('denies unsupported record rules and escapes filter values', () => {
    const fields = new Map([
      [
        'name',
        { id: 'name', type: 'text', options: {}, source: { column: 'name', sourceType: 'Edm.String' } },
      ],
    ]);
    const filter = {
      conjunction: 'and' as const,
      conditions: [{ id: 'name-filter', fieldId: 'name', operator: 'is' as const, value: "O'Brien" }],
    };
    const plan = planOData({
      fields,
      filter,
      rules: null,
      sorts: [],
      context: { now: new Date(), timeZone: 'UTC' },
    });
    expect(odataText(plan.where!)).toContain("'O''Brien'");
    const denied = {
      conjunction: 'and' as const,
      conditions: [{ id: 'local-filter', fieldId: 'local', operator: 'is' as const, value: 'secret' }],
    };
    expect(odataRuleTranslates(denied, fields)).toBe(false);
    expect(
      odataText(
        planOData({
          fields,
          filter: null,
          rules: [denied],
          sorts: [],
          context: { now: new Date(), timeZone: 'UTC' },
        }).where!,
      ),
    ).toContain('false');
  });
});

it('runs every declared OData contract against its metadata and native query fixture', async () => {
  const boundary = new FixtureBoundary();
  const data = [1, 2, 3].map((id) => ({ id, name: null, amount: null }));
  const net = network((request) => {
    if (request.url.pathname.endsWith('$metadata')) return metadata;
    const filter = request.url.searchParams.get('$filter');
    return {
      value: filter
        ? data.filter((row) => row.id === Number(filter.split(' ').at(-1)))
        : request.url.searchParams.has('$orderby')
          ? [...data].reverse()
          : data,
    };
  });
  await strictFixture(
    createODataConnector(boundary.wrap({ network: net, sockets })),
    odataCtx,
    { kind: 'object', object: { schema: null, name: 'Items' } },
    ['id'],
    3,
    boundary,
  );
});

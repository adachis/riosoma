import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { connectorFor, registerConnector, sourceKey } from '../registry.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import type { LiveTarget } from '../live/reader.js';
import { planLive } from '../live/translate.js';
import { createHttpEngineConnector } from './index.js';
import { EngineHttp } from './http.js';
import { GraphMetricsSession } from './graph-metrics.js';
import { elasticFilter, SearchSession, searchFilter } from './search.js';
import { searchMatching, searchRows } from './reader.js';

const object = { kind: 'object' as const, object: { schema: null, name: 'readings' } };
const response = (value: unknown) => new Response(JSON.stringify(value));
const context = (kind: string, extra: object = {}): ConnectorContext => ({
  connection: SourceConnection.parse({
    kind,
    endpoint: `https://${randomUUID()}.invalid`,
    auth: 'none',
    database: 'readings',
    ...extra,
  }),
  secrets: {},
});

// Flux scans a `$` together with whatever follows it as one interpolation token, so a backslash
// before it is swallowed and a name holding `$"`, `$\`, or `$${` needs its own byte escape.
it.each([
  ['readings${die(msg: "stop")}\\\n\r\t', String.raw`"readings\x24{die(msg: \"stop\")}\\\n\r\t"`],
  ['a$"b', String.raw`"a\x24\"b"`],
  ['a$\\b', String.raw`"a\x24\\b"`],
  ['a$${x}b', String.raw`"a\x24\x24{x}b"`],
])('reads the Flux catalog name %s as one literal', async (name, literal) => {
  const statements: string[] = [];
  const session = new GraphMetricsSession(
    new EngineHttp(
      context('influxdb', {
        version: '2',
        database: name,
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z',
      }),
      {
        fetch: async (_url, init) => {
          const { query } = JSON.parse(String(init.body));
          statements.push(query);
          return new Response(
            query.includes('schema.measurements')
              ? `,_value\n,"${name.replaceAll('"', '""')}"\n`
              : ',_time,value\n,2026-01-01T00:00:00Z,1\n',
          );
        },
      },
    ),
  );
  try {
    const rows = [];
    for await (const page of session.rows({ kind: 'object', object: { schema: null, name } }, [], 5))
      rows.push(...page);
    expect(rows).toHaveLength(1);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(
      `import "influxdata/influxdb/schema"\nschema.measurements(bucket: ${literal}, start: time(v: 0))`,
    );
    expect(statements[1]).toContain(`from(bucket: ${literal})`);
    expect(statements[1]).toContain(`r._measurement == ${literal}`);
    expect(statements[1]).toContain(
      'range(start: time(v: "2026-01-01T00:00:00Z"), stop: time(v: "2026-01-02T00:00:00Z"))',
    );
    // No `$` reaches the engine as one, so no name can begin an interpolation.
    expect(statements.join('\n')).not.toContain('$');
  } finally {
    await session.close();
  }
});

it('reads a measurement that is quiet in the current window as no rows', async () => {
  const statements: string[] = [];
  const session = new GraphMetricsSession(
    new EngineHttp(
      context('influxdb', {
        version: '2',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z',
      }),
      {
        fetch: async (_url, init) => {
          const query = JSON.parse(String(init.body)).query as string;
          statements.push(query);
          if (query.includes('schema.measurements'))
            // Only the catalog question, which carries no window, still names a quiet measurement.
            return new Response(query.includes('time(v: 0)') ? ',_value\n,readings\n' : ',_value\n');
          return new Response('#datatype,string,long,dateTime:RFC3339,double\n,result,table,_time,_value\n');
        },
      },
    ),
  );
  try {
    const rows = [];
    for await (const page of session.rows(object, [], 5)) rows.push(...page);
    expect(rows).toEqual([]);
    expect(await session.describe(object)).toEqual([]);
    expect(statements[0]).toContain('schema.measurements(bucket: "readings", start: time(v: 0))');
    expect(statements[1]).toContain(
      'range(start: time(v: "2026-01-01T00:00:00Z"), stop: time(v: "2026-01-02T00:00:00Z"))',
    );
    // The picker still lists what the window holds, so a quiet measurement isn't offered as new.
    expect(await session.list()).toEqual([]);
  } finally {
    await session.close();
  }
});

it('refuses a measurement absent from the catalog before reading it', async () => {
  const statements: string[] = [];
  const session = new GraphMetricsSession(
    new EngineHttp(context('influxdb', { version: '2' }), {
      fetch: async (_url, init) => {
        statements.push(JSON.parse(String(init.body)).query);
        return new Response(',_value\n,allowed\n');
      },
    }),
  );
  try {
    await expect(session.rows(object, [], 5).next()).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('schema.measurements');
  } finally {
    await session.close();
  }
});

it.each(['`', 'x` || allowed:=true || id:=`x', '\\`', 'ends\\'])(
  'refuses the Typesense filter value %s',
  (value) => {
    expect(() => searchFilter({ op: 'eq', column: 'id', value }, 'typesense')).toThrow();
    expect(searchFilter({ op: 'eq', column: 'id', value }, 'meilisearch')).toContain(JSON.stringify(value));
  },
);

it('compares a Typesense backslash as it stands and fetches the IDs it cannot', async () => {
  // Typesense keeps a backslash inside backticks literally, escaping only a backtick, so doubling
  // it would look for a value the source never held.
  expect(searchFilter({ op: 'eq', column: 'id', value: 'a\\b' }, 'typesense')).toBe('id:=`a\\b`');
  const docs = [
    { id: 'a\\b', amount: 2 },
    { id: 'ends\\', amount: 3 },
  ];
  const direct: string[] = [];
  const filters: string[] = [];
  const connector = createHttpEngineConnector('typesense', {
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/collections') return response([{ name: 'readings' }]);
      if (parsed.pathname === '/collections/readings')
        return response({ fields: [{ name: 'amount', type: 'int32' }] });
      if (parsed.pathname.endsWith('/documents/search')) {
        const filter = parsed.searchParams.get('filter_by') ?? '';
        filters.push(filter);
        const selected = filter.includes('amount:>=3') ? docs.slice(1) : docs;
        return response({ hits: selected.map((document) => ({ document })), found: selected.length });
      }
      const id = decodeURIComponent(parsed.pathname.split('/documents/')[1]!);
      direct.push(id);
      const doc = docs.find((entry) => entry.id === id);
      return doc ? response(doc) : new Response('', { status: 404 });
    },
  });
  const original = connectorFor('typesense');
  registerConnector(connector);
  const target: LiveTarget = {
    id: randomUUID(),
    version: '1',
    kind: 'typesense',
    context: context('typesense'),
    select: object,
    keyColumns: ['id'],
  };
  const keys = docs.map((doc) => sourceKey([doc.id]));
  try {
    const rows = await searchRows(target, keys, [{ id: 'amount', column: 'amount', type: 'number' }]);
    expect([...rows]).toEqual(keys.map((key, index) => [key, { amount: docs[index]!.amount }]));
    expect(direct).toEqual(docs.map((doc) => doc.id));
    expect(filters).toEqual([]);
    // A record rule still decides which of the directly fetched IDs may be returned.
    expect(
      await searchMatching(target, keys, { parts: [], native: { op: 'gte', column: 'amount', value: 3 } }),
    ).toEqual(new Set([keys[1]]));
    expect(filters.every((filter) => filter.includes('amount:>=3'))).toBe(true);
    // An ID is fetched directly rather than written into a filter, so neither appears in one.
    expect(filters.every((filter) => !filter.includes('id:'))).toBe(true);
  } finally {
    registerConnector(original);
  }
});

it('keeps a Meilisearch native filter and the record rules in their own filter strings', async () => {
  const bodies: Array<{ filter?: unknown }> = [];
  const session = new SearchSession(
    new EngineHttp(context('meilisearch'), {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return response({ results: [], total: 0 });
      },
    }),
  );
  // Meilisearch binds AND tighter than OR, so text that closes a group it never opened would end
  // the group the rules sit in.  Its filter takes an array, and parses each string on its own.
  const native = 'id EXISTS) OR (id EXISTS';
  try {
    for await (const _page of session.pages({ ...object, nativeFilter: native }, 10, {
      where: {
        op: 'and',
        args: [
          { op: 'lt', column: 'amount', value: 100 },
          { op: 'or', args: [{ op: 'eq', column: 'id', value: 'k1' }] },
        ],
      },
    })) {
      /* Read every page */
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.filter).toEqual([native, '(amount < 100 AND (id = "k1"))']);
  } finally {
    await session.close();
  }
});

/** A Typesense native filter read beside one record rule, as the filter strings the engine was sent. */
async function typesenseFilters(nativeFilter: string, sent: string[] = []): Promise<string[]> {
  const session = new SearchSession(
    new EngineHttp(context('typesense'), {
      fetch: async (url) => {
        sent.push(new URL(url).searchParams.get('filter_by') ?? '');
        return response({ hits: [], found: 0 });
      },
    }),
  );
  try {
    for await (const _page of session.pages({ ...object, nativeFilter }, 10, {
      where: { op: 'eq', column: 'owner', value: 'alice' },
    })) {
      /* Read every page */
    }
    return sent;
  } finally {
    await session.close();
  }
}

// Typesense takes one filter string, and its tokenizer toggles on every backtick and never refuses
// an unclosed one.  An open backtick would swallow the record rules into one value, and a group
// closed early would end the one they sit in, so either would exempt documents from the rules.
it.each(['a:=x) || b:=`v', 'id:=`a', 'amount:>=2) || (amount:<=9', '(amount:>=2', 'title:="a ) || ( b"'])(
  'refuses the %s Typesense filter before sending it',
  async (nativeFilter) => {
    const sent: string[] = [];
    await expect(typesenseFilters(nativeFilter, sent)).rejects.toMatchObject({
      messageKey: 'sources.engines.filterGroup',
    });
    expect(sent).toEqual([]);
  },
);

it.each(['amount:>=2', '(amount:>=2 && amount:<=9) || id:=`k1`', 'id:=`a ) || ( b`'])(
  'joins the %s Typesense filter with the record rules',
  async (nativeFilter) => {
    expect(await typesenseFilters(nativeFilter)).toEqual([`(${nativeFilter}) && (owner:=\`alice\`)`]);
  },
);

/** One native filter through an engine's own paging, or the key of the refusal it answered with. */
async function engineQuery(kind: 'elasticsearch' | 'opensearch', nativeFilter: string): Promise<unknown> {
  const queries: unknown[] = [];
  const session = new SearchSession(
    new EngineHttp(context(kind), {
      fetch: async (url, init) => {
        if (init.method === 'DELETE') return response({});
        if (new URL(url).pathname !== '/_search') return response({ id: 'handle', pit_id: 'handle' });
        const body = JSON.parse(String(init.body));
        queries.push(body.query);
        return response({ hits: { hits: [] } });
      },
    }),
  );
  try {
    for await (const _page of session.pages({ ...object, nativeFilter }, 10)) {
      /* Read every page */
    }
    return queries[0];
  } finally {
    await session.close();
  }
}

// A guard that names the keys to refuse misses a script under any other name, and cannot see
// through a query wrapped as base64, so the guard lists what a filter may use instead.
it.each([
  `{"script":{"script":{"source":"doc['amount'].value"}}}`,
  '{"script_score":{"query":{"match_all":{}},"script":{"source":"1"}}}',
  '{"terms_set":{"tags":{"terms":["a"],"minimum_should_match_script":{"source":"1"}}}}',
  '{"function_score":{"query":{"match_all":{}},"functions":[{"script_score":{"source":"1"}}]}}',
  '{"percolate":{"field":"query","document":{"match_all":{}}}}',
  '{"match_all":{},"runtime_mappings":{"amount":{"type":"double","script":{"source":"1"}}}}',
  '{"bool":{"filter":[{"match_all":{}}],"must_not":[{"script":{"script":{"source":"1"}}}]}}',
  '{"nested":{"path":"detail","query":{"script":{"script":{"source":"1"}}}}}',
  '{"term":{"detail":{"script":{"source":"1"}}}}',
])('refuses the %s native filter', async (nativeFilter) => {
  for (const kind of ['elasticsearch', 'opensearch'] as const)
    await expect(engineQuery(kind, nativeFilter), kind).rejects.toMatchObject({
      messageKey: 'sources.engines.filter',
    });
});

it('refuses a native filter that hides its query as base64', async () => {
  const hidden = Buffer.from(`{"script":{"script":{"source":"doc['amount'].value"}}}`, 'utf8').toString(
    'base64',
  );
  await expect(
    engineQuery('elasticsearch', JSON.stringify({ wrapper: { query: hidden } })),
  ).rejects.toMatchObject({ messageKey: 'sources.engines.filter' });
});

// Inner hits and highlights hold whole queries where the guard does not follow them: a sort's
// nested filter and a highlight query.  The connector reads neither, so both are refused wherever
// they sit, which also closes a script wrapped as base64 or a percolate query hidden in one.
const wrapped = JSON.stringify({
  wrapper: {
    query: Buffer.from('{"script":{"script":{"source":"1"}}}', 'utf8').toString('base64'),
  },
});
it.each([
  `{"nested":{"path":"d","query":{"match_all":{}},"inner_hits":{"sort":[{"d.n":{"nested":{"path":"d","filter":${wrapped}}}}]}}}`,
  '{"has_child":{"type":"detail","query":{"match_all":{}},"inner_hits":{"highlight":{"fields":{"at":{}},"highlight_query":{"percolate":{"field":"query","document":{}}}}}}}',
  `{"nested":{"path":"d","query":{"match_all":{}},"highlight":{"highlight_query":${wrapped}}}}`,
  '{"has_child":{"type":"detail","query":{"term":{"at":1}},"inner_hits":{"size":1}}}',
  '{"bool":{"filter":[{"has_parent":{"parent_type":"order","query":{"match_all":{}},"inner_hits":{}}}]}}',
])('refuses the %s native filter, which carries inner hits or a highlight', async (nativeFilter) => {
  for (const kind of ['elasticsearch', 'opensearch'] as const)
    await expect(engineQuery(kind, nativeFilter), kind).rejects.toMatchObject({
      messageKey: 'sources.engines.filter',
    });
});

it.each([
  '{"match_all":{}}',
  '{"range":{"amount":{"gte":2,"format":"strict_date_optional_time"}}}',
  '{"term":{"script_name":"kept"}}',
  '{"ids":{"values":["1","2"]}}',
  '{"bool":{"filter":[{"exists":{"field":"amount"}}],"should":[{"match_phrase":{"title":"two words"}}],"minimum_should_match":1,"boost":2}}',
  '{"nested":{"path":"detail","query":{"term":{"detail.at":1}},"score_mode":"none"}}',
  '{"constant_score":{"filter":{"prefix":{"title":"a"}},"boost":1.5}}',
  '{"dis_max":{"queries":[{"wildcard":{"title":"a*"}},{"fuzzy":{"title":"a"}}],"tie_breaker":0.3}}',
  '{"bool":{"must_not":[{"geo_distance":{"distance":"2km","position":{"lat":34,"lon":-118}}}]}}',
  '{"has_child":{"type":"detail","query":{"term":{"at":1}},"max_children":10}}',
])('reads the %s native filter', async (nativeFilter) => {
  expect(await engineQuery('elasticsearch', nativeFilter)).toEqual(JSON.parse(nativeFilter));
});

it('fetches backtick document IDs directly and retains native filters and record rules', async () => {
  const docs = [
    { id: 'visible`/?#', amount: 2 },
    { id: 'hidden` || amount:>=0', amount: 0 },
  ];
  const direct: string[] = [];
  const filters: string[] = [];
  const connector = createHttpEngineConnector('typesense', {
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/collections') return response([{ name: 'readings' }]);
      if (parsed.pathname === '/collections/readings')
        return response({ fields: [{ name: 'amount', type: 'int32' }] });
      if (parsed.pathname.endsWith('/documents/search')) {
        const filter = parsed.searchParams.get('filter_by') ?? '';
        filters.push(filter);
        const selected = filter.includes('amount:>=1') ? docs.slice(0, 1) : docs;
        return response({ hits: selected.map((document) => ({ document })), found: selected.length });
      }
      const id = decodeURIComponent(parsed.pathname.split('/documents/')[1]!);
      direct.push(id);
      const doc = docs.find((entry) => entry.id === id);
      return doc ? response(doc) : new Response('', { status: 404 });
    },
  });
  const original = connectorFor('typesense');
  registerConnector(connector);
  const target: LiveTarget = {
    id: randomUUID(),
    version: '1',
    kind: 'typesense',
    context: context('typesense'),
    select: object,
    keyColumns: ['id'],
  };
  const keys = docs.map((doc) => sourceKey([doc.id]));
  try {
    const rows = await searchRows(
      target,
      [...keys, sourceKey(['missing`'])],
      [{ id: 'amount', column: 'amount', type: 'number' }],
    );
    expect([...rows]).toEqual(keys.map((key, index) => [key, { amount: docs[index]!.amount }]));
    expect(direct).toEqual([...docs.map((doc) => doc.id), 'missing`']);
    expect(filters).toEqual([]);
    expect(
      await searchMatching(target, keys, { parts: [], native: { op: 'gte', column: 'amount', value: 1 } }),
    ).toEqual(new Set([keys[0]]));
    const filtered = { ...target, id: randomUUID(), select: { ...object, nativeFilter: 'amount:>=1' } };
    expect([
      ...(await searchRows(filtered, keys, [{ id: 'amount', column: 'amount', type: 'number' }])),
    ]).toEqual([[keys[0], { amount: 2 }]]);
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((filter) => filter.includes('amount:>=1') && !filter.includes('`'))).toBe(true);
  } finally {
    registerConnector(original);
  }
});

it.each(['elasticsearch', 'opensearch'] as const)(
  'preserves late %s arrays in preview, sync, and live scalar fields',
  async (kind) => {
    let latePreview = false;
    const connector = createHttpEngineConnector(kind, {
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (init.method === 'DELETE') return response({});
        if (path === '/_alias') return response({ readings: { aliases: {} } });
        if (path.endsWith('/_mapping'))
          return response({
            readings: {
              mappings: {
                properties: {
                  amount: { type: 'integer' },
                  time: { type: 'date' },
                  active: { type: 'boolean' },
                  point: { type: 'geo_point' },
                },
              },
            },
          });
        if (path !== '/_search') return response({ id: 'snapshot', pit_id: 'snapshot' });
        const body = JSON.parse(String(init.body));
        const start = body.search_after ? Number(body.search_after[0]) + 1 : 0;
        const count = Math.min(body.size, 1_002 - start);
        return response({
          hits: {
            hits: Array.from({ length: count }, (_, index) => {
              const at = start + index;
              const array = at === 1_000 || (latePreview && body.size === 5);
              return {
                _id: String(at),
                _index: 'readings',
                sort: [at],
                _source: {
                  amount: array ? [1, 2] : 1,
                  time: array ? ['2026-01-01', '2026-01-02'] : '2026-01-01',
                  active: array ? [true, false] : true,
                  point: array
                    ? [
                        [12, 34],
                        [56, 78],
                      ]
                    : [12, 34],
                },
              };
            }),
          },
        });
      },
    });
    const ctx = context(kind);
    const original = connectorFor(kind);
    registerConnector(connector);
    try {
      const rows: SourceRow[] = [];
      const types = { amount: 'number', time: 'date', active: 'checkbox', point: 'location' };
      for await (const page of connector.read(ctx, object, {
        columns: Object.keys(types),
        types,
        keyColumns: ['_index', '_id'],
        batchSize: 500,
      }))
        rows.push(...page);
      expect(rows).toHaveLength(1_002);
      const expected = {
        amount: '[1,2]',
        time: '["2026-01-01","2026-01-02"]',
        active: '[true,false]',
        point: '[[12,34],[56,78]]',
      };
      expect(rows[1_000]!.values).toEqual(expected);
      expect(rows[1_001]!.values.amount).toBe(1);
      expect(rows[1_001]!.values.point).toEqual({ lat: 34, lng: 12, label: null });
      const target: LiveTarget = {
        id: randomUUID(),
        version: '1',
        kind,
        context: ctx,
        select: object,
        keyColumns: ['_index', '_id'],
      };
      const live = await searchRows(
        target,
        [rows[1_000]!.key],
        Object.entries(types).map(([column, type]) => ({ id: column, column, type })),
      );
      expect(live.get(rows[1_000]!.key)).toEqual(expected);
      latePreview = true;
      const preview = await connector.preview(ctx, object, 5);
      expect(preview.rows[0]![preview.columns.findIndex((column) => column.name === 'amount')]).toBe('[1,2]');
    } finally {
      registerConnector(original);
    }
  },
);

it('preserves late Meilisearch arrays in preview, sync, and live scalar fields', async () => {
  let latePreview = false;
  const array = (at: number, limit: number) => at === 1_000 || (latePreview && at === 0 && limit === 5);
  const documents = Array.from({ length: 1_002 }, (_unused, at) => ({
    id: String(at),
    amount: 1,
    time: '2026-01-01',
  }));
  const connector = createHttpEngineConnector('meilisearch', {
    fetch: async (_url, init) => {
      // The index list is a plain GET, which carries no filter and no body to read.
      if (init.body === undefined) return response({ results: [{ uid: 'readings' }] });
      const body = JSON.parse(String(init.body)) as { offset: number; limit: number; filter?: string[] };
      const only = body.filter?.join(' ').match(/id = "(\d+)"/)?.[1];
      // Only the sample a description takes is limited, so an array after it is a late one.
      const page = only
        ? documents.filter((document) => document.id === only)
        : documents.slice(body.offset, body.offset + body.limit);
      return response({
        results: page.map((document) =>
          array(Number(document.id), body.limit)
            ? { ...document, amount: [1, 2], time: ['2026-01-01', '2026-01-02'] }
            : document,
        ),
        total: only ? page.length : documents.length,
      });
    },
  });
  const ctx = context('meilisearch');
  const original = connectorFor('meilisearch');
  registerConnector(connector);
  try {
    const rows: SourceRow[] = [];
    const types = { amount: 'number', time: 'date' };
    for await (const page of connector.read(ctx, object, {
      columns: Object.keys(types),
      types,
      keyColumns: ['id'],
      batchSize: 500,
    }))
      rows.push(...page);
    expect(rows).toHaveLength(1_002);
    const expected = { amount: '[1,2]', time: '["2026-01-01","2026-01-02"]' };
    expect(rows[1_000]!.values).toEqual(expected);
    expect(rows[1_001]!.values.amount).toBe(1);
    const target: LiveTarget = {
      id: randomUUID(),
      version: '1',
      kind: 'meilisearch',
      context: ctx,
      select: object,
      keyColumns: ['id'],
    };
    const live = await searchRows(
      target,
      [rows[1_000]!.key],
      Object.entries(types).map(([column, type]) => ({ id: column, column, type })),
    );
    expect(live.get(rows[1_000]!.key)).toEqual(expected);
    latePreview = true;
    const preview = await connector.preview(ctx, object, 5);
    expect(preview.rows[0]![preview.columns.findIndex((column) => column.name === 'amount')]).toBe('[1,2]');
  } finally {
    registerConnector(original);
  }
});

it('uses a catalog label in the node pattern on every page', async () => {
  const statements: string[] = [];
  const session = new GraphMetricsSession(
    new EngineHttp(context('neo4j'), {
      fetch: async (_url, init) => {
        const { statement } = JSON.parse(String(init.body));
        statements.push(statement);
        return response({
          data: statement.startsWith('CALL db.labels')
            ? { fields: ['label'], values: [['readings']] }
            : { fields: ['properties', '_id'], values: statements.length === 2 ? [[{}, 'node-a']] : [] },
        });
      },
    }),
  );
  try {
    for await (const _page of session.rows(object, [], 1)) {
      /* Read every page */
    }
    expect(statements).toHaveLength(3);
    for (const statement of statements.slice(1)) expect(statement).toContain('MATCH (n:`readings`)');
  } finally {
    await session.close();
  }
});

it.each(['elasticsearch', 'opensearch'] as const)(
  'sets an explicit ISO format on every %s date range',
  (kind) => {
    const field = {
      id: 'time',
      type: 'date',
      options: { includeTime: true },
      source: { column: 'time', sourceType: 'date' },
    };
    for (const operator of [
      'is',
      'isNot',
      'isBefore',
      'isAfter',
      'isOnOrBefore',
      'isOnOrAfter',
      'isWithin',
    ] as const) {
      const plan = planLive({
        dialect: kind,
        fields: new Map([[field.id, field]]),
        sorts: [],
        rules: null,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              id: 'range',
              fieldId: field.id,
              operator,
              value: operator === 'isWithin' ? { mode: 'pastWeek' } : { mode: 'today' },
            },
          ],
        },
        context: { now: new Date('2026-01-01T12:00:00Z'), timeZone: 'UTC' },
      });
      expect(plan.skipped).toEqual([]);
      const query = elasticFilter(plan.where!.native!);
      const ranges: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, part] of Object.entries(value)) {
          if (key === 'range') ranges.push(...Object.values(part as Record<string, Record<string, unknown>>));
          else visit(part);
        }
      };
      visit(query);
      expect(ranges.length).toBeGreaterThan(0);
      for (const range of ranges) expect(range.format).toBe('strict_date_optional_time');
    }
    expect(elasticFilter({ op: 'gte', column: 'amount', value: 1 })).toEqual({
      range: { amount: { gte: 1 } },
    });
  },
);

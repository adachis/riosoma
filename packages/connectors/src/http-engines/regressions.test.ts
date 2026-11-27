import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { connectorFor, registerConnector, sourceKey } from '../registry.js';
import { planLive } from '../live/translate.js';
import type { LiveTarget } from '../live/reader.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { createHttpEngineConnector } from './index.js';
import { EngineHttp } from './http.js';
import { GraphMetricsSession } from './graph-metrics.js';
import { searchKeys, searchMatching, searchRows } from './reader.js';

const object = { kind: 'object' as const, object: { schema: null, name: 'readings' } };
const response = (value: unknown) => new Response(JSON.stringify(value));
const context = (kind: string, extra: object = {}): ConnectorContext => ({
  connection: SourceConnection.parse({
    kind,
    endpoint: `https://${randomUUID()}.invalid`,
    auth: 'none',
    query: 'up',
    ...extra,
  }),
  secrets: {},
});

describe('graph and metrics source regressions', () => {
  it.each([
    [
      'Allowed\\u0060) SET n.review_probe = true RETURN n //',
      '`Allowed\\u005cu0060) SET n.review_probe = true RETURN n //`',
    ],
    ['We`ird\\name', '`We``ird\\u005cname`'],
    ['Équipe', '`Équipe`'],
  ])('keeps the catalog label %s entirely inside one quoted identifier', async (name, quoted) => {
    const calls: Array<{ statement: string; parameters: Record<string, unknown> }> = [];
    const session = new GraphMetricsSession(
      new EngineHttp(context('neo4j'), {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          calls.push(body);
          if (body.statement.startsWith('CALL db.labels'))
            return response({ data: { fields: ['label'], values: [[name]] } });
          return response({
            data: { fields: ['properties', '_id'], values: calls.length === 2 ? [[{}, 'node-a']] : [] },
          });
        },
      }),
    );
    try {
      for await (const _page of session.rows({ kind: 'object', object: { schema: null, name } }, [], 1)) {
        // Reading the next page also verifies that the label survives pagination as data.
      }
      expect(calls).toHaveLength(3);
      expect(calls[0]!.statement).toBe('CALL db.labels() YIELD label RETURN label ORDER BY label');
      for (const call of calls.slice(1)) {
        expect(call.statement).toBe(
          `MATCH (n:${quoted}) WHERE elementId(n) > $after WITH n ORDER BY elementId(n) LIMIT $limit RETURN properties(n) AS properties, elementId(n) AS _id, [(n)-[r]->(m) | {type: type(r), labels: labels(m), id: elementId(m)}] AS _relationships ORDER BY _id`,
        );
        expect(call.parameters.limit).toBe(1);
      }
      expect(calls[2]!.parameters.after).toBe('node-a');
    } finally {
      await session.close();
    }
  });

  it.each([60, 17])('keeps overlapping rolling samples on the same %i second grid', async (stepSeconds) => {
    const ctx = context('prometheus', { windowMinutes: 2, stepSeconds });
    const bounds: Array<{ start: number; end: number }> = [];
    const connector = createHttpEngineConnector('prometheus', {
      fetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('buildinfo')) return response({ status: 'success' });
        const start = Date.parse(parsed.searchParams.get('start')!);
        const end = Date.parse(parsed.searchParams.get('end')!);
        bounds.push({ start, end });
        const values = [];
        for (let time = start; time <= end; time += stepSeconds * 1_000) values.push([time / 1_000, '1']);
        return response({
          status: 'success',
          data: { resultType: 'matrix', result: [{ metric: { job: 'service' }, values }] },
        });
      },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const runs: SourceRow[][] = [];
      for (const now of ['2026-01-01T12:00:00.123Z', '2026-01-01T12:01:00.456Z']) {
        vi.setSystemTime(new Date(now));
        const rows: SourceRow[] = [];
        for await (const page of connector.read(ctx, object, {
          columns: ['time', 'value'],
          types: {},
          keyColumns: ['_series', 'time'],
        }))
          rows.push(...page);
        runs.push(rows);
      }
      const overlap = runs[1]!.filter((row) => runs[0]!.some((before) => before.key === row.key));
      expect(overlap.length).toBeGreaterThan(0);
      for (const bound of bounds) {
        expect(bound.start % (stepSeconds * 1_000)).toBe(0);
        expect(bound.end % (stepSeconds * 1_000)).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves explicit Prometheus bounds between paged requests', async () => {
    const start = '2026-01-01T00:00:00.123Z';
    const end = '2026-01-01T00:16:41.123Z';
    const ranges: URLSearchParams[] = [];
    const session = new GraphMetricsSession(
      new EngineHttp(context('prometheus', { start, end, stepSeconds: 1 }), {
        fetch: async (url) => {
          ranges.push(new URL(url).searchParams);
          return response({ status: 'success', data: { resultType: 'matrix', result: [] } });
        },
      }),
    );
    try {
      for await (const _page of session.rows(object, [], 500)) {
        /* An empty series still advances the time window */
      }
      expect(ranges).toHaveLength(2);
      expect(ranges[0]!.get('start')).toBe(start);
      expect(ranges[0]!.get('end')).toBe('2026-01-01T00:16:39.123Z');
      expect(ranges[1]!.get('start')).toBe('2026-01-01T00:16:40.123Z');
      expect(ranges[1]!.get('end')).toBe(end);
    } finally {
      await session.close();
    }
  });
});

describe('search conversion regressions', () => {
  it('preserves sampled timestamps in live values and keys', async () => {
    const ctx = context('meilisearch');
    const documents = [
      { id: 'a', time: '2026-01-01T12:34:56.000Z' },
      { id: 'b', time: '2026-01-01T14:34:56+01:00' },
    ];
    const times = documents.map((row) => new Date(row.time).toISOString());
    const connector = createHttpEngineConnector('meilisearch', {
      fetch: async (url) =>
        response(
          new URL(url).pathname === '/indexes'
            ? { results: [{ uid: 'readings' }] }
            : { results: documents, total: documents.length },
        ),
    });
    const original = connectorFor('meilisearch');
    registerConnector(connector);
    try {
      const preview = await connector.preview(ctx, object, 5);
      const at = preview.columns.findIndex((column) => column.name === 'time');
      expect(preview.rows.map((row) => row[at])).toEqual(times);
      const target: LiveTarget = {
        id: randomUUID(),
        version: '1',
        kind: 'meilisearch',
        context: ctx,
        select: object,
        keyColumns: ['time'],
      };
      const expectedKeys = times.map((time) => sourceKey([time]));
      const values = await searchRows(target, expectedKeys, [{ id: 'time', column: 'time', type: 'date' }]);
      expect([...values.values()]).toEqual(times.map((time) => ({ time })));
      expect([...values.keys()]).toEqual(expectedKeys);
      expect((await searchKeys(target, { where: null, order: [], limit: 5 })).keys).toEqual(expectedKeys);
      expect(await searchMatching(target, expectedKeys, { parts: [], native: { op: 'true' } })).toEqual(
        new Set(expectedKeys),
      );
    } finally {
      registerConnector(original);
    }
  });

  it('reads declared nested Typesense paths and gives literal dotted keys precedence', async () => {
    const ctx = context('typesense');
    const documents = [
      { id: 'a', person: { age: 42, active: false } },
      { id: 'b', person: { age: 99 }, 'person.age': 0 },
      { id: 'c', person: { age: 99 }, 'person.age': null },
      { id: 'd', person: null },
    ];
    const connector = createHttpEngineConnector('typesense', {
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path === '/collections') return response([{ name: 'readings', num_documents: documents.length }]);
        if (path === '/collections/readings')
          return response({
            fields: [
              { name: 'person.age', type: 'int32' },
              { name: 'person.active', type: 'bool' },
            ],
          });
        return response({ hits: documents.map((document) => ({ document })), found: documents.length });
      },
    });
    const original = connectorFor('typesense');
    registerConnector(connector);
    try {
      const preview = await connector.preview(ctx, object, 5);
      expect(preview.rows).toEqual([
        [42, false, 'a'],
        [0, null, 'b'],
        [null, null, 'c'],
        [null, null, 'd'],
      ]);
      const rows: SourceRow[] = [];
      for await (const page of connector.read(ctx, object, {
        columns: ['person.age'],
        types: {},
        keyColumns: ['id'],
      }))
        rows.push(...page);
      expect(rows.map((row) => row.values['person.age'])).toEqual([42, 0, null, null]);
      const target: LiveTarget = {
        id: randomUUID(),
        version: '1',
        kind: 'typesense',
        context: ctx,
        select: object,
        keyColumns: ['id'],
      };
      const keys = documents.map((row) => sourceKey([row.id]));
      const live = await searchRows(target, keys, [{ id: 'age', column: 'person.age', type: 'number' }]);
      expect([...live.values()]).toEqual([{ age: 42 }, { age: 0 }, { age: null }, { age: null }]);
    } finally {
      registerConnector(original);
    }
  });

  it.each(['elasticsearch', 'opensearch'] as const)(
    'preserves multivalued %s fields as JSON without scalar pushdown',
    async (kind) => {
      const ctx = context(kind);
      const documents = [
        {
          scores: [10, 20],
          tags: ['a', 'b'],
          dates: ['2026-01-01'],
          point: [12, 34],
          places: [
            [12, 34],
            [56, 78],
          ],
        },
        { scores: [], tags: [], dates: [], point: { lat: 34, lon: 12 }, places: [] },
        { scores: 10, tags: 'a', dates: '2026-01-01', point: [12, 34], places: { lat: 34, lon: 12 } },
      ];
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
                    scores: { type: 'integer' },
                    tags: { type: 'keyword' },
                    dates: { type: 'date' },
                    point: { type: 'geo_point' },
                    places: { type: 'geo_point' },
                  },
                },
              },
            });
          if (path === '/_search')
            return response({
              hits: {
                hits: documents.map((document, at) => ({
                  _id: String(at),
                  _index: 'readings',
                  _source: document,
                  sort: [at],
                })),
              },
            });
          return response({ id: 'snapshot', pit_id: 'snapshot' });
        },
      });
      const original = connectorFor(kind);
      registerConnector(connector);
      try {
        const preview = await connector.preview(ctx, object, 5);
        const score = preview.columns.find((column) => column.name === 'scores')!;
        expect(score.suggested?.type).toBe('json');
        expect(preview.columns.find((column) => column.name === 'point')?.suggested?.type).toBe('location');
        for (const name of ['scores', 'tags', 'dates', 'places'])
          expect(preview.columns.find((column) => column.name === name)?.suggested?.type).toBe('json');
        const rows: SourceRow[] = [];
        for await (const page of connector.read(ctx, object, {
          columns: ['scores'],
          types: {},
          keyColumns: ['_index', '_id'],
        }))
          rows.push(...page);
        expect(rows.map((row) => row.values.scores)).toEqual(['[10,20]', '[]', '10']);
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
          rows.map((row) => row.key),
          [{ id: 'scores', column: 'scores', type: 'json' }],
        );
        expect([...live.values()]).toEqual([{ scores: '[10,20]' }, { scores: '[]' }, { scores: '10' }]);
        const field = {
          id: 'scores',
          type: 'number',
          options: {},
          source: { column: 'scores', sourceType: score.sourceType },
        };
        for (const operator of ['gt', 'isEmpty', 'isNotEmpty'] as const) {
          const plan = planLive({
            dialect: kind,
            fields: new Map([[field.id, field]]),
            filter: {
              conjunction: 'and',
              conditions: [{ id: 'filter', fieldId: field.id, operator, value: 5 }],
            },
            sorts: [{ fieldId: field.id, direction: 'asc' }],
            rules: null,
            context: { now: new Date(), timeZone: 'UTC' },
          });
          expect(plan.skipped.map((item) => item.part)).toEqual(['filter', 'sort']);
          expect(plan.where?.native).toEqual({ op: 'true' });
          expect(plan.order).toEqual([]);
        }
      } finally {
        registerConnector(original);
      }
    },
  );
});

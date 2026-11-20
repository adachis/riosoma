import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { SourceConnection, SourceSecrets, isHttpEngine, type SourceSelect } from '@riosoma/contracts';
import { createHttpEngineConnector } from './index.js';
import { EngineHttp, record } from './http.js';

/**
 * Live reads against the fleet in `ops/test-fleet/compose.yaml`, which `search-graph-smoke.mjs`
 * starts, seeds, and stops.  Each engine reads its own settings from the environment, so a fleet
 * that runs only some of them skips only those:
 *
 * - `RIOSOMA_TEST_ELASTICSEARCH_SETTINGS`, `RIOSOMA_TEST_OPENSEARCH_SETTINGS`,
 *   `RIOSOMA_TEST_MEILISEARCH_SETTINGS`, `RIOSOMA_TEST_TYPESENSE_SETTINGS`,
 *   `RIOSOMA_TEST_NEO4J_SETTINGS`, `RIOSOMA_TEST_INFLUXDB_SETTINGS` for version 2,
 *   `RIOSOMA_TEST_INFLUXDB3_SETTINGS` for version 3, and `RIOSOMA_TEST_PROMETHEUS_SETTINGS`
 *
 * Each value is JSON with a `connection` and its `secrets`, as the source contracts define them.
 * Every run makes its own fixtures and removes them afterwards.
 */
const FLEET = [
  'ELASTICSEARCH',
  'OPENSEARCH',
  'MEILISEARCH',
  'TYPESENSE',
  'NEO4J',
  'INFLUXDB',
  'INFLUXDB3',
  'PROMETHEUS',
] as const;
const contexts = FLEET.flatMap((name) => {
  const setting = process.env[`RIOSOMA_TEST_${name}_SETTINGS`];
  if (!setting) return [];
  const value = record(JSON.parse(setting));
  return [
    {
      connection: SourceConnection.parse(value.connection),
      secrets: SourceSecrets.parse(value.secrets ?? {}),
      timeoutMs: 30_000,
    },
  ];
});

it.skipIf(contexts.length === 0)(
  'reads the configured search, graph, and metrics fleet',
  async () => {
    for (const provided of contexts) {
      const now = Date.now();
      const context = {
        ...provided,
        connection:
          provided.connection.kind === 'influxdb'
            ? SourceConnection.parse({
                ...provided.connection,
                start: new Date(now - 60_000).toISOString(),
                end: new Date(now + 1_000).toISOString(),
              })
            : provided.connection,
      };
      const { connection } = context;
      if (!isHttpEngine(connection.kind)) throw new Error('The fleet entry must be an HTTP engine');
      const connector = createHttpEngineConnector(connection.kind);
      const http = new EngineHttp(context, {});
      const name = `sources-search-graph-${randomBytes(6).toString('hex')}`;
      let cleanup: (() => Promise<unknown>) | undefined;
      let select: SourceSelect | undefined;
      try {
        if (connection.kind === 'elasticsearch' || connection.kind === 'opensearch') {
          await http.json(
            `/${name}`,
            {
              mappings: {
                properties: {
                  title: { type: 'keyword' },
                  amount: { type: 'double' },
                  position: { type: 'geo_point' },
                  detail: { type: 'object' },
                },
              },
            },
            'PUT',
          );
          cleanup = () => http.json(`/${name}`, undefined, 'DELETE');
          for (let at = 1; at <= 3; at++)
            await http.json(
              `/${name}/_doc/${at}?refresh=true`,
              { title: String(at), amount: at, position: { lat: 34, lon: -118 }, detail: { at } },
              'PUT',
            );
          select = { kind: 'object', object: { schema: null, name } };
        } else if (connection.kind === 'typesense') {
          await http.json('/collections', {
            name,
            fields: [
              { name: 'title', type: 'string' },
              { name: 'amount', type: 'float' },
            ],
          });
          cleanup = () => http.json(`/collections/${name}`, undefined, 'DELETE');
          for (let at = 1; at <= 3; at++)
            await http.json(`/collections/${name}/documents`, {
              id: String(at),
              title: String(at),
              amount: at,
            });
          select = { kind: 'object', object: { schema: null, name } };
        } else if (connection.kind === 'meilisearch') {
          const wait = async (task: unknown) => {
            const uid = record(task).taskUid;
            for (let attempt = 0; attempt < 100; attempt++) {
              const state = record(await http.json(`/tasks/${String(uid)}`));
              if (state.status === 'succeeded') return;
              if (state.status === 'failed' || state.status === 'canceled')
                throw new Error('The fixture task failed');
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error('The fixture task did not finish');
          };
          await wait(await http.json('/indexes', { uid: name, primaryKey: 'id' }));
          cleanup = async () => wait(await http.json(`/indexes/${name}`, undefined, 'DELETE'));
          await wait(
            await http.json(
              `/indexes/${name}/documents`,
              [1, 2, 3].map((id) => ({ id: String(id), title: String(id), amount: id })),
            ),
          );
          select = { kind: 'object', object: { schema: null, name } };
        } else if (connection.kind === 'neo4j') {
          const run = (statement: string) =>
            http.json(`/db/${encodeURIComponent(connection.database)}/query/v2`, {
              statement,
              accessMode: 'Write',
            });
          await run(
            `CREATE (a:\`${name}\` {title: 'first', amount: 1}), (b:\`${name}\` {title: 'second', amount: 2}), (a)-[:NEXT]->(b)`,
          );
          cleanup = () => run(`MATCH (n:\`${name}\`) DETACH DELETE n`);
          select = { kind: 'object', object: { schema: null, name } };
        } else if (connection.kind === 'influxdb') {
          const query = new URLSearchParams(
            connection.version === '2'
              ? { bucket: connection.database, org: connection.organization, precision: 'ns' }
              : { db: connection.database, precision: 'nanosecond' },
          );
          const path = connection.version === '2' ? '/api/v2/write' : '/api/v3/write_lp';
          const written = await fetch(`${connection.endpoint.replace(/\/+$/, '')}${path}?${query}`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
            headers: {
              'content-type': 'text/plain',
              ...(connection.auth === 'token'
                ? {
                    authorization: `${connection.version === '2' ? 'Token' : 'Bearer'} ${context.secrets.token}`,
                  }
                : {}),
            },
            body: [1, 2, 3]
              .map(
                (amount) =>
                  `${name},room=office amount=${amount} ${BigInt(now - 1_000) * 1_000_000n + BigInt(amount)}`,
              )
              .join('\n'),
          });
          expect(written.ok).toBe(true);
          await written.body?.cancel();
          cleanup =
            connection.version === '2'
              ? () =>
                  http.text(
                    `/api/v2/delete?${new URLSearchParams({ bucket: connection.database, org: connection.organization })}`,
                    {
                      start: new Date(now - 60_000).toISOString(),
                      stop: new Date(now + 1_000).toISOString(),
                      predicate: `_measurement="${name}"`,
                    },
                  )
              : () =>
                  http.text(
                    `/api/v3/configure/table?${new URLSearchParams({ db: connection.database, table: name, hard_delete_at: new Date().toISOString() })}`,
                    undefined,
                    'DELETE',
                  );
          select = { kind: 'object', object: { schema: null, name } };
        }
        expect(await connector.test(context)).toMatchObject({ ok: true });
        const objects = await connector.listObjects(context);
        if (!select && objects[0]) select = { kind: 'object', object: objects[0] };
        expect(select).toBeDefined();
        if (!select) continue;
        const preview = await connector.preview(context, select, 5);
        expect(preview.columns.length).toBeGreaterThan(0);
        if (cleanup) expect(preview.rows.length).toBeGreaterThan(0);
        const keys = select.kind === 'object' ? await connector.keyCandidates(context, select.object) : [];
        if (connection.kind === 'influxdb') keys.push(['_timeKey']);
        if (keys[0]) {
          const columns = preview.columns.filter((column) => column.suggested);
          let count = 0;
          for await (const rows of connector.read(context, select, {
            columns: columns.map((column) => column.name),
            types: Object.fromEntries(columns.map((column) => [column.name, column.suggested!.type])),
            keyColumns: keys[0],
            batchSize: 1,
          })) {
            count += rows.length;
            if (count >= 3) break;
          }
          expect(count).toBeGreaterThan(0);
        }
      } finally {
        try {
          await cleanup?.();
        } finally {
          await http.close();
        }
      }
    }
  },
  120_000,
);

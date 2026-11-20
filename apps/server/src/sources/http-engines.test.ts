/**
 * The search, graph, and metrics sources on the server: the private-network rule their addresses
 * meet before one is saved or tried, and who may narrow what a synced table reads.
 *
 * Nothing here reaches an engine.  The connectors' own suites cover the protocols, with recorded
 * responses everywhere and a real fleet where one is running.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HTTP_ENGINE_KINDS,
  SourceConnection,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type SourceMeta,
} from '@riosoma/contracts';
import { connectorFor, registerConnector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { analyticsConnectors, checkAnalyticsSource } from './analytics.js';
import { retargets } from './target.js';
import { claimSyncs, runSync } from './sync.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';

const config = { production: true, automationsAllowPrivateHosts: false };
/** An address that resolves nowhere, so nothing a test builds can reach a real host. */
const nowhere = () => `https://${randomUUID()}.invalid`;

describe('where an engine source may point', () => {
  it.each(HTTP_ENGINE_KINDS)('refuses private %s endpoints before saving or connecting', async (kind) => {
    const connection = SourceConnection.parse({
      kind,
      endpoint: 'https://127.0.0.1',
      database: 'metrics',
      query: 'up',
      auth: 'none',
    });
    expect(() => checkAnalyticsSource(connection, config)).toThrow();
    const endpoint = new URL(nowhere());
    const looked: string[] = [];
    const connector = analyticsConnectors(config, async (name) => {
      looked.push(name);
      return [{ address: '10.0.0.1', family: 4 }];
    }).find((entry) => entry.kind === kind)!;
    const result = await connector.test({
      connection: SourceConnection.parse({ ...connection, endpoint: endpoint.href }),
      secrets: {},
      timeoutMs: 2_000,
    });
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.analytics.blocked' }),
    ]);
    expect(looked).toEqual([endpoint.hostname]);
  });
});

describe('what an engine source may change and keep its stored credential', () => {
  it('keeps a credential when only what to read changes, and drops it for a new address', () => {
    const prometheus = SourceConnection.parse({
      kind: 'prometheus',
      endpoint: nowhere(),
      auth: 'token',
      query: 'up',
      windowMinutes: 60,
      stepSeconds: 60,
    });
    // A window, a step, bounds, and a query all choose what one address is asked for.
    for (const change of [
      { query: 'node_load1' },
      { windowMinutes: 240 },
      { stepSeconds: 300 },
      { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    ])
      expect(retargets(prometheus, SourceConnection.parse({ ...prometheus, ...change }))).toBe(false);
    expect(retargets(prometheus, SourceConnection.parse({ ...prometheus, endpoint: nowhere() }))).toBe(true);
    const influx = SourceConnection.parse({
      kind: 'influxdb',
      endpoint: nowhere(),
      auth: 'token',
      database: 'readings',
      version: '2',
      windowMinutes: 60,
    });
    expect(retargets(influx, SourceConnection.parse({ ...influx, windowMinutes: 30 }))).toBe(false);
    // Another way of signing in is another arrangement with the same address, so it is a new target.
    expect(retargets(influx, SourceConnection.parse({ ...influx, auth: 'none' }))).toBe(true);
    const search = SourceConnection.parse({ kind: 'elasticsearch', endpoint: nowhere(), auth: 'api-key' });
    expect(retargets(search, SourceConnection.parse({ ...search, endpoint: `${nowhere()}/nested` }))).toBe(
      true,
    );
  });
});

describe('engine sources on a running server', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let databaseId: string;

  beforeAll(async () => {
    kit = await startTestPostgres();
    // Private hosts are allowed, so the rule under test is the only thing refusing a request.
    server = await startServer(kit, 'enginesrc', { automationsAllowPrivateHosts: true });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: newId('database'),
        name: 'Readings',
        table: {
          id: newId('table'),
          name: 'Local',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    databaseId = created.json<DatabaseSchema>().database.id;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  async function createSource(connection: Record<string, unknown>): Promise<SourceMeta> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: `Engine ${newId('source')}`,
        connection,
        secrets: {},
        access: 'creators',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SourceMeta>();
  }

  /** A synced table over one object, narrowed by an engine's own filter when one is given. */
  function table(sourceId: string, nativeFilter?: string) {
    const id = newId('table');
    return {
      kind: 'table.create',
      table: {
        id,
        name: `Readings ${id}`,
        source: {
          sourceId,
          select: {
            kind: 'object',
            object: { schema: null, name: 'readings' },
            ...(nativeFilter === undefined ? {} : { nativeFilter }),
          },
          keyColumns: ['_id'],
          everyMinutes: null,
        },
        fields: [
          { id: newId('field'), name: 'Key', type: 'text', source: { column: '_id', sourceType: 'keyword' } },
          {
            id: newId('field'),
            name: 'Amount',
            type: 'number',
            options: {},
            source: { column: 'amount', sourceType: 'double' },
          },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    };
  }

  async function send(command: Record<string, unknown>, headers: Record<string, string>) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...command }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CommandBatchResult>().results[0]!;
  }

  it.each(['elasticsearch', 'opensearch'] as const)(
    'completes %s syncs when an existing scalar field receives an array',
    async (kind) => {
      const engine = await createSource({ kind, endpoint: nowhere(), auth: 'none' });
      const original = connectorFor(kind);
      let multivalued = false;
      registerConnector({
        ...original,
        async describe() {
          return [
            {
              name: '_id',
              sourceType: 'keyword',
              nullable: false,
              suggested: { type: 'text', options: {} },
              alternatives: [],
            },
            {
              name: 'amount',
              sourceType: 'double',
              nullable: true,
              suggested: { type: 'number', options: {} },
              alternatives: [],
            },
          ];
        },
        async *read() {
          yield [
            { key: '["a"]', values: { _id: 'a', amount: multivalued ? '[1,2]' : 1 } },
            { key: '["b"]', values: { _id: 'b', amount: 2 } },
          ];
        },
      });
      try {
        const command = table(engine.id);
        const tableId = command.table.id;
        const amount = command.table.fields[1]!.id;
        expect(await send(command, server.owner.headers)).toMatchObject({ status: 'applied' });
        const sync = async () => {
          await send({ kind: 'table.sync', tableId }, server.owner.headers);
          const job = (await claimSyncs(server.ctx, 100)).find((job) => job.table_id === tableId)!;
          await runSync(server.ctx, job);
          const synced = (await loadTable(server.pool, server.schemas, tableId))!;
          expect(synced.source!.status).toMatchObject({ state: 'idle', error: null });
          const ids = await query<{ __id: string }>(
            server.pool,
            sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} ORDER BY __rid`,
          );
          const fields = await loadFields(server.pool, server.schemas, [tableId]);
          return fetchRowsById(
            server.pool,
            server.schemas.data,
            tableId,
            fields,
            ids.rows.map((row) => row.__id),
          );
        };
        expect((await sync()).map((row) => row.values[amount])).toEqual([1, 2]);
        multivalued = true;
        const rows = await sync();
        expect(rows.map((row) => row.values[amount])).toEqual([null, 2]);
        expect(rows[0]!.errors).toEqual({ [amount]: 'sources.engines.arrayCell' });
        expect(rows[1]!.errors).toBeUndefined();
        expect(rows[0]!.overrides).toBeUndefined();
        const fields = await loadFields(server.pool, server.schemas, [tableId]);
        const withoutAmount = await fetchRowsById(
          server.pool,
          server.schemas.data,
          tableId,
          fields.filter((field) => field.id !== amount),
          [rows[0]!.id],
        );
        expect(withoutAmount[0]!.errors).toBeUndefined();
        expect(withoutAmount[0]!.overrides).toBeUndefined();
        expect(
          await send(
            { kind: 'record.update', tableId, records: [{ id: rows[0]!.id, values: { [amount]: 7 } }] },
            server.owner.headers,
          ),
        ).toMatchObject({ status: 'applied' });
        const pinned = await sync();
        expect(pinned[0]!.values[amount]).toBe(7);
        expect(pinned[0]!.errors).toBeUndefined();
        expect(
          await send(
            { kind: 'record.update', tableId, records: [{ id: rows[0]!.id, values: { [amount]: null } }] },
            server.owner.headers,
          ),
        ).toMatchObject({ status: 'applied' });
        const emptyOverride = await sync();
        expect(emptyOverride[0]!.values[amount]).toBeNull();
        expect(emptyOverride[0]!.errors).toBeUndefined();
        expect(emptyOverride[0]!.overrides?.[amount]).toBeDefined();
        expect(
          await send(
            { kind: 'record.clearOverrides', tableId, records: [{ id: rows[0]!.id, fieldIds: [amount] }] },
            server.owner.headers,
          ),
        ).toMatchObject({ status: 'applied' });
        expect((await sync())[0]!.errors).toEqual({ [amount]: 'sources.engines.arrayCell' });
        multivalued = false;
        const recovered = await sync();
        expect(recovered.map((row) => row.values[amount])).toEqual([1, 2]);
        expect(recovered[0]!.errors).toBeUndefined();
      } finally {
        registerConnector(original);
      }
    },
  );

  it('keeps an engine’s filter to its admins, and off a source with no filter syntax', async () => {
    const engine = await createSource({ kind: 'elasticsearch', endpoint: nowhere(), auth: 'none' });
    const member = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'creator')`,
    );
    // A synced table's columns are read from the source as it's made, so the engine stands in.
    const original = connectorFor('elasticsearch');
    registerConnector({
      ...original,
      async describe() {
        return [
          {
            name: '_id',
            sourceType: 'keyword',
            nullable: false,
            suggested: { type: 'text', options: {} },
            alternatives: [],
          },
          {
            name: 'amount',
            sourceType: 'double',
            nullable: true,
            suggested: { type: 'number', options: {} },
            alternatives: [],
          },
        ];
      },
    });
    try {
      // A creator may sync the whole index, but not choose what the engine narrows it to.
      const wide = await send(table(engine.id), member.headers);
      expect(wide, JSON.stringify(wide)).toMatchObject({ status: 'applied' });
      const filtered = await send(
        table(engine.id, '{ "range": { "amount": { "gte": 2 } } }'),
        member.headers,
      );
      expect(filtered, JSON.stringify(filtered)).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'sources.filterAdminsOnly' },
      });
      const admin = await send(
        table(engine.id, '{ "range": { "amount": { "gte": 2 } } }'),
        server.owner.headers,
      );
      expect(admin, JSON.stringify(admin)).toMatchObject({ status: 'applied' });
      // Another kind has no filter syntax of its own, so nobody may claim one for it.
      const api = await createSource({
        kind: 'rest',
        baseUrl: nowhere(),
        auth: { method: 'none' },
        endpoints: [{ name: 'Readings' }],
      });
      const elsewhere = await send(table(api.id, 'amount >= 2'), server.owner.headers);
      expect(elsewhere, JSON.stringify(elsewhere)).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'sources.filterUnsupported' },
      });
    } finally {
      registerConnector(original);
    }
  });

  // Only an admin writes a filter, but the record rules still bind everyone who reads the table.
  // Meilisearch binds AND tighter than OR, so a filter that closes a group early would close the
  // group the rules sit in, and one left open fails every read.  Typesense takes one filter string
  // and toggles on every backtick, so an open backtick would swallow the rules joined after it.
  it.each([
    {
      kind: 'meilisearch' as const,
      refused: ['id EXISTS) OR (id EXISTS', 'amount >= 2) OR (amount <= 0', '(amount >= 2', '_id = "a'],
      kept: '(amount >= 2 OR amount <= 0) AND _id = "a ) OR ( b"',
    },
    {
      kind: 'typesense' as const,
      refused: ['a:=x) || b:=`v', '_id:=`a', 'amount:>=2) || (amount:<=0', '(amount:>=2'],
      kept: '(amount:>=2 || amount:<=0) && _id:=`a ) || ( b`',
    },
  ])('refuses a $kind filter whose groups or quoted values do not close', async ({ kind, refused, kept }) => {
    const engine = await createSource({ kind, endpoint: nowhere(), auth: 'none' });
    const original = connectorFor(kind);
    registerConnector({
      ...original,
      async describe() {
        return [
          {
            name: '_id',
            sourceType: 'keyword',
            nullable: false,
            suggested: { type: 'text', options: {} },
            alternatives: [],
          },
          {
            name: 'amount',
            sourceType: 'double',
            nullable: true,
            suggested: { type: 'number', options: {} },
            alternatives: [],
          },
        ];
      },
    });
    try {
      for (const filter of refused) {
        const escaping = await send(table(engine.id, filter), server.owner.headers);
        expect(escaping, `${filter} ${JSON.stringify(escaping)}`).toMatchObject({
          status: 'rejected',
          error: { messageKey: 'sources.engines.filterGroup' },
        });
      }
      // A filter that keeps its groups to itself, parentheses inside a value included, is stored.
      const whole = await send(table(engine.id, kept), server.owner.headers);
      expect(whole, JSON.stringify(whole)).toMatchObject({ status: 'applied' });
    } finally {
      registerConnector(original);
    }
  });
});

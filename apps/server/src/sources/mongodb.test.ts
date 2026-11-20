/**
 * MongoDB sources through the server: the checks a source's addresses meet before it's saved,
 * the network the driver's lookups go through, who may filter a synced table, and whole syncs
 * from a real server into tables, overrides and all.
 *
 * The syncs run only when `RIOSOMA_TEST_MONGODB_URL` names a server whose user may create and
 * drop databases, like `mongodb://root:secret@127.0.0.1:27018/?authSource=admin`, and skip
 * otherwise.  The rest runs everywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import {
  AppError,
  MongoConnection,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { FileNetworkError } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { checkMongoSource, mongoNetwork } from './mongodb.js';
import { claimSyncs, runSync } from './sync.js';

const URL = process.env.RIOSOMA_TEST_MONGODB_URL || undefined;
const STRICT = { production: true, automationsAllowPrivateHosts: false };

function connection(patch: Record<string, unknown>) {
  return MongoConnection.parse({ kind: 'mongodb', database: 'sales', ...patch });
}

/** The key and fields a refusal names, or null when there's none. */
function problem(work: () => void): [string, string[]] | null {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return [error.messageKey, Object.keys(error.fields ?? {})];
  }
}

describe('where a MongoDB source may point', () => {
  it('refuses private addresses and unusable connection strings before a source is saved', () => {
    const check = (patch: Record<string, unknown>, secrets: Record<string, string> = {}) =>
      problem(() => checkMongoSource(connection(patch), secrets, STRICT));
    const uri = (connectionString: string, patch: Record<string, unknown> = {}) =>
      check({ address: 'uri', ...patch }, { connectionString });
    expect(check({ host: 'db.example.com' })).toBeNull();
    expect(uri('mongodb+srv://reader:secret@cluster0.example.mongodb.net/sales')).toBeNull();
    expect(check({ host: '10.0.0.5' })).toEqual(['sources.mongodb.blocked', ['host']]);
    expect(check({ host: 'localhost' })).toEqual(['sources.mongodb.blocked', ['host']]);
    // The dot that ends a full name changes nothing about where the name points.
    expect(check({ host: 'db.example.com.' })).toBeNull();
    expect(uri('mongodb://reader:secret@db.example.com.:27017/sales')).toBeNull();
    expect(check({ host: 'localhost.' })).toEqual(['sources.mongodb.blocked', ['host']]);
    expect(uri('mongodb://localhost./sales')).toEqual(['sources.mongodb.blocked', ['connectionString']]);
    expect(check({ host: '10.0.0.5.' })).toEqual(['sources.remote.host', ['host']]);
    expect(uri('mongodb://db.example.com,192.168.1.20:27017/?replicaSet=rs0')).toEqual([
      'sources.mongodb.blocked',
      ['connectionString'],
    ]);
    expect(uri('mongodb://[::1]:27017')).toEqual(['sources.mongodb.blocked', ['connectionString']]);
    expect(uri('https://db.example.com')).toEqual(['sources.mongodb.connectionString', ['connectionString']]);
    // Options that say how to talk to the named servers pass, and the rest never reach the driver.
    expect(
      uri('mongodb+srv://reader:secret@cluster0.example.mongodb.net/sales?retryWrites=true&w=majority'),
    ).toBeNull();
    for (const options of [
      'proxyHost=10.0.0.5&proxyPort=6379',
      'tls=true&tlsCertificateKeyFile=/var/run/secrets/client.pem',
      'authMechanism=MONGODB-AWS&authSource=$external',
      'authMechanism=AWS',
      'servername=other.example.com',
    ])
      expect(uri(`mongodb://db.example.com/sales?${options}`), options).toEqual([
        'sources.mongodb.option',
        ['connectionString'],
      ]);
    expect(check({ host: 'db.example.com/?proxyHost=10.0.0.5&appName=' })).toEqual([
      'sources.remote.host',
      ['host'],
    ]);
    // Behind a tunnel, the bastion is the host the rule applies to, and it reaches one server.
    const ssh = { host: 'bastion.example.com', user: 'tunnel', hostKey: 'ssh-ed25519 AAAA' };
    expect(check({ host: '10.0.0.5', ssh })).toBeNull();
    expect(check({ host: 'db.internal', ssh: { ...ssh, host: '172.16.0.1' } })).toEqual([
      'sources.mongodb.blocked',
      ['sshHost'],
    ]);
    expect(uri('mongodb+srv://cluster0.example.net/', { ssh })).toEqual([
      'sources.mongodb.tunnel',
      ['connectionString'],
    ]);
    // An operator who allows private hosts allows them here too.
    const open = { production: true, automationsAllowPrivateHosts: true };
    expect(problem(() => checkMongoSource(connection({ host: '10.0.0.5' }), {}, open))).toBeNull();
  });

  it('holds every name the driver looks up to the rule, whatever it resolves to', async () => {
    const network = mongoNetwork(STRICT, async (host) =>
      host === 'inside.example.test'
        ? [
            { address: '93.184.216.34', family: 4 },
            { address: '10.1.2.3', family: 4 },
          ]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    await expect(network.lookup('db.example.com')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    const refused = await network.lookup('inside.example.test').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FileNetworkError);
    expect((refused as FileNetworkError).problem).toBe('blocked');
    expect(network.allowsAddress('93.184.216.34')).toBe(true);
    expect(network.allowsAddress('10.1.2.3')).toBe(false);
    expect(network.allowsAddress('::1')).toBe(false);
    // The dot that ends a full name doesn't make a local name anything else.
    const home = async () => [{ address: '127.0.0.1', family: 4 as const }];
    const developing = mongoNetwork({ production: false, automationsAllowPrivateHosts: false }, home);
    for (const name of ['localhost', 'localhost.'])
      await expect(developing.lookup(name), name).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
    await expect(mongoNetwork(STRICT, home).lookup('localhost.')).rejects.toMatchObject({
      problem: 'blocked',
    });
  });
});

describe('MongoDB sources on a running server', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let databaseId: string;
  let mongo: MongoClient | undefined;
  let db: Db | undefined;
  const database = `rio_sync_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    kit = await startTestPostgres();
    // Private hosts are allowed, so a server in Docker on this machine can be reached.
    server = await startServer(kit, 'mongosrc', { automationsAllowPrivateHosts: true });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: newId('database'),
        name: 'Documents',
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
    if (URL) {
      mongo = new MongoClient(URL);
      await mongo.connect();
      db = mongo.db(database);
    }
  }, 60_000);

  afterAll(async () => {
    await db?.dropDatabase().catch(() => undefined);
    await mongo?.close();
    await server?.close();
    await kit?.stop();
  });

  async function createSource(access: 'admins' | 'creators' = 'admins'): Promise<SourceMeta> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: `Mongo ${newId('source')}`,
        connection: { kind: 'mongodb', address: 'uri', database },
        secrets: { connectionString: URL ?? 'mongodb://127.0.0.1:27017' },
        access,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SourceMeta>();
  }

  async function applied(input: Record<string, unknown>) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<CommandBatchResult>().results[0]!;
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  }

  async function sync(tableId: string): Promise<TableMeta> {
    await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    return (await loadTable(server.pool, server.schemas, tableId))!;
  }

  async function rows(tableId: string): Promise<RowData[]> {
    const ids = await query<{ __id: string }>(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
    );
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    return fetchRowsById(
      server.pool,
      server.schemas.data,
      tableId,
      fields,
      ids.rows.map((row) => row.__id),
    );
  }

  async function createTable(sourceId: string, preview: SourcePreview, select: Record<string, unknown>) {
    const tableId = newId('table');
    const field = Object.fromEntries(preview.columns.map((column) => [column.name, newId('field')]));
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: `Orders ${tableId}`,
        source: { sourceId, select, keyColumns: ['_id'], everyMinutes: null },
        fields: ['customer', '_id', 'total', 'placed', 'shipping.city'].map((name) => {
          const column = preview.columns.find((entry) => entry.name === name)!;
          return {
            id: field[name],
            name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: name, sourceType: column.sourceType },
          };
        }),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    return { tableId, field };
  }

  it('refuses a connection string with options a source can’t use when saving, changing, and testing', async () => {
    const send = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) =>
      server.app.inject({ method, url, headers: server.owner.headers, payload });
    const proxied = 'mongodb://db.example.com/sales?proxyHost=10.0.0.5&proxyPort=6379';
    const input = {
      name: 'Proxied',
      connection: { kind: 'mongodb', address: 'uri', database },
      secrets: { connectionString: proxied },
    };
    for (const url of ['/api/sources', '/api/sources/test']) {
      const refused = await send('POST', url, input);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error.messageKey).toBe('sources.mongodb.option');
    }
    const source = await createSource();
    const changed = await send('PATCH', `/api/sources/${source.id}`, {
      secrets: { connectionString: proxied },
    });
    expect(changed.statusCode, changed.body).toBe(422);
    expect(changed.json().error.messageKey).toBe('sources.mongodb.option');
    const smuggled = await send('POST', '/api/sources', {
      name: 'Smuggled',
      connection: { kind: 'mongodb', host: 'db.example.com/?proxyHost=10.0.0.5&appName=', database },
      secrets: {},
    });
    expect(smuggled.statusCode, smuggled.body).toBe(422);
    expect(smuggled.json().error.messageKey).toBe('sources.remote.host');
  });

  it('refuses a filter from anyone but an admin, and on a source that isn’t MongoDB', async () => {
    const source = await createSource('creators');
    const member = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'creator')`,
    );
    const filtered = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: member.headers,
      payload: { select: { kind: 'object', object: { schema: null, name: 'orders' }, filter: '{"a": 1}' } },
    });
    expect(filtered.json()).toMatchObject({ error: { messageKey: 'sources.filterAdminsOnly' } });
    const api = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: 'An API',
        connection: { kind: 'rest', baseUrl: 'https://api.example.com', endpoints: [{ name: 'Orders' }] },
        secrets: {},
      },
    });
    const elsewhere = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${api.json<SourceMeta>().id}/preview`,
      headers: server.owner.headers,
      payload: { select: { kind: 'object', object: { schema: null, name: 'Orders' }, filter: '{"a": 1}' } },
    });
    expect(elsewhere.json()).toMatchObject({ error: { messageKey: 'sources.filterUnsupported' } });
    const javascript = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: {
        select: { kind: 'object', object: { schema: null, name: 'orders' }, filter: '{"$where": "true"}' },
      },
    });
    // JavaScript never gets as far as the source, since the filter doesn't read as one.
    expect(javascript.statusCode).toBe(422);
  });

  it.skipIf(!URL)('tests a source, and lists its collections', async () => {
    await db!.collection('orders').insertOne({ _id: 'seed' as never, customer: 'Seed' });
    const source = await createSource();
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['collections', 'ok'],
      ['document', 'ok'],
    ]);
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>()).toContainEqual(
      expect.objectContaining({ name: 'orders', type: 'collection' }),
    );
    await db!.collection('orders').deleteMany({});
  });

  it.skipIf(!URL)(
    'syncs a collection, keeps an override through the next sync, and filters another',
    async () => {
      const { Decimal128, ObjectId } = await import('mongodb');
      const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
      const order = (index: number, customer: string, total: string, city: string) => ({
        _id: ids[index]!,
        customer,
        total: Decimal128.fromString(total),
        placed: new Date(Date.UTC(2026, 8, index + 1, 9, 30)),
        shipping: { city },
      });
      const orders = db!.collection('orders');
      await orders.insertMany([
        order(0, 'Ada', '10.50', 'London'),
        order(1, 'Grace', '20.00', 'Arlington'),
        order(2, 'Linus', '30.25', 'Helsinki'),
      ]);
      const source = await createSource();
      expect(JSON.stringify(source)).not.toContain('rootpass');
      const select = { kind: 'object', object: { schema: null, name: 'orders' } };
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/preview`,
        headers: server.owner.headers,
        payload: { select },
      });
      expect(response.statusCode, response.body).toBe(200);
      const preview = response.json<SourcePreview>();
      expect(preview.keyCandidates).toEqual([['_id']]);
      expect(preview.rowEstimate).toBe(3);
      const { tableId, field } = await createTable(source.id, preview, select);

      const first = await sync(tableId);
      expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
        state: 'idle',
        stats: { added: 3 },
      });
      const grace = (await rows(tableId)).find((row) => row.values[field._id!] === ids[1]!.toHexString())!;
      expect(grace.values).toMatchObject({
        [field.customer!]: 'Grace',
        [field.total!]: '20.00',
        [field.placed!]: '2026-09-02T09:30:00.000Z',
        [field['shipping.city']!]: 'Arlington',
      });
      await applied({
        kind: 'record.update',
        tableId,
        records: [{ id: grace.id, values: { [field.customer!]: 'Grace Hopper' } }],
      });

      // The source changes: Grace's name and total move, Linus leaves, and Katherine arrives.
      await orders.updateOne(
        { _id: ids[1]! },
        { $set: { customer: 'G. Hopper', total: Decimal128.fromString('25.00') } },
      );
      await orders.deleteOne({ _id: ids[2]! });
      const katherine = new ObjectId();
      await orders.insertOne({ ...order(0, 'Katherine', '40.00', 'Hampton'), _id: katherine });
      const second = await sync(tableId);
      expect(second.source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
      const after = await rows(tableId);
      expect(after.map((row) => row.values[field._id!])).toEqual([
        ids[0]!.toHexString(),
        ids[1]!.toHexString(),
        katherine.toHexString(),
      ]);
      const kept = after.find((row) => row.id === grace.id)!;
      expect(kept.values).toMatchObject({ [field.customer!]: 'Grace Hopper', [field.total!]: '25.00' });
      expect(kept.overrides![field.customer!]).toMatchObject({ source: 'G. Hopper' });

      // A filtered table reads only the documents its filter matches.
      const filtered = { ...select, filter: '{"shipping.city": {"$in": ["London", "Hampton"]}}' };
      const narrowed = await server.app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/preview`,
        headers: server.owner.headers,
        payload: { select: filtered },
      });
      expect(narrowed.json<SourcePreview>().rowEstimate).toBe(2);
      const other = await createTable(source.id, narrowed.json<SourcePreview>(), filtered);
      await sync(other.tableId);
      expect((await rows(other.tableId)).map((row) => row.values[other.field.customer!]).sort()).toEqual([
        'Ada',
        'Katherine',
      ]);

      // The connection string is nowhere: not in the change history, the sync status, or the list.
      const changes = await query<{ body: unknown }>(
        server.pool,
        sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
      );
      const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
      for (const text of [JSON.stringify(changes.rows), JSON.stringify(second.source), listed.body])
        expect(text).not.toContain(URL!);
    },
  );
});

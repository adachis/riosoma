/**
 * MongoDB against a real server.  It runs only when `RIOSOMA_TEST_MONGODB_URL` names one that
 * signs in as a user who may create and drop databases, like
 * `mongodb://root:secret@127.0.0.1:27018/?authSource=admin` for a server in Docker, and skips
 * otherwise.
 *
 * The suite fills a database of its own with every type the connector reads, a collection whose
 * documents disagree about their fields, and a view, reads them through the connector, and drops
 * the database.
 */
import { MongoConnection, type SourceSelect } from '@riosoma/contracts';
import {
  Binary,
  BSONRegExp,
  Decimal128,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
  UUID,
  type Db,
} from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError, type ConnectorContext, type SourceRow } from '@riosoma/connectors/internal/types.js';
import { parseConnectionString } from '@riosoma/connectors/internal/mongodb/address.js';
import { createMongoConnector } from './connector.js';

const url = process.env.RIOSOMA_TEST_MONGODB_URL || undefined;

const ADA = new ObjectId('65f1c2a4b3d2e1f0a9b8c7d6');
const GRACE = new ObjectId('65f1c2a4b3d2e1f0a9b8c7d7');
const UID = new UUID('2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d');

describe.skipIf(!url)('mongodb against a real server', () => {
  const database = `rio_test_${Math.random().toString(36).slice(2, 10)}`;
  const connector = createMongoConnector();
  let admin: MongoClient;
  let db: Db;

  const context = (patch: Record<string, unknown> = {}, secrets = { connectionString: url ?? '' }) =>
    ({
      connection: MongoConnection.parse({ kind: 'mongodb', address: 'uri', database, ...patch }),
      secrets,
      timeoutMs: 20_000,
    }) satisfies ConnectorContext;
  const object = (name: string, filter?: string): SourceSelect => ({
    kind: 'object',
    object: { schema: null, name },
    ...(filter === undefined ? {} : { filter }),
  });
  async function readAll(ctx: ConnectorContext, select: SourceSelect, columns: string[], types = {}) {
    const rows: SourceRow[] = [];
    for await (const batch of connector.read(ctx, select, {
      columns,
      types,
      keyColumns: ['_id'],
      batchSize: 2,
    }))
      rows.push(...batch);
    return rows;
  }
  async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
    const error = await work.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }

  beforeAll(async () => {
    admin = new MongoClient(url ?? '');
    await admin.connect();
    db = admin.db(database);
    await db.collection('things').insertMany([
      {
        _id: ADA,
        name: 'Ada',
        count: 3,
        ratio: 1.5,
        big: Long.fromString('9007199254740993'),
        small: Long.fromNumber(42),
        price: Decimal128.fromString('19.990'),
        at: new Date('2026-09-27T12:34:56.789Z'),
        flag: true,
        uid: UID,
        blob: new Binary(Buffer.from('abc')),
        stamp: new Timestamp({ t: 1_790_000_000, i: 1 }),
        pattern: new BSONRegExp('^a+', 'i'),
        tags: ['north', 'east'],
        address: { city: 'Paris', geo: { lat: 48.85, lng: 2.35 } },
        items: [{ sku: 'x1', qty: 2 }],
      },
      {
        _id: GRACE,
        name: 'Grace',
        count: 5,
        ratio: 2,
        big: Long.fromString('-9007199254740995'),
        small: Long.fromNumber(7),
        price: Decimal128.fromString('1.23E+5'),
        at: new Date('2026-01-02T00:00:00Z'),
        flag: false,
        uid: new UUID('00000000-0000-4000-8000-000000000001'),
        blob: new Binary(Buffer.from('xyz')),
        stamp: new Timestamp({ t: 1_790_000_060, i: 2 }),
        pattern: new BSONRegExp('b$', ''),
        tags: [],
        address: { city: 'Lyon' },
        items: [],
      },
    ]);
    // Documents that disagree: fields come and go, and one holds a different type.
    await db.collection<{ _id: number } & Record<string, unknown>>('people').insertMany([
      { _id: 1, name: 'Ada', age: 36, email: 'ada@example.com' },
      { _id: 2, name: 'Grace', city: 'Arlington' },
      { _id: 3, name: 'Linus', age: 'unknown', email: 'linus@example.com' },
      { _id: 4, name: 'Katherine', age: 17 },
    ]);
    await db.createCollection('adults', {
      viewOn: 'people',
      pipeline: [{ $match: { age: { $gte: 18 } } }, { $project: { name: 1, age: 1 } }],
    });
  }, 60_000);

  afterAll(async () => {
    await db?.dropDatabase().catch(() => undefined);
    await admin?.close();
  });

  it('climbs every step of the test and names the server', async () => {
    const result = await connector.test(context());
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['collections', 'ok'],
      ['document', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^MongoDB \d+\.\d+/);
  });

  it('lists the collections and views, with sizes for collections', async () => {
    const objects = await connector.listObjects(context());
    expect(objects.map((entry) => [entry.name, entry.type, entry.rowEstimate])).toEqual([
      ['adults', 'view', null],
      ['people', 'collection', 4],
      ['things', 'collection', 2],
    ]);
  });

  it('reads every type, and flattens nested documents one level down', async () => {
    const preview = await connector.preview(context(), object('things'), 10);
    const columns = Object.fromEntries(
      preview.columns.map((column) => [column.name, [column.sourceType, column.suggested?.type ?? null]]),
    );
    expect(columns).toEqual({
      _id: ['objectId', 'text'],
      name: ['string', 'text'],
      count: ['number', 'number'],
      ratio: ['number', 'number'],
      big: ['long', 'text'],
      small: ['number', 'number'],
      price: ['decimal', 'text'],
      at: ['date', 'date'],
      flag: ['boolean', 'checkbox'],
      uid: ['uuid', 'text'],
      blob: ['binary', null],
      stamp: ['timestamp', 'date'],
      pattern: ['regex', 'text'],
      tags: ['list', 'text'],
      'address.city': ['string', 'text'],
      'address.geo': ['json', 'longText'],
      // An empty list reads as no value, like an API's, so the column holds JSON and nothing else.
      items: ['mixed', 'longText'],
    });
    expect(preview.columns.find((column) => column.name === 'price')!.alternatives).toContain('number');
    expect(preview.rowEstimate).toBe(2);
    const names = preview.columns.map((column) => column.name);
    const ada = Object.fromEntries(names.map((name, index) => [name, preview.rows[0]![index]]));
    expect(ada).toEqual({
      _id: '65f1c2a4b3d2e1f0a9b8c7d6',
      name: 'Ada',
      count: 3,
      ratio: 1.5,
      big: '9007199254740993',
      small: 42,
      price: '19.990',
      at: '2026-09-27T12:34:56.789Z',
      flag: true,
      uid: '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
      blob: null,
      stamp: '2026-09-21T14:13:20.000Z',
      pattern: '/^a+/i',
      tags: 'north, east',
      'address.city': 'Paris',
      'address.geo': '{"lat":48.85,"lng":2.35}',
      items: '[{"sku":"x1","qty":2}]',
    });
    expect(preview.rows[1]![names.indexOf('price')]).toBe('123000');
    expect(preview.rows[1]![names.indexOf('big')]).toBe('-9007199254740995');
    expect(await connector.keyCandidates(context(), { schema: null, name: 'things' })).toEqual([['_id']]);
  });

  it('flattens deeper and keeps lists as JSON when the source says so', async () => {
    const columns = await connector.describe(context({ flattenDepth: 2, arrays: 'json' }), object('things'));
    const types = Object.fromEntries(columns.map((column) => [column.name, column.suggested?.type ?? null]));
    expect(types).toMatchObject({
      'address.geo.lat': 'number',
      'address.geo.lng': 'number',
      tags: 'longText',
    });
    const rows = await readAll(
      context({ flattenDepth: 2, arrays: 'json' }),
      object('things'),
      ['tags', 'address.geo.lat', 'price'],
      { tags: 'longText', 'address.geo.lat': 'number', price: 'number' },
    );
    expect(rows[0]!.values).toEqual({ tags: '["north","east"]', 'address.geo.lat': 48.85, price: 19.99 });
    expect(rows[1]!.values).toEqual({ tags: '[]', 'address.geo.lat': null, price: 123000 });
  });

  it('reads a collection whose documents disagree about their fields', async () => {
    const columns = await connector.describe(context(), object('people'));
    expect(columns.map((column) => [column.name, column.sourceType, column.suggested?.type])).toEqual([
      ['_id', 'number', 'number'],
      ['name', 'string', 'text'],
      ['age', 'mixed', 'text'],
      ['email', 'string', 'email'],
      ['city', 'string', 'text'],
    ]);
    const rows = await readAll(context(), object('people'), ['name', 'age', 'city'], { age: 'text' });
    expect(rows.map((row) => [row.key, row.values])).toEqual([
      ['[1]', { name: 'Ada', age: '36', city: null }],
      ['[2]', { name: 'Grace', age: null, city: 'Arlington' }],
      ['[3]', { name: 'Linus', age: 'unknown', city: null }],
      ['[4]', { name: 'Katherine', age: '17', city: null }],
    ]);
  });

  it('reads a view, and offers its `_id` as the key', async () => {
    const preview = await connector.preview(context(), object('adults'), 10);
    expect(preview.columns.map((column) => column.name)).toEqual(['_id', 'name', 'age']);
    expect(preview.rowEstimate).toBe(1);
    expect(await connector.keyCandidates(context(), { schema: null, name: 'adults' })).toEqual([['_id']]);
    const rows = await readAll(context(), object('adults'), ['name']);
    expect(rows.map((row) => row.values.name)).toEqual(['Ada']);
  });

  it('runs a filter as a query document, and refuses JavaScript in one', async () => {
    const filtered = object('people', '{"name": {"$in": ["Grace", "Katherine"]}}');
    const preview = await connector.preview(context(), filtered, 10);
    expect(preview.rowEstimate).toBe(2);
    const rows = await readAll(context(), filtered, ['name']);
    expect(rows.map((row) => row.values.name)).toEqual(['Grace', 'Katherine']);
    const byId = await readAll(context(), object('things', `{"_id": {"$oid": "${GRACE.toHexString()}"}}`), [
      'name',
    ]);
    expect(byId.map((row) => row.values.name)).toEqual(['Grace']);
    for (const filter of [
      '{"$where": "true"}',
      '{"$expr": {"$function": {"body": "1", "args": [], "lang": "js"}}}',
    ])
      expect((await refusal(connector.describe(context(), object('people', filter)))).messageKey).toBe(
        'sources.mongodb.javascript',
      );
    expect((await refusal(connector.describe(context(), object('people', '{"name": ')))).messageKey).toBe(
      'sources.mongodb.filter',
    );
  });

  it('says a collection is missing rather than reading it as empty', async () => {
    const missing = await refusal(connector.describe(context(), object('nothing here')));
    expect(missing.messageKey).toBe('sources.sync.objectMissing');
    expect(missing.params).toEqual({ object: 'nothing here' });
  });

  it('says a wrong password was refused, without repeating it', async () => {
    const address = parseConnectionString(url ?? '')!;
    const wrong = (url ?? '').replace(
      `:${encodeURIComponent(address.password ?? '')}@`,
      ':not-the-password@',
    );
    const tested = await connector.test(context({}, { connectionString: wrong }));
    expect(tested.ok).toBe(false);
    expect(tested.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.mongodb.denied',
    });
    expect(JSON.stringify(tested)).not.toContain('not-the-password');
    const refused = await refusal(
      connector.describe(context({}, { connectionString: wrong }), object('people')),
    );
    expect(refused.messageKey).toBe('sources.mongodb.denied');
    expect(refused.detail ?? '').not.toContain('not-the-password');
  });

  it('signs in with a host, a user, and a password as well as with a connection string', async () => {
    const address = parseConnectionString(url ?? '')!;
    const seed = address.hosts[0]!;
    const ctx = context(
      {
        address: 'host',
        host: seed.host,
        port: seed.port,
        user: address.user,
        authSource: address.options.get('authSource') ?? 'admin',
      },
      { password: address.password ?? '' } as never,
    );
    const rows = await readAll(ctx, object('people'), ['name']);
    expect(rows).toHaveLength(4);
  });

  it('refuses a server on a private network when the rule says so', async () => {
    const strict = createMongoConnector({
      network: {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        allowsAddress: () => false,
      },
    });
    const refused = await refusal(strict.describe(context(), object('people')));
    expect(refused.messageKey).toBe('sources.mongodb.blocked');
    const tested = await strict.test(context());
    expect(tested.steps.at(-1)).toMatchObject({ status: 'failed', messageKey: 'sources.mongodb.blocked' });
  });
});

/**
 * MongoDB sources without a server: reading connection strings, turning documents into records,
 * and the filters a synced table may run.  `mongodb.live.test.ts` covers a real server.
 */
import { MongoConnection } from '@riosoma/contracts';
import {
  Binary,
  BSONRegExp,
  Code,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from 'mongodb';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@riosoma/connectors/internal/types.js';
import { cellsOf, Sampler } from '@riosoma/connectors/internal/rest/records.js';
import { FileNetworkError } from '@riosoma/connectors/internal/files/network.js';
import {
  asksForTls,
  parseConnectionString,
  throughTunnel,
} from '@riosoma/connectors/internal/mongodb/address.js';
import { createMongoConnector } from './connector.js';
import { documentRecord, plainDecimal } from '@riosoma/connectors/internal/mongodb/documents.js';
import { parseFilter } from './filter.js';

describe('connection strings', () => {
  it('reads the hosts, the sign-in, the database, and the options', () => {
    const address = parseConnectionString(
      'mongodb://reader:p%40ss:word@DB1.example.com:27018,db2.example.com,[::1]:27020/sales?replicaSet=rs0&tls=true',
    )!;
    expect(address).toMatchObject({
      srv: false,
      hosts: [
        { host: 'db1.example.com', port: 27018 },
        { host: 'db2.example.com', port: 27017 },
        { host: '::1', port: 27020 },
      ],
      user: 'reader',
      password: 'p@ss:word',
      database: 'sales',
    });
    expect(address.options.get('replicaSet')).toBe('rs0');
    expect(asksForTls(address)).toBe(true);
    const atlas = parseConnectionString('mongodb+srv://cluster0.abc.mongodb.net/?appName=x')!;
    expect(atlas).toMatchObject({ srv: true, hosts: [{ host: 'cluster0.abc.mongodb.net' }], user: null });
    // A DNS seed list turns a secure connection on unless the string says otherwise.
    expect(asksForTls(atlas)).toBe(true);
    expect(asksForTls(parseConnectionString('mongodb+srv://cluster0.example.com/?tls=false')!)).toBe(false);
    expect(asksForTls(parseConnectionString('mongodb://db.example.com')!)).toBe(false);
    // A full name may end in a dot, which the checks leave off when they compare names.
    expect(parseConnectionString('mongodb://DB.Example.com.:27018,db2.example.com./sales')).toMatchObject({
      hosts: [
        { host: 'db.example.com', port: 27018 },
        { host: 'db2.example.com', port: 27017 },
      ],
    });
    expect(parseConnectionString('mongodb+srv://cluster0.abc.mongodb.net./')).toMatchObject({
      srv: true,
      hosts: [{ host: 'cluster0.abc.mongodb.net' }],
    });
  });

  it('refuses what isn’t a connection string a source can use', () => {
    for (const text of [
      'postgres://db.example.com/sales',
      'mongodb://',
      'mongodb+srv://a.example.com,b.example.com/',
      'mongodb+srv://cluster0.example.com:27017/',
      'mongodb://%2Ftmp%2Fmongodb-27017.sock',
      'mongodb://db.example.com:70000',
      'mongodb://::1/sales',
      'mongodb://user:%zz@db.example.com',
      // A host the driver would read differently than the check does.
      'mongodb://10.0.0.5#db.example.com/sales',
      'mongodb://db.example.com#x:27017/sales',
      // One dot ends a full name.  More than one, a dot alone, a dot after an address, and a
      // socket file with a dot after it aren't host names.
      'mongodb://db.example.com../sales',
      'mongodb://./sales',
      'mongodb://127.0.0.1./sales',
      'mongodb://mongodb-27017.sock./sales',
      // A name outside ASCII is written in its ASCII form.
      'mongodb://b\u00fccher.example/sales',
    ])
      expect(parseConnectionString(text), text).toBeNull();
    expect(parseConnectionString('mongodb://xn--bcher-kva.example/sales')).not.toBeNull();
  });

  it('reads only the options that say how to talk to the servers the string names', () => {
    for (const options of [
      'retryWrites=true&w=majority&appName=Cluster0',
      'authSource=admin&replicaSet=rs0&tls=true&readPreference=secondaryPreferred',
      'authMechanism=SCRAM-SHA-256&ssl=true&directConnection=true',
      'AUTHMECHANISM=scram-sha-1&connectTimeoutMS=5000&serverSelectionTimeoutMS=5000&maxIdleTimeMS=1000',
      'compressors=zlib&readPreferenceTags=dc:east&readPreferenceTags=&heartbeatFrequencyMS=10000',
    ])
      expect(parseConnectionString(`mongodb://db.example.com/sales?${options}`), options).not.toBeNull();
    // Options that send the connection through another address, read files on this machine, sign
    // in with this machine's own identity, or change which server the certificate must name.
    for (const options of [
      'proxyHost=10.0.0.5',
      'proxyHost=10.0.0.5&proxyPort=1080&proxyUsername=a&proxyPassword=b',
      'PROXYHOST=10.0.0.5',
      '%70roxyHost=10.0.0.5',
      'tls=true&tlsCAFile=/etc/ssl/cert.pem',
      'tlsCertificateKeyFile=/var/run/secrets/client.pem',
      'tlsCertificateKeyFilePassword=secret',
      'tlsCRLFile=/etc/ssl/crl.pem',
      'tlsAllowInvalidCertificates=true',
      'tlsAllowInvalidHostnames=true',
      'tlsInsecure=true',
      'servername=other.example.com',
      'authMechanism=MONGODB-AWS',
      'authMechanism=mongodb-aws',
      'authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:azure',
      'authMechanism=GSSAPI',
      'authMechanism=MONGODB-X509',
      'authMechanism=SCRAM-SHA-256&authMechanism=MONGODB-AWS',
      'authMechanismProperties=AWS_SESSION_TOKEN:token',
      'srvServiceName=other',
      'loadBalanced=true',
      'mongodbLogPath=stderr',
      'localAddress=127.0.0.1',
      'unknownOption=1',
    ])
      expect(parseConnectionString(`mongodb://db.example.com/sales?${options}`), options).toBeNull();
  });

  it('puts a tunnel’s address in place of the one host, keeping the sign-in and options', () => {
    const text = 'mongodb://reader:secret@db.internal:27017/sales?authSource=admin';
    const address = parseConnectionString(text)!;
    expect(throughTunnel(text, address, '127.0.0.1', 40_001)).toBe(
      'mongodb://reader:secret@127.0.0.1:40001/sales?authSource=admin',
    );
  });
});

describe('documents', () => {
  const flat = { flattenDepth: 1, arrays: 'text' as const };

  it('reads each of MongoDB’s own types as text, an instant, an exact number, or nothing', () => {
    const id = new ObjectId('65f1c2a4b3d2e1f0a9b8c7d6');
    const uuid = new UUID('2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d');
    const record = documentRecord({
      _id: id,
      at: new Date('2026-09-27T12:34:56.789Z'),
      price: Decimal128.fromString('19.990'),
      scientific: Decimal128.fromString('1.23E+5'),
      tiny: Decimal128.fromString('1E-7'),
      nan: Decimal128.fromString('NaN'),
      big: Long.fromString('9007199254740993'),
      uid: new Binary(uuid.buffer, 4),
      blob: new Binary(Buffer.from('abc')),
      stamp: new Timestamp({ t: 1_790_000_000, i: 3 }),
      pattern: new BSONRegExp('^a+', 'i'),
      code: new Code('return 1'),
      low: new MinKey(),
      high: new MaxKey(),
      int: new Int32(7),
      double: new Double(2.5),
      ids: [id, id],
      nested: {
        at: new Date('2026-01-02T00:00:00Z'),
        big: Long.fromString('9007199254740993'),
        blob: new Binary(Buffer.from('x')),
      },
    });
    const cells = cellsOf(record, flat);
    expect(Object.fromEntries(cells)).toEqual({
      _id: '65f1c2a4b3d2e1f0a9b8c7d6',
      at: { date: '2026-09-27T12:34:56.789Z' },
      price: '19.990',
      scientific: '123000',
      tiny: '0.0000001',
      nan: null,
      big: '9007199254740993',
      uid: '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
      blob: null,
      stamp: { date: '2026-09-21T14:13:20.000Z' },
      pattern: '/^a+/i',
      code: 'return 1',
      low: 'MinKey',
      high: 'MaxKey',
      int: 7,
      double: 2.5,
      ids: '65f1c2a4b3d2e1f0a9b8c7d6, 65f1c2a4b3d2e1f0a9b8c7d6',
      'nested.at': { date: '2026-01-02T00:00:00.000Z' },
      'nested.big': '9007199254740993',
      'nested.blob': null,
    });
    // Deeper than the flattening goes, the same values take their JSON forms, and binary data stays out.
    const shallow = cellsOf(record, { flattenDepth: 0, arrays: 'json' });
    expect(shallow.get('nested')).toBe('{"at":"2026-01-02T00:00:00.000Z","big":9007199254740993}');
    expect(shallow.get('ids')).toBe('["65f1c2a4b3d2e1f0a9b8c7d6","65f1c2a4b3d2e1f0a9b8c7d6"]');
  });

  it('keeps an `_id` that is itself a document whole, as JSON', () => {
    const cells = cellsOf(
      documentRecord({ _id: { region: 'eu', n: Long.fromNumber(4) }, name: 'Ada' }),
      flat,
    );
    expect(cells.get('_id')).toBe('{"region":"eu","n":4}');
    expect(cells.has('_id.region')).toBe(false);
  });

  it('types columns from the sample, with exact numbers as text and binary data left out', () => {
    const sampler = new Sampler({ flattenDepth: 1, arrays: 'text' });
    for (const n of [1, 2, 3])
      sampler.add(
        documentRecord({
          _id: new ObjectId(),
          price: Decimal128.fromString(`${n}.50`),
          at: new Date(Date.UTC(2026, 0, n)),
          blob: new Binary(Buffer.from([n])),
          digits: new ObjectId(`${n}`.repeat(24)),
        }),
      );
    const columns = Object.fromEntries(sampler.describe().map((entry) => [entry.column.name, entry.column]));
    expect(columns._id).toMatchObject({ sourceType: 'objectId', suggested: { type: 'text' } });
    // An ID that happens to be all digits is still an ID.
    expect(columns.digits).toMatchObject({ sourceType: 'objectId', suggested: { type: 'text' } });
    expect(columns.price).toMatchObject({
      sourceType: 'decimal',
      suggested: { type: 'text' },
      alternatives: ['number', 'longText'],
    });
    expect(columns.at).toMatchObject({
      sourceType: 'date',
      suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
    });
    expect(columns.blob).toEqual({
      name: 'blob',
      sourceType: 'binary',
      nullable: true,
      suggested: null,
      alternatives: [],
    });
  });

  it('writes a decimal out in full', () => {
    expect(plainDecimal('1.23E+5')).toBe('123000');
    expect(plainDecimal('-4.5E-3')).toBe('-0.0045');
    expect(plainDecimal('1.0E+1')).toBe('10');
    expect(plainDecimal('12.340')).toBe('12.340');
    expect(plainDecimal('1E+6000')).toBe('1E+6000');
  });
});

describe('filters', () => {
  it('reads Extended JSON, so IDs and dates mean what they mean in MongoDB’s own tools', () => {
    const filter = parseFilter(
      '{"_id": {"$oid": "65f1c2a4b3d2e1f0a9b8c7d6"}, "at": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}, "n": {"$in": [1, 2]}}',
    );
    expect(filter._id).toBeInstanceOf(ObjectId);
    expect((filter.at as { $gte: unknown }).$gte).toBeInstanceOf(Date);
    expect(filter.n).toEqual({ $in: [1, 2] });
    expect(parseFilter(undefined)).toEqual({});
  });

  it('refuses JavaScript anywhere in a filter, and anything that isn’t one JSON object', () => {
    const refusal = (text: string) => {
      try {
        parseFilter(text);
        return null;
      } catch (error) {
        return error instanceof ConnectorError ? error.messageKey : String(error);
      }
    };
    for (const text of [
      '{"$where": "this.a > 1"}',
      '{"$or": [{"a": 1}, {"$where": "sleep(100)"}]}',
      '{"$expr": {"$function": {"body": "function() { return true }", "args": [], "lang": "js"}}}',
      '{"a": {"$code": "function() {}"}}',
    ])
      expect(refusal(text), text).toBe('sources.mongodb.javascript');
    for (const text of ['', '[1, 2]', '"text"', '{"a": ', 'null'])
      if (text) expect(refusal(text), text).toBe('sources.mongodb.filter');
  });
});

describe('the private-network rule', () => {
  const strict = createMongoConnector({
    network: {
      lookup: async (host) => {
        if (host === 'db.example.test')
          throw new FileNetworkError('blocked', `${host} is on a private network`);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      allowsAddress: (address) => !/^(10\.|127\.|::1$)/.test(address),
    },
  });
  const context = (patch: Record<string, unknown>, secrets = {}) => ({
    connection: MongoConnection.parse({ kind: 'mongodb', database: 'sales', ...patch }),
    secrets,
    timeoutMs: 5_000,
  });
  const select = { kind: 'object' as const, object: { schema: null, name: 'orders' } };

  it('refuses an address written outright, and a name that resolves somewhere private, before connecting', async () => {
    for (const ctx of [
      context({ address: 'uri' }, { connectionString: 'mongodb://10.1.2.3:27017/sales' }),
      context({ host: '127.0.0.1' }),
      context({ host: '[::1]' }),
      context({ host: 'db.example.test' }),
    ]) {
      const error = await strict.describe(ctx, select).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).messageKey).toBe('sources.mongodb.blocked');
    }
    const tested = await strict.test(context({ host: 'db.example.test' }));
    expect(tested.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.mongodb.blocked' }),
    ]);
  });

  it('refuses a connection string whose options would send the driver somewhere else first', async () => {
    // A proxy written as an address never goes through a lookup, so the driver would reach it
    // without the rule being asked.  The listener stands in for a service on a private network.
    let reached = 0;
    const inside = createServer((socket) => {
      reached += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => inside.listen(0, '127.0.0.1', resolve));
    const { port } = inside.address() as { port: number };
    try {
      const proxied = `mongodb://db.public.example/sales?proxyHost=127.0.0.1&proxyPort=${port}`;
      const ctx = { ...context({ address: 'uri' }, { connectionString: proxied }), timeoutMs: 1_500 };
      const error = await strict.describe(ctx, select).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).messageKey).toBe('sources.mongodb.option');
      const tested = await strict.test(ctx);
      expect(tested.steps).toEqual([
        expect.objectContaining({ status: 'failed', messageKey: 'sources.mongodb.option' }),
      ]);
      // A host that carries options of its own is refused the same way.
      const smuggled = {
        ...context({ host: `db.public.example/?proxyHost=127.0.0.1&proxyPort=${port}&appName=` }),
        timeoutMs: 1_500,
      };
      const refused = await strict.describe(smuggled, select).catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(ConnectorError);
      expect((refused as ConnectorError).messageKey).toBe('sources.remote.host');
      expect((await strict.test(smuggled)).steps).toEqual([
        expect.objectContaining({ status: 'failed', messageKey: 'sources.remote.host' }),
      ]);
      expect(reached).toBe(0);
    } finally {
      await new Promise<void>((resolve) => inside.close(() => resolve()));
    }
  });

  it('holds a tunnel’s bastion to the rule, and not the server behind it', async () => {
    const ssh = { host: '10.0.0.9', user: 'tunnel', hostKey: 'ssh-ed25519 AAAA' };
    const tested = await strict.test(context({ host: '10.0.0.5', ssh }, { sshPrivateKeyPem: 'key-text' }));
    expect(tested.steps).toEqual([
      expect.objectContaining({ step: 'tunnel', status: 'failed', messageKey: 'sources.mongodb.blocked' }),
    ]);
  });
});

describe('SSH tunnels', () => {
  const connector = createMongoConnector();
  const ssh = { host: '127.0.0.1', user: 'tunnel', hostKey: 'not-a-pinned-key' };

  it('stops at a tunnel that won’t open, without repeating its key', async () => {
    const tested = await connector.test({
      connection: MongoConnection.parse({ kind: 'mongodb', host: 'db.internal', database: 'sales', ssh }),
      secrets: { sshPrivateKeyPem: 'secret-private-key' },
      timeoutMs: 5_000,
    });
    expect(tested.steps).toEqual([
      expect.objectContaining({ step: 'tunnel', status: 'failed', messageKey: 'sources.test.tunnel' }),
    ]);
    expect(JSON.stringify(tested)).not.toContain('secret-private-key');
  });

  it('refuses a connection string a tunnel can’t carry before asking the bastion', async () => {
    for (const connectionString of [
      'mongodb://a.internal,b.internal/sales',
      'mongodb+srv://cluster0.example.mongodb.net/sales',
    ]) {
      const tested = await connector.test({
        connection: MongoConnection.parse({ kind: 'mongodb', address: 'uri', database: 'sales', ssh }),
        secrets: { connectionString, sshPrivateKeyPem: 'secret-private-key' },
        timeoutMs: 5_000,
      });
      expect(tested.steps, connectionString).toEqual([
        expect.objectContaining({ status: 'failed', messageKey: 'sources.mongodb.tunnel' }),
      ]);
    }
  });
});

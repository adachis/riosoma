import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { createServer as createPlainServer, type Socket } from 'node:net';
import { createSecureContext, createServer as createTlsServer } from 'node:tls';
import { createNode } from 'oracledb/lib/thin/sqlnet/connStrategy.js';
import { describe, expect, it } from 'vitest';
import { FieldOptions, SourceConnection } from '@riosoma/contracts';
import { makeConnector } from '@riosoma/connectors/internal/common.js';
import { liveError } from '@riosoma/connectors/internal/live/reader.js';
import { LEGACY_REFUSED, NOT_ENCRYPTED, attachFirebird, firebirdType } from './firebird.js';
import { connectorFor } from '@riosoma/connectors';
import './register.test-support.js';
import type oracledb from 'oracledb';
import { REDIRECT_REFUSED, ROUTE_UNUSED, connectOverRoute, oracleDescriptor, oracleType } from './oracle.js';
import { selfSigned, walletContent, walletParts } from '@riosoma/connectors/internal/oracle-tls.js';
import { projection, querySql, quote } from '@riosoma/connectors/internal/sql.js';
import { ConnectorError } from '@riosoma/connectors/internal/types.js';
import { column, keyValue } from '@riosoma/connectors/internal/values.js';

/** A self-signed certificate for `name`, with its key encrypted when there's a passphrase. */
function certificateFor(name: string, passphrase?: string): { certificate: string; key: string } {
  const { cert, key } = selfSigned(name);
  return {
    certificate: cert,
    key: passphrase
      ? String(
          createPrivateKey(key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }),
        )
      : key,
  };
}

describe('Oracle and Firebird types', () => {
  it('names Oracle columns the way their metadata describes them', () => {
    const number = { dbType: { num: 2010, name: 'DB_TYPE_NUMBER' }, dbTypeName: 'NUMBER' };
    expect(oracleType({ ...number, precision: 20, scale: 0 })).toBe('number(20)');
    expect(oracleType({ ...number, precision: 30, scale: 4 })).toBe('number(30,4)');
    expect(oracleType({ ...number, precision: 0, scale: -127 })).toBe('number');
    expect(oracleType({ ...number, precision: 126, scale: -127 })).toBe('float(126)');
    expect(oracleType({ ...number, precision: 0, scale: 0 })).toBe('number(*,0)');
    expect(oracleType({ ...number, precision: 0, scale: 2 })).toBe('number(*,2)');
    const varchar = { dbType: { num: 2001, name: 'DB_TYPE_VARCHAR' }, dbTypeName: 'VARCHAR2', byteSize: 80 };
    expect(oracleType(varchar)).toBe('varchar2(80)');
    expect(
      oracleType({
        dbType: { num: 2014, name: 'DB_TYPE_TIMESTAMP_TZ' },
        dbTypeName: 'TIMESTAMP WITH TIME ZONE',
      }),
    ).toBe('timestamp(6) with time zone');
    expect(oracleType({ dbType: { num: 2017, name: 'DB_TYPE_CLOB' }, dbTypeName: 'CLOB' })).toBe('clob');
  });

  it('names Firebird columns by their storage, charset, and scale', () => {
    expect(firebirdType({ type: 580, subType: 0, scale: 0 })).toBe('bigint');
    expect(firebirdType({ type: 581, subType: 1, scale: -4 })).toBe('numeric(18,4)');
    expect(firebirdType({ type: 496, subType: 2, scale: -2 })).toBe('decimal(9,2)');
    expect(firebirdType({ type: 32752, subType: 0, scale: 0 })).toBe('int128');
    expect(firebirdType({ type: 32752, subType: 1, scale: -6 })).toBe('numeric(38,6)');
    expect(firebirdType({ type: 32762 })).toBe('decfloat(34)');
    expect(firebirdType({ type: 32756 })).toBe('time with time zone');
    expect(firebirdType({ type: 32748 })).toBe('timestamp with time zone');
    expect(firebirdType({ type: 448, subType: 4, length: 320 })).toBe('varchar(80)');
    expect(firebirdType({ type: 452, subType: 0, length: 10 })).toBe('char(10)');
    expect(firebirdType({ type: 448, subType: 1, length: 8 })).toBe('varbinary(8)');
    expect(firebirdType({ type: 520, subType: 1 })).toBe('blob sub_type text');
    expect(firebirdType({ type: 520, subType: 0 })).toBe('blob sub_type binary');
  });

  it.each<['oracle' | 'firebird', string, string | null, Record<string, unknown>]>([
    ['oracle', 'number(20)', 'number', { precision: 0 }],
    ['oracle', 'number(*,0)', 'number', { precision: 0 }],
    ['oracle', 'number(30,4)', 'number', { precision: 4 }],
    ['oracle', 'number(38,12)', 'number', { precision: 8 }],
    ['oracle', 'number(10,-2)', 'number', { precision: 0 }],
    ['oracle', 'number', 'number', { precision: null }],
    ['oracle', 'float(126)', 'number', { precision: null }],
    ['oracle', 'binary_float', 'number', { precision: null }],
    ['oracle', 'binary_double', 'number', { precision: null }],
    ['oracle', 'date', 'date', { includeTime: true, timeZone: 'UTC' }],
    ['oracle', 'timestamp(6)', 'date', { includeTime: true, timeZone: 'UTC' }],
    ['oracle', 'timestamp(9) with time zone', 'date', { includeTime: true, timeZone: 'UTC' }],
    ['oracle', 'timestamp(6) with local time zone', 'date', { includeTime: true, timeZone: 'UTC' }],
    ['oracle', 'varchar2(80)', 'text', {}],
    ['oracle', 'nvarchar2(2000)', 'longText', {}],
    ['oracle', 'char(10)', 'text', {}],
    ['oracle', 'clob', 'longText', {}],
    ['oracle', 'nclob', 'longText', {}],
    ['oracle', 'json', 'longText', {}],
    ['oracle', 'boolean', 'checkbox', {}],
    ['oracle', 'raw(16)', null, {}],
    ['oracle', 'blob', null, {}],
    ['firebird', 'int128', 'number', { precision: 0 }],
    ['firebird', 'numeric(38,6)', 'number', { precision: 6 }],
    ['firebird', 'decfloat(34)', 'number', { precision: null }],
    ['firebird', 'time with time zone', 'text', {}],
    ['firebird', 'timestamp with time zone', 'date', { includeTime: true, timeZone: 'UTC' }],
    ['firebird', 'date', 'date', {}],
    ['firebird', 'blob sub_type text', 'longText', {}],
    ['firebird', 'blob sub_type binary', null, {}],
    ['firebird', 'varbinary(8)', null, {}],
  ])('maps %s %s', (dialect, type, expected, options) => {
    const col = column({ name: 'value', type, nullable: true }, dialect);
    expect(col.suggested?.type ?? null).toBe(expected);
    if (expected) {
      expect(col.suggested?.options).toEqual(options);
      expect(
        FieldOptions[expected as keyof typeof FieldOptions].safeParse(col.suggested!.options).success,
      ).toBe(true);
    }
  });

  it('keeps exact numbers and long whole numbers exact as keys', () => {
    const scaled = column({ name: 'amount', type: 'number(30,4)', nullable: false }, 'oracle');
    expect(keyValue('12345678901234567890.1200', scaled)).toBe('12345678901234567890.1200');
    const whole = column({ name: 'id', type: 'number', nullable: false }, 'oracle');
    expect(keyValue('9007199254740993', whole)).toBe('9007199254740993');
    expect(keyValue('12', whole)).toBe(12);
    expect(keyValue('1.5', whole)).toBe(1.5);
    const huge = column({ name: 'id', type: 'int128', nullable: false }, 'firebird');
    expect(keyValue('170141183460469231731687303715884105727', huge)).toBe(
      '170141183460469231731687303715884105727',
    );
  });

  it('reads dates, times, and exact decimals as text the driver can’t shift', () => {
    const col = (type: string, dialect: 'oracle' | 'firebird') =>
      column({ name: 'v', type, nullable: true }, dialect);
    expect(projection(col('number(30,4)', 'oracle'), '"v"', 'oracle')).toBe(
      `TO_CHAR("v", 'FM${'9'.repeat(25)}0.0000')`,
    );
    expect(projection(col('date', 'oracle'), '"v"', 'oracle')).toContain('YYYY-MM-DD"T"HH24:MI:SS');
    expect(projection(col('timestamp(6) with time zone', 'oracle'), '"v"', 'oracle')).toContain(
      'SYS_EXTRACT_UTC',
    );
    expect(projection(col('number(20)', 'oracle'), '"v"', 'oracle')).toBe('"v"');
    expect(projection(col('timestamp with time zone', 'firebird'), '"v"', 'firebird')).toBe(
      `REPLACE(CAST("v" AT TIME ZONE 'UTC' AS VARCHAR(60)), ' UTC', 'Z')`,
    );
    expect(projection(col('decfloat(34)', 'firebird'), '"v"', 'firebird')).toBe('CAST("v" AS VARCHAR(64))');
  });
});

describe.each(['oracle', 'firebird'] as const)('%s query boundaries', (dialect) => {
  it.each([
    'SELECT 1 FROM dual; DELETE FROM records',
    "SELECT q'[unfinished FROM dual",
    'SELECT 1 /* nested /* comment */ */ FROM dual',
    'SELECT 1) q; DELETE FROM records; SELECT * FROM (SELECT 1',
  ])('refuses %s', (sql) => expect(() => querySql(sql, dialect)).toThrow(ConnectorError));
  it('reads alternative quotes whole, and names the derived table its own way', () => {
    const wrapped = querySql("SELECT q'[it's; )]' AS a, nq'{x}' AS b, Q'<;>' AS c FROM dual", dialect);
    expect(wrapped).toContain("q'[it's; )]'");
    expect(wrapped.endsWith(dialect === 'oracle' ? '\n) q' : '\n) AS q')).toBe(true);
    // A column that happens to end in q is not a quote.
    expect(() => querySql("SELECT freq'x' FROM dual", dialect)).not.toThrow();
    // A backslash is only a character in these dialects' strings.
    expect(() => querySql("SELECT 1 FROM t WHERE REGEXP_LIKE(x, '\\d+')", dialect)).not.toThrow();
    expect(quote('a"b', dialect)).toBe('"a""b"');
  });
});

describe('Oracle connect descriptors', () => {
  const target = { protocol: 'tcp' as const, host: 'db.example.com', port: 1521, service: 'FREEPDB1' };

  it('reads as exactly one address and the named service, even for unusual names', async () => {
    for (const [host, tls] of [
      // Without a proxy setting the driver resolves the name itself, so this one has to resolve here.
      ['localhost', false],
      ['db.example.com', true],
      ['2001:db8::1', true],
      ['10.0.0.5', false],
    ] as const) {
      const text = oracleDescriptor(
        { host, port: 2484 },
        { ...target, service: 'a$b.c-d', server: 'dedicated', instance: 'orcl-1' },
        tls,
      );
      const node = await createNode(text, { httpsProxy: tls ? '127.0.0.1' : undefined });
      const options = node.descriptionList.flatMap((description) => description.cOpts);
      // A name can resolve to two addresses, and each one is still that host.
      expect(options.length, host).toBeGreaterThan(0);
      for (const option of options)
        expect(option, host).toMatchObject({ hostname: host, port: 2484, protocol: tls ? 'TCPS' : 'TCP' });
      expect(new Set(options.map((option) => option.hostname))).toEqual(new Set([host]));
      expect(text).toContain('(SERVICE_NAME=a$b.c-d)(SERVER=DEDICATED)(INSTANCE_NAME=orcl-1)');
    }
  });

  it.each([
    'shown.example.com,other.example.com',
    '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=other.example.com)(PORT=1521)))',
    'shown.example.com:1521/svc?https_proxy=other.example.com&https_proxy_port=8080&x=',
    'tcps://shown.example.com',
    'shown.example.com)(HOST=other.example.com',
  ])('refuses a host that would reach somewhere else: %s', (host) => {
    expect(() => oracleDescriptor({ host, port: 1521 }, target, false)).toThrow(ConnectorError);
  });

  it('refuses a service or instance the descriptor could read as more', () => {
    for (const service of ['svc)(HOST=other', 'svc name', '', 'a#b'])
      expect(
        () => oracleDescriptor({ host: 'db', port: 1521 }, { ...target, service }, false),
        service,
      ).toThrow(ConnectorError);
    for (const instance of ['i)(x=1', 'x#y'])
      expect(
        () => oracleDescriptor({ host: 'db', port: 1521 }, { ...target, instance }, false),
        instance,
      ).toThrow(ConnectorError);
  });
});

describe('Oracle TLS', () => {
  const certificate = certificateFor('localhost');
  const password = () => ['stand', 'in', randomBytes(4).toString('hex')].join('-');

  /** A local listener that runs `onSocket` for each connection and counts them. */
  async function listener(onSocket: (socket: Socket) => void, tlsIdentity?: { cert: string; key: string }) {
    let connections = 0;
    const handle = (socket: Socket) => {
      connections++;
      socket.on('error', () => undefined);
      onSocket(socket);
    };
    const server = tlsIdentity ? createTlsServer(tlsIdentity, handle) : createPlainServer(handle);
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as { port: number }).port,
      connections: () => connections,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  const oracleSource = (
    port: number,
    tls: Record<string, unknown>,
    secrets: Record<string, string> = {},
  ) => ({
    connection: SourceConnection.parse({
      kind: 'oracle',
      host: '127.0.0.1',
      port,
      serviceName: 'FREEPDB1',
      user: 'reader',
      tls,
    }),
    secrets: { password: password(), ...secrets },
    timeoutMs: 5000,
  });

  it('makes certificates every TLS library reads, a fresh one each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { cert, key } = selfSigned('Riosoma placeholder');
      // One in 256 serials started with a zero byte before, which OpenSSL refuses to read.
      expect(() => new X509Certificate(cert)).not.toThrow();
      expect(() => createSecureContext({ cert, key })).not.toThrow();
      seen.add(new X509Certificate(cert).serialNumber);
    }
    expect(seen.size).toBe(2000);
    // The throwaway client identity is made for each connection, never kept.
    expect(walletContent(certificate.certificate)).not.toBe(walletContent(certificate.certificate));
  });

  it('opens the TLS socket itself, straight to the address, with nothing listening for it', async () => {
    let hello: Buffer | undefined;
    const database = await listener((socket) =>
      socket.once('data', (data) => {
        hello = data;
        socket.destroy();
      }),
    );
    try {
      const result = await connectorFor('oracle').test(
        oracleSource(database.port, {
          mode: 'verify-full',
          caPem: certificate.certificate,
          serverName: 'db.example.com',
        }),
      );
      // A TLS handshake record, not a proxy's CONNECT line.
      expect(hello?.[0]).toBe(0x16);
      expect(hello?.subarray(0, 7).toString('latin1')).not.toBe('CONNECT');
      // The test's own check that the port answers, then the driver's one socket.
      expect(database.connections()).toBe(2);
      expect(result.steps.at(-1)).toMatchObject({ status: 'failed' });
    } finally {
      await database.close();
    }
  });

  it('refuses to check a certificate without its name unless the source brings an authority', async () => {
    const database = await listener((socket) => socket.destroy());
    try {
      const result = await connectorFor('oracle').test(oracleSource(database.port, { mode: 'verify-ca' }));
      expect(result.steps.at(-1)).toMatchObject({ step: 'tls', status: 'failed' });
      expect(result.steps.at(-1)?.detail).toContain('needs an authority of your own');
      // Only the test's own check that the port answers: the driver never dialed.  The listener can
      // count that check a moment after the client side finishes, so wait for it.
      await expect.poll(() => database.connections()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(database.connections()).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('closes and refuses a connection the driver made without taking the route', async () => {
    const route = { host: 'db.example.com', port: 2484, dial: { host: '127.0.0.1', port: 1 }, used: false };
    const attributes = {
      user: 'reader',
      connectString: '',
      httpsProxy: `riosoma-route-${randomBytes(16).toString('hex')}.invalid`,
    };
    let closed = 0;
    const made = { close: async () => void closed++ } as unknown as oracledb.Connection;
    await expect(connectOverRoute(attributes, route, async () => made)).rejects.toMatchObject({
      messageKey: 'sources.test.connect',
      detail: ROUTE_UNUSED,
    });
    expect(closed).toBe(1);
    // Taking the route is what lets the connection through.
    const taken = await connectOverRoute(attributes, { ...route }, async (settings) => {
      expect(settings.httpsProxy).toBe(attributes.httpsProxy);
      return made;
    }).catch((error: unknown) => error);
    expect(taken).toMatchObject({ detail: ROUTE_UNUSED });
    const used = { ...route };
    await expect(
      connectOverRoute(attributes, used, async () => {
        used.used = true;
        return made;
      }),
    ).resolves.toBe(made);
    // A route without its token in the attributes can't be taken at all.
    await expect(
      connectOverRoute({ ...attributes, httpsProxy: undefined }, { ...route }, async () => made),
    ).rejects.toMatchObject({
      detail: ROUTE_UNUSED,
    });
  });

  /** A packet that redirects the client to `address`, the way a listener answers a connect request. */
  function redirect(address: string): Buffer {
    const data = Buffer.from(address, 'ascii');
    const packet = Buffer.alloc(10 + data.length);
    packet.writeUInt16BE(packet.length, 0);
    packet[4] = 5;
    packet.writeUInt16BE(data.length, 8);
    data.copy(packet, 10);
    return packet;
  }

  it.each([false, true])(
    'refuses a listener’s redirect, and opens nothing to its address (TLS %s)',
    async (tls) => {
      const server = selfSigned('db.example.com');
      const target = await listener((socket) => socket.destroy(), tls ? server : undefined);
      const first = await listener(
        (socket) =>
          socket.once('data', () =>
            socket.write(
              redirect(`(ADDRESS=(PROTOCOL=${tls ? 'TCPS' : 'TCP'})(HOST=127.0.0.1)(PORT=${target.port}))`),
            ),
          ),
        tls ? server : undefined,
      );
      try {
        const result = await connectorFor('oracle').test(
          oracleSource(
            first.port,
            tls
              ? { mode: 'verify-full', caPem: server.cert, serverName: 'db.example.com' }
              : { mode: 'disable' },
          ),
        );
        expect(result.steps.at(-1)).toMatchObject({
          step: 'connect',
          status: 'failed',
          detail: REDIRECT_REFUSED,
        });
        expect(first.connections()).toBeGreaterThan(0);
        expect(target.connections()).toBe(0);
      } finally {
        await first.close();
        await target.close();
      }
    },
  );

  it('reads a PEM wallet’s trusted certificates and its client key, encrypted or not', () => {
    const passphrase = ['wallet', randomBytes(4).toString('hex')].join('-');
    const client = certificateFor('client', passphrase);
    const wallet = `${certificate.certificate}${client.certificate}${client.key}`;
    const parts = walletParts(wallet, passphrase);
    expect(parts.ca).toEqual([certificate.certificate.trim()]);
    expect(parts.cert).toBe(client.certificate.trim());
    expect(parts.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(walletParts(certificate.certificate)).toEqual({ ca: [certificate.certificate.trim()] });
    expect(() => walletParts(wallet, `${passphrase}-other`)).toThrow(ConnectorError);
  });

  it('builds a wallet the driver’s own TLS can load, with a client key first', () => {
    const passphrase = ['wallet', randomBytes(4).toString('hex')].join('-');
    const client = certificateFor('client', passphrase);
    expect(walletContent()).toBeUndefined();
    const authorityOnly = walletContent(certificate.certificate)!;
    const withClient = walletContent(
      undefined,
      `${certificate.certificate}${client.certificate}${client.key}`,
      passphrase,
    )!;
    for (const wallet of [authorityOnly, withClient]) {
      // The same call the driver makes with a wallet.
      expect(() => createSecureContext({ cert: wallet, key: wallet, ca: wallet })).not.toThrow();
      expect(wallet).toContain(certificate.certificate.trim());
    }
    expect(withClient.startsWith(client.certificate.trim())).toBe(true);
    expect(authorityOnly.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
    expect(() => walletContent('not a certificate')).toThrow(ConnectorError);
  });

  it('reports a wallet it can’t read at the TLS step', async () => {
    const listener = createPlainServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      const connector = makeConnector('oracle', async () => {
        throw new ConnectorError('sources.test.tls', 'bad decrypt');
      });
      const result = await connector.test({
        connection: {
          kind: 'oracle',
          address: 'host',
          host: '127.0.0.1',
          port: (listener.address() as { port: number }).port,
          serviceName: 'FREEPDB1',
          user: 'reader',
          tls: { mode: 'verify-ca' },
        },
        secrets: { password: randomBytes(6).toString('hex') },
      });
      expect(result.steps.at(-1)).toMatchObject({ step: 'tls', status: 'failed' });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});

describe('Firebird sign-in with wire encryption required', () => {
  const int = (n: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(n);
    return buffer;
  };
  const opaque = (data: Buffer) =>
    Buffer.concat([int(data.length), data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const text = (value: string) => opaque(Buffer.from(value));
  const PROTOCOL_13 = 0x8000 | 13;
  /** An SRP challenge: a salt and a server key, which the client can compute a proof from. */
  const challenge = () => {
    const salt = Buffer.from(randomBytes(32).toString('hex'));
    const key = Buffer.from(`${randomBytes(64).toString('hex')}`);
    const lengths = (n: number) => {
      const buffer = Buffer.alloc(2);
      buffer.writeUInt16LE(n);
      return buffer;
    };
    return Buffer.concat([lengths(salt.length), salt, lengths(key.length), key]);
  };

  /**
   * A server that answers the client's messages with `answers`, one per message, and remembers the
   * operation each message started with.
   */
  async function fakeServer(answers: Buffer[], after?: (socket: Socket) => void) {
    const operations: number[] = [];
    let connections = 0;
    const server = createPlainServer((socket) => {
      connections++;
      socket.on('error', () => undefined);
      socket.on('data', (data) => {
        operations.push(data.readInt32BE(0));
        const answer = answers.shift();
        if (answer) socket.write(answer);
        if (!answers.length) after?.(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      operations,
      connections: () => connections,
      port: (server.address() as { port: number }).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  async function signIn(port: number) {
    return connectorFor('firebird').test({
      connection: {
        kind: 'firebird',
        host: '127.0.0.1',
        port,
        database: 'employee',
        user: 'reader',
        wireCrypt: 'required',
      },
      secrets: { password: ['stand', 'in', randomBytes(4).toString('hex')].join('-') },
      timeoutMs: 3000,
    });
  }

  it('stops before attaching, the request that carries the password, on a protocol without encryption', async () => {
    // Protocol 10 has no plugins or encryption, and would send the password in the attach request.
    const server = await fakeServer([Buffer.concat([int(3), int(10), int(1), int(2)])]);
    try {
      const result = await signIn(server.port);
      expect(result.steps.at(-1)).toMatchObject({ step: 'tls', status: 'failed', detail: NOT_ENCRYPTED });
      expect(server.operations).toEqual([1]);
    } finally {
      await server.close();
    }
  });

  it('refuses a server that answers with Legacy_Auth, before sending anything from the password', async () => {
    const server = await fakeServer([
      Buffer.concat([
        int(98),
        int(PROTOCOL_13),
        int(1),
        int(5),
        opaque(Buffer.alloc(0)),
        text('Legacy_Auth'),
        int(0),
        text(''),
      ]),
    ]);
    try {
      const result = await signIn(server.port);
      expect(result.ok).toBe(false);
      expect(server.operations).toEqual([1]);
    } finally {
      await server.close();
    }
  });

  it('refuses Legacy_Auth chained after SRP, where the driver would otherwise send a hash of the password', async () => {
    const server = await fakeServer([
      Buffer.concat([
        int(98),
        int(PROTOCOL_13),
        int(1),
        int(5),
        opaque(challenge()),
        text('Srp256'),
        int(0),
        text(''),
      ]),
      Buffer.concat([int(92), opaque(Buffer.alloc(0)), text('Legacy_Auth'), text(''), text('')]),
    ]);
    try {
      const result = await signIn(server.port);
      expect(result.steps.at(-1)).toMatchObject({ status: 'failed', detail: LEGACY_REFUSED });
      // The connect request, then the SRP proof, and nothing after.
      expect(server.operations).toEqual([1, 92]);
    } finally {
      await server.close();
    }
  });

  it('never signs in again on its own after the server drops an attached connection', async () => {
    // An old protocol, which a source that doesn't require encryption accepts, and an attach the
    // server answers, then drops.  The driver's own reconnect would open a second connection.
    const accept = Buffer.concat([int(3), int(10), int(1), int(2)]);
    const attached = Buffer.concat([int(9), int(1), int(0), int(0), opaque(Buffer.alloc(0)), int(0)]);
    const server = await fakeServer([accept, attached], (socket) => setTimeout(() => socket.destroy(), 50));
    try {
      const db = await attachFirebird(
        {
          host: '127.0.0.1',
          port: server.port,
          database: 'employee',
          user: 'reader',
          password: ['stand', 'in', randomBytes(4).toString('hex')].join('-'),
          wireCrypt: 0,
        },
        false,
        3000,
      );
      expect(db).toBeDefined();
      expect(server.operations).toEqual([1, 19]);
      // The driver retries a second after the drop, so this waits well past it.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(server.connections()).toBe(1);
      // A call on the dropped connection fails at once rather than waiting for a reply.
      const started = Date.now();
      await expect(db.queryAsync('SELECT 1 FROM RDB$DATABASE')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(500);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('classifies a sign-in timeout as a timeout error when attach never resolves', async () => {
    const server = await fakeServer([]);
    try {
      const ctx = {
        connection: {
          kind: 'firebird' as const,
          host: '127.0.0.1',
          port: server.port,
          database: 'employee',
          user: 'reader',
          wireCrypt: 'required' as const,
        },
        secrets: { password: ['stand', 'in', randomBytes(4).toString('hex')].join('-') },
        timeoutMs: 10,
      };
      const caught = await attachFirebird(
        {
          host: '127.0.0.1',
          port: server.port,
          database: 'employee',
          user: 'reader',
          password: ctx.secrets.password,
          wireCrypt: 2,
        },
        true,
        10,
      ).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ConnectorError);
      expect(caught).toMatchObject({ messageKey: 'sources.test.timeout' });
      expect(liveError(caught, ctx).messageKey).toBe('sources.live.timeout');
    } finally {
      await server.close();
    }
  });
});

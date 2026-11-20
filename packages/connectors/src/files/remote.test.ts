import { createSecureContext, TLSSocket, getCACertificates, setDefaultCACertificates } from 'node:tls';
import { selfSigned } from '../oracle-tls.js';
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { createFileConnectors } from './connector.js';
import { openFtp, parseFtpListing } from './ftp.js';
import { parseDavListing, pathMatcher, remoteFileAddress } from './remote.js';
import type { FileNetwork } from './network.js';
import { NotModified, type ConnectorContext } from '../types.js';

const listeners: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    listeners.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function listen(handler: (socket: Socket) => void) {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen');
  return address.port;
}
const checked: FileNetwork = {
  allowsAddress: () => true,
  check: async () => ({ address: '127.0.0.1', family: 4 }),
  request: async () => {
    throw new Error('unexpected HTTP');
  },
};
const password = () => randomBytes(18).toString('base64url');

describe('remote file sources', () => {
  it.each(['files.invalid:2222', 'fe80::1%eth0', 'a^b.invalid'])(
    'rejects malformed remote host %s without falling back to a local address',
    (host) => {
      const config = SourceConnection.parse({ kind: 'ftps', host, user: 'reader', path: '*.csv' });
      if (config.kind !== 'ftps') throw new Error('unexpected connection');
      expect(() => remoteFileAddress(config)).toThrowError(
        expect.objectContaining({ messageKey: 'sources.remote.host' }),
      );
    },
  );

  it.each([
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
    ['0', '0.0.0.0'],
    ['127.1', '127.0.0.1'],
  ])('normalizes remote host %s to %s', (host, normalized) => {
    const config = SourceConnection.parse({ kind: 'ftps', host, user: 'reader', path: '*.csv', port: 2222 });
    if (config.kind !== 'ftps') throw new Error('unexpected connection');
    expect(remoteFileAddress(config).hostname).toBe(normalized);
    expect(remoteFileAddress(config).port).toBe('2222');
  });

  it('matches bounded path globs and reads machine and legacy listings', () => {
    expect(pathMatcher('exports/**/*.csv').test('exports/one.csv')).toBe(true);
    expect(pathMatcher('exports/*.csv').test('exports/nested/one.csv')).toBe(false);
    expect(pathMatcher('exports/*/data.csv').descend('exports/team')).toBe(true);
    expect(pathMatcher('exports/*/data.csv').test('exports/team/data.csv')).toBe(true);
    expect(pathMatcher('exports/*/data.csv').descend('exports/team/nested')).toBe(false);
    expect(pathMatcher('*a'.repeat(100) + '.csv').test('a'.repeat(200) + '.json')).toBe(false);
    expect(parseFtpListing('type=file;size=12;modify=20260930010203; report.csv\r\n', true)).toEqual([
      { name: 'report.csv', bytes: 12, modified: '2026-09-30T01:02:03Z', directory: false },
    ]);
    expect(
      parseFtpListing('type=file;size=12;modify=20260930010203.123; report.csv', true)[0]?.modified,
    ).toBe('2026-09-30T01:02:03.123Z');
    expect(parseFtpListing('-rw-r--r-- 1 reader group 12 Sep 30 01:02 report.csv', false)).toMatchObject([
      { name: 'report.csv', modified: null },
    ]);
    expect(() => parseFtpListing('not a listing', true)).toThrow();
  });
  it('downloads a passive FTP file relative to the login directory and skips unchanged files', async () => {
    const secret = password();
    const commands: string[] = [];
    const port = await listen((control) => {
      let data: Socket | undefined;
      let buffer = '';
      control.write('220-Test server\r\n220 Ready\r\n');
      control.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n')) {
          const end = buffer.indexOf('\r\n');
          const command = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          commands.push(command.split(' ')[0]!);
          void (async () => {
            if (command.startsWith('USER ')) control.write('331 Password\r\n');
            else if (command === `PASS ${secret}`) control.write('230 Signed in\r\n');
            else if (command === 'TYPE I') control.write('200 Binary\r\n');
            else if (command === 'EPSV') {
              const port = await listen((socket) => {
                data = socket;
              });
              control.write(`229 Passive (|||${port}|)\r\n`);
            } else if (command === 'MLSD .') {
              control.write('150 Listing\r\n');
              data!.end('type=file;size=19;modify=20260930010203; data.csv\r\n');
              control.write('226 Done\r\n');
            } else if (command === 'RETR data.csv') {
              control.write('150 Data\r\n');
              data!.end('id,name\n1,First\n');
              control.write('226 Done\r\n');
            } else control.write('550 Missing\r\n');
          })();
        }
      });
    });
    const connector = createFileConnectors({
      network: checked,
      allowPlainFtp: (host) => host === '127.0.0.1',
    }).find((entry) => entry.kind === 'ftp')!;
    const ctx: ConnectorContext = {
      connection: SourceConnection.parse({ kind: 'ftp', host: '127.0.0.1', port, user: 'reader', path: '*' }),
      secrets: { password: secret },
    };
    const files = await connector.listObjects(ctx);
    expect(files).toMatchObject([{ name: 'data.csv', bytes: 19 }]);
    const select = { kind: 'object' as const, object: { schema: null, name: 'data.csv' } };
    expect((await connector.preview(ctx, select, 5)).rows).toEqual([[true, 'First']]);
    let etag: string | undefined;
    const options = {
      columns: ['id'],
      keyColumns: ['id'],
      types: { id: 'number' },
      onValidators: (validators: { etag?: string }) => {
        etag = validators.etag;
      },
    };
    for await (const batch of connector.read(ctx, select, options)) expect(batch).toHaveLength(1);
    expect(etag).toBeTruthy();
    const retr = commands.filter((command) => command === 'RETR').length;
    const again = async () => {
      for await (const batch of connector.read(ctx, select, { ...options, since: { etag } }))
        expect(batch).toEqual([]);
    };
    await expect(again()).rejects.toBeInstanceOf(NotModified);
    expect(commands.filter((command) => command === 'RETR')).toHaveLength(retr);
  });
  it('refuses an FTPS server that will not upgrade before sending credentials', async () => {
    const commands: string[] = [];
    const port = await listen((control) => {
      control.write('220 Ready\r\n');
      control.on('data', (chunk) => {
        commands.push(chunk.toString().trim());
        control.write('502 TLS unavailable\r\n');
      });
    });
    await expect(
      openFtp({
        address: '127.0.0.1',
        host: '127.0.0.1',
        port,
        user: 'reader',
        password: password(),
        secure: true,
        signal: AbortSignal.timeout(2_000),
        timeoutMs: 1_000,
      }),
    ).rejects.toHaveProperty('messageKey', 'sources.remote.reply');
    expect(commands).toEqual(['AUTH TLS']);
  });

  it('upgrades FTPS control and data connections with certificate verification', async () => {
    const host = randomBytes(10).toString('hex');
    const certificate = selfSigned(host);
    const trusted = getCACertificates('default');
    setDefaultCACertificates([...trusted, certificate.cert]);
    const secureContext = createSecureContext(certificate);
    const commands: string[] = [];
    try {
      const port = await listen((plain) => {
        plain.write('220 Ready\r\n');
        plain.once('data', (chunk) => {
          expect(chunk.toString()).toBe('AUTH TLS\r\n');
          plain.write('234 Upgrade\r\n');
          const control = new TLSSocket(plain, { isServer: true, secureContext });
          control.on('error', () => {});
          sockets.add(control);
          control.on('data', (chunk) => {
            const command = chunk.toString().trim();
            commands.push(command);
            void (async () => {
              if (command.startsWith('USER ')) control.write('230 Ready\r\n');
              else if (['TYPE I', 'PBSZ 0', 'PROT P'].includes(command)) control.write('200 Ready\r\n');
              else if (command === 'EPSV') {
                const dataPort = await listen((raw) => {
                  const data = new TLSSocket(raw, { isServer: true, secureContext });
                  sockets.add(data);
                  data.on('error', () => {});
                  data.once('secure', () => {
                    data.end('type=file;size=12;modify=20260930010203; report.csv\r\n');
                    control.write('226 Done\r\n');
                  });
                });
                control.write(`229 Passive (|||${dataPort}|)\r\n`);
              } else if (command === 'MLSD .') control.write('150 Listing\r\n');
            })();
          });
        });
      });
      const client = await openFtp({
        address: '127.0.0.1',
        host,
        port,
        user: 'reader',
        password: password(),
        secure: true,
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 2_000,
      });
      try {
        expect(await client.list('.')).toMatchObject([{ name: 'report.csv', bytes: 12 }]);
        expect(commands).toContain('PROT P');
      } finally {
        client.close();
      }
    } finally {
      setDefaultCACertificates(trusted);
    }
  });

  it('ignores the passive reply host and falls back from MLSD to LIST', async () => {
    let data: Socket | undefined;
    const port = await listen((control) => {
      control.write('220 Ready\r\n');
      control.on('data', (chunk) => {
        const command = chunk.toString().trim();
        void (async () => {
          if (command.startsWith('USER ')) control.write('230 Ready\r\n');
          else if (command === 'TYPE I') control.write('200 Binary\r\n');
          else if (command === 'EPSV') control.write('502 Unsupported\r\n');
          else if (command === 'PASV') {
            const dataPort = await listen((socket) => {
              data = socket;
            });
            control.write(`227 Passive (192,0,2,99,${Math.floor(dataPort / 256)},${dataPort % 256})\r\n`);
          } else if (command.startsWith('MLSD ')) control.write('502 Unsupported\r\n');
          else if (command.startsWith('LIST ')) {
            control.write('150 Listing\r\n');
            data!.end('-rw-r--r-- 1 reader group 12 Sep 30 2026 report.csv\r\n');
            control.write('226 Done\r\n');
          }
        })();
      });
    });
    const client = await openFtp({
      address: '127.0.0.1',
      host: '127.0.0.1',
      port,
      user: 'reader',
      password: password(),
      secure: false,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 2_000,
    });
    try {
      expect(await client.list('.')).toMatchObject([{ name: 'report.csv', bytes: 12, modified: null }]);
    } finally {
      client.close();
    }
  });

  it('uses guarded PROPFIND and GET for encoded cloud folders', async () => {
    const secret = password();
    const base = new URL('https://192.0.2.1/remote.php/dav/files/reader/');
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${base.pathname}Report%20One.csv</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype/><d:getcontentlength>15</d:getcontentlength><d:getlastmodified>Wed, 30 Sep 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>`;
    const network: FileNetwork = {
      ...checked,
      request: vi.fn(async (request) => {
        expect(request.headers.authorization).toBe(`Bearer ${secret}`);
        if (request.method === 'PROPFIND') expect(request.headers.depth).toBe('1');
        else expect(decodeURIComponent(request.url.pathname)).toBe(`${base.pathname}Report One.csv`);
        return {
          status: request.method === 'PROPFIND' ? 207 : 200,
          headers: {},
          url: request.url,
          close() {},
          body: (async function* () {
            yield Buffer.from(request.method === 'PROPFIND' ? xml : 'id,name\n1,One\n');
          })(),
        };
      }),
    };
    const ctx: ConnectorContext = {
      connection: SourceConnection.parse({ kind: 'webdav', url: base.href, path: '*.csv', auth: 'bearer' }),
      secrets: { token: secret },
    };
    const connector = createFileConnectors({ network }).find((entry) => entry.kind === 'webdav')!;
    expect((await connector.listObjects(ctx))[0]?.name).toBe('Report One.csv');
    expect(
      (await connector.preview(ctx, { kind: 'object', object: { schema: null, name: 'Report One.csv' } }, 5))
        .rows,
    ).toEqual([[true, 'One']]);
    expect(() => parseDavListing(xml.replace(base.pathname, 'https://192.0.2.2/'), base)).toThrow();
    expect(() => parseDavListing('<!DOCTYPE x><x/>', base)).toThrow();
  });
});

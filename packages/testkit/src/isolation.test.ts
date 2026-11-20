import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTestConnection,
  guardTestConnection,
  neutralizeCloudEnvironment,
  noteRunningTestServer,
  noteStoppedTestServer,
} from './isolation.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cloud environment isolation', () => {
  it('replaces ambient credentials while preserving explicit live settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rio-cloud-check-'));
    const removed = [
      'AWS_PROFILE',
      'AWS_DEFAULT_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AZURE_CLIENT_ID',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_SECRET',
      'AZURE_FEDERATED_TOKEN_FILE',
    ];
    const env: NodeJS.ProcessEnv = Object.fromEntries(removed.map((name) => [name, 'synthetic']));
    env.RIOSOMA_TEST_BIGQUERY_CREDENTIALS = 'explicit-live-setting';
    try {
      neutralizeCloudEnvironment(directory, env);
      for (const name of removed) expect(env[name], name).toBeUndefined();
      expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
      expect(existsSync(env.AWS_CONFIG_FILE!)).toBe(false);
      expect(existsSync(env.AWS_SHARED_CREDENTIALS_FILE!)).toBe(false);
      expect(readdirSync(env.CLOUDSDK_CONFIG!)).toEqual([]);
      expect(env.RIOSOMA_TEST_BIGQUERY_CREDENTIALS).toBe('explicit-live-setting');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads the neutral environment before test modules', () => {
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(existsSync(process.env.AWS_CONFIG_FILE!)).toBe(false);
    expect(existsSync(process.env.AWS_SHARED_CREDENTIALS_FILE!)).toBe(false);
    expect(readdirSync(process.env.CLOUDSDK_CONFIG!)).toEqual([]);
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });
});

describe('network isolation', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    '127.0.0.1',
    '127.4.3.2',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('allows loopback host %s', (host) => {
    expect(() => assertTestConnection([{ host, port: 443 }], {})).not.toThrow();
  });

  it.each([
    'example.invalid',
    'localhost.example.invalid',
    '192.0.2.1',
    '169.254.169.254',
    '::ffff:192.0.2.1',
  ])('rejects external host %s before connecting', (host) => {
    for (const args of [[{ host, port: 443 }], [443, host], [[{ host, port: 443 }, undefined]]]) {
      expect(() => assertTestConnection(args, {})).toThrow(host);
    }
  });

  it('allows Unix sockets and the default loopback host', () => {
    for (const args of [
      [join(tmpdir(), 'rio-test.sock')],
      [{ path: join(tmpdir(), 'rio-test.sock') }],
      [5432],
    ]) {
      expect(() => assertTestConnection(args, {})).not.toThrow();
    }
  });

  it('limits the PostgreSQL exception to its configured host and port', () => {
    const env = {
      RIOSOMA_TEST_DATABASE_URL: 'postgres://postgres@database.invalid:5433/test',
      RIOSOMA_TEST_RETRY: '1',
    };
    expect(() => assertTestConnection([{ host: 'database.invalid', port: 5433 }], env)).not.toThrow();
    expect(() => assertTestConnection([{ host: 'database.invalid', port: 443 }], env)).toThrow(
      'database.invalid',
    );
    expect(() => assertTestConnection([{ host: 'example.invalid', port: 5433 }], env)).toThrow(
      'example.invalid',
    );
  });

  it('requires a nonempty live service variable to allow external connections', () => {
    const args = [{ host: 'example.invalid', port: 443 }];
    expect(() => assertTestConnection(args, { RIOSOMA_TEST_MINIO_URL: '' })).toThrow('example.invalid');
    expect(() =>
      assertTestConnection(args, { RIOSOMA_TEST_MINIO_URL: 'explicit-live-setting' }),
    ).not.toThrow();
  });

  it.each(['RIOSOMA_INGEST_BUILD_EVAL_LIVE', 'RIOSOMA_INGEST_STUDY_EVAL_LIVE', 'RIOSOMA_RIO_EVAL_LIVE'])(
    'allows the explicit evaluation flag %s only when enabled',
    (name) => {
      const args = [{ host: 'example.invalid', port: 443 }];
      for (const value of ['', '0', 'false'])
        expect(() => assertTestConnection(args, { [name]: value })).toThrow('example.invalid');
      const env = { [name]: '1' };
      expect(() => assertTestConnection(args, env)).not.toThrow();
      expect(guardTestConnection(args, env)).toBe(args);
    },
  );

  it('keeps credentials and unrelated evaluation settings from enabling external connections', () => {
    expect(() =>
      assertTestConnection([{ host: 'example.invalid', port: 443 }], {
        RIOSOMA_INGEST_BUILD_EVAL_MODEL: 'fixture',
        RIOSOMA_RIO_EVAL_BUDGET_USD: '1',
        RIOSOMA_TEST_DATABASE_URL: 'postgres://localhost/test',
        RIOSOMA_TEST_RETRY: '1',
      }),
    ).toThrow('example.invalid');
  });

  it('blocks TCP, TLS, HTTP, HTTPS, and fetch through their real connection paths', async () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('RIOSOMA_TEST_')) vi.stubEnv(name, undefined);
    }
    for (const connect of [
      () => net.connect(443, 'example.invalid'),
      () => net.createConnection({ host: 'example.invalid', port: 443 }),
      () => new net.Socket().connect(443, 'example.invalid'),
      () => tls.connect({ host: 'example.invalid', port: 443 }),
      () => tls.connect(443, 'example.invalid'),
      () => http.get('http://example.invalid'),
      () => https.get('https://example.invalid'),
    ])
      expect(connect).toThrow('example.invalid');
    await expect(fetch('https://example.invalid')).rejects.toMatchObject({
      cause: { code: 'TEST_NETWORK_ISOLATED', message: expect.stringContaining('example.invalid') },
    });
  });

  it('preserves request and fetch stubs', async () => {
    const request = vi.spyOn(https, 'request').mockImplementation(() => ({}) as http.ClientRequest);
    const fetchStub = vi.fn().mockResolvedValue(new Response('stubbed'));
    vi.stubGlobal('fetch', fetchStub);
    https.request('https://example.invalid');
    expect(request).toHaveBeenCalledOnce();
    expect(await (await fetch('https://example.invalid')).text()).toBe('stubbed');
  });

  it.each(['tcp', 'unix'])('keeps real %s listeners reachable', async (transport) => {
    const directory = mkdtempSync(join(tmpdir(), 'rio-socket-check-'));
    const server = net.createServer((socket) => socket.end('local'));
    const endpoint =
      transport === 'tcp' ? { host: '127.0.0.1', port: 0 } : { path: join(directory, 'socket') };
    try {
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      const address = server.address()!;
      const socket =
        typeof address === 'string' ? net.connect(address) : net.connect(address.port, '127.0.0.1');
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('end', resolve);
        socket.once('error', reject);
      });
      expect(received).toBe('local');
      socket.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('a server this test run stopped', () => {
  // A privileged port, so no listener of the suite's own can be the one recorded here.
  const port = 9;
  const stopped = 'a PostgreSQL server this test run started and stopped';
  afterEach(() => noteRunningTestServer(port));

  it('refuses a connection to the port it held, and names what stopped there', () => {
    noteStoppedTestServer(port, stopped);
    for (const args of [
      [{ host: '127.0.0.1', port }],
      [port, '127.0.0.1'],
      [[{ host: '127.0.0.1', port }], undefined],
    ])
      expect(() => assertTestConnection(args, {})).toThrow(stopped);
    expect(() => assertTestConnection([{ host: '127.0.0.1', port: port + 1 }], {})).not.toThrow();
  });

  it('refuses in a live run too, since no service anybody named is on that port', () => {
    noteStoppedTestServer(port, stopped);
    expect(() =>
      assertTestConnection([{ host: '127.0.0.1', port }], { RIOSOMA_TEST_S3_URL: 'explicit-live-setting' }),
    ).toThrow('A test connection outlived its server');
  });

  it('allows the port again once a server holds it', () => {
    noteStoppedTestServer(port, stopped);
    noteRunningTestServer(port);
    expect(() => assertTestConnection([{ host: '127.0.0.1', port }], {})).not.toThrow();
  });

  it('clears the record when a listener of this process takes the port again', async () => {
    const server = net.createServer();
    const take = (wanted: number) =>
      new Promise<boolean>((resolve) => {
        server.removeAllListeners('error');
        server.once('error', () => resolve(false));
        server.listen(wanted, '127.0.0.1', () => resolve(true));
      });
    const release = () => new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // Taking a port back needs it to be free, so a new one is drawn if another process won the race.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await take(0)).toBe(true);
        const { port: freed } = server.address() as net.AddressInfo;
        noteStoppedTestServer(freed, stopped);
        expect(() => assertTestConnection([{ host: '127.0.0.1', port: freed }], {})).toThrow(stopped);
        await release();
        if (!(await take(freed))) {
          noteRunningTestServer(freed);
          continue;
        }
        expect(() => assertTestConnection([{ host: '127.0.0.1', port: freed }], {})).not.toThrow();
        await release();
        return;
      }
      throw new Error('A freed port could not be taken again');
    } finally {
      server.removeAllListeners();
      if (server.listening) await release();
    }
  });

  it('stops a real connection before it opens, whichever way the address is passed', () => {
    noteStoppedTestServer(port, stopped);
    expect(() => net.connect({ host: '127.0.0.1', port })).toThrow('A test connection outlived its server');
    expect(() => net.connect(port, '127.0.0.1')).toThrow('A test connection outlived its server');
  });
});

describe('connections that bring their own lookup', () => {
  const connect = (address: string) => {
    const lookup = (
      _host: string,
      _options: unknown,
      callback: (error: Error | null, address?: string, family?: number) => void,
    ) => callback(null, address, 4);
    const [options] = guardTestConnection([{ host: 'service.invalid', port: 443, lookup }], {}) as [
      { lookup: typeof lookup },
    ];
    return new Promise<Error | null>((resolve) =>
      options.lookup('service.invalid', {}, (error) => resolve(error)),
    );
  };

  it('are checked on the address their lookup gives, not on their name', async () => {
    expect(await connect('127.0.0.1')).toBeNull();
    expect(String(await connect('10.0.0.1'))).toContain('10.0.0.1');
  });

  it('keep the lookup’s own refusal', async () => {
    const refusal = new Error('blocked by the product');
    const lookup = (_host: string, _options: unknown, callback: (error: Error | null) => void) =>
      callback(refusal);
    const [options] = guardTestConnection([{ host: 'service.invalid', port: 443, lookup }], {}) as [
      { lookup: typeof lookup },
    ];
    expect(await new Promise((resolve) => options.lookup('service.invalid', {}, resolve))).toBe(refusal);
  });
});

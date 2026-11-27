import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import ssh2, { type Client } from 'ssh2';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSftp } from './sftp.js';
import { sshKeyPair } from './ssh.test-helpers.js';

const { Server } = ssh2;
const hostKey = sshKeyPair();
const userKey = sshKeyPair();
const secret = randomBytes(20).toString('base64url');
let server: InstanceType<typeof Server>;
let port = 0;
beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (auth) => {
      if (
        auth.username === 'reader' &&
        ((auth.method === 'password' && auth.password === secret) || auth.method === 'publickey')
      )
        auth.accept();
      else auth.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          let listed = false;
          channel.on('OPENDIR', (id) => {
            listed = false;
            channel.handle(id, Buffer.from([1]));
          });
          channel.on('READDIR', (id) => {
            if (listed) channel.status(id, 1);
            else {
              listed = true;
              channel.name(id, [
                {
                  filename: 'data.csv',
                  longname: 'data.csv',
                  attrs: { mode: 0o100644, uid: 1, gid: 1, size: 12, atime: 0, mtime: 17 },
                },
              ]);
            }
          });
          channel.on('CLOSE', (id) => channel.status(id, 0));
          channel.on('STAT', (id, path) => {
            if (path === 'data.csv')
              channel.attrs(id, { mode: 0o100644, uid: 1, gid: 1, size: 12, atime: 0, mtime: 17 });
            else channel.status(id, 2);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('pins the host key and accepts password and key authentication', async () => {
  for (const auth of [{ password: secret }, { privateKey: userKey.private }]) {
    const client = await openSftp({
      address: '127.0.0.1',
      port,
      user: 'reader',
      hostKey: hostKey.public,
      ...auth,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 2_000,
    });
    try {
      expect((await client.stat('data.csv')).mtime).toBe(17);
      expect(await client.list('.')).toMatchObject([
        { filename: 'data.csv', attrs: { size: 12, mtime: 17 } },
      ]);
    } finally {
      client.close();
    }
  }
});

it('refuses a changed host key and a canceled connection', async () => {
  const options = {
    address: '127.0.0.1',
    port,
    user: 'reader',
    password: secret,
    hostKey: userKey.public,
    signal: AbortSignal.timeout(5_000),
    timeoutMs: 2_000,
  };
  await expect(openSftp(options)).rejects.toThrow('sources.remote.hostKey');
  await expect(
    openSftp({ ...options, hostKey: hostKey.public, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});

it('handles read stream error events after close, end, abort, and server drop without crashing', async () => {
  const uncaught: unknown[] = [];
  const rejected: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const onRejected = (reason: unknown) => rejected.push(reason);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejected);
  try {
    const createFake = (mode: 'partial' | 'normal' | 'abort' | 'drop') => {
      const streams: Readable[] = [];
      const client = new EventEmitter() as EventEmitter & {
        connect(config: { hostVerifier: (key: Buffer) => boolean }): void;
        sftp(cb: (err: Error | undefined, wrapper: unknown) => void): void;
        destroy(): void;
      };
      client.connect = (config) => {
        const parsed = ssh2.utils.parseKey(hostKey.public);
        if (parsed instanceof Error) throw parsed;
        expect(config.hostVerifier(parsed.getPublicSSH())).toBe(true);
        queueMicrotask(() => client.emit('ready'));
      };
      client.sftp = (cb) => {
        const wrapper = new EventEmitter() as EventEmitter & {
          createReadStream(): Readable;
        };
        wrapper.createReadStream = () => {
          const chunks = [Buffer.from('id,name\n'), Buffer.from('1,Alpha\n')];
          const stream = new Readable({
            read() {
              const next = chunks.shift();
              if (next) this.push(next);
              else if (mode === 'normal') this.push(null);
            },
          });
          streams.push(stream);
          return stream;
        };
        queueMicrotask(() => cb(undefined, wrapper));
      };
      client.destroy = () => {
        for (const stream of streams) stream.emit('error', new Error('No response from server'));
        client.emit('close');
      };
      return { client: client as unknown as Client, streams };
    };

    // 1. Early close after partial read (mirrors connector test() reading HEAD_BYTES and closing in finally)
    const partial = createFake('partial');
    const sftpPartial = await openSftp({
      address: '127.0.0.1',
      port: 22,
      user: 'reader',
      hostKey: hostKey.public,
      password: secret,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 2_000,
      createClient: () => partial.client,
    });
    let head = '';
    for await (const chunk of sftpPartial.read('data.csv')) {
      head += chunk.toString('utf8');
      break;
    }
    sftpPartial.close();
    expect(head).toBe('id,name\n');

    // 2. Normal end followed by close() emitting error on the finished stream
    const normal = createFake('normal');
    const sftpNormal = await openSftp({
      address: '127.0.0.1',
      port: 22,
      user: 'reader',
      hostKey: hostKey.public,
      password: secret,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 2_000,
      createClient: () => normal.client,
    });
    let full = '';
    for await (const chunk of sftpNormal.read('data.csv')) full += chunk.toString('utf8');
    sftpNormal.close();
    expect(full).toBe('id,name\n1,Alpha\n');

    // 3. Signal abort while stream is open
    const controller = new AbortController();
    const aborted = createFake('abort');
    const sftpAbort = await openSftp({
      address: '127.0.0.1',
      port: 22,
      user: 'reader',
      hostKey: hostKey.public,
      password: secret,
      signal: controller.signal,
      timeoutMs: 2_000,
      createClient: () => aborted.client,
    });
    sftpAbort.read('data.csv');
    controller.abort();
    sftpAbort.close();

    // 4. Server drops connection after stream ends
    const dropped = createFake('drop');
    const sftpDrop = await openSftp({
      address: '127.0.0.1',
      port: 22,
      user: 'reader',
      hostKey: hostKey.public,
      password: secret,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 2_000,
      createClient: () => dropped.client,
    });
    sftpDrop.read('data.csv');
    dropped.streams[0]!.emit('error', new Error('Connection reset by peer'));
    sftpDrop.close();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uncaught).toEqual([]);
    expect(rejected).toEqual([]);
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejected);
  }
});

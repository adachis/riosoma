import { randomBytes } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
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

import { connect, type Socket } from 'node:net';
import { Server, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { SshTunnel } from '@riosoma/contracts';
import { connectDatabase } from './connection.js';
import { openTunnel } from './tunnel.js';
import { probeDatabase } from './probe.js';
import { parseSshKey, sshKeyPair } from './ssh.test-helpers.js';

// The user key is encrypted, as a key kept for a bastion usually is.
const passphrase = 'test-passphrase';
const hostKey = sshKeyPair();
const userKey = sshKeyPair({ passphrase, rounds: 16 });
const accepted = parseSshKey(userKey.public);
let kit: TestPostgres;
let db: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let server: Server;
let ssh: SshTunnel;
let forwards = 0;
let connections = 0;
const clients = new Set<Connection>();
const sockets = new Set<Socket>();

beforeAll(async () => {
  kit = await startTestPostgres();
  db = await kit.createDatabase('tunnel');
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    connections++;
    clients.add(client);
    client.on('error', () => undefined);
    client.once('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (
        context.method === 'publickey' &&
        context.username === 'test' &&
        context.key.data.equals(accepted.getPublicSSH()) &&
        (!context.signature || accepted.verify(context.blob!, context.signature, context.hashAlgo))
      )
        context.accept();
      else context.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwards++;
        if (info.destIP !== db.profile.host || info.destPort !== db.profile.port) return reject();
        const socket = connect({ host: info.destIP, port: info.destPort });
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.once('error', () => {
          socket.destroy();
          reject();
        });
        socket.once('connect', () => {
          const channel = accept();
          channel.on('error', () => socket.destroy());
          channel.once('close', () => socket.destroy());
          socket.once('close', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing SSH listener');
  ssh = {
    host: '127.0.0.1',
    port: address.port,
    user: 'test',
    privateKeyPem: userKey.private,
    passphrase,
    hostKey: hostKey.public,
  };
}, 60_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const client of clients) client.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.drop();
  await kit?.stop();
});

// Each test starts a real SSH server and PostgreSQL, and the gate runs every package at once.
describe('SSH tunnels', { timeout: 20_000 }, () => {
  it('shares one SSH connection across pool sockets and closes both', async () => {
    const before = connections;
    const connection = await connectDatabase({ ...db.profile, ssh });
    try {
      const first = await connection.pool.connect();
      const second = await connection.pool.connect();
      try {
        expect((await first.query('SELECT 1 AS value')).rows[0].value).toBe(1);
        expect((await second.query('SELECT 2 AS value')).rows[0].value).toBe(2);
        expect(connections - before).toBe(1);
      } finally {
        first.release();
        second.release();
      }
    } finally {
      await connection.close();
    }
    await connection.close();
    await expect(connection.pool.query('SELECT 1')).rejects.toThrow();
    await expect.poll(() => clients.size).toBe(0);
    await expect.poll(() => sockets.size).toBe(0);
  });

  it('opens a fresh SSH connection after the old one drops', async () => {
    const before = connections;
    const connection = await connectDatabase({ ...db.profile, ssh, pool: { max: 2, idleTimeoutMs: 1_000 } });
    try {
      expect((await connection.pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
      // The bastion ends every session, as it would on a restart.
      for (const client of clients) client.end();
      await expect.poll(() => clients.size, { timeout: 10_000 }).toBe(0);
      // The pool's old connection died with the tunnel; the next query reconnects through a new one.
      // A fresh SSH handshake plus a database login can take a few seconds on a busy machine.
      await expect
        .poll(
          async () => {
            try {
              return (await connection.pool.query('SELECT 2 AS value')).rows[0].value;
            } catch {
              return null;
            }
          },
          { timeout: 10_000 },
        )
        .toBe(2);
      expect(connections - before).toBe(2);
    } finally {
      await connection.close();
    }
    await expect.poll(() => clients.size).toBe(0);
  });

  it('closes the local listener', async () => {
    const tunnel = await openTunnel(ssh, db.profile);
    await tunnel.close();
    await tunnel.close();
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect(tunnel);
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('fails closed on a different pinned key before forwarding database traffic', async () => {
    const before = forwards;
    const wrong = { ...ssh, hostKey: sshKeyPair().public };
    await expect(connectDatabase({ ...db.profile, ssh: wrong })).rejects.toMatchObject({
      reason: 'hostKeyMismatch',
    });
    const report = await probeDatabase({ ...db.profile, ssh: wrong });
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({
      step: 'tunnel',
      messageKey: 'setup.diagnose.tunnel.hostKeyMismatch',
      fixKey: 'setup.fix.checkHostKey',
    });
    expect(forwards).toBe(before);
  });

  it('reports a rejected authentication key', async () => {
    const wrong = {
      ...ssh,
      privateKeyPem: sshKeyPair().private,
      passphrase: undefined,
    };
    const report = await probeDatabase({ ...db.profile, ssh: wrong });
    expect(report.steps.at(-1)).toMatchObject({
      step: 'tunnel',
      messageKey: 'setup.diagnose.tunnel.authRejected',
    });
  });

  it('reaches every rung through a tunnel', async () => {
    const report = await probeDatabase({ ...db.profile, ssh });
    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.step)).toEqual([
      'dns',
      'tunnel',
      'tcp',
      'tls',
      'auth',
      'database',
      'privileges',
      'extensions',
      'version',
      'latency',
    ]);
  });
});

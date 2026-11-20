import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import ssh2 from 'ssh2';
import type { SshTunnel } from '@riosoma/contracts';
import type { Endpoint } from './connection.js';

// ssh2 is CommonJS; Node's ESM loader exposes only its default export.
const { Client, utils } = ssh2;

export class TunnelError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'hostKeyMismatch' | 'authRejected',
    options?: ErrorOptions,
  ) {
    super(`setup.diagnose.tunnel.${reason}`, options);
  }
}

export interface Tunnel extends Endpoint {
  close(): Promise<void>;
}

type SshClient = InstanceType<typeof Client>;

/**
 * Opens a local 127.0.0.1 endpoint that forwards each connection through the SSH server to the
 * database.  The server's host key must match the pinned one on every connection, and nothing is
 * forwarded before it does.  If the SSH connection drops, the next database connection opens a
 * fresh one, so a restarted bastion doesn't need a restarted Riosoma.
 */
export async function openTunnel(profile: SshTunnel, target: Endpoint): Promise<Tunnel> {
  const pinned = utils.parseKey(profile.hostKey);
  if (pinned instanceof Error || pinned.isPrivateKey()) throw new TunnelError('hostKeyMismatch');
  const digest = (key: Buffer) => createHash('sha256').update(key).digest();
  const expected = digest(pinned.getPublicSSH());
  const sockets = new Set<Socket>();
  let live: SshClient | null = null;
  let pending: Promise<SshClient> | null = null;
  let closing: Promise<void> | undefined;

  const connect = () =>
    new Promise<SshClient>((resolve, reject) => {
      const ssh = new Client();
      let mismatch = false;
      let ready = false;
      ssh.once('ready', () => {
        ready = true;
        live = ssh;
        resolve(ssh);
      });
      ssh.on('error', (error: Error & { level?: string }) => {
        if (!ready) {
          reject(
            new TunnelError(
              mismatch
                ? 'hostKeyMismatch'
                : error.level === 'client-authentication'
                  ? 'authRejected'
                  : 'unreachable',
              { cause: error },
            ),
          );
        }
        ssh.destroy();
      });
      ssh.once('close', () => {
        if (!ready) reject(new TunnelError('unreachable'));
        // Forget a dropped connection; the next database connection replaces it.
        if (live === ssh) live = null;
      });
      try {
        ssh.connect({
          host: profile.host,
          port: profile.port,
          username: profile.user,
          privateKey: profile.privateKeyPem,
          passphrase: profile.passphrase,
          readyTimeout: 5_000,
          hostVerifier: (key: Buffer) => {
            mismatch = !timingSafeEqual(expected, digest(key));
            return !mismatch;
          },
        });
      } catch (error) {
        // Invalid private keys throw before ssh2 creates a socket.
        reject(new TunnelError('authRejected', { cause: error }));
      }
    });

  // One connection attempt at a time, shared by every socket that arrives while it's in flight.
  const connection = (): Promise<SshClient> => {
    if (live) return Promise.resolve(live);
    pending ??= connect().finally(() => {
      pending = null;
    });
    return pending;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    if (closing) return void socket.destroy();
    connection().then(
      (ssh) => {
        ssh.forwardOut('127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (error, channel) => {
          if (error) return void socket.destroy();
          if (socket.destroyed) return void channel.destroy();
          channel.on('error', () => socket.destroy());
          channel.once('close', () => socket.destroy());
          socket.once('close', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      },
      () => socket.destroy(),
    );
  });

  const close = () => {
    closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      const listenerClosed = new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      });
      const ssh = live ?? (await pending?.catch(() => null)) ?? null;
      if (ssh) {
        const sshClosed = new Promise<void>((resolve) => ssh.once('close', () => resolve()));
        ssh.destroy();
        await sshClosed;
      }
      await listenerClosed;
    })();
    return closing;
  };

  // The first connection proves the settings before the endpoint is handed out.
  await connection();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await close();
    throw new TunnelError('unreachable', { cause: error });
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new TunnelError('unreachable');
  }
  return { host: '127.0.0.1', port: address.port, close };
}

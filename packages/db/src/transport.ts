import { connect, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { DatabaseProfile } from '@riosoma/contracts';
import { tlsOptions, type Endpoint } from './connection.js';

export class TransportError extends Error {
  constructor(readonly reason: 'timedOut' | 'unsupported' | 'protocol') {
    super(`setup.diagnose.${reason === 'timedOut' ? 'tcp' : 'tls'}.${reason}`);
  }
}

export function openSocket(endpoint: Endpoint): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const timer = setTimeout(() => socket.destroy(new TransportError('timedOut')), 5_000);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

/** Only PostgreSQL's explicit SSL refusal permits a plaintext fallback. */
export async function negotiateTls(
  profile: DatabaseProfile,
  endpoint: Endpoint,
  socket: Socket,
): Promise<boolean> {
  if (profile.tls.mode === 'disable') return false;
  let stream = socket;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      timer = setTimeout(() => stream.destroy(new TransportError('timedOut')), 5_000);
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new TransportError('protocol'));
      });
      socket.once('error', reject);
      socket.once('data', (response: Buffer) => {
        if (response.length !== 1) return reject(new TransportError('protocol'));
        if (response[0] === 78) {
          clearTimeout(timer);
          if (profile.tls.mode === 'prefer') resolve(false);
          else reject(new TransportError('unsupported'));
          return;
        }
        if (response[0] !== 83) return reject(new TransportError('protocol'));
        const options = tlsOptions(profile, endpoint);
        try {
          stream = connectTls({ ...(options || {}), socket });
        } catch (error) {
          reject(error);
          return;
        }
        stream.once('error', reject);
        stream.once('secureConnect', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

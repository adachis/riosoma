import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import assert from 'node:assert/strict';
import { refusedPort } from '@riosoma/testkit';

export const eicar = Buffer.from(
  ['X5O!P%@AP[4', '\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

const command = 'zINSTREAM\0';

/**
 * A scanner address nothing answers on, for the tests of what a file does while its scanner is
 * gone.  A stand-in that is started and stopped leaves a port the operating system gives to the
 * next listener that asks for one, so the connection meant for the stopped scanner can reach
 * another test's server instead.
 */
export async function unreachableScanner(): Promise<string> {
  return `tcp://127.0.0.1:${await refusedPort()}`;
}

export async function standIn(
  options: {
    maxBytes?: number;
    result?: string;
    version?: string;
    socketPath?: string;
    earlyOk?: boolean;
  } = {},
) {
  const received: Buffer[] = [];
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let pending = Buffer.alloc(0);
    let streaming = false;
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on('data', (bytes) => {
      if (socket.writableEnded) return;
      pending = Buffer.concat([pending, bytes]);
      if (!streaming) {
        const end = pending.indexOf(0);
        if (end < 0) return;
        const name = pending.subarray(0, end).toString();
        if (name === 'zPING') return void socket.end('PONG\0');
        if (name === 'zVERSION')
          return void socket.end(
            (options.version ?? 'ClamAV 1.4.6/12345/Thu Oct 01 08:00:00 2026 UTC') + '\0',
          );
        if (pending.length < command.length) return;
        const opening = pending.subarray(0, command.length).toString('latin1');
        if (opening !== command) {
          // Not a scan: a client made for a server that has stopped, which the operating system
          // sent here instead.  Hang up first, so closing the stand-in does not wait on a client
          // that will never get an answer, and then fail where the stray connection is visible.
          socket.destroy();
          assert.equal(opening, command, 'the scanner stand-in was sent bytes that are not a scan command');
          return;
        }
        pending = pending.subarray(command.length);
        streaming = true;
        if (options.earlyOk) return void socket.end('stream: OK\0');
      }
      while (pending.length >= 4) {
        const length = pending.readUInt32BE();
        if (options.maxBytes !== undefined && total + length > options.maxBytes) {
          socket.end('INSTREAM size limit exceeded. ERROR\0');
          return;
        }
        if (pending.length < 4 + length) return;
        total += length;
        chunks.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
        if (!length) {
          const file = Buffer.concat(chunks);
          received.push(file);
          socket.end(
            options.result ??
              (file.includes(eicar) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'),
          );
          return;
        }
      }
    });
  });
  if (options.socketPath) server.listen(options.socketPath);
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address) throw new Error('Missing scanner address');
  return {
    url: typeof address === 'string' ? `unix://${address}` : `tcp://127.0.0.1:${address.port}`,
    received,
    async close() {
      // Anything still waiting on an answer would hold the listener open past the test's own end.
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

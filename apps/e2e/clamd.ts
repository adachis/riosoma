import { createServer, type Socket } from 'node:net';

export const eicar = Buffer.from(
  ['X5O!P%@AP[4', '\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

/** A daemon that answers diagnostics and scans INSTREAM bytes held entirely in memory. */
export async function standIn() {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let streaming = false;
    const chunks: Buffer[] = [];
    socket.on('data', (bytes) => {
      if (socket.writableEnded) return;
      pending = Buffer.concat([pending, bytes]);
      if (!streaming) {
        const end = pending.indexOf(0);
        if (end < 0) return;
        const command = pending.subarray(0, end).toString();
        if (command === 'zPING') return void socket.end('PONG\0');
        if (command === 'zVERSION')
          return void socket.end('ClamAV 1.4.6/12345/Thu Oct 01 08:00:00 2026 UTC\0');
        if (command !== 'zINSTREAM') return void socket.destroy();
        pending = pending.subarray(end + 1);
        streaming = true;
      }
      while (pending.length >= 4) {
        const length = pending.readUInt32BE();
        if (pending.length < 4 + length) return;
        chunks.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
        if (length) continue;
        const file = Buffer.concat(chunks);
        received.push(file);
        socket.end(file.includes(eicar) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        return;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing scanner address');
  return {
    url: `tcp://127.0.0.1:${address.port}`,
    received,
    async close() {
      // Open diagnostic connections must not keep the listener alive after a test finishes.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

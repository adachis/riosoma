import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';

/** Drain responses without letting their keep-alive sockets or open streams delay shutdown. */
export function installHttpShutdown(app: FastifyInstance, { streamGraceMs = 10_000 } = {}): void {
  let closing = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const finish = (_request: IncomingMessage, socket: Duplex) => {
    if (!socket.destroyed) socket.end(() => socket.destroy());
  };
  app.addHook('preClose', async () => {
    closing = true;
    // Closing upgrade refusals bypass request hooks. Run after the WebSocket router flushes
    // its closing response on the same upgrade event.
    app.server.on('upgrade', finish);
    // Event streams answer until their clients leave.  After a grace period for ordinary
    // responses, close whatever is still open so shutdown always finishes.
    grace = setTimeout(() => app.server.closeAllConnections(), streamGraceMs);
    grace.unref();
  });
  app.addHook('onResponse', async () => {
    // Node closes sockets idle when close() starts; a response can become idle afterward.
    if (closing) app.server.closeIdleConnections();
  });
  app.addHook('onClose', async () => {
    clearTimeout(grace);
    app.server.off('upgrade', finish);
  });
}

export async function closeServer(
  app: { close(): Promise<unknown> },
  closeDatabase: (() => Promise<void>) | null | undefined,
): Promise<void> {
  // Shutdown hooks drain work that still uses the pool.
  await app.close();
  await closeDatabase?.();
}

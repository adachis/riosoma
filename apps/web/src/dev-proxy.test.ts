// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile, type ViteDevServer } from 'vite';
import { expect, it, vi } from 'vitest';

it('proxies realtime and script socket upgrades with the browser origin and session intact', async () => {
  const received: Array<{
    path: string | undefined;
    origin: string | undefined;
    cookie: string | undefined;
  }> = [];
  const sockets = new Set<Socket>();
  const upstream = createHttpServer();
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  upstream.on('upgrade', (incoming, socket) => {
    received.push({ path: incoming.url, origin: incoming.headers.origin, cookie: incoming.headers.cookie });
    const accept = createHash('sha1')
      .update(`${incoming.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  let vite: ViteDevServer | undefined;
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    vi.stubEnv('RIOSOMA_DEV_SERVER', `http://127.0.0.1:${upstreamPort}`);
    const web = fileURLToPath(new URL('../', import.meta.url));
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, undefined, web);
    expect(loaded).not.toBeNull();
    vite = await createServer({
      configFile: false,
      root: web,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...loaded!.config.server, host: '127.0.0.1', port: 0, watch: null },
    });
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const origin = `http://localhost:${port}`;
    const cookie = `session=${randomBytes(24).toString('hex')}`;
    for (const path of ['/api/realtime', '/api/scripts/example/run']) {
      await new Promise<void>((resolve, reject) => {
        const upgrade = request({
          host: '127.0.0.1',
          port,
          path,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            Origin: origin,
            Cookie: cookie,
          },
        });
        upgrade.on('error', reject);
        upgrade.on('response', (response) => {
          response.resume();
          reject(new Error(`Socket upgrade returned ${response.statusCode}`));
        });
        upgrade.on('upgrade', (response, socket) => {
          socket.destroy();
          expect(response.statusCode).toBe(101);
          resolve();
        });
        upgrade.setTimeout(3_000, () => upgrade.destroy(new Error('Socket upgrade timed out')));
        upgrade.end();
      });
      expect(received.at(-1)).toEqual({ path, origin, cookie });
    }
  } finally {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await vite?.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

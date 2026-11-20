import type { AddressInfo } from 'node:net';
import { buildConnectorService, type ConnectorServiceOptions } from './app.js';
import { fixedToken } from './token.js';

export { buildConnectorService, type ConnectorServiceOptions } from './app.js';
export { fileToken, fixedToken, type TokenSource } from './token.js';

export interface RunningConnectorService {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Starts the service in this process on a port of its own on this machine, for tests that drive
 * the server's connectors through the real service.
 */
export async function startConnectorService(
  token: string,
  options: Omit<ConnectorServiceOptions, 'token' | 'version'> = {},
): Promise<RunningConnectorService> {
  const app = await buildConnectorService({
    logLevel: 'silent',
    ...options,
    token: fixedToken(token),
    version: 'test',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  // A test's process ends when its tests do, whether or not the service is still listening.
  app.server.unref();
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, token, close: () => app.close() };
}

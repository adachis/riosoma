import type { AddressInfo } from 'node:net';
import { buildConnectorService } from './app.js';
import { loadServiceConfig, ServiceConfigError } from './config.js';

/**
 * Runs the connector service.  In a container it listens for the server on the internal network.
 * Started by a server running from a source checkout, it listens on a port of this machine the
 * system picks, tells the server which over the channel between them, and ends when the server does.
 */
async function main(): Promise<void> {
  const config = loadServiceConfig();
  const app = await buildConnectorService({
    token: config.token,
    version: config.version,
    logLevel: config.logLevel,
  });
  const stop = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  await app.listen({ host: config.host, port: config.port });
  if (process.send) {
    const { port } = app.server.address() as AddressInfo;
    process.send({ listening: port });
    process.on('disconnect', () => void stop('disconnect'));
  }
  if (!config.token.current()) app.log.warn('waiting for the token the server writes on its first start');
}

main().catch((error: unknown) => {
  const setting = error instanceof ServiceConfigError ? error.setting : undefined;
  console.error(
    JSON.stringify({ level: 50, msg: 'connector service failed to start', ...(setting ? { setting } : {}) }),
  );
  process.exit(1);
});

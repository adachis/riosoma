import { openDatabase } from './startup-database.js';
import { buildApp, type AppContext } from './app.js';
import { startupFailure } from './configuration-error.js';
import { redactUrlUserinfo } from './logger.js';
import { loadConfig } from './config.js';
import { checkFileStorage } from './data/files/check.js';
import { NO_SESSIONS } from './http/policy.js';
import { SetupState } from './setup/state.js';
import { closeServer } from './shutdown.js';
import { prepareDemo } from './demo/sessions.js';
import { childLink } from './sources/connector-service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const setup = new SetupState(config.configDir, config.setupTokenFromEnv);
  // From a source checkout, the server runs the connector service itself unless told where it is.
  let warn: (fields: object, message: string) => void = () => undefined;
  const connectorService = config.connectorServiceUrl
    ? null
    : childLink((fields, message) => warn(fields, message));
  const ctx: AppContext = {
    config,
    pool: null,
    setup,
    sessions: NO_SESSIONS,
    ...(connectorService ? { connectorService } : {}),
  };
  const app = await buildApp(ctx);
  warn = (fields, message) => app.log.warn(fields, message);
  void connectorService?.endpoint().catch(() => undefined);
  app.log.info({ storage: await checkFileStorage(config) }, 'file storage checked');
  await openDatabase(app, ctx);
  await prepareDemo(ctx);
  await setup.refresh(ctx.pool, config.database?.schemas.app ?? 'rio_app');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await closeServer(app, ctx.closeDatabase);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });

  const token = setup.currentToken;
  if (token && !config.setupTokenFromEnv) {
    // The only way into a fresh install: the operator reads this link from the server log.  The
    // token rides in the fragment, which browsers never send to a server or proxy.
    const base = redactUrlUserinfo(config.baseUrl ?? `http://localhost:${config.port}`);
    app.log.warn(`Finish setting up Riosoma at ${base}/setup#token=${token}`);
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 50, ...startupFailure(error) }));
  process.exit(1);
});

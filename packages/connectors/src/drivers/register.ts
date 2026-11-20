import { db2Connector } from '../db2.js';
import { informixConnector } from '../informix.js';
import { teradataConnector } from '../teradata.js';
import { registerConnector } from '../registry.js';
import type { ConnectorContext } from '../types.js';

/**
 * Registers the connectors that load an installed driver, reading drivers from `directory` and
 * keeping every value `serverSecrets` gives out of what a driver's errors say.  It's asked on
 * every call, so a secret the server gains later, like a database chosen in setup, is covered.
 */
export function registerDriverConnectors(
  directory?: string,
  serverSecrets: () => readonly string[] = () => [],
): void {
  const context = (ctx: ConnectorContext): ConnectorContext => ({
    ...ctx,
    driversDir: directory,
    serverSecrets: serverSecrets(),
  });
  for (const connector of [teradataConnector, db2Connector, informixConnector])
    registerConnector({
      kind: connector.kind,
      test: (ctx) => connector.test(context(ctx)),
      listObjects: (ctx) => connector.listObjects(context(ctx)),
      keyCandidates: (ctx, object) => connector.keyCandidates(context(ctx), object),
      describe: (ctx, select) => connector.describe(context(ctx), select),
      preview: (ctx, select, limit) => connector.preview(context(ctx), select, limit),
      read: (ctx, select, options) => connector.read(context(ctx), select, options),
    });
}

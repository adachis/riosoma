import { HTTP_ENGINE_KINDS, type SourceConnection } from '@riosoma/contracts';
import {
  analyticsHost,
  createHttpEngineConnector,
  createDruidConnector,
  createTrinoConnector,
  registerConnector,
  type Connector,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { refuse } from './files.js';
import { hostGuard, refusedHost } from './hosts.js';

/**
 * The analytics engines, and the search, graph, and metrics engines that also speak HTTP, use
 * connectors given a guard that holds every host they connect to, and every address a coordinator
 * names, to the private-network rule the server's other HTTP sources follow.  A host written as a
 * private address, or as `localhost`, is refused before a source is saved or tested, and a name
 * that resolves somewhere private is refused when it's looked up.  ClickHouse runs in the
 * connector service, under the same rule, and its host is checked here before it's saved too.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export function analyticsConnectors(config: Config, resolve: Resolve = systemResolve): Connector[] {
  const guard = hostGuard(config, resolve);
  return [
    ...HTTP_ENGINE_KINDS.map((kind) => createHttpEngineConnector(kind, { hostGuard: guard })),
    createTrinoConnector({ hostGuard: guard }),
    createDruidConnector({ hostGuard: guard }),
  ];
}

export function installAnalyticsSources(app: FastifyInstance): void {
  for (const connector of analyticsConnectors(app.ctx.config)) registerConnector(connector);
}

/** Refuses an engine whose host the rule forbids, before it's saved or tried. */
export function checkAnalyticsSource(connection: SourceConnection, config: Config): void {
  const host = analyticsHost(connection);
  if (host !== null && refusedHost(host, config)) refuse('host', 'sources.analytics.blocked');
}

import { isNoSqlConnection, NOSQL_KINDS, type SourceConnection } from '@riosoma/contracts';
import { createNoSqlConnector, noSqlEndpoint, registerConnector } from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '../config.js';
import { refuse } from './files.js';
import { hostGuard, refusedHost } from './hosts.js';

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;
export function installNoSqlSources(app: FastifyInstance): void {
  for (const kind of NOSQL_KINDS)
    registerConnector(createNoSqlConnector(kind, { hostGuard: hostGuard(app.ctx.config) }));
}
export function checkNoSqlSource(connection: SourceConnection, config: Config): void {
  if (!isNoSqlConnection(connection)) return;
  const host = new URL(noSqlEndpoint(connection)).hostname;
  if (refusedHost(host, config)) refuse('endpoint', 'sources.analytics.blocked');
}

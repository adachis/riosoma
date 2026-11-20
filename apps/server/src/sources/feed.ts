import type { SourceConnection } from '@riosoma/contracts';
import { createFeedConnector, registerConnector, type FeedConnectorOptions } from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';
import { addressProblem, fileNetwork, refuse } from './files.js';

/**
 * Feed sources on this server: the connector, given the same guarded network file and API sources
 * use, so a feed is held to the private-network rule, the checks on each redirect, and the size
 * limit on each answer.  Addresses are https, except plain http to `localhost` while private hosts
 * are allowed.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export function feedConnectorOptions(config: Config, resolve: Resolve = systemResolve): FeedConnectorOptions {
  return { network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }) };
}

export function installFeedSources(app: FastifyInstance): void {
  registerConnector(createFeedConnector(feedConnectorOptions(app.ctx.config)));
}

/**
 * Refuses a feed whose address can't be reached under the private-network rule before it's saved
 * or tried.  Names that resolve somewhere private are caught again when the feed is fetched.
 */
export function checkFeedAddress(connection: SourceConnection, config: Config): void {
  if (connection.kind !== 'feed') return;
  const problem = addressProblem(connection.url, config);
  if (problem) refuse('url', `sources.feed.${problem}`);
}

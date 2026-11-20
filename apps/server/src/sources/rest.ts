import type { RestEndpoint, SourceConnection, SourcePreview } from '@riosoma/contracts';
import {
  ConnectorError,
  connectorFor,
  createRestConnector,
  createAppConnector,
  createGraphQlConnector,
  createODataConnector,
  isRestConnector,
  registerConnector,
  type ConnectorContext,
  type RestConnectorOptions,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';
import { addressProblem, fileNetwork, refuse } from './files.js';
import { connectorCall } from './store.js';

/**
 * API sources on this server: the connector, given the same guarded network file sources use, so
 * an API is held to the private-network rule, the checks on each redirect, and the size limit on
 * each answer, the way a file is.  Addresses are https, except plain http to `localhost` while
 * private hosts are allowed.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

/** How many of an endpoint's first records the setup preview shows. */
const PREVIEW_ROWS = 20;

export function restConnectorOptions(config: Config, resolve: Resolve = systemResolve): RestConnectorOptions {
  return { network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }) };
}

export function installRestSources(app: FastifyInstance): void {
  registerConnector(createRestConnector(restConnectorOptions(app.ctx.config)));
  registerConnector(createGraphQlConnector(restConnectorOptions(app.ctx.config)));
  registerConnector(createODataConnector(restConnectorOptions(app.ctx.config)));
  registerConnector(
    createAppConnector({
      ...restConnectorOptions(app.ctx.config),
      onUnexpectedError: (diagnostic) =>
        app.log.warn({ messageKey: 'sources.app.read', ...diagnostic }, 'sources.app.read'),
    }),
  );
}

/**
 * Refuses an API source whose base address or OAuth token address can't be reached under the
 * private-network rule before it's saved or tried, the way a file's address is refused.
 */
export function checkApiAddress(connection: SourceConnection, config: Config): void {
  if (connection.kind !== 'rest' && connection.kind !== 'graphql' && connection.kind !== 'odata') return;
  const places = [{ field: 'baseUrl', address: connection.baseUrl }];
  if (connection.auth.method === 'oauth-client')
    places.push({ field: 'tokenUrl', address: connection.auth.tokenUrl });
  for (const place of places) {
    const problem = addressProblem(place.address, config);
    if (problem) refuse(place.field, `sources.rest.${problem}`);
  }
}

/** One endpoint's first page, for the setup form, read with the connection's own address and sign-in. */
export function endpointPreview(context: ConnectorContext, endpoint: RestEndpoint): Promise<SourcePreview> {
  return connectorCall(async () => {
    const connector = connectorFor('rest');
    if (!isRestConnector(connector)) throw new ConnectorError('sources.kindUnavailable');
    const preview = await connector.firstPage(
      context,
      { kind: 'object', object: { schema: null, name: endpoint.name } },
      PREVIEW_ROWS,
    );
    return { ...preview, keyCandidates: [] };
  });
}

import { HTTP_ENGINE_KINDS, isSearchSource, type HttpEngineKind } from '@riosoma/contracts';
import { registerConnector } from '../registry.js';
import { ConnectorError, type Connector } from '../types.js';
import { failure } from '../warehouses/errors.js';
import { directNetwork, makeWarehouseConnector, type Network } from '../warehouses/frame.js';
import { EngineHttp, type EngineOptions } from './http.js';
import { SearchSession } from './search.js';
import { GraphMetricsSession } from './graph-metrics.js';

export function createHttpEngineConnector(
  kind: HttpEngineKind,
  options: EngineOptions & { network?: Network } = {},
): Connector {
  const connector = makeWarehouseConnector(
    {
      kind,
      endpoint(ctx) {
        const settings = ctx.connection;
        if (settings.kind !== kind || !('endpoint' in settings) || !settings.endpoint)
          throw new ConnectorError('sources.engines.response');
        const url = new URL(settings.endpoint);
        return {
          host: url.hostname.replace(/^\[|\]$/g, ''),
          port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
          tls: url.protocol === 'https:' ? { ca: 'caPem' in settings ? settings.caPem : undefined } : false,
        };
      },
      async open(ctx) {
        if (ctx.connection.kind !== kind) throw new ConnectorError('sources.engines.response');
        const http = new EngineHttp(ctx, options);
        const session = isSearchSource(kind) ? new SearchSession(http) : new GraphMetricsSession(http);
        try {
          await session.list();
          return session;
        } catch (error) {
          await session.close();
          throw error;
        }
      },
      missing: () => null,
    },
    options.network ?? directNetwork(options.hostGuard),
  );
  if (isSearchSource(kind))
    connector.search = async function* (ctx, select, request) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(ctx.statementTimeoutMs ?? ctx.timeoutMs ?? 30_000),
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      const session = new SearchSession(new EngineHttp({ ...ctx, signal }, options));
      try {
        yield* session.pages(select, 1_000, request);
      } catch (error) {
        throw failure(error, ctx, select, () => null);
      } finally {
        await session.close();
      }
    };
  return connector;
}

for (const kind of HTTP_ENGINE_KINDS) registerConnector(createHttpEngineConnector(kind));
export type { Predicate, SearchOrder, SearchRequest } from './search.js';

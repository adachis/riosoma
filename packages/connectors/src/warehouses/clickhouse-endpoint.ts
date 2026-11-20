import type { SourceConnection } from '@riosoma/contracts';
import { hostAndPort, type Endpoint } from './frame.js';

type ClickHouseSettings = Extract<SourceConnection, { kind: 'clickhouse' }>;

/**
 * Where a ClickHouse source's HTTP interface is, and how it's secured.  It lives apart from the
 * connector, so the server can check a source's host without loading the ClickHouse client.
 */
export function clickHouseEndpoint(settings: ClickHouseSettings): Endpoint {
  const endpoint = hostAndPort(settings.host, settings.port);
  return { ...endpoint, tls: settings.secure ? (settings.caPem ? { ca: settings.caPem } : {}) : false };
}

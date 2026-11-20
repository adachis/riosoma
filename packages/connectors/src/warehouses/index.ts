/**
 * The warehouse connectors that need no driver package: MotherDuck, Redshift, Athena, and DuckDB
 * files, and the open-source analytics engines Trino and Druid.  Importing this folder registers
 * them, so the rest of Riosoma reaches one through the connector interface and never through a
 * driver.  Snowflake, BigQuery, Databricks, and ClickHouse run in the connector service.
 */
import { isHttpEngineConnection, type SourceConnection } from '@riosoma/contracts';
import { clickHouseEndpoint } from './clickhouse-endpoint.js';
import { druidEndpoint } from './druid.js';
import { trinoEndpoint } from './trino.js';

export { createDruidConnector, druidConnector } from './druid.js';
export type { HostGuard } from './http.js';
export { clickHouseEndpoint } from './clickhouse-endpoint.js';
export { motherDuckConnector } from './motherduck.js';
export { createTrinoConnector, trinoConnector } from './trino.js';

/**
 * The host an analytics engine's settings name, read the way its connector reads them, so a
 * pasted address gives its host alone.  Null for every other kind of source.
 */
export function analyticsHost(connection: SourceConnection): string | null {
  if (connection.kind === 'clickhouse') return clickHouseEndpoint(connection).host;
  if (connection.kind === 'trino') return trinoEndpoint(connection).host;
  if (connection.kind === 'druid') return druidEndpoint(connection).host;
  // The search, graph, and metrics engines name one whole address, which no secret may ride in.
  if (isHttpEngineConnection(connection) && URL.canParse(connection.endpoint))
    return new URL(connection.endpoint).hostname;
  return null;
}

export { redshiftConnector } from './redshift.js';
export { athenaConnector } from './athena.js';
export { createDuckDbFileConnector } from './duckdb-file.js';

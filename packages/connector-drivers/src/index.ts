/**
 * The connectors that need a driver package of their own: MySQL, SQL Server, Oracle, Firebird,
 * Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB.  Only the connector service loads
 * them, so the server and its image never carry their drivers.  Nothing here registers itself:
 * the service builds the set it runs, with the private-network rule each call is under.
 */
import type { Connector, HostGuard } from '@riosoma/connectors';
import { firebird } from './firebird.js';
import { createMongoConnector, OPEN_NETWORK } from './mongodb/connector.js';
import { mysqlConnector } from './mysql.js';
import { oracle } from './oracle.js';
import { sqlserver } from './sqlserver.js';
import { bigQueryConnector } from './warehouses/bigquery.js';
import { createClickHouseConnector } from './warehouses/clickhouse.js';
import { databricksConnector } from './warehouses/databricks.js';
import { snowflakeConnector } from './warehouses/snowflake.js';

export interface DriverConnectorOptions {
  /** Holds the hosts that ClickHouse and MongoDB look up to the private-network rule */
  hostGuard?: HostGuard;
}

/** Every driver connector, with the hosts that need it held to the given rule. */
export function createDriverConnectors(options: DriverConnectorOptions = {}): Connector[] {
  return [
    mysqlConnector,
    sqlserver,
    oracle,
    firebird,
    snowflakeConnector,
    bigQueryConnector,
    databricksConnector,
    createClickHouseConnector(options.hostGuard ? { hostGuard: options.hostGuard } : {}),
    createMongoConnector({ network: options.hostGuard ?? OPEN_NETWORK }),
  ];
}

export { createClickHouseConnector, clickHouseConnector } from './warehouses/clickhouse.js';
export {
  createMongoConnector,
  MONGO_KEYS,
  OPEN_NETWORK,
  type MongoConnectorOptions,
  type MongoNetwork,
} from './mongodb/connector.js';
export { parseFilter } from './mongodb/filter.js';
export {
  bigQueryConnector,
  databricksConnector,
  firebird,
  mysqlConnector,
  oracle,
  snowflakeConnector,
  sqlserver,
};

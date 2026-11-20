import { SOURCE_KINDS, type SourceKind } from '@riosoma/contracts';

export interface ConnectorCapabilities {
  list: boolean;
  describe: boolean;
  read: boolean;
  paging: boolean;
  keys: boolean;
  query: 'sql' | 'graphql' | 'native' | false;
  filter: boolean;
  sort: boolean;
  secrets: boolean;
  timeout: boolean;
}

const copy: ConnectorCapabilities = {
  list: true,
  describe: true,
  read: true,
  paging: true,
  keys: true,
  query: false,
  filter: false,
  sort: false,
  secrets: true,
  timeout: true,
};
const sql: ConnectorCapabilities = { ...copy, query: 'sql', filter: true, sort: true };
const documents: ConnectorCapabilities = { ...copy, filter: true, sort: true };

/** Declarations cover shipped kinds, including connectors the server registers with its own IO. */
export const CONNECTOR_CAPABILITIES = {
  postgres: sql,
  mysql: sql,
  sqlserver: sql,
  oracle: sql,
  firebird: sql,
  snowflake: sql,
  bigquery: sql,
  databricks: sql,
  motherduck: sql,
  redshift: sql,
  athena: sql,
  'duckdb-file': sql,
  clickhouse: sql,
  trino: sql,
  druid: sql,
  teradata: sql,
  db2: sql,
  informix: sql,
  'file-url': copy,
  bucket: copy,
  sftp: copy,
  ftp: copy,
  ftps: copy,
  webdav: copy,
  graphql: { ...copy, query: 'graphql' },
  odata: documents,
  rest: copy,
  app: copy,
  mongodb: { ...copy, filter: true },
  dynamodb: documents,
  couchdb: documents,
  couchbase: documents,
  firestore: documents,
  cosmosdb: documents,
  elasticsearch: documents,
  opensearch: documents,
  meilisearch: documents,
  typesense: documents,
  neo4j: { ...copy, query: 'native', filter: true, sort: true },
  influxdb: { ...copy, query: 'native', filter: true, sort: true },
  prometheus: copy,
  'google-sheets': copy,
  airtable: copy,
  'sharepoint-list': copy,
  'excel-online': copy,
  dataverse: copy,
  feed: copy,
  // Incoming posts have no snapshot stream or remote call to time out.
  webhook: { ...copy, read: false, paging: false, timeout: false },
} satisfies Record<SourceKind, ConnectorCapabilities>;

export const SHIPPED_CONNECTORS: readonly SourceKind[] = SOURCE_KINDS;
export type ContractCapability = keyof ConnectorCapabilities;

export function declaredCapabilities(kind: SourceKind): ConnectorCapabilities {
  return { ...CONNECTOR_CAPABILITIES[kind] };
}

export function requiredCapabilities(kind: SourceKind): ContractCapability[] {
  return (Object.entries(declaredCapabilities(kind)) as Array<[ContractCapability, boolean | string]>)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([name]) => name);
}

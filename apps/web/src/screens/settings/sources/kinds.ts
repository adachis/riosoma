import {
  APP_CATALOG,
  appConnectionSchema,
  type AppCatalogEntry,
  isHttpEngine,
  isHttpEngineConnection,
  isNoSqlKind,
  isNoSqlConnection,
} from '@riosoma/contracts';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  faBolt,
  faBucket,
  faChartLine,
  faChartSimple,
  faCircleNodes,
  faCloud,
  faDatabase,
  faCubes,
  faDiagramProject,
  faFileExcel,
  faFileLines,
  faFire,
  faGaugeHigh,
  faHardDrive,
  faInbox,
  faLayerGroup,
  faLeaf,
  faListUl,
  faMagnifyingGlass,
  faPlug,
  faRss,
  faServer,
  faSnowflake,
  faTableCells,
  faTableColumns,
  faTableList,
  faWarehouse,
  faWaveSquare,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@riosoma/icons';
import {
  ANALYTICS_PORTS,
  MONGODB_DEFAULT_PORT,
  REST_LIMITS,
  WEBHOOK_SOURCE_LIMITS,
  RestEndpoint,
  RestTarget,
  SourceConnection,
  dataverseEnvironmentOf,
  oracleTarget,
  oracleTlsMode,
  parseEasyConnect,
  requiredSecrets,
  sharePointSiteOf,
  spreadsheetIdOf,
  workbookAddressOf,
  type FileFormat,
  type FirebirdWireCrypt,
  type MongoTlsMode,
  type OracleTlsMode,
  type RestAuthMethod,
  type RestPagingStyle,
  type SecretName,
  type SourceAccess,
  type SourceKind,
  type TrinoAuthMethod,
} from '@riosoma/contracts';

/**
 * The connection kinds, the form that describes one, and the two ways it turns into the contract's
 * `SourceConnection`: `toConnection` on the way out, `fromConnection` on the way in.  The form keeps
 * every field of every kind in one flat record so one dialog can hold all of them; each kind reads
 * only the fields it has, and the contract decides what may be saved.
 */

type Postgres = Extract<SourceConnection, { kind: 'postgres' }>;
type SqlServer = Extract<SourceConnection, { kind: 'sqlserver' }>;
type Snowflake = Extract<SourceConnection, { kind: 'snowflake' }>;
type Teradata = Extract<SourceConnection, { kind: 'teradata' }>;
type Oracle = Extract<SourceConnection, { kind: 'oracle' }>;
type Rest = Extract<SourceConnection, { kind: 'rest' }>;
type Mongo = Extract<SourceConnection, { kind: 'mongodb' }>;
type Webhook = Extract<SourceConnection, { kind: 'webhook' }>;
export type SignatureFormat = NonNullable<Webhook['signature']>['format'];

export type TlsMode = Postgres['tls']['mode'];
export type TlsSettings = Postgres['tls'];
export type SshSettings = NonNullable<Postgres['ssh']>;
export type AuthMethod = Postgres['auth']['method'];
export type SqlServerAuthMethod = SqlServer['auth']['method'];
export type EntraCredential = Extract<Postgres['auth'], { method: 'azure-entra' }>['credential'];
export type SnowflakeAuth = Snowflake['auth'];
export type Logmech = Teradata['logmech'];

/** Each kind's icon and name, in the order the chooser lists them. */
export const KIND_INFO: ReadonlyArray<{
  kind: SourceKind;
  icon: IconDefinition;
  name: MessageDescriptor;
}> = [
  { kind: 'postgres', icon: faDatabase, name: msg({ id: 'sources.kind.postgres', message: 'PostgreSQL' }) },
  {
    kind: 'mysql',
    icon: faServer,
    name: msg({ id: 'sources.kind.mysql', message: 'MySQL or MariaDB' }),
  },
  {
    kind: 'sqlserver',
    icon: faHardDrive,
    name: msg({ id: 'sources.kind.sqlserver', message: 'SQL Server or Azure SQL' }),
  },
  // Stacked layers for Oracle's tiers of schemas and a flame for Firebird, since neither has an
  // icon of its own in the set.
  {
    kind: 'oracle',
    icon: faLayerGroup,
    name: msg({ id: 'sources.kind.oracle', message: 'Oracle Database' }),
  },
  { kind: 'firebird', icon: faFire, name: msg({ id: 'sources.kind.firebird', message: 'Firebird' }) },
  { kind: 'snowflake', icon: faSnowflake, name: msg({ id: 'sources.kind.snowflake', message: 'Snowflake' }) },
  {
    kind: 'redshift',
    icon: faDatabase,
    name: msg({ id: 'sources.kind.redshift', message: 'Amazon Redshift' }),
  },
  { kind: 'athena', icon: faChartSimple, name: msg({ id: 'sources.kind.athena', message: 'Amazon Athena' }) },
  {
    kind: 'duckdb-file',
    icon: faDatabase,
    name: msg({ id: 'sources.kind.duckdb-file', message: 'DuckDB file' }),
  },
  { kind: 'bigquery', icon: faChartSimple, name: msg({ id: 'sources.kind.bigquery', message: 'BigQuery' }) },
  {
    kind: 'databricks',
    icon: faBolt,
    name: msg({ id: 'sources.kind.databricks', message: 'Databricks' }),
  },
  {
    kind: 'motherduck',
    icon: faCloud,
    name: msg({ id: 'sources.kind.motherduck', message: 'MotherDuck' }),
  },
  // Columns for a column store, a diagram for an engine that queries many systems, and a line over
  // time for a time-series store, since none of the three has an icon of its own in the set.
  {
    kind: 'clickhouse',
    icon: faTableColumns,
    name: msg({ id: 'sources.kind.clickhouse', message: 'ClickHouse' }),
  },
  { kind: 'trino', icon: faDiagramProject, name: msg({ id: 'sources.kind.trino', message: 'Trino' }) },
  { kind: 'druid', icon: faChartLine, name: msg({ id: 'sources.kind.druid', message: 'Apache Druid' }) },
  { kind: 'db2', icon: faDatabase, name: msg({ id: 'sources.kind.db2', message: 'IBM Db2' }) },
  { kind: 'informix', icon: faDatabase, name: msg({ id: 'sources.kind.informix', message: 'IBM Informix' }) },
  { kind: 'teradata', icon: faWarehouse, name: msg({ id: 'sources.kind.teradata', message: 'Teradata' }) },
  {
    kind: 'file-url',
    icon: faFileLines,
    name: msg({ id: 'sources.kind.fileUrl', message: 'File at a web address' }),
  },
  {
    kind: 'bucket',
    icon: faBucket,
    name: msg({ id: 'sources.kind.bucket', message: 'Files in a storage bucket' }),
  },
  { kind: 'sftp', icon: faFileLines, name: msg({ id: 'sources.kind.sftp', message: 'SFTP' }) },
  { kind: 'ftp', icon: faFileLines, name: msg({ id: 'sources.kind.ftp', message: 'FTP' }) },
  { kind: 'ftps', icon: faFileLines, name: msg({ id: 'sources.kind.ftps', message: 'FTPS' }) },
  { kind: 'webdav', icon: faFileLines, name: msg({ id: 'sources.kind.webdav', message: 'WebDAV' }) },
  { kind: 'graphql', icon: faPlug, name: msg({ id: 'sources.kind.graphql', message: 'GraphQL' }) },
  { kind: 'odata', icon: faPlug, name: msg({ id: 'sources.kind.odata', message: 'OData v4' }) },
  { kind: 'rest', icon: faPlug, name: msg({ id: 'sources.kind.rest', message: 'Web API' }) },
  { kind: 'app', icon: faPlug, name: msg({ id: 'sources.app.kind', message: 'App' }) },
  { kind: 'dynamodb', icon: faDatabase, name: msg({ id: 'sources.kind.dynamodb', message: 'DynamoDB' }) },
  { kind: 'couchdb', icon: faDatabase, name: msg({ id: 'sources.kind.couchdb', message: 'CouchDB' }) },
  { kind: 'couchbase', icon: faDatabase, name: msg({ id: 'sources.kind.couchbase', message: 'Couchbase' }) },
  { kind: 'firestore', icon: faDatabase, name: msg({ id: 'sources.kind.firestore', message: 'Firestore' }) },
  { kind: 'cosmosdb', icon: faDatabase, name: msg({ id: 'sources.kind.cosmosdb', message: 'Cosmos DB' }) },
  { kind: 'mongodb', icon: faLeaf, name: msg({ id: 'sources.kind.mongodb', message: 'MongoDB' }) },
  {
    kind: 'elasticsearch',
    icon: faMagnifyingGlass,
    name: msg({ id: 'sources.kind.elasticsearch', message: 'Elasticsearch' }),
  },
  {
    kind: 'opensearch',
    icon: faMagnifyingGlass,
    name: msg({ id: 'sources.kind.opensearch', message: 'OpenSearch' }),
  },
  {
    kind: 'meilisearch',
    icon: faMagnifyingGlass,
    name: msg({ id: 'sources.kind.meilisearch', message: 'Meilisearch' }),
  },
  {
    kind: 'typesense',
    icon: faMagnifyingGlass,
    name: msg({ id: 'sources.kind.typesense', message: 'Typesense' }),
  },
  { kind: 'neo4j', icon: faCircleNodes, name: msg({ id: 'sources.kind.neo4j', message: 'Neo4j' }) },
  { kind: 'influxdb', icon: faWaveSquare, name: msg({ id: 'sources.kind.influxdb', message: 'InfluxDB' }) },
  {
    kind: 'prometheus',
    icon: faGaugeHigh,
    name: msg({ id: 'sources.kind.prometheus', message: 'Prometheus' }),
  },
  {
    kind: 'google-sheets',
    icon: faTableCells,
    name: msg({ id: 'sources.kind.googleSheets', message: 'Google Sheets' }),
  },
  { kind: 'airtable', icon: faTableList, name: msg({ id: 'sources.kind.airtable', message: 'Airtable' }) },
  // A list for SharePoint's lists, a sheet for Excel, and cubes for Dataverse's tables, since none
  // of the three has a brand icon in the set.
  {
    kind: 'sharepoint-list',
    icon: faListUl,
    name: msg({ id: 'sources.kind.sharePointList', message: 'SharePoint lists' }),
  },
  {
    kind: 'excel-online',
    icon: faFileExcel,
    name: msg({ id: 'sources.kind.excelOnline', message: 'Excel in SharePoint or OneDrive' }),
  },
  { kind: 'dataverse', icon: faCubes, name: msg({ id: 'sources.kind.dataverse', message: 'Dataverse' }) },
  { kind: 'feed', icon: faRss, name: msg({ id: 'sources.kind.feed', message: 'RSS or Atom feed' }) },
  {
    kind: 'webhook',
    icon: faInbox,
    name: msg({ id: 'sources.kind.webhook', message: 'Incoming webhook' }),
  },
];

/** Apps are individual catalog entries in the creation chooser. */
export const FORM_KIND_INFO = KIND_INFO.filter((info) => info.kind !== 'app');

export function kindInfo(kind: SourceKind): (typeof KIND_INFO)[number] {
  return KIND_INFO.find((info) => info.kind === kind) ?? KIND_INFO[0]!;
}

/** The port each kind listens on by default, for the ones that have one. */
const DEFAULT_PORTS: Partial<Record<SourceKind, number>> = {
  sftp: 22,
  ftp: 21,
  ftps: 21,
  postgres: 5432,
  redshift: 5439,
  teradata: 443,
  db2: 50000,
  informix: 9089,
  mysql: 3306,
  sqlserver: 1433,
  oracle: 1521,
  firebird: 3050,
  mongodb: MONGODB_DEFAULT_PORT,
  clickhouse: ANALYTICS_PORTS.clickhouse.secure,
  trino: ANALYTICS_PORTS.trino.secure,
  druid: ANALYTICS_PORTS.druid.secure,
};

/** The kinds that answer over HTTP, which is HTTPS unless someone turns it off. */
export type AnalyticsKind = keyof typeof ANALYTICS_PORTS;

export function isAnalyticsKind(kind: SourceKind): kind is AnalyticsKind {
  return kind in ANALYTICS_PORTS;
}

/**
 * The port after HTTPS is turned on or off: the other default when the port is still one of the
 * kind's defaults, and whatever someone typed otherwise.
 */
export function portAfterSecure(kind: AnalyticsKind, port: number, secure: boolean): number {
  const ports = ANALYTICS_PORTS[kind];
  const from = secure ? ports.plain : ports.secure;
  return port === from ? (secure ? ports.secure : ports.plain) : port;
}

/**
 * What a pasted address says, for a kind that takes one: the host, the port it names or the
 * scheme's default, and whether it's HTTPS.  Null for text that isn't a whole address, which stays
 * in the host field as typed.
 */
export function pastedAddress(
  kind: AnalyticsKind,
  text: string,
): Pick<SourceFormValues, 'host' | 'port' | 'secure'> | null {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed) || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  const secure = url.protocol === 'https:';
  const ports = ANALYTICS_PORTS[kind];
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : secure ? ports.secure : ports.plain,
    secure,
  };
}

/**
 * What a host field holds once someone leaves it: a whole address splits the way a paste does, and
 * `host:port` splits into the two fields, so the port the form shows is always the one used.
 */
export function typedAddress(
  kind: AnalyticsKind,
  text: string,
): Pick<SourceFormValues, 'host' | 'port'> | Pick<SourceFormValues, 'host' | 'port' | 'secure'> | null {
  const whole = pastedAddress(kind, text);
  if (whole) return whole;
  const match = /^([^\s:/[\]]+):(\d{1,5})$/.exec(text.trim());
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : null;
}

/** SSH has one default of its own, the same on every bastion. */
const DEFAULT_SSH_PORT = 22;

/** An API source's pace unless someone slows it down or speeds it up. */
export const DEFAULT_REQUESTS_PER_SECOND = 5;

/**
 * One endpoint of an API source as its form holds it: text and numbers, with every paging style's
 * settings side by side so switching styles keeps what was typed.  Query parameters are one
 * `name=value` per line.  A cleared number is `NaN`, and an optional one stays out of the endpoint.
 */
export interface EndpointDraft {
  name: string;
  path: string;
  query: string;
  records: string;
  paging: RestPagingStyle;
  pageParam: string;
  pageStart: number;
  pageValueTemplate?: string;
  pageStep?: number;
  sizeParam: string;
  pageSize: number;
  offsetParam: string;
  limitParam: string;
  limit: number;
  cursorPath: string;
  cursorParam: string;
  nextPath: string;
  maxPages: number;
  maxRecords: number;
  flattenDepth: number;
  arrays: RestEndpoint['arrays'];
}

export function blankEndpoint(): EndpointDraft {
  return {
    name: '',
    path: '',
    query: '',
    records: '',
    paging: 'none',
    pageParam: 'page',
    pageStart: 1,
    sizeParam: '',
    pageSize: NaN,
    offsetParam: 'offset',
    limitParam: 'limit',
    limit: 100,
    cursorPath: '',
    cursorParam: '',
    nextPath: '',
    maxPages: REST_LIMITS.pages,
    maxRecords: REST_LIMITS.records,
    flattenDepth: 1,
    arrays: 'text',
  };
}

/** Query parameters, one `name=value` per line, with blank lines skipped. */
function queryOf(text: string): Array<{ name: string; value: string }> {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const at = line.indexOf('=');
      return at < 0
        ? { name: line.trim(), value: '' }
        : { name: line.slice(0, at).trim(), value: line.slice(at + 1) };
    });
}

function pagingOf(draft: EndpointDraft): Record<string, unknown> {
  switch (draft.paging) {
    case 'none':
    case 'link-header':
      return { style: draft.paging };
    case 'page':
      return {
        style: 'page',
        param: draft.pageParam.trim(),
        start: draft.pageStart,
        ...(draft.pageValueTemplate ? { valueTemplate: draft.pageValueTemplate } : {}),
        ...(draft.pageStep ? { step: draft.pageStep } : {}),
        ...(filled(draft.sizeParam) ? { sizeParam: filled(draft.sizeParam) } : {}),
        ...(Number.isFinite(draft.pageSize) ? { size: draft.pageSize } : {}),
      };
    case 'offset':
      return {
        style: 'offset',
        offsetParam: draft.offsetParam.trim(),
        limitParam: draft.limitParam.trim(),
        limit: draft.limit,
      };
    case 'last-record':
      return {
        style: 'last-record',
        cursorPath: draft.cursorPath.trim(),
        param: draft.cursorParam.trim(),
        size: draft.pageSize,
        ...(filled(draft.sizeParam) ? { sizeParam: filled(draft.sizeParam) } : {}),
      };
    case 'cursor':
      return { style: 'cursor', cursorPath: draft.cursorPath.trim(), param: draft.cursorParam.trim() };
    case 'next-url':
      return { style: 'next-url', nextPath: draft.nextPath.trim() };
  }
}

function draftEndpoint(draft: EndpointDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    path: draft.path.trim(),
    query: queryOf(draft.query),
    records: draft.records.trim(),
    paging: pagingOf(draft),
    maxPages: draft.maxPages,
    maxRecords: draft.maxRecords,
    flattenDepth: draft.flattenDepth,
    arrays: draft.arrays,
  };
}

/** The contract's endpoint for a draft, or null while the draft can't be one. */
export function toEndpoint(draft: EndpointDraft): RestEndpoint | null {
  const parsed = RestEndpoint.safeParse(draftEndpoint(draft));
  return parsed.success ? parsed.data : null;
}

/** Fills an endpoint's form from a stored endpoint. */
export function fromEndpoint(endpoint: RestEndpoint): EndpointDraft {
  const draft: EndpointDraft = {
    ...blankEndpoint(),
    name: endpoint.name,
    path: endpoint.path,
    query: endpoint.query.map(({ name, value }) => `${name}=${value}`).join('\n'),
    records: endpoint.records,
    paging: endpoint.paging.style,
    maxPages: endpoint.maxPages,
    maxRecords: endpoint.maxRecords,
    flattenDepth: endpoint.flattenDepth,
    arrays: endpoint.arrays,
  };
  const { paging } = endpoint;
  switch (paging.style) {
    case 'page':
      return {
        ...draft,
        pageParam: paging.param,
        pageStart: paging.start,
        ...(paging.valueTemplate ? { pageValueTemplate: paging.valueTemplate } : {}),
        ...(paging.step ? { pageStep: paging.step } : {}),
        sizeParam: paging.sizeParam ?? '',
        pageSize: paging.size ?? NaN,
      };
    case 'offset':
      return {
        ...draft,
        offsetParam: paging.offsetParam,
        limitParam: paging.limitParam,
        limit: paging.limit,
      };
    case 'last-record':
      return {
        ...draft,
        cursorPath: paging.cursorPath,
        cursorParam: paging.param,
        pageSize: paging.size,
        sizeParam: paging.sizeParam ?? '',
      };
    case 'cursor':
      return { ...draft, cursorPath: paging.cursorPath, cursorParam: paging.param };
    case 'next-url':
      return { ...draft, nextPath: paging.nextPath };
    default:
      return draft;
  }
}

/**
 * One flat record of everything the form can hold.  Text stays text until it reaches the contract,
 * so a half-typed value is a validation failure rather than a guess.
 */
export interface SourceFormValues {
  app: string;
  appSettings: Record<string, string>;
  remotePath: string;
  remoteAuth: 'password' | 'key';
  davAuth: 'basic' | 'bearer';
  graphQuery: string;
  graphVariables: string;
  graphRecords: string;
  graphPaging: 'none' | 'cursor' | 'offset';
  graphPageInfo: string;
  graphVariable: string;
  graphSizeVariable: string;
  graphSize: number;
  redshiftAuth: 'iam' | 'password';
  deployment: 'provisioned' | 'serverless';
  clusterIdentifier: string;
  workgroup: string;
  resultsLocation: string;
  maxScannedBytes: number;
  duckStorage: 'local' | 'url' | 'bucket';
  duckPath: string;
  duckFormat: 'duckdb' | 'parquet' | 'csv';
  noSqlAuth: 'master-key' | 'entra';
  emulator: boolean;
  collectionGroups: string;
  segments: number;
  /** How an HTTP engine signs a request in: a key, a password, a token, or an AWS signature */
  engineAuth: 'none' | 'basic' | 'api-key' | 'token' | 'aws-sigv4';
  /** Which Amazon OpenSearch service an address is: a managed cluster or a serverless collection */
  engineService: 'es' | 'aoss';
  /** Which InfluxDB API to speak: version 2's, or version 3's SQL one */
  influxVersion: '2' | '3';
  /** The InfluxDB organization a token belongs to, which version 2's query API needs */
  organization: string;
  /** A PromQL query, which is the only thing a Prometheus source reads */
  query: string;
  /** How far back a time-series source reads, in minutes, when no fixed range is set */
  windowMinutes: number;
  /** Seconds between the points of a Prometheus range query */
  stepSeconds: number;
  /** The ends of a fixed range, as ISO moments.  Empty reads the rolling window instead. */
  start: string;
  end: string;
  name: string;
  description: string;
  access: SourceAccess;
  host: string;
  port: number;
  database: string;
  user: string;
  account: string;
  warehouse: string;
  schema: string;
  role: string;
  projectId: string;
  location: string;
  dataset: string;
  httpPath: string;
  catalog: string;
  logmech: Logmech;
  /** Snowflake signs in with a password or a key pair; the others use `authMethod`. */
  snowflakeAuth: SnowflakeAuth;
  authMethod: AuthMethod;
  credential: EntraCredential;
  clientId: string;
  tenantId: string;
  region: string;
  instanceConnectionName: string;
  tlsMode: TlsMode;
  caPem: string;
  clientCertPem: string;
  serverName: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  useSsh: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostKey: string;
  /** A file source's address */
  url: string;
  /** The file format, or empty to go by each file's name */
  fileFormat: FileFormat | '';
  sheet: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** An API source's base address */
  baseUrl: string;
  restAuth: RestAuthMethod;
  /** Preserve transport options configured outside the form when visible settings are edited. */
  restAuthOptions?: Rest['auth'];
  /** The header or query parameter an API key travels in */
  keyName: string;
  tokenUrl: string;
  scope: string;
  clientAuth: Extract<Rest['auth'], { method: 'oauth-client' }>['clientAuth'];
  requestsPerSecond: number;
  endpoints: EndpointDraft[];
  /** Whether a MongoDB source is named by a connection string or by a host and port */
  mongoAddress: Mongo['address'];
  /** Finds a MongoDB source's servers through DNS, as `mongodb+srv` does */
  srv: boolean;
  authSource: string;
  mongoTls: MongoTlsMode;
  /** How many levels of a MongoDB source's nested documents become their own columns */
  flattenDepth: number;
  arrays: Mongo['arrays'];
  /** A Google Sheets source's spreadsheets, one address or ID per line */
  spreadsheets: string;
  /** The row that names each sheet's columns */
  headerRow: number;
  /** The service account's address, which the server copies from the key */
  serviceAccountEmail: string;
  /** The IDs of the bases an Airtable source offers, in the order they were chosen */
  airtableBases: string[];
  /** A SharePoint list source's sites, one address per line */
  sharePointSites: string;
  /** An Excel workbook source's workbooks, one address per line */
  workbooks: string;
  /** A Dataverse environment's address */
  environmentUrl: string;
  /** Where a webhook's posts keep their records, or empty for the post itself */
  hookRecords: string;
  /** Whether a list in a post makes a record of each item */
  hookSplit: boolean;
  /** Whether a webhook checks each post's signature */
  hookSigned: boolean;
  hookFormat: SignatureFormat;
  hookHeader: string;
  /** For the hex form, the header holding the time the signature covers, or empty for none */
  hookTimestampHeader: string;
  hookTolerance: number;
  hookPerMinute: number;
  hookPaused: boolean;
  /** Whether ClickHouse, Trino, or Druid answers over HTTPS */
  secure: boolean;
  trinoAuth: TrinoAuthMethod;
  /** Whether an Oracle source is named by a host and service or by an Easy Connect string */
  oracleAddress: Oracle['address'];
  serviceName: string;
  easyConnect: string;
  oracleTls: OracleTlsMode;
  /** Whether a Firebird source insists on wire encryption or takes it when the server offers it */
  wireCrypt: FirebirdWireCrypt;
}

export function blankValues(kind: SourceKind): SourceFormValues {
  return {
    app: '',
    appSettings: {},
    remotePath: '*',
    remoteAuth: 'password',
    davAuth: 'basic',
    graphQuery: '',
    graphVariables: '{}',
    graphRecords: '',
    graphPaging: 'none',
    graphPageInfo: '',
    graphVariable: 'after',
    graphSizeVariable: 'limit',
    graphSize: 100,
    redshiftAuth: 'iam',
    deployment: 'provisioned',
    clusterIdentifier: '',
    workgroup: '',
    resultsLocation: '',
    maxScannedBytes: 1_000_000_000,
    duckStorage: 'local',
    duckPath: '',
    duckFormat: 'duckdb',
    // Each engine's own usual way in, so the form starts on the choice most people need.
    engineAuth:
      kind === 'prometheus'
        ? 'none'
        : kind === 'neo4j' || kind === 'opensearch'
          ? 'basic'
          : kind === 'influxdb'
            ? 'token'
            : 'api-key',
    engineService: 'es',
    influxVersion: '2',
    organization: '',
    query: '',
    windowMinutes: 60,
    stepSeconds: 60,
    start: '',
    end: '',
    name: '',
    description: '',
    access: 'admins',
    host: '',
    port: DEFAULT_PORTS[kind] ?? 5432,
    // ClickHouse names its first database and user `default`, which is where most people start.
    // Neo4j names its only database in the community edition `neo4j`.
    database: kind === 'clickhouse' ? 'default' : kind === 'neo4j' ? 'neo4j' : '',
    user: kind === 'clickhouse' ? 'default' : '',
    account: '',
    warehouse: '',
    schema: '',
    role: '',
    projectId: '',
    location: '',
    dataset: '',
    httpPath: '',
    catalog: kind === 'athena' ? 'AwsDataCatalog' : '',
    logmech: 'TD2',
    // A key pair is what Snowflake's own documentation recommends, and the contract's default.
    snowflakeAuth: 'key-pair',
    authMethod: 'password',
    credential: 'managed-identity',
    clientId: '',
    tenantId: '',
    region: '',
    instanceConnectionName: '',
    tlsMode: 'verify-full',
    caPem: '',
    clientCertPem: '',
    serverName: '',
    encrypt: true,
    trustServerCertificate: false,
    noSqlAuth: 'master-key',
    emulator: false,
    collectionGroups: '',
    segments: 4,
    useSsh: false,
    sshHost: '',
    sshPort: DEFAULT_SSH_PORT,
    sshUser: '',
    sshHostKey: '',
    url: '',
    fileFormat: '',
    sheet: '',
    endpoint: '',
    bucket: '',
    prefix: '',
    pathStyle: false,
    baseUrl: '',
    restAuth: 'none',
    keyName: '',
    tokenUrl: '',
    scope: '',
    clientAuth: 'basic',
    requestsPerSecond: DEFAULT_REQUESTS_PER_SECOND,
    endpoints: [],
    // Atlas and most hosted services hand out a connection string, so that's where one starts.
    mongoAddress: 'uri',
    srv: false,
    authSource: '',
    mongoTls: 'auto',
    flattenDepth: 1,
    arrays: 'text',
    spreadsheets: '',
    headerRow: 1,
    serviceAccountEmail: '',
    airtableBases: [],
    sharePointSites: '',
    workbooks: '',
    environmentUrl: '',
    hookRecords: '',
    hookSplit: true,
    hookSigned: false,
    hookFormat: 'timestamped',
    hookHeader: 'Riosoma-Signature',
    hookTimestampHeader: '',
    hookTolerance: WEBHOOK_SOURCE_LIMITS.toleranceSeconds,
    hookPerMinute: WEBHOOK_SOURCE_LIMITS.postsPerMinute,
    hookPaused: false,
    secure: true,
    trinoAuth: 'password',
    oracleAddress: 'host',
    serviceName: '',
    easyConnect: '',
    oracleTls: 'disable',
    wireCrypt: 'required',
  };
}

/**
 * The spreadsheets a form's text names, one per line, as IDs.  A line that names none stays as it
 * was typed, so the contract refuses it rather than the form dropping it.
 */
export function spreadsheetsOf(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => spreadsheetIdOf(line) ?? line);
}

/** The lines of a form's spreadsheets that name no spreadsheet, for saying which ones to fix. */
export function unreadableSpreadsheets(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && spreadsheetIdOf(line) === null);
}

/**
 * A form's text as one address per line, each written the way `parse` writes it, and each only
 * once.  A line `parse` can't read stays as it was typed, so the contract refuses it rather than
 * the form dropping it.
 */
export function addressLines(text: string, parse: (line: string) => string | null): string[] {
  return [
    ...new Set(
      text
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parse(line) ?? line),
    ),
  ];
}

/** The lines of a form's text that `parse` can't read, for saying which ones to fix. */
export function unreadableLines(text: string, parse: (line: string) => string | null): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && parse(line) === null);
}

/** An empty optional field stays out of the request rather than traveling as an empty string. */
function filled(value: string): string | undefined {
  const text = value.trim();
  return text ? text : undefined;
}

function tlsOf(values: SourceFormValues): TlsSettings {
  return {
    mode: values.tlsMode,
    caPem: filled(values.caPem),
    clientCertPem: filled(values.clientCertPem),
    serverName: filled(values.serverName),
  };
}

/**
 * The TLS mode an Oracle form comes to: its own choice, or full checks when the choice is Off and
 * an Easy Connect string starts with `tcps://`, the way the connector reads it.
 */
export function effectiveOracleTls(values: SourceFormValues): OracleTlsMode {
  const tcps = values.oracleAddress === 'easy-connect' && /^\s*tcps:\/\//i.test(values.easyConnect);
  return values.oracleTls === 'disable' && tcps ? 'verify-full' : values.oracleTls;
}

/** An Oracle form's TLS settings, keeping the authority and the name only where the mode reads them. */
function oracleTlsOf(values: SourceFormValues): Record<string, unknown> {
  const mode = effectiveOracleTls(values);
  return {
    mode: values.oracleTls,
    ...(mode !== 'disable' ? { caPem: filled(values.caPem) } : {}),
    ...(mode === 'verify-full' ? { serverName: filled(values.serverName) } : {}),
  };
}

function sshOf(values: SourceFormValues): SshSettings | undefined {
  if (!values.useSsh) return undefined;
  return {
    host: values.sshHost.trim(),
    port: values.sshPort,
    user: values.sshUser.trim(),
    hostKey: values.sshHostKey.trim(),
  };
}

function authOf(values: SourceFormValues): Postgres['auth'] {
  switch (values.authMethod) {
    case 'azure-entra':
      return {
        method: 'azure-entra',
        credential: values.credential,
        clientId: filled(values.clientId),
        tenantId: filled(values.tenantId),
      };
    case 'aws-rds-iam':
      return { method: 'aws-rds-iam', region: values.region.trim() };
    case 'gcp-cloudsql-iam':
      return { method: 'gcp-cloudsql-iam', instanceConnectionName: values.instanceConnectionName.trim() };
    case 'client-certificate':
      return { method: 'client-certificate' };
    case 'password':
      return { method: 'password' };
  }
}

function restAuthOf(values: SourceFormValues): Record<string, unknown> {
  const options = values.restAuthOptions?.method === values.restAuth ? values.restAuthOptions : {};
  switch (values.restAuth) {
    case 'none':
    case 'bearer':
      return { method: values.restAuth };
    case 'header':
    case 'query':
      return { ...options, method: values.restAuth, name: values.keyName.trim() };
    case 'basic':
      return { ...options, method: 'basic', user: values.user.trim() };
    case 'oauth-client':
      return {
        ...options,
        method: 'oauth-client',
        tokenUrl: values.tokenUrl.trim(),
        clientId: values.clientId.trim(),
        scope: filled(values.scope),
        clientAuth: values.clientAuth,
      };
  }
}

/** An API source's address and sign-in, without its endpoints. */
function draftTarget(values: SourceFormValues): Record<string, unknown> {
  return {
    kind: 'rest',
    baseUrl: values.baseUrl.trim(),
    auth: restAuthOf(values),
    requestsPerSecond: values.requestsPerSecond,
  };
}

/** An API source's address and sign-in, or null while they're incomplete, for trying an endpoint. */
export function toRestTarget(values: SourceFormValues): RestTarget | null {
  const parsed = RestTarget.safeParse(draftTarget(values));
  return parsed.success ? parsed.data : null;
}

function draftConnection(kind: SourceKind, values: SourceFormValues): Record<string, unknown> {
  if (kind === 'app') return { kind, app: values.app, settings: values.appSettings };
  if (isNoSqlKind(kind))
    return {
      kind,
      ...(values.endpoint.trim() ? { endpoint: values.endpoint.trim() } : {}),
      region: values.region.trim(),
      segments: values.segments,
      user: values.user.trim(),
      database: values.database.trim() || (kind === 'firestore' ? '(default)' : ''),
      projectId: values.projectId.trim(),
      auth: values.noSqlAuth,
      emulator: values.emulator,
      collectionGroups: values.collectionGroups
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      flattenDepth: values.flattenDepth,
      arrays: values.arrays,
    };

  // Every HTTP engine holds its address and sign-in the same way.  The contract takes only the
  // fields its own kind declares and drops the rest, so one draft serves all seven.
  if (isHttpEngine(kind))
    return {
      kind,
      endpoint: values.endpoint.trim(),
      user: values.user.trim(),
      auth: values.engineAuth,
      caPem: filled(values.caPem),
      region: values.region.trim() || 'us-east-1',
      service: values.engineService,
      database: values.database.trim() || (kind === 'neo4j' ? 'neo4j' : ''),
      organization: values.organization.trim(),
      version: values.influxVersion,
      query: values.query.trim(),
      windowMinutes: values.windowMinutes,
      stepSeconds: values.stepSeconds,
      start: filled(values.start),
      end: filled(values.end),
    };

  switch (kind) {
    case 'sftp':
    case 'ftp':
    case 'ftps':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        user: values.user,
        path: values.remotePath,
        format: values.fileFormat || undefined,
        sheet: filled(values.sheet),
        ...(kind === 'sftp' ? { auth: values.remoteAuth, hostKey: values.sshHostKey.trim() } : {}),
      };
    case 'webdav':
      return {
        kind,
        url: values.url.trim(),
        path: values.remotePath,
        auth: values.davAuth,
        user: values.user,
        format: values.fileFormat || undefined,
        sheet: filled(values.sheet),
      };
    case 'odata':
      return { ...draftTarget(values), kind };
    case 'graphql': {
      let variables: unknown;
      try {
        variables = JSON.parse(values.graphVariables);
      } catch {
        variables = null;
      }
      return {
        ...draftTarget(values),
        kind,
        query: values.graphQuery,
        variables,
        records: values.graphRecords,
        paging:
          values.graphPaging === 'none'
            ? { style: 'none' }
            : {
                style: values.graphPaging,
                pageInfo: values.graphPageInfo,
                variable: values.graphVariable,
                ...(values.graphPaging === 'offset'
                  ? { sizeVariable: values.graphSizeVariable, size: values.graphSize }
                  : {}),
              },
      };
    }
    case 'postgres':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: values.user.trim(),
        auth: authOf(values),
        tls: tlsOf(values),
        ssh: sshOf(values),
      };
    case 'mysql':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: values.user.trim(),
        tls: tlsOf(values),
        ssh: sshOf(values),
      };
    case 'sqlserver':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: filled(values.user),
        // SQL Server signs in with a password or with Entra; the wider list is PostgreSQL's.
        auth: values.authMethod === 'azure-entra' ? authOf(values) : { method: 'password' },
        encrypt: values.encrypt,
        trustServerCertificate: values.trustServerCertificate,
        ...(values.encrypt && !values.trustServerCertificate && filled(values.serverName)
          ? { serverName: filled(values.serverName) }
          : {}),
        ssh: sshOf(values),
      };
    case 'oracle':
      return {
        kind,
        address: values.oracleAddress,
        ...(values.oracleAddress === 'host'
          ? { host: values.host.trim(), port: values.port, serviceName: values.serviceName.trim() }
          : { easyConnect: values.easyConnect.trim() }),
        user: values.user.trim(),
        tls: oracleTlsOf(values),
        ssh: sshOf(values),
      };
    case 'firebird':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: values.user.trim(),
        role: filled(values.role),
        wireCrypt: values.wireCrypt,
        ssh: sshOf(values),
      };
    case 'snowflake':
      return {
        kind,
        account: values.account.trim(),
        user: values.user.trim(),
        warehouse: values.warehouse.trim(),
        database: values.database.trim(),
        schema: filled(values.schema),
        role: filled(values.role),
        auth: values.snowflakeAuth,
      };
    case 'bigquery':
      return {
        kind,
        projectId: values.projectId.trim(),
        location: filled(values.location),
        dataset: filled(values.dataset),
      };
    case 'databricks':
      return {
        kind,
        host: values.host.trim(),
        httpPath: values.httpPath.trim(),
        catalog: filled(values.catalog),
        schema: filled(values.schema),
      };
    case 'redshift':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: filled(values.user),
        region: values.region.trim(),
        deployment: values.deployment,
        auth: values.redshiftAuth,
        clusterIdentifier: filled(values.clusterIdentifier),
        workgroup: filled(values.workgroup),
      };
    case 'athena':
      return {
        kind,
        region: values.region.trim(),
        database: values.database.trim(),
        catalog: values.catalog.trim(),
        workgroup: values.workgroup.trim(),
        resultsLocation: values.resultsLocation.trim(),
        maxScannedBytes: values.maxScannedBytes,
      };
    case 'duckdb-file':
      return {
        kind,
        storage: values.duckStorage,
        format: values.duckFormat,
        ...(values.duckStorage === 'local'
          ? { path: values.duckPath.trim() }
          : values.duckStorage === 'url'
            ? { url: values.url.trim() }
            : {
                bucket: values.bucket.trim(),
                prefix: values.prefix,
                region: values.region.trim() || 'us-east-1',
              }),
      };
    case 'motherduck':
      return { kind, database: values.database.trim() };
    case 'clickhouse':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: values.user.trim(),
        secure: values.secure,
        caPem: values.secure ? filled(values.caPem) : undefined,
      };
    case 'trino':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        catalog: values.catalog.trim(),
        schema: filled(values.schema),
        user: filled(values.user),
        auth: values.trinoAuth,
        secure: values.secure,
        caPem: values.secure ? filled(values.caPem) : undefined,
      };
    case 'druid':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        user: filled(values.user),
        secure: values.secure,
      };
    case 'db2':
    case 'informix':
      return {
        kind,
        host: values.host.trim(),
        port: values.port,
        database: values.database.trim(),
        user: values.user.trim(),
        secure: values.secure,
        caPem: filled(values.caPem),
      };
    case 'teradata':
      return {
        kind,
        port: values.port,
        secure: values.secure,
        caPem: filled(values.caPem),
        host: values.host.trim(),
        user: values.user.trim(),
        database: filled(values.database),
        logmech: values.logmech,
      };
    case 'file-url':
      return {
        kind,
        url: values.url.trim(),
        format: values.fileFormat || undefined,
        sheet: filled(values.sheet),
      };
    case 'bucket':
      return {
        kind,
        endpoint: filled(values.endpoint),
        region: filled(values.region),
        bucket: values.bucket.trim(),
        // A prefix is matched exactly, so its spaces are part of it.
        prefix: values.prefix,
        pathStyle: values.pathStyle,
        format: values.fileFormat || undefined,
        sheet: filled(values.sheet),
      };
    case 'rest':
      return { ...draftTarget(values), endpoints: values.endpoints.map(draftEndpoint) };
    case 'mongodb':
      return {
        kind,
        address: values.mongoAddress,
        ...(values.mongoAddress === 'host'
          ? { host: values.host.trim(), port: values.port, srv: values.srv, user: filled(values.user) }
          : {}),
        database: values.database.trim(),
        authSource: filled(values.authSource),
        tls: { mode: values.mongoTls, caPem: values.mongoTls === 'off' ? undefined : filled(values.caPem) },
        ssh: sshOf(values),
        flattenDepth: values.flattenDepth,
        arrays: values.arrays,
      };
    case 'google-sheets':
      return {
        kind,
        spreadsheets: spreadsheetsOf(values.spreadsheets),
        headerRow: values.headerRow,
        serviceAccountEmail: filled(values.serviceAccountEmail),
      };
    case 'airtable':
      return { kind, bases: values.airtableBases };
    case 'sharepoint-list':
      return {
        kind,
        tenantId: values.tenantId.trim(),
        clientId: values.clientId.trim(),
        sites: addressLines(values.sharePointSites, sharePointSiteOf),
      };
    case 'excel-online':
      return {
        kind,
        tenantId: values.tenantId.trim(),
        clientId: values.clientId.trim(),
        workbooks: addressLines(values.workbooks, workbookAddressOf),
      };
    case 'dataverse':
      return {
        kind,
        tenantId: values.tenantId.trim(),
        clientId: values.clientId.trim(),
        environmentUrl: dataverseEnvironmentOf(values.environmentUrl) ?? values.environmentUrl.trim(),
      };
    case 'feed':
      return { kind, url: values.url.trim() };
    case 'webhook':
      return {
        kind,
        records: values.hookRecords.trim(),
        split: values.hookSplit,
        ...(values.hookSigned
          ? {
              signature: {
                format: values.hookFormat,
                header: values.hookHeader.trim(),
                ...(values.hookFormat === 'hex' && filled(values.hookTimestampHeader)
                  ? { timestampHeader: filled(values.hookTimestampHeader) }
                  : {}),
                toleranceSeconds: values.hookTolerance,
              },
            }
          : {}),
        postsPerMinute: values.hookPerMinute,
        paused: values.hookPaused,
        flattenDepth: values.flattenDepth,
        arrays: values.arrays,
      };
  }
}

/**
 * The contract's shape for what the form holds, or null while the form is incomplete.  A null keeps
 * Save and Test connection disabled, so a request only leaves the browser when the server could
 * accept it.
 */
export function toConnection(
  kind: SourceKind,
  values: SourceFormValues,
  catalog: readonly AppCatalogEntry[] = APP_CATALOG,
): SourceConnection | null {
  const schema = kind === 'app' ? appConnectionSchema(catalog) : SourceConnection;
  const parsed = schema.safeParse(draftConnection(kind, values));
  return parsed.success ? parsed.data : null;
}

function tlsValues(
  tls: TlsSettings,
): Pick<SourceFormValues, 'tlsMode' | 'caPem' | 'clientCertPem' | 'serverName'> {
  return {
    tlsMode: tls.mode,
    caPem: tls.caPem ?? '',
    clientCertPem: tls.clientCertPem ?? '',
    serverName: tls.serverName ?? '',
  };
}

function sshValues(
  ssh: SshSettings | undefined,
): Pick<SourceFormValues, 'useSsh' | 'sshHost' | 'sshPort' | 'sshUser' | 'sshHostKey'> {
  if (!ssh) return { useSsh: false, sshHost: '', sshPort: DEFAULT_SSH_PORT, sshUser: '', sshHostKey: '' };
  return { useSsh: true, sshHost: ssh.host, sshPort: ssh.port, sshUser: ssh.user, sshHostKey: ssh.hostKey };
}

function authValues(auth: Postgres['auth'] | SqlServer['auth']): Partial<SourceFormValues> {
  switch (auth.method) {
    case 'azure-entra':
      return {
        authMethod: 'azure-entra',
        credential: auth.credential,
        clientId: auth.clientId ?? '',
        tenantId: auth.tenantId ?? '',
      };
    case 'aws-rds-iam':
      return { authMethod: 'aws-rds-iam', region: auth.region };
    case 'gcp-cloudsql-iam':
      return { authMethod: 'gcp-cloudsql-iam', instanceConnectionName: auth.instanceConnectionName };
    case 'client-certificate':
      return { authMethod: 'client-certificate' };
    case 'password':
      return { authMethod: 'password' };
  }
}

/** Fills the form from a stored connection, so editing shows what was saved. */
export function fromConnection(connection: SourceConnection): SourceFormValues {
  if (connection.kind === 'app')
    return {
      ...blankValues('app'),
      app: connection.app,
      appSettings: Object.fromEntries(
        Object.entries(connection.settings).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    };
  if (isHttpEngineConnection(connection))
    return {
      ...blankValues(connection.kind),
      endpoint: connection.endpoint,
      user: connection.user,
      engineAuth: connection.auth,
      caPem: connection.caPem ?? '',
      ...('region' in connection ? { region: connection.region } : {}),
      ...('service' in connection ? { engineService: connection.service } : {}),
      ...('database' in connection ? { database: connection.database } : {}),
      ...('organization' in connection ? { organization: connection.organization } : {}),
      ...('version' in connection ? { influxVersion: connection.version } : {}),
      ...('query' in connection ? { query: connection.query } : {}),
      ...('stepSeconds' in connection ? { stepSeconds: connection.stepSeconds } : {}),
      ...('windowMinutes' in connection
        ? {
            windowMinutes: connection.windowMinutes,
            start: connection.start ?? '',
            end: connection.end ?? '',
          }
        : {}),
    };

  if (isNoSqlConnection(connection))
    return {
      ...blankValues(connection.kind),
      ...connection,
      endpoint: connection.endpoint ?? '',
      ...(connection.kind === 'cosmosdb' ? { noSqlAuth: connection.auth } : {}),
      collectionGroups: connection.kind === 'firestore' ? connection.collectionGroups.join('\n') : '',
    };

  const values = blankValues(connection.kind);
  switch (connection.kind) {
    case 'postgres':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        ...authValues(connection.auth),
        ...tlsValues(connection.tls),
        ...sshValues(connection.ssh),
      };
    case 'mysql':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        ...tlsValues(connection.tls),
        ...sshValues(connection.ssh),
      };
    case 'sqlserver':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user ?? '',
        ...authValues(connection.auth),
        encrypt: connection.encrypt,
        trustServerCertificate: connection.trustServerCertificate,
        serverName: connection.serverName ?? '',
        ...sshValues(connection.ssh),
      };
    case 'oracle':
      return {
        ...values,
        oracleAddress: connection.address,
        host: connection.host ?? '',
        port: connection.port,
        serviceName: connection.serviceName ?? '',
        easyConnect: connection.easyConnect ?? '',
        user: connection.user,
        oracleTls: connection.tls.mode,
        caPem: connection.tls.caPem ?? '',
        serverName: connection.tls.serverName ?? '',
        ...sshValues(connection.ssh),
      };
    case 'firebird':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        role: connection.role ?? '',
        wireCrypt: connection.wireCrypt,
        ...sshValues(connection.ssh),
      };
    case 'snowflake':
      return {
        ...values,
        account: connection.account,
        user: connection.user,
        warehouse: connection.warehouse,
        database: connection.database,
        schema: connection.schema ?? '',
        role: connection.role ?? '',
        snowflakeAuth: connection.auth,
      };
    case 'bigquery':
      return {
        ...values,
        projectId: connection.projectId,
        location: connection.location ?? '',
        dataset: connection.dataset ?? '',
      };
    case 'databricks':
      return {
        ...values,
        host: connection.host,
        httpPath: connection.httpPath,
        catalog: connection.catalog ?? '',
        schema: connection.schema ?? '',
      };
    case 'redshift':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user ?? '',
        region: connection.region,
        deployment: connection.deployment,
        redshiftAuth: connection.auth,
        clusterIdentifier: connection.clusterIdentifier ?? '',
        workgroup: connection.workgroup ?? '',
      };
    case 'athena':
      return {
        ...values,
        region: connection.region,
        database: connection.database,
        catalog: connection.catalog,
        workgroup: connection.workgroup,
        resultsLocation: connection.resultsLocation,
        maxScannedBytes: connection.maxScannedBytes,
      };
    case 'duckdb-file':
      return {
        ...values,
        duckStorage: connection.storage,
        duckFormat: connection.format,
        duckPath: connection.path ?? '',
        url: connection.url ?? '',
        bucket: connection.bucket ?? '',
        prefix: connection.prefix,
        region: connection.region,
      };
    case 'motherduck':
      return { ...values, database: connection.database };
    case 'clickhouse':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        secure: connection.secure,
        caPem: connection.caPem ?? '',
      };
    case 'trino':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        catalog: connection.catalog,
        schema: connection.schema ?? '',
        user: connection.user ?? '',
        trinoAuth: connection.auth,
        secure: connection.secure,
        caPem: connection.caPem ?? '',
      };
    case 'druid':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        user: connection.user ?? '',
        secure: connection.secure,
      };
    case 'db2':
    case 'informix':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        secure: connection.secure,
        caPem: connection.caPem ?? '',
      };
    case 'teradata':
      return {
        ...values,
        port: connection.port,
        secure: connection.secure,
        caPem: connection.caPem ?? '',
        host: connection.host,
        user: connection.user,
        database: connection.database ?? '',
        logmech: connection.logmech,
      };
    case 'file-url':
      return {
        ...values,
        url: connection.url,
        fileFormat: connection.format ?? '',
        sheet: connection.sheet ?? '',
      };
    case 'bucket':
      return {
        ...values,
        endpoint: connection.endpoint ?? '',
        region: connection.region ?? '',
        bucket: connection.bucket,
        prefix: connection.prefix,
        pathStyle: connection.pathStyle,
        fileFormat: connection.format ?? '',
        sheet: connection.sheet ?? '',
      };
    case 'sftp':
    case 'ftp':
    case 'ftps':
      return {
        ...values,
        host: connection.host,
        port: connection.port,
        user: connection.user,
        remotePath: connection.path,
        fileFormat: connection.format ?? '',
        sheet: connection.sheet ?? '',
        ...(connection.kind === 'sftp'
          ? { remoteAuth: connection.auth, sshHostKey: connection.hostKey }
          : {}),
      };
    case 'webdav':
      return {
        ...values,
        url: connection.url,
        remotePath: connection.path,
        davAuth: connection.auth,
        user: connection.user,
        fileFormat: connection.format ?? '',
        sheet: connection.sheet ?? '',
      };
    case 'graphql':
    case 'odata':
    case 'rest': {
      const { auth } = connection;
      return {
        ...values,
        baseUrl: connection.baseUrl,
        restAuth: auth.method,
        ...('prefix' in auth || 'secretAsUsername' in auth || 'grant' in auth || 'tokenParams' in auth
          ? { restAuthOptions: auth }
          : {}),
        keyName: auth.method === 'header' || auth.method === 'query' ? auth.name : '',
        user: auth.method === 'basic' ? auth.user : '',
        tokenUrl: auth.method === 'oauth-client' ? auth.tokenUrl : '',
        clientId: auth.method === 'oauth-client' ? auth.clientId : '',
        scope: auth.method === 'oauth-client' ? (auth.scope ?? '') : '',
        clientAuth: auth.method === 'oauth-client' ? auth.clientAuth : 'basic',
        requestsPerSecond: connection.requestsPerSecond,
        endpoints: connection.kind === 'rest' ? connection.endpoints.map(fromEndpoint) : [],
        ...(connection.kind === 'graphql'
          ? {
              graphQuery: connection.query,
              graphVariables: JSON.stringify(connection.variables, null, 2),
              graphRecords: connection.records,
              graphPaging: connection.paging.style,
              ...(connection.paging.style !== 'none'
                ? { graphPageInfo: connection.paging.pageInfo, graphVariable: connection.paging.variable }
                : {}),
              ...(connection.paging.style === 'offset'
                ? { graphSize: connection.paging.size, graphSizeVariable: connection.paging.sizeVariable }
                : {}),
            }
          : {}),
      };
    }
    case 'mongodb':
      return {
        ...values,
        mongoAddress: connection.address,
        host: connection.host ?? '',
        port: connection.port,
        srv: connection.srv,
        database: connection.database,
        user: connection.user ?? '',
        authSource: connection.authSource ?? '',
        mongoTls: connection.tls.mode,
        caPem: connection.tls.caPem ?? '',
        ...sshValues(connection.ssh),
        flattenDepth: connection.flattenDepth,
        arrays: connection.arrays,
      };
    case 'google-sheets':
      return {
        ...values,
        spreadsheets: connection.spreadsheets.join('\n'),
        headerRow: connection.headerRow,
        serviceAccountEmail: connection.serviceAccountEmail ?? '',
      };
    case 'airtable':
      return { ...values, airtableBases: connection.bases };
    case 'sharepoint-list':
      return {
        ...values,
        tenantId: connection.tenantId,
        clientId: connection.clientId,
        sharePointSites: connection.sites.join('\n'),
      };
    case 'excel-online':
      return {
        ...values,
        tenantId: connection.tenantId,
        clientId: connection.clientId,
        workbooks: connection.workbooks.join('\n'),
      };
    case 'dataverse':
      return {
        ...values,
        tenantId: connection.tenantId,
        clientId: connection.clientId,
        environmentUrl: connection.environmentUrl,
      };
    case 'feed':
      return { ...values, url: connection.url };
    case 'webhook':
      return {
        ...values,
        hookRecords: connection.records,
        hookSplit: connection.split,
        hookSigned: Boolean(connection.signature),
        hookFormat: connection.signature?.format ?? 'timestamped',
        hookHeader: connection.signature?.header ?? values.hookHeader,
        hookTimestampHeader: connection.signature?.timestampHeader ?? '',
        hookTolerance: connection.signature?.toleranceSeconds ?? values.hookTolerance,
        hookPerMinute: connection.postsPerMinute,
        hookPaused: connection.paused,
        flattenDepth: connection.flattenDepth,
        arrays: connection.arrays,
      };
  }
}

/** Stand-ins for fields whose shape the contract checks, so a half-filled form still has one. */
const PROBES: Record<string, string> = {
  url: 'https://example.com/file.csv',
  endpoint: 'https://example.com',
  bucket: 'bucket',
  prefix: '',
  fileFormat: '',
  region: 'us-east-1',
  baseUrl: 'https://example.com',
  tokenUrl: 'https://example.com/token',
  keyName: 'X-Api-Key',
  scope: '',
  spreadsheets: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
  serviceAccountEmail: '',
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '00000000-0000-4000-8000-000000000000',
  sharePointSites: 'https://contoso.sharepoint.com/sites/placeholder',
  workbooks: 'https://contoso.sharepoint.com/sites/placeholder/Shared%20Documents/placeholder.xlsx',
  environmentUrl: 'https://placeholder.crm.dynamics.com',
  hookRecords: '',
  hookHeader: 'Riosoma-Signature',
  hookTimestampHeader: '',
  easyConnect: 'db.example.com/service',
  serviceName: 'service',
  // An Oracle source that checks a certificate without its name needs a wallet when no authority
  // is pasted, so an empty authority stays empty.
  caPem: '',
};

/**
 * The connection a half-filled form would have, with a stand-in for every field nobody has typed
 * yet.  Which secrets a connection needs follows from its shape alone: the kind, the way it signs
 * in, and whether a tunnel is in the way.  Asking the contract about the shape is what lets the
 * form ask for the right secrets before the rest of it is complete.
 */
export function probeConnection(kind: SourceKind, values: SourceFormValues): SourceConnection | null {
  const probed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' && !value.trim()
        ? (PROBES[key] ?? 'placeholder')
        : typeof value === 'number' && !Number.isFinite(value)
          ? key === 'sshPort'
            ? DEFAULT_SSH_PORT
            : key === 'requestsPerSecond'
              ? DEFAULT_REQUESTS_PER_SECOND
              : key === 'headerRow'
                ? 1
                : key === 'hookTolerance'
                  ? WEBHOOK_SOURCE_LIMITS.toleranceSeconds
                  : key === 'hookPerMinute'
                    ? WEBHOOK_SOURCE_LIMITS.postsPerMinute
                    : (DEFAULT_PORTS[kind] ?? 5432)
          : value,
    ]),
  ) as SourceFormValues;
  // An API's secrets follow from how it signs in, whatever its endpoints are so far.
  if (kind === 'graphql') {
    probed.graphVariables = '{}';
    probed.graphQuery = '{ __typename }';
    probed.graphRecords = 'data.rows';
  }
  if (kind === 'rest') probed.endpoints = [{ ...blankEndpoint(), name: 'placeholder' }];
  // A MongoDB or Druid source without a user connects without signing in, so an empty user stays empty.
  if (kind === 'mongodb' || kind === 'druid') probed.user = values.user;
  // A spreadsheet half pasted is still a Google Sheets source, which needs its key all the same.
  if (kind === 'google-sheets') probed.spreadsheets = PROBES.spreadsheets!;
  // An Airtable source needs its token before any base can be listed, let alone chosen.
  if (kind === 'airtable') probed.airtableBases = ['appPlaceholder000'];
  // A Microsoft 365 source needs its app's secret whatever it names so far, half typed or not.
  if (kind === 'sharepoint-list' || kind === 'excel-online' || kind === 'dataverse')
    for (const key of ['tenantId', 'clientId', 'sharePointSites', 'workbooks', 'environmentUrl'] as const)
      probed[key] = PROBES[key]!;
  // A half-typed Easy Connect string still says whether it asks for TLS, and with it a wallet.
  if (kind === 'oracle' && !parseEasyConnect(probed.easyConnect))
    probed.easyConnect = /^\s*tcps:\/\//i.test(values.easyConnect)
      ? `tcps://${PROBES.easyConnect!}`
      : PROBES.easyConnect!;
  if (kind === 'athena' || kind === 'redshift' || kind === 'duckdb-file') {
    probed.region = 'us-east-1';
    probed.resultsLocation = 's3://example/results/';
  }
  // An engine's range is read when someone tries the connection, so it stays empty here.
  if (isHttpEngine(kind)) {
    probed.start = '';
    probed.end = '';
  }
  return toConnection(kind, probed);
}

/**
 * The secrets this draft may ask for: the ones the connection needs, plus the ones its options make
 * possible but never require (an SSH key's passphrase, a key pair's passphrase).
 */
export function secretNamesFor(connection: SourceConnection | null): SecretName[] {
  if (!connection) return [];
  const optional: SecretName[] = [];
  if (connection.kind === 'sftp' && connection.auth === 'key') optional.push('sshPassphrase');
  if (
    (connection.kind === 'opensearch' && connection.auth === 'aws-sigv4') ||
    connection.kind === 'athena' ||
    (connection.kind === 'redshift' && connection.auth === 'iam') ||
    (connection.kind === 'duckdb-file' && connection.storage === 'bucket')
  )
    optional.push('sessionToken');
  if (connection.kind === 'duckdb-file' && connection.storage === 'url') optional.push('headers');
  if (connection.kind === 'dynamodb') optional.push('token');
  if ('ssh' in connection && connection.ssh) optional.push('sshPassphrase');
  if (connection.kind === 'snowflake' && connection.auth === 'key-pair')
    optional.push('privateKeyPassphrase');
  if (connection.kind === 'file-url' || connection.kind === 'feed') optional.push('headers');
  // A wallet is optional even with TLS on, since the platform's authorities may be enough.
  if (connection.kind === 'oracle' && oracleTlsMode(connection) !== 'disable')
    optional.push('wallet', 'walletPassword');
  return [...new Set([...requiredSecrets(connection), ...optional])];
}

/**
 * Where the source points, in the parts a person recognizes: a host and its database, or an
 * account, a project, or a workspace.  Each part is one line, so nothing has to be punctuated.
 */
export function locationOf(connection: SourceConnection | null): string[] {
  if (!connection) return [];
  if (connection.kind === 'app')
    return [APP_CATALOG.find((app) => app.id === connection.app)?.name ?? connection.app];
  if (isHttpEngineConnection(connection))
    return [
      connection.endpoint,
      ...('database' in connection ? [connection.database] : []),
      ...('organization' in connection && connection.organization ? [connection.organization] : []),
    ];
  if (isNoSqlConnection(connection))
    return [connection.endpoint ?? '', ...('database' in connection ? [connection.database] : [])].filter(
      Boolean,
    );
  switch (connection.kind) {
    case 'postgres':
    case 'mysql':
    case 'sqlserver':
    case 'db2':
    case 'informix':
      return [connection.host, connection.database];
    case 'oracle': {
      const target = oracleTarget(connection);
      return [target.host, target.service];
    }
    case 'firebird':
      return [connection.host, connection.database];
    case 'teradata':
      return [connection.host, ...(connection.database ? [connection.database] : [])];
    case 'snowflake':
      return [connection.account, connection.database];
    case 'bigquery':
      return [connection.projectId, ...(connection.dataset ? [connection.dataset] : [])];
    case 'databricks':
      return [connection.host, ...(connection.catalog ? [connection.catalog] : [])];
    case 'redshift':
      return [connection.host, connection.database];
    case 'athena':
      return [connection.region, connection.database, connection.workgroup];
    case 'duckdb-file':
      return [
        connection.storage === 'local'
          ? connection.path!
          : connection.storage === 'url'
            ? connection.url!
            : `${connection.bucket}/${connection.prefix}`,
      ];
    case 'motherduck':
      return [connection.database];
    case 'clickhouse':
      return [connection.host, connection.database];
    case 'trino':
      return [connection.host, connection.catalog];
    case 'druid':
      return [connection.host];
    case 'file-url':
    case 'feed':
      return [connection.url];
    case 'webhook':
      // A webhook's address is a secret, so nothing about where it is shows.
      return [];
    case 'sftp':
    case 'ftp':
    case 'ftps':
      return [connection.host, connection.path];
    case 'webdav':
      return [connection.url, connection.path];
    case 'graphql':
    case 'odata':
    case 'rest':
      return [connection.baseUrl];
    case 'mongodb':
      // A connection string is a secret, so only its database is shown.
      return connection.address === 'host' && connection.host
        ? [connection.host, connection.database]
        : [connection.database];
    case 'google-sheets':
      return connection.spreadsheets;
    case 'airtable':
      return connection.bases;
    case 'sharepoint-list':
      return connection.sites;
    case 'excel-online':
      return connection.workbooks;
    case 'dataverse':
      return [connection.environmentUrl];
    case 'bucket':
      return [
        ...(connection.endpoint ? [new URL(connection.endpoint).host] : []),
        `${connection.bucket}/${connection.prefix}`,
      ];
  }
}

/** Whether a kind has settings that belong behind the Advanced disclosure. */
export function hasAdvanced(kind: SourceKind): boolean {
  return (
    kind === 'postgres' ||
    kind === 'mysql' ||
    kind === 'sqlserver' ||
    kind === 'oracle' ||
    kind === 'firebird' ||
    kind === 'file-url' ||
    kind === 'bucket' ||
    kind === 'rest' ||
    kind === 'mongodb' ||
    kind === 'google-sheets' ||
    kind === 'webhook' ||
    kind === 'clickhouse' ||
    kind === 'trino'
  );
}

/**
 * Whether a stored connection already uses an advanced setting, so editing it opens the disclosure
 * instead of hiding what was saved.
 */
export function advancedInUse(connection: SourceConnection | null): boolean {
  if (!connection) return false;
  if ('ssh' in connection && connection.ssh) return true;
  if (connection.kind === 'clickhouse' || connection.kind === 'trino') return Boolean(connection.caPem);
  if (connection.kind === 'oracle')
    return connection.tls.mode !== 'disable' || Boolean(connection.tls.caPem || connection.tls.serverName);
  if (connection.kind === 'firebird') return connection.wireCrypt !== 'required' || Boolean(connection.role);
  if (connection.kind === 'mongodb')
    return (
      connection.tls.mode !== 'auto' ||
      Boolean(connection.tls.caPem) ||
      Boolean(connection.authSource) ||
      connection.flattenDepth !== 1 ||
      connection.arrays !== 'text'
    );
  if ('tls' in connection) {
    const { tls } = connection;
    if (tls.mode !== 'verify-full' || tls.caPem || tls.clientCertPem || tls.serverName) return true;
  }
  if (connection.kind === 'rest') return connection.requestsPerSecond !== DEFAULT_REQUESTS_PER_SECOND;
  if (connection.kind === 'google-sheets') return connection.headerRow !== 1;
  if (connection.kind === 'webhook')
    return (
      connection.postsPerMinute !== WEBHOOK_SOURCE_LIMITS.postsPerMinute ||
      connection.flattenDepth !== 1 ||
      connection.arrays !== 'text'
    );
  if (connection.kind === 'file-url' || connection.kind === 'bucket')
    return (
      Boolean(connection.format) ||
      Boolean(connection.sheet) ||
      (connection.kind === 'bucket' && connection.pathStyle)
    );
  if (connection.kind === 'sqlserver') {
    return (
      connection.auth.method !== 'password' ||
      !connection.encrypt ||
      connection.trustServerCertificate ||
      Boolean(connection.serverName)
    );
  }
  return connection.kind === 'postgres' && connection.auth.method !== 'password';
}

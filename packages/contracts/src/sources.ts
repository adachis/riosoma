import { z } from 'zod';
import { AppConnection, APP_CATALOG } from './app-sources.js';
import { AirtableBaseId, AirtableToken } from './airtable-import.js';
import { TLS_MODES } from './database-profile.js';
import {
  ElasticsearchConnection,
  OpenSearchConnection,
  MeilisearchConnection,
  TypesenseConnection,
  Neo4jConnection,
  InfluxDbConnection,
  PrometheusConnection,
  type HttpEngineConnection,
} from './http-engines.js';
import type { CellValue } from './data/values.js';
import { CommandId, Description, LIMITS, Name } from './data/fields.js';
import { SourceId, SourceSelect, isHttpEngine, isNoSqlKind, type SourceKind } from './source-refs.js';

export * from './source-refs.js';
export * from './app-sources.js';
export * from './http-engines.js';

/**
 * Data Source: tables whose records come from another system and stay in step with it.
 *
 * A **source** is one connection to an outside system, set up once per organization by an admin
 * with the Data Sources role.  A **synced table** lives in a database like any other table: its
 * source fields are copied from the source on every sync, and people can add their own fields
 * beside them.  Source values never flow back.  Where the table allows it, a person can
 * **override** a source value: the override is what everyone sees, the source's value stays on
 * record beside it, and the override clears itself once the source catches up to it.
 *
 * See `docs/architecture/data-source.md`.
 *
 * Routes (all session policy).  Creating, changing, testing, and deleting sources needs the Data
 * Sources admin role.  Listing shows admins every source and others only those open to creators.
 *
 * - `GET /api/sources` → `SourceMeta[]`
 * - `POST /api/sources` (`SourceCreate`) → `SourceMeta`
 * - `PATCH /api/sources/:sourceId` (`SourceUpdate`) → `SourceMeta`
 * - `DELETE /api/sources/:sourceId` (refused while synced tables use it)
 * - `POST /api/sources/test` (`SourceCreate`, before saving) → `SourceTestResult`
 * - `POST /api/sources/:sourceId/test` → `SourceTestResult`
 * - `GET /api/sources/:sourceId/objects` → `SourceObject[]`
 * - `POST /api/sources/:sourceId/preview` (`PreviewRequest`) → `SourcePreview`
 *
 * A webhook source also has routes of its own, for Data Sources admins, and its public address:
 *
 * - `POST /api/sources/:sourceId/webhook-address` → `WebhookAddress`, a new address shown once
 * - `GET /api/sources/:sourceId/webhook-deliveries` → `WebhookSourceLog`
 * - `PUT /api/sources/:sourceId/webhook-bodies` (`WebhookBodyLogging`) → `WebhookSourceLog`
 * - `POST /api/inbound/:token` (public): a post to the webhook, answered at once with `202` and
 *   `WebhookAccepted`, or refused with a plain `WebhookRefusal`
 *
 * Synced tables are created, changed, and synced through database commands: `table.create` with
 * `source`, `table.updateSource`, `table.sync`, and `record.clearOverrides`.
 */

const Host = z.string().min(1).max(253);
const Port = z.number().int().min(1).max(65_535);
const Text = z.string().min(1).max(255);

/** An SSH bastion in front of a private network.  The key and passphrase are secrets. */
export const SourceSsh = z.object({
  host: Host,
  port: Port.default(22),
  user: Text,
  /** Pinned host key (OpenSSH "type base64" form); connections fail closed when it doesn't match */
  hostKey: z.string().min(1).max(8_000),
});

export const SourceTls = z.object({
  mode: z.enum(TLS_MODES).default('verify-full'),
  /** PEM bundle of trusted roots; the platform's store when absent */
  caPem: z.string().max(64_000).optional(),
  /** A client certificate; its private key is the `clientKeyPem` secret */
  clientCertPem: z.string().max(64_000).optional(),
  serverName: z.string().max(253).optional(),
});

/** PostgreSQL and everything that speaks its protocol (Aurora, Supabase, Neon, Cloud SQL, and more). */
export const PostgresConnection = z.object({
  kind: z.literal('postgres'),
  host: Host,
  port: Port.default(5432),
  database: Text,
  user: Text,
  auth: z
    .discriminatedUnion('method', [
      z.object({ method: z.literal('password') }),
      z.object({
        method: z.literal('azure-entra'),
        credential: z.enum(['managed-identity', 'workload-identity', 'service-principal']),
        clientId: z.string().max(100).optional(),
        tenantId: z.string().max(100).optional(),
      }),
      z.object({ method: z.literal('aws-rds-iam'), region: Text }),
      z.object({ method: z.literal('gcp-cloudsql-iam'), instanceConnectionName: Text }),
      z.object({ method: z.literal('client-certificate') }),
    ])
    .default({ method: 'password' }),
  tls: SourceTls.default({ mode: 'verify-full' }),
  ssh: SourceSsh.optional(),
});

/** MySQL, MariaDB, Aurora MySQL, and compatible servers. */
export const MySqlConnection = z.object({
  kind: z.literal('mysql'),
  host: Host,
  port: Port.default(3306),
  database: Text,
  user: Text,
  tls: SourceTls.default({ mode: 'verify-full' }),
  ssh: SourceSsh.optional(),
});

/** SQL Server and Azure SQL. */
export const SqlServerConnection = z.object({
  kind: z.literal('sqlserver'),
  host: Host,
  port: Port.default(1433),
  database: Text,
  user: Text.optional(),
  auth: z
    .discriminatedUnion('method', [
      z.object({ method: z.literal('password') }),
      z.object({
        method: z.literal('azure-entra'),
        credential: z.enum(['managed-identity', 'workload-identity', 'service-principal']),
        clientId: z.string().max(100).optional(),
        tenantId: z.string().max(100).optional(),
      }),
    ])
    .default({ method: 'password' }),
  encrypt: z.boolean().default(true),
  /** Only for servers with self-signed certificates on a trusted network */
  trustServerCertificate: z.boolean().default(false),
  /** The certificate's host name, when connecting by IP address or through a tunnel */
  serverName: z.string().max(253).optional(),
  ssh: SourceSsh.optional(),
});

/** The parts of an Oracle Easy Connect string Riosoma reads, and nothing else. */
export interface EasyConnect {
  /** `tcps` turns TLS on, the way `tcps://` does for Oracle's own tools */
  protocol: 'tcp' | 'tcps';
  host: string;
  port: number;
  service: string;
  /** `dedicated`, `shared`, or `pooled`, when the string asks for one */
  server?: string;
  instance?: string;
}

const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;
const IPV6 = /^(?=.{2,45}$)[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?::\d{1,3}(?:\.\d{1,3}){3})?$/;

/**
 * Whether text names one host: a DNS name, an IPv4 address, or an IPv6 address without brackets.
 * Nothing in it can read as a list of hosts, a connect descriptor, a URL, or parameters, which is
 * what keeps a source's host the only place it can reach.
 */
export function isHostName(text: string): boolean {
  return DNS_NAME.test(text) || IPV6.test(text);
}
const HostName = Host.refine(isHostName);

/**
 * An Oracle service or instance name: letters, digits, and `_ $ . -`, starting with a letter or
 * digit.  The driver's descriptor reader refuses `#`, so a name with one could never connect.
 */
export const ORACLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/;

const EASY_CONNECT =
  /^(?:(tcps?):\/\/|\/\/)?([^\s/:[\]]+|\[[^\s\]]+\])(?::(\d{1,5}))?\/([^\s:/]+)(?::(dedicated|shared|pooled))?(?:\/([^\s:/]+))?$/i;

/**
 * Reads an Easy Connect string like `db.example.com:1521/sales.example.com`, or `tcps://` before one
 * for TLS.  It names one host and a service, with an optional server type and instance, and takes no
 * parameters, connect descriptors, lists of hosts, or `tnsnames.ora` aliases, so a stored string
 * can only ever reach the host it shows.  Riosoma builds the driver's descriptor from these parts,
 * so the driver never reads the text itself.  Null when the text isn't one.
 */
export function parseEasyConnect(text: string): EasyConnect | null {
  const match = EASY_CONNECT.exec(text.trim());
  if (!match) return null;
  const host = match[2]!.replace(/^\[(.*)\]$/, '$1');
  // An IPv6 address needs its brackets, since its colons would read as a port.
  if (match[2]!.startsWith('[') ? !IPV6.test(host) : !DNS_NAME.test(host)) return null;
  const port = match[3] ? Number(match[3]) : 1521;
  if (port < 1 || port > 65_535) return null;
  if (!ORACLE_NAME.test(match[4]!) || (match[6] !== undefined && !ORACLE_NAME.test(match[6]))) return null;
  return {
    protocol: match[1]?.toLowerCase() === 'tcps' ? 'tcps' : 'tcp',
    host,
    port,
    service: match[4]!,
    ...(match[5] ? { server: match[5].toLowerCase() } : {}),
    ...(match[6] ? { instance: match[6] } : {}),
  };
}

/**
 * How an Oracle source is encrypted.  TLS (TCPS) listens on a port of its own, so there's nothing
 * to fall back from and no `prefer`.  The driver always checks the certificate's chain, so there's
 * no `require` either: a server with a self-signed certificate needs it as a trusted authority.
 */
export const ORACLE_TLS_MODES = ['disable', 'verify-ca', 'verify-full'] as const;
export type OracleTlsMode = (typeof ORACLE_TLS_MODES)[number];

/**
 * Oracle Database, read in the driver's thin mode, so the server needs no Oracle client.  The
 * database is named by a host, port, and service name (`address: 'host'`), or by an Easy Connect
 * string (`address: 'easy-connect'`).  TLS is on when `tls` says so or the string starts with
 * `tcps://`.  A private certificate authority goes in `caPem`, and a PEM wallet (`ewallet.pem`,
 * which holds trusted certificates and a client certificate and key for mutual TLS) is the
 * `wallet` secret, with the `walletPassword` secret when its key is encrypted.
 */
export const OracleConnection = z
  .object({
    kind: z.literal('oracle'),
    address: z.enum(['host', 'easy-connect']).default('host'),
    host: HostName.optional(),
    port: Port.default(1521),
    serviceName: z.string().trim().regex(ORACLE_NAME).optional(),
    easyConnect: z
      .string()
      .trim()
      .max(600)
      .refine((text) => parseEasyConnect(text) !== null)
      .optional(),
    user: Text,
    tls: z
      .object({
        mode: z.enum(ORACLE_TLS_MODES).default('disable'),
        /** PEM bundle of trusted roots, beside any in the wallet, or the platform's store when neither has one */
        caPem: z.string().max(64_000).optional(),
        /** The name the certificate has to carry, when it isn't the host's */
        serverName: HostName.optional(),
      })
      .default({ mode: 'disable' }),
    ssh: SourceSsh.optional(),
  })
  .refine((connection) => connection.address === 'easy-connect' || connection.host !== undefined, {
    path: ['host'],
  })
  .refine((connection) => connection.address === 'easy-connect' || connection.serviceName !== undefined, {
    path: ['serviceName'],
  })
  .refine((connection) => connection.address === 'host' || connection.easyConnect !== undefined, {
    path: ['easyConnect'],
  });
export type OracleConnection = z.infer<typeof OracleConnection>;

/** The host, port, and service an Oracle connection reaches, whichever way it names them. */
export function oracleTarget(connection: OracleConnection): EasyConnect {
  if (connection.address === 'easy-connect' && connection.easyConnect) {
    const parsed = parseEasyConnect(connection.easyConnect);
    if (parsed) return parsed;
  }
  return {
    protocol: 'tcp',
    host: connection.host ?? '',
    port: connection.port,
    service: connection.serviceName ?? '',
  };
}

/** How an Oracle connection is encrypted: its TLS setting, or full checks for a `tcps://` string. */
export function oracleTlsMode(connection: OracleConnection): OracleTlsMode {
  return connection.tls.mode === 'disable' && oracleTarget(connection).protocol === 'tcps'
    ? 'verify-full'
    : connection.tls.mode;
}

/**
 * Whether a Firebird connection has to be encrypted.  `required` signs in only with SRP on
 * protocol 13 or later and refuses to send anything that comes from the password until wire
 * encryption is on.  `enabled` encrypts whenever the server can, which it must when its own
 * `WireCrypt` is `Required`, the default since Firebird 3, and otherwise signs in however the
 * server asks, which can send the password or a hash of it unencrypted.
 */
export const FIREBIRD_WIRE_CRYPT = ['required', 'enabled'] as const;
export type FirebirdWireCrypt = (typeof FIREBIRD_WIRE_CRYPT)[number];

/**
 * Firebird 3, 4, and 5, over its own wire protocol with wire encryption.  The database is its path
 * on the server or an alias from the server's `databases.conf`.
 */
export const FirebirdConnection = z.object({
  kind: z.literal('firebird'),
  host: HostName,
  port: Port.default(3050),
  database: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .refine((text) => !hasControl(text)),
  user: Text,
  /** A role to take on when signing in, for privileges granted to it */
  role: Text.optional(),
  wireCrypt: z.enum(FIREBIRD_WIRE_CRYPT).default('required'),
  ssh: SourceSsh.optional(),
});
export type FirebirdConnection = z.infer<typeof FirebirdConnection>;

export const SnowflakeConnection = z.object({
  kind: z.literal('snowflake'),
  /** Account identifier, like `myorg-myaccount` */
  account: Text,
  user: Text,
  warehouse: Text,
  database: Text,
  schema: Text.optional(),
  role: Text.optional(),
  /** `password` uses the `password` secret; `key-pair` uses `privateKeyPem` and `privateKeyPassphrase` */
  auth: z.enum(['password', 'key-pair']).default('key-pair'),
});

export const BigQueryConnection = z.object({
  kind: z.literal('bigquery'),
  projectId: Text,
  location: Text.optional(),
  /** The dataset listed first when choosing a table */
  dataset: Text.optional(),
});

export const DatabricksConnection = z.object({
  kind: z.literal('databricks'),
  /** Workspace host, like `adb-123.azuredatabricks.net` */
  host: Host,
  /** The SQL warehouse's HTTP path */
  httpPath: z.string().min(1).max(500),
  catalog: Text.optional(),
  schema: Text.optional(),
});

const AwsRegion = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/);

export const RedshiftConnection = z
  .object({
    kind: z.literal('redshift'),
    host: Host,
    port: Port.default(5439),
    database: Text,
    user: Text.optional(),
    region: AwsRegion,
    deployment: z.enum(['provisioned', 'serverless']).default('provisioned'),
    auth: z.enum(['password', 'iam']).default('iam'),
    clusterIdentifier: Text.optional(),
    workgroup: Text.optional(),
  })
  .refine((c) => c.auth !== 'password' || Boolean(c.user), { path: ['user'] })
  .refine(
    (c) => c.auth !== 'iam' || c.deployment !== 'provisioned' || Boolean(c.clusterIdentifier && c.user),
    { path: ['clusterIdentifier'] },
  )
  .refine((c) => c.auth !== 'iam' || c.deployment !== 'serverless' || Boolean(c.workgroup), {
    path: ['workgroup'],
  });
export type RedshiftConnection = z.infer<typeof RedshiftConnection>;

export const AthenaConnection = z.object({
  kind: z.literal('athena'),
  region: AwsRegion,
  catalog: Text.default('AwsDataCatalog'),
  database: Text,
  workgroup: Text,
  resultsLocation: z
    .string()
    .max(2_000)
    .regex(/^s3:\/\/[^/]+\/.*$/),
  maxScannedBytes: z.number().int().min(10_000_000).max(Number.MAX_SAFE_INTEGER).default(1_000_000_000),
});
export type AthenaConnection = z.infer<typeof AthenaConnection>;

/** Local paths need an operator allowlist, and remote bytes use the guarded file client. */
export const DuckDbFileConnection = z
  .object({
    kind: z.literal('duckdb-file'),
    storage: z.enum(['local', 'url', 'bucket']).default('local'),
    path: z.string().min(1).max(2_000).optional(),
    url: z.url().max(2_000).optional(),
    bucket: Text.optional(),
    prefix: z.string().max(2_000).default(''),
    region: AwsRegion.default('us-east-1'),
    format: z.enum(['duckdb', 'parquet', 'csv']).default('duckdb'),
  })
  .refine((c) => c.storage !== 'local' || Boolean(c.path), { path: ['path'] })
  .refine((c) => c.storage !== 'url' || Boolean(c.url), { path: ['url'] })
  .refine((c) => c.storage !== 'bucket' || Boolean(c.bucket), { path: ['bucket'] });
export type DuckDbFileConnection = z.infer<typeof DuckDbFileConnection>;

export const MotherDuckConnection = z.object({
  kind: z.literal('motherduck'),
  database: Text,
});

/**
 * The analytics engines below answer over HTTP, which is HTTPS unless `secure` is off.  A secure
 * connection always checks the server's certificate and its name.
 */
const Secure = z.boolean().default(true);
/** PEM bundle of trusted roots, for a server whose certificate comes from a private authority */
const CaPem = z.string().max(64_000).optional();

/** The ports each engine's HTTP interface listens on by default, over HTTPS and without it. */
export const ANALYTICS_PORTS = {
  clickhouse: { secure: 8443, plain: 8123 },
  trino: { secure: 443, plain: 8080 },
  druid: { secure: 9088, plain: 8888 },
} as const;

/**
 * ClickHouse and ClickHouse Cloud, through the HTTP interface.  The host can be a whole address, like
 * the `https://abc123.us-east-1.aws.clickhouse.cloud:8443` ClickHouse Cloud shows, whose port wins.
 * The password is the `password` secret.
 */
export const ClickHouseConnection = z.object({
  kind: z.literal('clickhouse'),
  host: Host,
  port: Port.default(ANALYTICS_PORTS.clickhouse.secure),
  /** The database listed first, and the one a query's unqualified names read */
  database: Text.default('default'),
  user: Text.default('default'),
  secure: Secure,
  caPem: CaPem,
});

/** How a Trino source signs in: not at all, with the `password` secret, or with the `token` secret. */
export const TRINO_AUTH_METHODS = ['none', 'password', 'token'] as const;
export type TrinoAuthMethod = (typeof TRINO_AUTH_METHODS)[number];

/**
 * Trino and services built on it, through the coordinator.  A catalog's schemas and tables are what
 * people sync.  Trino takes a password or a token only over HTTPS, so neither is sent without it.
 */
export const TrinoConnection = z
  .object({
    kind: z.literal('trino'),
    /** The coordinator's host, or its whole address */
    host: Host,
    port: Port.default(ANALYTICS_PORTS.trino.secure),
    catalog: Text,
    /** The schema listed first when choosing a table */
    schema: Text.optional(),
    /** Who queries run as.  A token names its own user, so this may be left out with one */
    user: Text.optional(),
    auth: z.enum(TRINO_AUTH_METHODS).default('password'),
    secure: Secure,
    caPem: CaPem,
  })
  .refine((connection) => connection.auth === 'none' || connection.secure, { path: ['auth'] })
  .refine((connection) => connection.auth === 'token' || connection.user !== undefined, {
    path: ['user'],
  });
export type TrinoConnection = z.infer<typeof TrinoConnection>;

/**
 * Apache Druid, through its router's SQL API.  Datasources are the tables, each with its `__time`.
 * With a user, it signs in with HTTP basic auth and the `password` secret, and without one it
 * doesn't sign in.  Certificates are checked against the server's own trusted roots.
 */
export const DruidConnection = z.object({
  kind: z.literal('druid'),
  /** The router's host, or its whole address */
  host: Host,
  port: Port.default(ANALYTICS_PORTS.druid.secure),
  user: Text.optional(),
  secure: Secure,
});

export const TeradataConnection = z.object({
  kind: z.literal('teradata'),
  host: Host,
  port: Port.default(443),
  secure: Secure,
  caPem: CaPem,
  user: Text,
  database: Text.optional(),
  logmech: z.enum(['TD2', 'LDAP']).default('TD2'),
});

const IbmConnection = {
  host: Host,
  port: Port.default(50000),
  database: Text,
  user: Text,
  secure: Secure,
  caPem: CaPem,
};
export const Db2Connection = z.object({ kind: z.literal('db2'), ...IbmConnection });
export const InformixConnection = z.object({
  kind: z.literal('informix'),
  ...IbmConnection,
  port: Port.default(9089),
});

/**
 * The file formats a file source reads.  The file's extension chooses one, and a source can name
 * one instead for files whose names don't say.
 */
export const FILE_FORMATS = ['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx'] as const;
export const FileFormat = z.enum(FILE_FORMATS);
export type FileFormat = z.infer<typeof FileFormat>;

/** A web address with no credentials in it.  Where it may point is the server's call. */
function isWebAddress(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    !url.username &&
    !url.password
  );
}

const WebAddress = z.string().trim().min(1).max(LIMITS.urlLength).refine(isWebAddress);

/** A worksheet's name, for workbooks.  The first sheet is read when there's none. */
const SheetName = z.string().trim().min(1).max(255);

/**
 * One file at a web address, over https (plain http only reaches `localhost`, and only while the
 * operator allows private hosts).  Request headers, like an authorization header, are the `headers`
 * secret.
 */
export const FileUrlConnection = z.object({
  kind: z.literal('file-url'),
  url: WebAddress,
  format: FileFormat.optional(),
  sheet: SheetName.optional(),
});

/** A service's own address, with nothing after the host but an optional slash. */
function isEndpoint(value: string): boolean {
  if (!isWebAddress(value)) return false;
  const url = new URL(value);
  return (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
}

/** Whether text holds a control character, which no key or header value may.  A tab may be allowed. */
function hasControl(text: string, tabs = false): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && !(tabs && code === 0x09)) || code === 0x7f) return true;
  }
  return false;
}

/** A key or prefix can't hold `.` or `..` as a part, which an address would read as moving up. */
function isObjectPath(value: string): boolean {
  return !value.split('/').some((part) => part === '.' || part === '..') && !hasControl(value);
}

/**
 * Files in an S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage
 * through its interoperability keys, and MinIO.  The access key ID and the secret access key are
 * secrets.  `prefix` names one file's key, or every file under it, or the whole bucket when empty.
 */
export const BucketConnection = z.object({
  kind: z.literal('bucket'),
  /** The service's address, like `https://<account>.r2.cloudflarestorage.com`, or AWS S3 when absent */
  endpoint: z.string().trim().max(LIMITS.urlLength).refine(isEndpoint).optional(),
  /** The region requests are signed for.  AWS needs one, and other services' own is guessed from the endpoint. */
  region: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  bucket: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,220}[A-Za-z0-9]$/),
  prefix: z.string().max(1_024).refine(isObjectPath).default(''),
  /** Addresses like `endpoint/bucket/key` instead of `bucket.endpoint/key`, which MinIO needs */
  pathStyle: z.boolean().default(false),
  format: FileFormat.optional(),
  sheet: SheetName.optional(),
});

const RemotePath = z.string().min(1).max(1_024).refine(isObjectPath);
const FileServerFields = {
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\s/@?#]/.test(value)),
  user: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !hasControl(value)),
  path: RemotePath,
  format: FileFormat.optional(),
  sheet: SheetName.optional(),
};

export const SftpConnection = z.object({
  kind: z.literal('sftp'),
  ...FileServerFields,
  port: z.number().int().min(1).max(65_535).default(22),
  auth: z.enum(['password', 'key']).default('password'),
  hostKey: z.string().trim().min(1).max(16_000),
});
export const FtpConnection = z.object({
  kind: z.literal('ftp'),
  ...FileServerFields,
  port: z.number().int().min(1).max(65_535).default(21),
});
export const FtpsConnection = FtpConnection.extend({ kind: z.literal('ftps') });
export const WebDavConnection = z.object({
  kind: z.literal('webdav'),
  url: WebAddress,
  path: RemotePath.default('*'),
  auth: z.enum(['basic', 'bearer']).default('basic'),
  user: z
    .string()
    .max(255)
    .refine((value) => !hasControl(value) && !value.includes(':'))
    .default(''),
  format: FileFormat.optional(),
  sheet: SheetName.optional(),
});
export type RemoteFileConnection =
  | z.infer<typeof SftpConnection>
  | z.infer<typeof FtpConnection>
  | z.infer<typeof FtpsConnection>
  | z.infer<typeof WebDavConnection>;

/** Headers the request itself decides, which a file source or an API's sign-in can't set. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'range',
  'proxy-authorization',
  'proxy-connection',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A name a request may carry as its own header. */
function isHeaderName(value: string): boolean {
  return HEADER_NAME.test(value) && !RESERVED_HEADERS.has(value.toLowerCase());
}

/** An API's base address: a web address that may have a path, and no query or fragment. */
function isBaseAddress(value: string): boolean {
  if (!isWebAddress(value)) return false;
  const url = new URL(value);
  return !url.search && !url.hash;
}

/**
 * Whether text is a path into a JSON answer: names joined by dots, like `data.items`, where a
 * number picks an item from a list.  Empty means the answer itself.
 */
export function isJsonPath(value: string): boolean {
  return value === '' || value.split('.').every((part) => part !== '' && !hasControl(part));
}

/**
 * Whether text is an endpoint's path under its base address, like `/v2/orders`.  It can't name
 * another site, carry a query (those are the endpoint's parameters), or climb out of the base.
 */
export function isEndpointPath(value: string): boolean {
  if (value === '') return true;
  if (hasControl(value) || /[\\?#\s]/.test(value)) return false;
  if (value.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  return !value.split('/').some((part) => /^(?:\.|%2e){1,2}$/i.test(part));
}

const ParamName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !hasControl(value));
const JsonPath = z.string().trim().max(255).refine(isJsonPath);
const RequiredJsonPath = JsonPath.refine((value) => value !== '');

/** How an API source signs in.  Each way but `none` keeps its secret sealed. */
export const REST_AUTH_METHODS = ['none', 'bearer', 'header', 'query', 'basic', 'oauth-client'] as const;
export type RestAuthMethod = (typeof REST_AUTH_METHODS)[number];

export const RestAuth = z.discriminatedUnion('method', [
  z.object({ method: z.literal('none') }),
  /** `Authorization: Bearer` and the `token` secret */
  z.object({ method: z.literal('bearer') }),
  /** A header of this name carrying the `apiKey` secret */
  z.object({
    method: z.literal('header'),
    name: z.string().trim().min(1).max(100).refine(isHeaderName),
    /** A scheme word and one space precede the key.  The API form does not offer this option. */
    prefix: z
      .string()
      .max(30)
      .regex(/^[A-Za-z][A-Za-z0-9_-]* $/)
      .optional(),
  }),
  /** A query parameter of this name carrying the `apiKey` secret */
  z.object({ method: z.literal('query'), name: ParamName }),
  /** HTTP basic sign-in as this user, with the `password` secret */
  z.object({
    method: z.literal('basic'),
    /** Send the sealed password as the user name and the user value as the password. */
    secretAsUsername: z.boolean().optional(),
    user: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.includes(':') && !hasControl(value)),
  }),
  /**
   * OAuth token exchanges send client credentials in a basic header or form body, and refresh
   * grants also send the sealed refresh token in the form body.
   */
  z.object({
    method: z.literal('oauth-client'),
    tokenUrl: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.urlLength)
      .refine((value) => isWebAddress(value) && !new URL(value).hash),
    clientId: Text,
    scope: z.string().trim().max(1_000).optional(),
    clientAuth: z.enum(['basic', 'body']).default('basic'),
    /** Omitted grants retain the client credentials exchange used by existing API sources. */
    grant: z.enum(['client_credentials', 'account_credentials', 'refresh_token']).optional(),
    /** Extra form values cannot replace the grant, scope, or sealed credentials. */
    tokenParams: z
      .record(
        ParamName,
        z
          .string()
          .max(2_000)
          .refine((value) => !hasControl(value)),
      )
      .refine(
        (params) =>
          !Object.keys(params).some((key) =>
            ['grant_type', 'client_id', 'client_secret', 'refresh_token', 'scope'].includes(key),
          ),
      )
      .optional(),
  }),
]);
export type RestAuth = z.infer<typeof RestAuth>;

/** How an endpoint's records continue past its first page. */
export const REST_PAGING_STYLES = [
  'none',
  'page',
  'offset',
  'cursor',
  'last-record',
  'next-url',
  'link-header',
] as const;
export type RestPagingStyle = (typeof REST_PAGING_STYLES)[number];

export const RestPaging = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }),
  /** A page number that counts up from `start`, with an optional page size to ask for */
  z
    .object({
      style: z.literal('page'),
      param: ParamName.default('page'),
      /** A query value can carry its page position inside fixed request text. */
      valueTemplate: z
        .string()
        .min(1)
        .max(2_000)
        .refine((value) => value.includes('{page}') && !hasControl(value, true))
        .optional(),
      step: z.number().int().min(1).max(10_000).optional(),
      /** The answer's total page count ends even a full final page. */
      countPath: RequiredJsonPath.optional(),
      start: z.number().int().min(0).max(1_000_000).default(1),
      sizeParam: ParamName.optional(),
      /** Records a full page holds, so a shorter one is known to be the last */
      size: z.number().int().min(1).max(10_000).optional(),
    })
    .refine((paging) => paging.sizeParam === undefined || paging.size !== undefined, { path: ['size'] }),
  /** An offset that moves on by the records read, with a limit on each page */
  z.object({
    style: z.literal('offset'),
    offsetParam: ParamName.default('offset'),
    limitParam: ParamName.default('limit'),
    limit: z.number().int().min(1).max(10_000).default(100),
    /** A boolean last-page flag takes precedence over the requested page size. */
    lastPath: RequiredJsonPath.optional(),
    /** A total record count takes precedence over the requested page size. */
    totalPath: RequiredJsonPath.optional(),
  }),
  /** A cursor the answer holds at `cursorPath`, sent back in the `param` query parameter */
  z.object({ style: z.literal('cursor'), cursorPath: RequiredJsonPath, param: ParamName }),
  /** The last record supplies the cursor, and a short page ends the read. */
  z.object({
    style: z.literal('last-record'),
    cursorPath: RequiredJsonPath,
    param: ParamName,
    size: z.number().int().min(1).max(10_000),
    sizeParam: ParamName.optional(),
  }),
  /** The next page's address, which the answer holds at `nextPath` */
  z.object({ style: z.literal('next-url'), nextPath: RequiredJsonPath }),
  /** The next page's address in the `Link` header, as `rel="next"` */
  z.object({ style: z.literal('link-header') }),
]);
export type RestPaging = z.infer<typeof RestPaging>;

export const REST_LIMITS = {
  endpoints: 50,
  query: 30,
  /** The pages one endpoint may read in a sync, unless its own limit says otherwise */
  pages: 10_000,
  records: 1_000_000,
  flattenDepth: 3,
} as const;

/** One thing an API source offers to sync: a path under the base address and where its records are. */
export const RestEndpoint = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !hasControl(value)),
  path: z.string().trim().max(2_000).refine(isEndpointPath).default(''),
  query: z
    .array(
      z.object({
        name: ParamName,
        value: z
          .string()
          .max(2_000)
          .refine((value) => !hasControl(value, true)),
      }),
    )
    .max(REST_LIMITS.query)
    .default([]),
  /** Where the records are in each answer, or empty when the answer is the list itself */
  records: JsonPath.default(''),
  paging: RestPaging.default({ style: 'none' }),
  /** The most pages a read follows before it stops and says so, a guard against endless paging */
  maxPages: z.number().int().min(1).max(100_000).default(REST_LIMITS.pages),
  /** The most records a read takes before it stops and says so */
  maxRecords: z.number().int().min(1).max(10_000_000).default(REST_LIMITS.records),
  /** How many levels of nested objects become dotted columns, and deeper ones stay JSON */
  flattenDepth: z.number().int().min(0).max(REST_LIMITS.flattenDepth).default(1),
  /** Lists of plain values as text joined with commas, or as JSON */
  arrays: z.enum(['text', 'json']).default('text'),
});
export type RestEndpoint = z.infer<typeof RestEndpoint>;

/**
 * A web API that answers in JSON: a base address, how to sign in, and the endpoints people can
 * sync, each one offered like a table.  Only GET requests reach the API, and the only other
 * request is OAuth's own token request.  Where the addresses may point is the server's call, as it
 * is for file sources.
 */
export const RestConnection = z.object({
  kind: z.literal('rest'),
  baseUrl: z.string().trim().min(1).max(LIMITS.urlLength).refine(isBaseAddress),
  auth: RestAuth.default({ method: 'none' }),
  endpoints: z
    .array(RestEndpoint)
    .min(1)
    .max(REST_LIMITS.endpoints)
    .refine(
      (endpoints) =>
        new Set(endpoints.map((endpoint) => endpoint.name.toLocaleLowerCase())).size === endpoints.length,
    ),
  /** Requests a second at most, across every call to the same API with the same sign-in */
  requestsPerSecond: z.number().min(0.1).max(100).default(5),
});
export type RestConnection = z.infer<typeof RestConnection>;

const GraphVariable = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/);
export const GraphQlConnection = z.object({
  kind: z.literal('graphql'),
  baseUrl: WebAddress.refine(isBaseAddress),
  auth: RestAuth.default({ method: 'none' }),
  query: z.string().trim().min(1).max(64_000),
  variables: z.record(z.string(), z.unknown()).default({}),
  records: RequiredJsonPath,
  paging: z
    .discriminatedUnion('style', [
      z.object({ style: z.literal('none') }),
      z.object({
        style: z.literal('cursor'),
        pageInfo: RequiredJsonPath,
        variable: GraphVariable.default('after'),
      }),
      z.object({
        style: z.literal('offset'),
        pageInfo: RequiredJsonPath,
        variable: GraphVariable.default('offset'),
        sizeVariable: GraphVariable.default('limit'),
        size: z.number().int().min(1).max(10_000).default(100),
      }),
    ])
    .default({ style: 'none' }),
  requestsPerSecond: z.number().min(0.1).max(100).default(5),
  maxPages: z.number().int().min(1).max(100_000).default(REST_LIMITS.pages),
});
export type GraphQlConnection = z.infer<typeof GraphQlConnection>;

export const ODataConnection = z.object({
  kind: z.literal('odata'),
  baseUrl: z.string().trim().min(1).max(LIMITS.urlLength).refine(isBaseAddress),
  auth: RestAuth.default({ method: 'none' }),
  requestsPerSecond: z.number().min(0.1).max(100).default(5),
});
export type ODataConnection = z.infer<typeof ODataConnection>;

/** An API source's address and sign-in without its endpoints, for trying one endpoint before saving. */
export const RestTarget = RestConnection.omit({ endpoints: true });
export type RestTarget = z.infer<typeof RestTarget>;

/**
 * Whether a MongoDB connection is encrypted: `auto` follows the connection string, which turns it
 * on for `mongodb+srv` addresses and when it says `tls=true`, and turns it on for a host found
 * through DNS.  A secure connection always checks the server's certificate and its name.
 */
export const MONGODB_TLS_MODES = ['auto', 'on', 'off'] as const;
export type MongoTlsMode = (typeof MONGODB_TLS_MODES)[number];

export const MONGODB_DEFAULT_PORT = 27_017;

/**
 * MongoDB, MongoDB Atlas, and services that speak its protocol.  The server is named either by a
 * connection string (`address: 'uri'`), which is the `connectionString` secret since it can hold a
 * password, or by a host and port (`address: 'host'`) with an optional user and the `password`
 * secret.  The database's collections and views are what people sync, and their documents flatten
 * into columns by the rules API sources use.
 */
export const MongoConnection = z
  .object({
    kind: z.literal('mongodb'),
    address: z.enum(['uri', 'host']).default('host'),
    host: Host.optional(),
    port: Port.default(MONGODB_DEFAULT_PORT),
    /** Finds the servers through the host's DNS records, the way a `mongodb+srv` address does */
    srv: z.boolean().default(false),
    /** The database whose collections and views are offered */
    database: Text,
    /** Signs in as this user with the `password` secret, and without one connects without signing in */
    user: Text.optional(),
    /** The database the user is defined in, when it isn't the driver's default (`admin`) */
    authSource: Text.optional(),
    tls: z
      .object({
        mode: z.enum(MONGODB_TLS_MODES).default('auto'),
        /** PEM bundle of trusted roots, or the platform's store when absent */
        caPem: z.string().max(64_000).optional(),
      })
      .default({ mode: 'auto' }),
    ssh: SourceSsh.optional(),
    /** How many levels of nested documents become dotted columns, and deeper ones stay JSON */
    flattenDepth: z.number().int().min(0).max(REST_LIMITS.flattenDepth).default(1),
    /** Lists of plain values as text joined with commas, or as JSON */
    arrays: z.enum(['text', 'json']).default('text'),
  })
  .refine((connection) => connection.address === 'uri' || connection.host !== undefined, {
    path: ['host'],
  })
  // A tunnel reaches one server, and DNS names a set of them.
  .refine((connection) => !(connection.ssh && connection.address === 'host' && connection.srv), {
    path: ['srv'],
  });
export type MongoConnection = z.infer<typeof MongoConnection>;

/** HTTP document sources share the same sampling and nested value rules. */
const DocumentFields = {
  flattenDepth: z.number().int().min(0).max(REST_LIMITS.flattenDepth).default(1),
  arrays: z.enum(['text', 'json']).default('text'),
};
const DocumentEndpoint = z
  .string()
  .url()
  .max(2_000)
  .refine((text) => {
    try {
      const url = new URL(text);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === '/' || url.pathname === '')
      );
    } catch {
      return false;
    }
  });
export const DynamoConnection = z.object({
  kind: z.literal('dynamodb'),
  endpoint: DocumentEndpoint.optional(),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  segments: z.number().int().min(1).max(16).default(4),
  ...DocumentFields,
});
export const CouchDbConnection = z.object({
  kind: z.literal('couchdb'),
  endpoint: DocumentEndpoint,
  user: Text,
  ...DocumentFields,
});
export const CouchbaseConnection = z.object({
  kind: z.literal('couchbase'),
  endpoint: DocumentEndpoint,
  user: Text,
  ...DocumentFields,
});
export const FirestoreConnection = z
  .object({
    kind: z.literal('firestore'),
    projectId: z.string().regex(/^[a-z][a-z0-9-]{3,62}$/),
    database: Text.default('(default)'),
    endpoint: DocumentEndpoint.optional(),
    emulator: z.boolean().default(false),
    collectionGroups: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^/]+$/),
      )
      .max(100)
      .default([]),
    ...DocumentFields,
  })
  .refine((value) => !value.emulator || value.endpoint !== undefined, { path: ['endpoint'] });
export const CosmosConnection = z.object({
  kind: z.literal('cosmosdb'),
  endpoint: DocumentEndpoint,
  database: Text,
  auth: z.enum(['master-key', 'entra']).default('master-key'),
  ...DocumentFields,
});
export type NoSqlConnection =
  | z.infer<typeof DynamoConnection>
  | z.infer<typeof CouchDbConnection>
  | z.infer<typeof CouchbaseConnection>
  | z.infer<typeof FirestoreConnection>
  | z.infer<typeof CosmosConnection>;

/** A Google Sheets spreadsheet's ID, the long part of its address after `/d/`. */
export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{25,100}$/;

export const SHEETS_LIMITS = {
  /** Spreadsheets one source may offer */
  spreadsheets: 20,
  /** The furthest down a header row may be */
  headerRow: 1_000,
} as const;

/**
 * The ID in a spreadsheet's address, like `https://docs.google.com/spreadsheets/d/<ID>/edit`, or the
 * ID itself, or null when the text is neither.  An address from Publish to the web names a copy
 * the Sheets API can't open, so it isn't one.
 */
export function spreadsheetIdOf(text: string): string | null {
  const value = text.trim();
  if (SPREADSHEET_ID.test(value)) return value;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/(?:^|\.)google\.com$/.test(url.hostname)) return null;
  const found = /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
  return found && SPREADSHEET_ID.test(found) ? found : null;
}

/**
 * The address a Google service account key belongs to, which is the one people share their
 * spreadsheets with, or null when the text isn't a service account's JSON key.  The address isn't
 * a secret, so a source keeps it in its settings where the form can show it.
 */
export function serviceAccountEmailOf(key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type, client_email: email, private_key: privateKey } = parsed as Record<string, unknown>;
  if (type !== 'service_account' || typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY'))
    return null;
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320 ? email : null;
}

/**
 * Sheets in Google spreadsheets, read as a service account that people share each spreadsheet
 * with.  Its JSON key is the `serviceAccountJson` secret, and the account's address is copied from
 * the key when the source is saved.  Each sheet's header row names its columns, and every row below
 * it is a record.  Requests only ever reach Google's own addresses.
 */
export const GoogleSheetsConnection = z.object({
  kind: z.literal('google-sheets'),
  /** The spreadsheets' IDs, whose sheets the source offers */
  spreadsheets: z
    .array(z.string().trim().regex(SPREADSHEET_ID))
    .min(1)
    .max(SHEETS_LIMITS.spreadsheets)
    .refine((ids) => new Set(ids).size === ids.length),
  /** The row that names each sheet's columns, counting from 1 */
  headerRow: z.number().int().min(1).max(SHEETS_LIMITS.headerRow).default(1),
  /** The service account's address, which the server copies from the key */
  serviceAccountEmail: z.string().trim().min(3).max(320).optional(),
});
export type GoogleSheetsConnection = z.infer<typeof GoogleSheetsConnection>;

export const AIRTABLE_SOURCE_LIMITS = {
  /** Bases one source may offer */
  bases: 50,
} as const;

/**
 * Tables in Airtable bases, read with a personal access token, the `token` secret.  The source
 * offers the tables of the bases an admin chose from the ones the token can see, never every base
 * the token reaches, since a token often reaches far more than anyone means to sync.
 */
export const AirtableConnection = z.object({
  kind: z.literal('airtable'),
  /** The bases' IDs, whose tables the source offers */
  bases: z
    .array(AirtableBaseId)
    .min(1)
    .max(AIRTABLE_SOURCE_LIMITS.bases)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type AirtableConnection = z.infer<typeof AirtableConnection>;

// ------------------------------------------------------------- Microsoft 365

/** A GUID, the way Entra writes an app's client ID or a tenant's ID. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant as a sign-in names it: its ID, or one of its domains, like `contoso.onmicrosoft.com`. */
const ENTRA_TENANT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z0-9-]+\.)+[a-z]{2,63})$/i;
/** SharePoint and OneDrive for Business hosts in Microsoft's global cloud, which Graph reaches. */
const SHAREPOINT_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.sharepoint\.com$/i;
/** A Dataverse environment's host, like `contoso.crm.dynamics.com` or `contoso.crm4.dynamics.com`. */
const DATAVERSE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.crm\d{0,2}\.dynamics\.com$/i;
/** Where a SharePoint site's own path starts: team and communication sites, and OneDrive. */
const SITE_ROOTS = new Set(['sites', 'teams', 'personal']);

export const MICROSOFT_LIMITS = {
  /** SharePoint sites one source may offer lists from */
  sites: 20,
  /** Workbooks one source may offer sheets from */
  workbooks: 20,
  /** The longest address a site or a workbook may have */
  address: 2_000,
} as const;

/**
 * An Entra app registration's sign-in, which every Microsoft 365 source uses: the tenant, the app's
 * client ID, and the `clientSecret` secret.  The app signs in as itself with the client credentials
 * grant, so what it reaches is what an admin granted the app, never a person's own access.
 */
const EntraApp = {
  tenantId: z.string().trim().max(253).regex(ENTRA_TENANT),
  clientId: z.string().trim().regex(GUID),
};

/** A path's parts as people read them, or null when one doesn't decode. */
function pathParts(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** A SharePoint address on a Microsoft host over https, with its path's parts, or null. */
function sharePointAddress(text: string): { host: string; parts: string[] } | null {
  const value = text.trim();
  if (!value || value.length > MICROSOFT_LIMITS.address || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!SHAREPOINT_HOST.test(url.hostname)) return null;
  const parts = pathParts(url.pathname);
  if (!parts || parts.some((part) => part === '.' || part === '..' || hasControl(part))) return null;
  return { host: url.hostname.toLowerCase(), parts };
}

/** How many of an address's parts name its site: two under `/sites`, `/teams`, or `/personal`. */
function siteDepth(parts: readonly string[]): number {
  return parts.length >= 2 && SITE_ROOTS.has(parts[0]!.toLowerCase()) ? 2 : 0;
}

/** An address from its host and its path's parts, each part encoded the one way. */
function joined(host: string, parts: readonly string[]): string {
  return `https://${host}${parts.map((part) => `/${encodeURIComponent(part)}`).join('')}`;
}

/**
 * A SharePoint site's address from any address inside it, like a list's or a page's, or null when
 * the text isn't a SharePoint address.  It comes back as `https://<host>/sites/<name>` (or
 * `/teams/…`, or `/personal/…` for a OneDrive), or the host alone for a tenant's root site, with
 * its path encoded.
 */
export function sharePointSiteOf(text: string): string | null {
  const address = sharePointAddress(text);
  if (!address) return null;
  return joined(address.host, address.parts.slice(0, siteDepth(address.parts)));
}

/**
 * A workbook's address in SharePoint or OneDrive for Business, from the address Excel's File, Info,
 * Copy path gives, or null when the text isn't the address of an `.xlsx` file.  Sharing links
 * (`/:x:/…`) and viewer pages (`Doc.aspx`) aren't a file's own address, so they aren't one.  It
 * comes back with its path encoded, without a query or a fragment.
 */
export function workbookAddressOf(text: string): string | null {
  const address = sharePointAddress(text);
  if (!address) return null;
  const { parts } = address;
  if (parts.length === 0 || /^:[a-z]:$/i.test(parts[0]!)) return null;
  // A workbook sits in a library, so its path in the site has a library and a file at least.
  if (parts.length < siteDepth(parts) + 2 || !/\.xlsx$/i.test(parts.at(-1)!)) return null;
  return joined(address.host, parts);
}

/** A workbook's site, and its path's parts inside the site, decoded, for an address `workbookAddressOf` gave. */
export function workbookPlace(address: string): { site: string; path: string[] } | null {
  const parsed = sharePointAddress(address);
  if (!parsed) return null;
  const depth = siteDepth(parsed.parts);
  return { site: joined(parsed.host, parsed.parts.slice(0, depth)), path: parsed.parts.slice(depth) };
}

/**
 * A Dataverse environment's address, like `https://contoso.crm.dynamics.com`, from its address or
 * any address inside it, or null when the text isn't one.  Only Microsoft's own hosts qualify,
 * since the app's token goes wherever the address says.
 */
export function dataverseEnvironmentOf(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > MICROSOFT_LIMITS.address || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  // The Web API's own host, `<org>.api.crm.dynamics.com`, belongs to the same environment.
  const host = url.hostname.toLowerCase().replace(/^([a-z0-9-]+)\.api\./, '$1.');
  return DATAVERSE_HOST.test(host) ? `https://${host}` : null;
}

function distinctFolded(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}

/**
 * The lists of SharePoint sites, read through Microsoft Graph as an Entra app.  The source offers
 * the lists of the sites it names, each by its ID with its name as a label, so renaming a list keeps
 * a synced table reading.  The app needs `Sites.Selected` with read access to each site, or
 * `Sites.Read.All`.
 */
export const SharePointListConnection = z.object({
  kind: z.literal('sharepoint-list'),
  ...EntraApp,
  /** The sites' addresses, as `sharePointSiteOf` writes them */
  sites: z
    .array(z.string().refine((site) => sharePointSiteOf(site) === site))
    .min(1)
    .max(MICROSOFT_LIMITS.sites)
    .refine(distinctFolded),
});
export type SharePointListConnection = z.infer<typeof SharePointListConnection>;

/**
 * The sheets of Excel workbooks kept in SharePoint or OneDrive for Business, downloaded through
 * Microsoft Graph as an Entra app and read the way uploaded workbooks are.  Each sheet's first row
 * names its columns.  The app needs read access to each workbook's site, as a SharePoint list source
 * does.
 */
export const ExcelOnlineConnection = z.object({
  kind: z.literal('excel-online'),
  ...EntraApp,
  /** The workbooks' addresses, as `workbookAddressOf` writes them */
  workbooks: z
    .array(z.string().refine((workbook) => workbookAddressOf(workbook) === workbook))
    .min(1)
    .max(MICROSOFT_LIMITS.workbooks)
    .refine(distinctFolded),
});
export type ExcelOnlineConnection = z.infer<typeof ExcelOnlineConnection>;

/**
 * The tables of one Dataverse environment, the data behind Power Apps, read through its Web API as
 * an Entra app that an admin added to the environment as an application user.  Each table is
 * offered by its logical name, with its display name as a label.
 */
export const DataverseConnection = z.object({
  kind: z.literal('dataverse'),
  ...EntraApp,
  /** The environment's address, as `dataverseEnvironmentOf` writes it */
  environmentUrl: z.string().refine((url) => dataverseEnvironmentOf(url) === url),
});
export type DataverseConnection = z.infer<typeof DataverseConnection>;

/**
 * An RSS or Atom feed, or a JSON Feed, at a web address, over https the way a file's address is.
 * Each item is a record keyed by its ID.  Request headers, like an authorization header, are the
 * optional `headers` secret.
 */
export const FeedConnection = z.object({
  kind: z.literal('feed'),
  url: WebAddress,
});
export type FeedConnection = z.infer<typeof FeedConnection>;

/** The feed formats a feed source reads. */
export const FEED_FORMATS = ['rss2', 'rss1', 'atom', 'json'] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];

/** The columns every feed offers, in order.  `id` is the key. */
export const FEED_COLUMNS = [
  'id',
  'title',
  'link',
  'author',
  'published',
  'updated',
  'summary',
  'content',
  'categories',
  'enclosure',
] as const;
export type FeedColumn = (typeof FEED_COLUMNS)[number];

export const WEBHOOK_SOURCE_LIMITS = {
  /** The largest post a webhook takes, in bytes */
  bodyBytes: 1_048_576,
  /** The most records one post may make */
  recordsPerPost: 1_000,
  /** Deliveries the log keeps for each webhook */
  deliveries: 100,
  /** Posts the mapping step shows, received while it's open */
  samples: 10,
  /** How long a sample is kept after the mapping step last asked for one, in seconds */
  sampleSeconds: 120,
  /** How long bodies are kept in the log once someone turns that on, in minutes */
  bodyMinutes: 60,
  /** Posts a minute unless the source says otherwise */
  postsPerMinute: 120,
  /** How far a signed post's time may be from the server's, unless the source says otherwise */
  toleranceSeconds: 300,
} as const;

/**
 * How a webhook's posts are signed.  `timestamped` is Riosoma's own form, the one its outgoing
 * webhooks send: a header like `t=<unix seconds>,v1=<hex>`, where `v1` is an HMAC-SHA256 of
 * `<t>.<body>`, and a header may carry several `v1` values.  `hex` is the form many other services
 * use: the header holds the HMAC-SHA256 of the body alone in hex, optionally after `sha256=`.  With a
 * `timestampHeader`, the signed text is `<timestamp>.<body>` instead, and the time is checked.  The
 * shared secret is the `signingSecret` secret.
 */
export const WebhookSignature = z.object({
  format: z.enum(['timestamped', 'hex']).default('timestamped'),
  header: z.string().trim().min(1).max(100).refine(isHeaderName).default('Riosoma-Signature'),
  /** For `hex`: the header holding the post's time in Unix seconds, which the signature covers */
  timestampHeader: z.string().trim().min(1).max(100).refine(isHeaderName).optional(),
  /** How far a post's time may be from the server's before it's refused as a replay, in seconds */
  toleranceSeconds: z.number().int().min(30).max(86_400).default(WEBHOOK_SOURCE_LIMITS.toleranceSeconds),
});
export type WebhookSignature = z.infer<typeof WebhookSignature>;

/**
 * An incoming webhook: another system posts JSON to its address, and each post becomes records.
 * The address carries a token the server makes, shows once, and keeps only as a hash.  `records`
 * is where a post keeps its records, and when that's a list, `split` makes each item its own
 * record.  Posts are flattened into columns the way API records are.
 */
export const WebhookConnection = z.object({
  kind: z.literal('webhook'),
  /** Where the records are in each post, or empty when the post itself is the record or the list */
  records: JsonPath.default(''),
  /** A list makes one record for each item, or else the whole post is one record */
  split: z.boolean().default(true),
  /** Checks each post's signature with the `signingSecret` secret, when set */
  signature: WebhookSignature.optional(),
  /** Posts a minute this webhook takes before it asks senders to wait */
  postsPerMinute: z.number().int().min(1).max(10_000).default(WEBHOOK_SOURCE_LIMITS.postsPerMinute),
  /** Refuses posts with `503` while set, so senders that retry try again later */
  paused: z.boolean().default(false),
  /** How many levels of nested objects become dotted columns, and deeper ones stay JSON */
  flattenDepth: z.number().int().min(0).max(REST_LIMITS.flattenDepth).default(1),
  /** Lists of plain values as text joined with commas, or as JSON */
  arrays: z.enum(['text', 'json']).default('text'),
});
export type WebhookConnection = z.infer<typeof WebhookConnection>;

/** Field types a webhook's columns can fill, which a post's JSON values convert to cleanly. */
export const WEBHOOK_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'currency',
  'percent',
  'checkbox',
  'date',
  'email',
  'url',
  'phone',
  'singleSelect',
  'multipleSelect',
] as const;

/**
 * The plain codes a webhook refuses a post with, which senders see in the answer and people see in
 * the delivery log.
 */
export const WEBHOOK_REFUSALS = [
  'not_found',
  'paused',
  'rate_limited',
  'payload_too_large',
  'unsupported_content_type',
  'signature_missing',
  'signature_invalid',
  'timestamp_expired',
  'invalid_json',
  'records_missing',
  'record_not_object',
  'too_many_records',
  'bad_request',
  'unavailable',
] as const;
export type WebhookRefusalCode = (typeof WEBHOOK_REFUSALS)[number];

/** A refused post's answer. */
export interface WebhookRefusal {
  error: WebhookRefusalCode;
}

/** An accepted post's answer: how many records it holds, and the delivery's ID for the log. */
export interface WebhookAccepted {
  accepted: number;
  delivery: string;
}

/** A webhook's new address, shown this once.  Only its hash is kept. */
export interface WebhookAddress {
  /** The address's path, like `/api/inbound/<token>`, under the server's own address */
  path: string;
}

/**
 * One post as the log keeps it.  Bodies are kept only during the hour someone turned that on, and
 * are forgotten when it ends.
 */
export interface WebhookSourceDelivery {
  id: string;
  at: string;
  /** The HTTP status the post was answered with */
  status: number;
  /** Why it was refused, when it was */
  refusal: WebhookRefusalCode | null;
  bytes: number;
  /** Records the post held, when it was accepted */
  records: number | null;
  /**
   * A message key when a table couldn't take an accepted post, or some of its records, once it's
   * written.  Before then, `sources.webhook.retrying` while it waits to try again after a problem
   * that passes, and `sources.webhook.gaveUp` once it has stopped trying and is kept, unwritten.
   */
  error: string | null;
  /** Whether it has been written to the tables yet */
  written: boolean;
  body: string | null;
}

/** The last 100 posts, and any still held, like one that failed, newest first. */
export interface WebhookSourceLog {
  deliveries: WebhookSourceDelivery[];
  /** Until when bodies are kept, or null while they aren't */
  bodiesUntil: string | null;
}

/** Keeps posts' bodies in the log for the next hour, or stops keeping them. */
export const WebhookBodyLogging = z.object({ on: z.boolean() }).strict();
export type WebhookBodyLogging = z.infer<typeof WebhookBodyLogging>;

export const SourceConnection = z.discriminatedUnion('kind', [
  PostgresConnection,
  MySqlConnection,
  SqlServerConnection,
  OracleConnection,
  FirebirdConnection,
  SnowflakeConnection,
  BigQueryConnection,
  DatabricksConnection,
  MotherDuckConnection,
  RedshiftConnection,
  AthenaConnection,
  DuckDbFileConnection,
  ClickHouseConnection,
  TrinoConnection,
  DruidConnection,
  TeradataConnection,
  Db2Connection,
  InformixConnection,
  FileUrlConnection,
  BucketConnection,
  SftpConnection,
  FtpConnection,
  FtpsConnection,
  WebDavConnection,
  GraphQlConnection,
  ODataConnection,
  RestConnection,
  AppConnection,
  MongoConnection,
  DynamoConnection,
  CouchDbConnection,
  CouchbaseConnection,
  FirestoreConnection,
  CosmosConnection,
  ElasticsearchConnection,
  OpenSearchConnection,
  MeilisearchConnection,
  TypesenseConnection,
  Neo4jConnection,
  InfluxDbConnection,
  PrometheusConnection,
  GoogleSheetsConnection,
  AirtableConnection,
  SharePointListConnection,
  ExcelOnlineConnection,
  DataverseConnection,
  FeedConnection,
  WebhookConnection,
]);
export type SourceConnection = z.infer<typeof SourceConnection>;

export function isNoSqlConnection(connection: SourceConnection): connection is NoSqlConnection {
  return isNoSqlKind(connection.kind);
}

/** Whether a connection reaches one of the engines spoken to over HTTP with JSON. */
export function isHttpEngineConnection(connection: SourceConnection): connection is HttpEngineConnection {
  return isHttpEngine(connection.kind);
}

/**
 * Secrets travel only from the browser to the server, which seals them with the instance key.
 * They're never sent back: a source says only which ones it holds.
 */
export const SECRET_NAMES = [
  'password',
  'clientSecret',
  /** A sealed refresh token used only at the OAuth token address. */
  'refreshToken',
  'clientKeyPem',
  'sshPrivateKeyPem',
  'sshPassphrase',
  'token',
  'serviceAccountJson',
  'privateKeyPem',
  'privateKeyPassphrase',
  /** A file source's request headers, one `Name: value` per line */
  'headers',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  /** An API source's key, sent in a header or a query parameter */
  'apiKey',
  /** A MongoDB source's connection string, which can hold a user and password */
  'connectionString',
  /** A webhook's shared secret, which checks each post's signature */
  'signingSecret',
  /** An Oracle wallet's `ewallet.pem`: its certificates, and a client key when it has one */
  'wallet',
  /** The password of the key in an Oracle wallet, when the key is encrypted */
  'walletPassword',
] as const;
export const SecretName = z.enum(SECRET_NAMES);
export type SecretName = z.infer<typeof SecretName>;
export const SourceSecrets = z.partialRecord(SecretName, z.string().min(1).max(64_000));
export type SourceSecrets = z.infer<typeof SourceSecrets>;

/** Which secrets a connection needs before it can be tested or saved. */
export function requiredSecrets(connection: SourceConnection): SecretName[] {
  const needs: SecretName[] = [];
  switch (connection.kind) {
    case 'app': {
      const app = APP_CATALOG.find((app) => app.id === connection.app)!;
      if (app.secret)
        needs.push(app.secret.name, ...(app.additionalSecrets ?? []).map((secret) => secret.name));
      break;
    }
    case 'postgres':
      if (connection.auth.method === 'password') needs.push('password');
      if (connection.auth.method === 'azure-entra' && connection.auth.credential === 'service-principal')
        needs.push('clientSecret');
      if (connection.auth.method === 'client-certificate') needs.push('clientKeyPem');
      break;
    case 'oracle':
      needs.push('password');
      // Checking a certificate without its name needs an authority of the source's own, so with
      // none pasted, the wallet has to bring one.
      if (connection.tls.mode === 'verify-ca' && !connection.tls.caPem) needs.push('wallet');
      break;
    case 'mysql':
    case 'firebird':
    case 'teradata':
    case 'db2':
    case 'informix':
    case 'clickhouse':
      needs.push('password');
      break;
    case 'trino':
      if (connection.auth === 'password') needs.push('password');
      if (connection.auth === 'token') needs.push('token');
      break;
    case 'druid':
      if (connection.user) needs.push('password');
      break;
    case 'sqlserver':
      if (connection.auth.method === 'password') needs.push('password');
      else if (connection.auth.credential === 'service-principal') needs.push('clientSecret');
      break;
    case 'snowflake':
      needs.push(connection.auth === 'password' ? 'password' : 'privateKeyPem');
      break;
    case 'bigquery':
    case 'google-sheets':
      needs.push('serviceAccountJson');
      break;
    case 'databricks':
    case 'motherduck':
    case 'airtable':
      needs.push('token');
      break;
    case 'sharepoint-list':
    case 'excel-online':
    case 'dataverse':
      needs.push('clientSecret');
      break;
    case 'redshift':
      if (connection.auth === 'password') needs.push('password');
      else needs.push('accessKeyId', 'secretAccessKey');
      break;
    case 'duckdb-file':
      if (connection.storage === 'bucket') needs.push('accessKeyId', 'secretAccessKey');
      break;
    case 'athena':
    case 'dynamodb':
    case 'bucket':
      needs.push('accessKeyId', 'secretAccessKey');
      break;
    case 'file-url':
    case 'feed':
      // Headers are optional, since plenty of files and feeds need none.
      break;
    case 'webhook':
      if (connection.signature) needs.push('signingSecret');
      break;
    case 'sftp':
      needs.push(connection.auth === 'key' ? 'sshPrivateKeyPem' : 'password');
      break;
    case 'ftp':
    case 'ftps':
      needs.push('password');
      break;
    case 'webdav':
      needs.push(connection.auth === 'bearer' ? 'token' : 'password');
      break;
    case 'graphql':
    case 'odata':
    case 'rest':
      switch (connection.auth.method) {
        case 'bearer':
          needs.push('token');
          break;
        case 'header':
        case 'query':
          needs.push('apiKey');
          break;
        case 'basic':
          needs.push('password');
          break;
        case 'oauth-client':
          needs.push('clientSecret');
          if (connection.auth.grant === 'refresh_token') needs.push('refreshToken');
          break;
        case 'none':
          break;
      }
      break;
    case 'couchdb':
    case 'couchbase':
      needs.push('password');
      break;
    case 'firestore':
      if (!connection.emulator) needs.push('serviceAccountJson');
      break;
    case 'cosmosdb':
      needs.push(connection.auth === 'master-key' ? 'secretAccessKey' : 'token');
      break;
    case 'elasticsearch':
    case 'opensearch':
    case 'meilisearch':
    case 'typesense':
    case 'neo4j':
    case 'influxdb':
    case 'prometheus':
      if (connection.auth === 'api-key') needs.push('apiKey');
      if (connection.auth === 'basic') needs.push('password');
      if (connection.auth === 'token') needs.push('token');
      if (connection.auth === 'aws-sigv4') needs.push('accessKeyId', 'secretAccessKey');
      break;
    case 'mongodb':
      if (connection.address === 'uri') needs.push('connectionString');
      else if (connection.user) needs.push('password');
      break;
  }
  if ('ssh' in connection && connection.ssh) needs.push('sshPrivateKeyPem');
  return needs;
}

export const REQUEST_HEADER_LIMITS = { headers: 20, valueLength: 8_000 } as const;

/**
 * A file source's request headers, written one `Name: value` per line, or null when a line isn't
 * one, a name repeats, or a name is one the request sets itself.  Blank lines are ignored.
 */
export function parseRequestHeaders(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > REQUEST_HEADER_LIMITS.headers) return null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, Math.max(colon, 0)).trim();
    const value = line.slice(colon + 1).trim();
    if (
      colon <= 0 ||
      !isHeaderName(name) ||
      Object.keys(headers).some((seen) => seen.toLowerCase() === name.toLowerCase()) ||
      value === '' ||
      value.length > REQUEST_HEADER_LIMITS.valueLength ||
      hasControl(value, true)
    )
      return null;
    headers[name] = value;
  }
  return headers;
}

/** Who may build synced tables from a source.  Admins with the Data Sources role always can. */
export const SourceAccess = z.enum(['admins', 'creators']);
export type SourceAccess = z.infer<typeof SourceAccess>;

export const SourceCreate = z.object({
  name: Name,
  description: Description.default(''),
  connection: SourceConnection,
  secrets: SourceSecrets,
  /** `creators`: anyone who can add tables to a database may sync from it */
  access: SourceAccess.default('admins'),
});
export type SourceCreate = z.infer<typeof SourceCreate>;

/** Secrets left out keep their current values; `null` removes one. */
export const SourceUpdate = z.object({
  name: Name.optional(),
  description: Description.optional(),
  connection: SourceConnection.optional(),
  secrets: z.partialRecord(SecretName, z.string().min(1).max(64_000).nullable()).optional(),
  access: SourceAccess.optional(),
});
export type SourceUpdate = z.infer<typeof SourceUpdate>;

/** Source commands keep credentials inside the server's private journal */
export const FileApiSourceKinds = ['sftp', 'ftp', 'ftps', 'webdav', 'graphql', 'odata'] as const;
export const isFileApiSource = (kind: SourceKind): boolean =>
  (FileApiSourceKinds as readonly string[]).includes(kind);
export const SourceCommand = z.object({
  id: CommandId,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), input: SourceCreate }),
    z.object({ kind: z.literal('update'), sourceId: SourceId, input: SourceUpdate }),
    z.object({ kind: z.literal('delete'), sourceId: SourceId }),
    z.object({ kind: z.literal('undo'), commandId: CommandId }),
  ]),
});
export type SourceCommand = z.infer<typeof SourceCommand>;
export interface SourceCommandResult {
  id: string;
  status: 'applied' | 'duplicate';
  source: SourceMeta | null;
}

/** The steps a connection test climbs, in order.  The first failure stops the climb. */
export const TEST_STEPS = [
  'driver',
  'tunnel',
  'resolve',
  'connect',
  'tls',
  'authenticate',
  /** File sources: the file's first bytes arrive */
  'read',
  /** File sources: the file reads in its format */
  'parse',
  /** API sources: the first page holds a list of records where the endpoint says */
  'records',
  /** API sources: a second page arrives, when the endpoint pages */
  'paging',
  /** MongoDB sources: the database lists its collections and views */
  'collections',
  /** MongoDB sources: one document reads from the first of them */
  'document',
  /** Google Sheets sources: each spreadsheet lists its sheets */
  'sheets',
  /** Airtable sources: the token lists its bases and the first base's tables */
  'tables',
  /** SharePoint list sources: each site opens and lists its lists */
  'lists',
  /** Excel workbook sources: each workbook opens and lists its sheets */
  'workbooks',
  /** Dataverse sources: the environment lists its tables */
  'entities',
  /** Feed sources: the answer is an RSS, Atom, or JSON feed */
  'feed',
  /** Webhook sources: a post has arrived */
  'posts',
  /** App sources: the first sheet, list, or table's first rows read */
  'rows',
  'query',
] as const;
export type TestStep = (typeof TEST_STEPS)[number];

export interface SourceTestResult {
  ok: boolean;
  steps: Array<{
    step: TestStep;
    status: 'ok' | 'failed' | 'skipped';
    ms: number | null;
    /** A source message key saying what went wrong or what the test noticed */
    messageKey?: string;
    /** Safe values for the message, such as an object and its required permissions */
    params?: Record<string, string | number | boolean>;
    /** The driver's own words, for people who know the system */
    detail?: string;
  }>;
  /** The server's product and version, when the test got that far */
  serverVersion?: string;
}

export interface SourceMeta {
  commandId?: string;
  credentialError?: 'credentials.unavailable';
  importNote?: string | null;
  id: string;
  name: string;
  description: string;
  kind: SourceKind;
  /** Admins see the connection; everyone else sees only the name and kind */
  connection: SourceConnection | null;
  /** Which secrets are stored, never their values */
  secrets: SecretName[];
  access: SourceAccess;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  lastTest: { at: string; ok: boolean } | null;
  /** Synced tables using this source */
  tables: number;
  /** A webhook source's address and posts, for admins */
  webhook?: {
    /** When the current address was made */
    addressAt: string;
    lastPostAt: string | null;
    /** Until when the log keeps bodies, or null */
    bodiesUntil: string | null;
  };
  /** A new webhook source's address, shown this once, only in the answer that saves it */
  webhookPath?: string;
}

/**
 * A table or view the source offers.  A file source offers files instead: each file, and for a
 * bucket prefix, every file of one format under it read together as one (`files`).  An API source
 * offers its endpoints, and a MongoDB source its database's collections and views.  A Google Sheets
 * source offers its spreadsheets' sheets, and an Airtable source its bases' tables, each by an ID
 * that stays the same when someone renames it there, with the name people know it by as a label.
 * A SharePoint list source offers its sites' lists, an Excel workbook source its workbooks' sheets,
 * and a Dataverse source its environment's tables, the same way.  A search engine offers its
 * indexes or collections, and their aliases, a Neo4j source its node labels, an InfluxDB source its
 * measurements or tables, and a Prometheus source the one query its settings hold.
 */
export interface SourceObject {
  /** Schema, dataset, or database, depending on the system; null when it has no such level */
  schema: string | null;
  /** What people call the schema, when it's known by an ID */
  schemaLabel?: string;
  name: string;
  /** What people call the object, when it's known by an ID */
  label?: string;
  /** Preset labels are translated by the client, while account names remain parameters. */
  labelMessageId?: string;
  labelParams?: Record<string, string>;
  type: 'table' | 'view' | 'file' | 'files' | 'endpoint' | 'collection' | 'sheet' | 'list' | 'feed' | 'posts';
  rowEstimate: number | null;
  /** A file's size in bytes, or the files' total, when the source says */
  bytes?: number | null;
  /** How many files a `files` object reads together */
  files?: number;
}

/** One column of a source table, with the field type Riosoma suggests for it. */
export interface SourceColumn {
  name: string;
  /** The source's own type name, like `varchar(80)` or `NUMBER(38,0)` */
  sourceType: string;
  nullable: boolean;
  /** A `FieldSpec` (type and options), or null for types Riosoma can't hold, like binary data */
  suggested: { type: string; options: Record<string, unknown> } | null;
  /** Other types this column converts to cleanly, for the person to choose instead */
  alternatives: string[];
  /**
   * A column the source adds rather than holds: a sheet's row numbers, or an Airtable record's ID.
   * Neither starts out as a field, and a row number is a poor key, since rows move.
   */
  role?: 'rowNumber' | 'recordId';
  /** How the column comes across when it isn't quite as it is in the source, as message keys */
  notes?: Array<{ messageKey: string; params?: Record<string, string | number> }>;
}

/** `POST /api/sources/:sourceId/preview` */
export const PreviewRequest = z.object({ select: SourceSelect });

/**
 * `POST /api/sources/endpoint-preview`: one endpoint's first page, while an API source is being set
 * up and before it's saved.  Answers with a `SourcePreview` whose key candidates are empty.
 */
export const EndpointPreviewDraft = z.object({
  connection: RestTarget,
  secrets: SourceSecrets,
  endpoint: RestEndpoint,
});
export type EndpointPreviewDraft = z.infer<typeof EndpointPreviewDraft>;

/**
 * `POST /api/sources/:sourceId/endpoint-preview`: the same for a saved API source, with its stored
 * address, sign-in, and secrets, so the secrets never travel to a draft's new address.
 */
export const EndpointPreviewSaved = z.object({ endpoint: RestEndpoint });
export type EndpointPreviewSaved = z.infer<typeof EndpointPreviewSaved>;

/**
 * `POST /api/sources/airtable-bases`: the bases a token can see, for choosing which ones an Airtable
 * source offers while it's being set up.  `POST /api/sources/:sourceId/airtable-bases` does the same
 * with a saved source's stored token, and takes no body.  Both answer with `AirtableSourceBase[]`.
 */
export const AirtableBasesDraft = z.object({ token: AirtableToken }).strict();
export type AirtableBasesDraft = z.infer<typeof AirtableBasesDraft>;

/** One base an Airtable source could offer. */
export interface AirtableSourceBase {
  id: string;
  name: string;
}
export interface SourcePreview {
  columns: SourceColumn[];
  /** The first rows, as values for each column's suggested type */
  rows: CellValue[][];
  rowEstimate: number | null;
  /** Column sets the source declares unique (primary key first), for identifying records */
  keyCandidates: string[][];
}

export const GraphQlSuggestionsDraft = z
  .object({ connection: GraphQlConnection, secrets: SourceSecrets })
  .strict();

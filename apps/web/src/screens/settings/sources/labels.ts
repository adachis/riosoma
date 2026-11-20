import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type {
  FileFormat,
  FirebirdWireCrypt,
  MongoTlsMode,
  OracleTlsMode,
  RestAuthMethod,
  RestPagingStyle,
  SecretName,
  SourceAccess,
  SourceKind,
  SourceTestResult,
  TestStep,
  TrinoAuthMethod,
} from '@riosoma/contracts';
import type {
  AuthMethod,
  EndpointDraft,
  EntraCredential,
  SignatureFormat,
  SnowflakeAuth,
  SourceFormValues,
  TlsMode,
} from './kinds';

/**
 * The words beside each choice, kept in records so a component can look one up by the value the
 * contract uses instead of repeating a switch everywhere.
 */

export type StepStatus = SourceTestResult['steps'][number]['status'];

export const ACCESS_LABELS: Record<SourceAccess, MessageDescriptor> = {
  admins: msg({ id: 'sources.access.admins', message: 'Data Sources admins' }),
  creators: msg({ id: 'sources.access.creators', message: 'Anyone who can add tables' }),
};

export const TLS_MODE_LABELS: Record<TlsMode, MessageDescriptor> = {
  disable: msg({ id: 'sources.tls.disable', message: 'Off' }),
  prefer: msg({ id: 'sources.tls.prefer', message: 'Use if available' }),
  require: msg({ id: 'sources.tls.require', message: 'Required, any certificate' }),
  'verify-ca': msg({ id: 'sources.tls.verifyCa', message: 'Required, trusted certificate' }),
  'verify-full': msg({
    id: 'sources.tls.verifyFull',
    message: 'Required, trusted certificate for this host',
  }),
};

export const AUTH_LABELS: Record<AuthMethod, MessageDescriptor> = {
  password: msg({ id: 'sources.auth.password', message: 'Password' }),
  'azure-entra': msg({ id: 'sources.auth.azureEntra', message: 'Microsoft Entra ID' }),
  'aws-rds-iam': msg({ id: 'sources.auth.awsRdsIam', message: 'AWS IAM' }),
  'gcp-cloudsql-iam': msg({ id: 'sources.auth.gcpCloudSqlIam', message: 'Google Cloud IAM' }),
  'client-certificate': msg({ id: 'sources.auth.clientCertificate', message: 'Client certificate' }),
};

/** What PostgreSQL offers; SQL Server takes only the first two. */
export const POSTGRES_AUTH_METHODS: readonly AuthMethod[] = [
  'password',
  'azure-entra',
  'aws-rds-iam',
  'gcp-cloudsql-iam',
  'client-certificate',
];
export const SQL_SERVER_AUTH_METHODS: readonly AuthMethod[] = ['password', 'azure-entra'];

export const SNOWFLAKE_AUTH_LABELS: Record<SnowflakeAuth, MessageDescriptor> = {
  password: msg({ id: 'sources.auth.password', message: 'Password' }),
  'key-pair': msg({ id: 'sources.auth.keyPair', message: 'Key pair' }),
};

/** How a Trino source signs in, in the order the choice lists them. */
export const TRINO_AUTH_LABELS: Record<TrinoAuthMethod, MessageDescriptor> = {
  password: msg({ id: 'sources.auth.password', message: 'Password' }),
  token: msg({ id: 'sources.trino.auth.token', message: 'Access token' }),
  none: msg({ id: 'sources.trino.auth.none', message: 'No password' }),
};

export const CREDENTIAL_LABELS: Record<EntraCredential, MessageDescriptor> = {
  'managed-identity': msg({ id: 'sources.credential.managedIdentity', message: 'Managed identity' }),
  'workload-identity': msg({ id: 'sources.credential.workloadIdentity', message: 'Workload identity' }),
  'service-principal': msg({ id: 'sources.credential.servicePrincipal', message: 'Service principal' }),
};

export const CREDENTIALS: readonly EntraCredential[] = [
  'managed-identity',
  'workload-identity',
  'service-principal',
];

export const SECRET_LABELS: Record<SecretName, MessageDescriptor> = {
  password: msg({ id: 'sources.secret.password', message: 'Password' }),
  refreshToken: msg({ id: 'sources.app.refreshToken', message: 'Refresh token' }),
  clientSecret: msg({ id: 'sources.secret.clientSecret', message: 'Client secret' }),
  clientKeyPem: msg({ id: 'sources.secret.clientKeyPem', message: 'Client private key (PEM)' }),
  sshPrivateKeyPem: msg({ id: 'sources.secret.sshPrivateKeyPem', message: 'SSH private key' }),
  sshPassphrase: msg({ id: 'sources.secret.sshPassphrase', message: 'SSH key passphrase' }),
  token: msg({ id: 'sources.secret.token', message: 'Access token' }),
  serviceAccountJson: msg({
    id: 'sources.secret.serviceAccountJson',
    message: 'Service account key (JSON)',
  }),
  privateKeyPem: msg({ id: 'sources.secret.privateKeyPem', message: 'Private key (PEM)' }),
  privateKeyPassphrase: msg({
    id: 'sources.secret.privateKeyPassphrase',
    message: 'Private key passphrase',
  }),
  headers: msg({ id: 'sources.secret.headers', message: 'Request headers' }),
  accessKeyId: msg({ id: 'sources.secret.accessKeyId', message: 'Access key ID' }),
  sessionToken: msg({ id: 'sources.secret.sessionToken', message: 'Session token' }),
  secretAccessKey: msg({ id: 'sources.secret.secretAccessKey', message: 'Secret access key' }),
  apiKey: msg({ id: 'sources.secret.apiKey', message: 'API key' }),
  connectionString: msg({ id: 'sources.secret.connectionString', message: 'Connection string' }),
  signingSecret: msg({ id: 'sources.secret.signingSecret', message: 'Signing secret' }),
  wallet: msg({ id: 'sources.secret.wallet', message: 'Wallet (ewallet.pem)' }),
  walletPassword: msg({ id: 'sources.secret.walletPassword', message: 'Wallet password' }),
};

/** Help under a secret's field, for the ones whose shape isn't obvious. */
export const SECRET_HINTS: Partial<Record<SecretName, MessageDescriptor>> = {
  headers: msg({
    id: 'sources.secret.headers.hint',
    message: 'One per line, as Name: value.  For example, Authorization: Bearer and your token.',
  }),
  connectionString: msg({
    id: 'sources.secret.connectionString.hint',
    message:
      'Like mongodb+srv://user:password@cluster0.example.mongodb.net.  It’s kept as a secret, since it can hold a password.',
  }),
  wallet: msg({
    id: 'sources.secret.wallet.hint',
    message:
      'The whole ewallet.pem file from the wallet, with its trusted certificates and, for mutual TLS, a client certificate and key.  Checking the certificate without its name needs a wallet or an authority pasted under Advanced.',
  }),
  walletPassword: msg({
    id: 'sources.secret.walletPassword.hint',
    message: 'Only when the wallet’s key is encrypted.',
  }),
};

/** Every Microsoft 365 kind signs in with an Entra app's client secret. */
const MICROSOFT_SECRET_HINT = msg({
  id: 'sources.microsoft.secret.hint',
  message:
    'A client secret’s value from the app registration’s Certificates and secrets page in Microsoft Entra, not its ID.',
});

/** Both engines that speak the query DSL issue their own API keys the same way. */
const SEARCH_KEY_HINT = msg({
  id: 'sources.engines.apiKey.hint',
  message: 'A key the cluster issues for a user that may read the indexes people sync.',
});

/** Amazon OpenSearch signs with an identity's key pair, as the other AWS sources do. */
const AWS_KEY_HINT = msg({
  id: 'sources.engines.awsKey.hint',
  message: 'The access key of an AWS identity allowed to search the domain or collection.',
});

/** Help under a secret's field that only one kind needs, in place of the secret's own help. */
export const KIND_SECRET_HINTS: Partial<Record<SourceKind, Partial<Record<SecretName, MessageDescriptor>>>> =
  {
    'google-sheets': {
      serviceAccountJson: msg({
        id: 'sources.google.key.hint',
        message:
          'The whole JSON key file of a Google Cloud service account.  Share each spreadsheet with the account’s address, which shows here once the key is in.',
      }),
    },
    webhook: {
      signingSecret: msg({
        id: 'sources.webhook.secret.hint',
        message:
          'The secret the sending service signs posts with, shared with Riosoma.  Paste it from the service’s webhook settings.',
      }),
    },
    feed: {
      headers: msg({
        id: 'sources.feed.headers.hint',
        message: 'Only for a private feed.  One per line, as Name: value, like an Authorization header.',
      }),
    },
    airtable: {
      token: msg({
        id: 'sources.airtable.token.hint',
        message:
          'A personal access token from Airtable’s builder hub, with the data.records:read and schema.bases:read scopes and the bases people may sync.',
      }),
    },
    'sharepoint-list': {
      clientSecret: MICROSOFT_SECRET_HINT,
    },
    'excel-online': {
      clientSecret: MICROSOFT_SECRET_HINT,
    },
    dataverse: {
      clientSecret: MICROSOFT_SECRET_HINT,
    },
    trino: {
      token: msg({
        id: 'sources.trino.token.hint',
        message: 'A JWT or OAuth 2.0 access token Trino accepts, which Riosoma sends as a bearer token.',
      }),
    },
    elasticsearch: {
      apiKey: SEARCH_KEY_HINT,
    },
    opensearch: {
      apiKey: SEARCH_KEY_HINT,
      accessKeyId: AWS_KEY_HINT,
    },
    meilisearch: {
      apiKey: msg({
        id: 'sources.engines.meiliKey.hint',
        message: 'The master key, or a key made from it that may search and read the indexes people sync.',
      }),
    },
    typesense: {
      apiKey: msg({
        id: 'sources.engines.typesenseKey.hint',
        message: 'An API key from the server, with read access to the collections people sync.',
      }),
    },
    neo4j: {
      password: msg({
        id: 'sources.engines.neo4jPassword.hint',
        message: 'The password of a database user that may read the labels people sync.',
      }),
    },
    influxdb: {
      token: msg({
        id: 'sources.engines.influxToken.hint',
        message: 'An API token with read access to the bucket, or to the database in version 3.',
      }),
    },
    prometheus: {
      token: msg({
        id: 'sources.engines.bearer.hint',
        message: 'A bearer token the server accepts, for one that sits behind an authenticating proxy.',
      }),
    },
  };

/** Certificates and service account keys arrive as blocks of text, so they get a monospace area. */
export const MULTILINE_SECRETS: ReadonlySet<SecretName> = new Set<SecretName>([
  'clientKeyPem',
  'sshPrivateKeyPem',
  'serviceAccountJson',
  'privateKeyPem',
  'headers',
  'wallet',
]);

/** The formats a file source reads, in the order the format choice lists them. */
export const FILE_FORMAT_LABELS: Record<FileFormat, MessageDescriptor> = {
  csv: msg({ id: 'sources.format.csv', message: 'CSV' }),
  tsv: msg({ id: 'sources.format.tsv', message: 'TSV (tab-separated)' }),
  json: msg({ id: 'sources.format.json', message: 'JSON' }),
  ndjson: msg({ id: 'sources.format.ndjson', message: 'NDJSON (one JSON object per line)' }),
  parquet: msg({ id: 'sources.format.parquet', message: 'Parquet' }),
  xlsx: msg({ id: 'sources.format.xlsx', message: 'Excel workbook' }),
};

export const STEP_NAMES: Record<TestStep, MessageDescriptor> = {
  driver: msg({ id: 'sources.step.driver', message: 'Installed driver' }),
  tunnel: msg({ id: 'sources.step.tunnel', message: 'SSH tunnel' }),
  resolve: msg({ id: 'sources.step.resolve', message: 'Find the host' }),
  connect: msg({ id: 'sources.step.connect', message: 'Reach the server' }),
  tls: msg({ id: 'sources.step.tls', message: 'Secure the connection' }),
  authenticate: msg({ id: 'sources.step.authenticate', message: 'Sign in' }),
  read: msg({ id: 'sources.step.read', message: 'Read the first bytes' }),
  parse: msg({ id: 'sources.step.parse', message: 'Read the file' }),
  records: msg({ id: 'sources.step.records', message: 'Find the records' }),
  paging: msg({ id: 'sources.step.paging', message: 'Read the next page' }),
  collections: msg({ id: 'sources.step.collections', message: 'List the collections' }),
  document: msg({ id: 'sources.step.document', message: 'Read a document' }),
  sheets: msg({ id: 'sources.step.sheets', message: 'List the sheets' }),
  tables: msg({ id: 'sources.step.tables', message: 'List the bases and tables' }),
  lists: msg({ id: 'sources.step.lists', message: 'List the sites’ lists' }),
  workbooks: msg({ id: 'sources.step.workbooks', message: 'Open the workbooks' }),
  entities: msg({ id: 'sources.step.entities', message: 'List the tables' }),
  rows: msg({ id: 'sources.step.rows', message: 'Read the first rows' }),
  feed: msg({ id: 'sources.step.feed', message: 'Read the feed' }),
  posts: msg({ id: 'sources.step.posts', message: 'Receive a post' }),
  query: msg({ id: 'sources.step.query', message: 'Run a query' }),
};

/** How a webhook's posts are signed. */
export const SIGNATURE_FORMAT_LABELS: Record<SignatureFormat, MessageDescriptor> = {
  timestamped: msg({
    id: 'sources.webhook.format.timestamped',
    message: 'A time and a signature, like t=…,v1=…',
  }),
  hex: msg({ id: 'sources.webhook.format.hex', message: 'The signature alone, in hex' }),
};

/** How an API source signs in, in the order the choice lists them. */
export const REST_AUTH_LABELS: Record<RestAuthMethod, MessageDescriptor> = {
  none: msg({ id: 'sources.api.auth.none', message: 'No sign-in' }),
  bearer: msg({ id: 'sources.api.auth.bearer', message: 'Bearer token' }),
  header: msg({ id: 'sources.api.auth.header', message: 'API key in a header' }),
  query: msg({ id: 'sources.api.auth.query', message: 'API key in a query parameter' }),
  basic: msg({ id: 'sources.api.auth.basic', message: 'User and password' }),
  'oauth-client': msg({ id: 'sources.api.auth.oauthClient', message: 'OAuth 2.0 client credentials' }),
};

export const CLIENT_AUTH_LABELS: Record<SourceFormValues['clientAuth'], MessageDescriptor> = {
  basic: msg({ id: 'sources.api.clientAuth.basic', message: 'In an Authorization header' }),
  body: msg({ id: 'sources.api.clientAuth.body', message: 'In the request’s body' }),
};

/** How an endpoint pages, in the order the choice lists them. */
export const PAGING_LABELS: Record<RestPagingStyle, MessageDescriptor> = {
  none: msg({ id: 'sources.api.paging.none', message: 'No paging' }),
  page: msg({ id: 'sources.api.paging.page', message: 'Page number' }),
  offset: msg({ id: 'sources.api.paging.offset', message: 'Offset and limit' }),
  cursor: msg({ id: 'sources.api.paging.cursor', message: 'Cursor from the answer' }),
  'last-record': msg({ id: 'sources.app.lastRecordCursor', message: 'Cursor from the last record' }),
  'next-url': msg({ id: 'sources.api.paging.nextUrl', message: 'Next page address in the answer' }),
  'link-header': msg({ id: 'sources.api.paging.linkHeader', message: 'Link header' }),
};

export const ARRAY_LABELS: Record<EndpointDraft['arrays'], MessageDescriptor> = {
  text: msg({ id: 'sources.api.arrays.text', message: 'Text joined with commas' }),
  json: msg({ id: 'sources.api.arrays.json', message: 'JSON' }),
};

/** How an Oracle source is named, in the order the choice lists them. */
export const ORACLE_ADDRESS_LABELS: Record<SourceFormValues['oracleAddress'], MessageDescriptor> = {
  host: msg({ id: 'sources.oracle.address.host', message: 'A host and service name' }),
  'easy-connect': msg({ id: 'sources.oracle.address.easyConnect', message: 'An Easy Connect string' }),
};

/**
 * Oracle's TLS choices.  TCPS listens on a port of its own, so there's no Use if available, and the
 * driver always checks the certificate's chain, so there's no Required, any certificate.
 */
export const ORACLE_TLS_LABELS: Record<OracleTlsMode, MessageDescriptor> = {
  disable: msg({ id: 'sources.tls.disable', message: 'Off' }),
  'verify-ca': msg({ id: 'sources.tls.verifyCa', message: 'Required, trusted certificate' }),
  'verify-full': msg({
    id: 'sources.tls.verifyFull',
    message: 'Required, trusted certificate for this host',
  }),
};

export const FIREBIRD_WIRE_CRYPT_LABELS: Record<FirebirdWireCrypt, MessageDescriptor> = {
  required: msg({ id: 'sources.firebird.wireCrypt.required', message: 'Required' }),
  enabled: msg({ id: 'sources.firebird.wireCrypt.enabled', message: 'When the server offers it' }),
};

/** How a MongoDB source is named, in the order the choice lists them. */
export const MONGO_ADDRESS_LABELS: Record<SourceFormValues['mongoAddress'], MessageDescriptor> = {
  uri: msg({ id: 'sources.mongodb.address.uri', message: 'A connection string' }),
  host: msg({ id: 'sources.mongodb.address.host', message: 'A host and port' }),
};

export const MONGO_TLS_LABELS: Record<MongoTlsMode, MessageDescriptor> = {
  auto: msg({ id: 'sources.mongodb.tls.auto', message: 'Automatic' }),
  on: msg({ id: 'sources.mongodb.tls.on', message: 'On' }),
  off: msg({ id: 'sources.mongodb.tls.off', message: 'Off' }),
};

export const STEP_STATUS_LABELS: Record<StepStatus, MessageDescriptor> = {
  ok: msg({ id: 'sources.step.ok', message: 'Passed' }),
  failed: msg({ id: 'sources.step.failed', message: 'Failed' }),
  skipped: msg({ id: 'sources.step.skipped', message: 'Skipped' }),
};

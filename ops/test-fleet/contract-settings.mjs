import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET_KINDS = [
  'mysql',
  'sqlserver',
  'oracle',
  'firebird',
  'duckdb-file',
  'clickhouse',
  'trino',
  'druid',
  'db2',
  'informix',
  'bucket',
  'sftp',
  'ftp',
  'ftps',
  'webdav',
  'file-url',
  'graphql',
  'odata',
  'rest',
  'feed',
  'mongodb',
  'dynamodb',
  'couchdb',
  'couchbase',
  'cosmosdb',
  'elasticsearch',
  'opensearch',
  'meilisearch',
  'typesense',
  'neo4j',
  'influxdb',
  'prometheus',
];

const FLEET_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));

export const FLEET_PASSWORD = 'Riosoma-Test-2026!';
export const FLEET_USER = 'riosoma_test';
export const FLEET_DATABASE = 'riosoma_test';
export const INFORMIX_USER = 'informix';
export const INFORMIX_PASSWORD = ['in4', 'mix'].join('');
export const COSMOS_EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const PLACEHOLDER_SFTP_HOST_KEY = `ssh-ed25519 ${Buffer.alloc(32, 1).toString('base64')}`;

const DEFAULTS = {
  httpBaseUrl: 'http://127.0.0.1:18900',
  duckdbPath: resolve(FLEET_DIR, '.fixtures/contract.duckdb'),
  driversDir: resolve(FLEET_DIR, '.drivers'),
  sftpHostKey: PLACEHOLDER_SFTP_HOST_KEY,
};

function settingsEnvName(kind) {
  return `RIOSOMA_TEST_${kind.toUpperCase().replaceAll('-', '_')}_SETTINGS`;
}

export function connectionForKind(kind, options = {}) {
  const config = { ...DEFAULTS, ...options };
  switch (kind) {
    case 'mysql':
      return {
        kind,
        host: '127.0.0.1',
        port: 13306,
        database: FLEET_DATABASE,
        user: FLEET_USER,
        tls: { mode: 'disable' },
      };
    case 'sqlserver':
      return {
        kind,
        host: '127.0.0.1',
        port: 11433,
        database: 'master',
        user: 'sa',
        encrypt: true,
        trustServerCertificate: true,
        serverName: 'localhost',
      };
    case 'oracle':
      return {
        kind,
        address: 'host',
        host: '127.0.0.1',
        port: 11521,
        serviceName: 'FREEPDB1',
        user: FLEET_USER,
        tls: { mode: 'disable' },
      };
    case 'firebird':
      return {
        kind,
        host: '127.0.0.1',
        port: 13050,
        database: '/var/lib/firebird/data/riosoma_test.fdb',
        user: FLEET_USER,
        wireCrypt: 'required',
      };
    case 'duckdb-file':
      return { kind, storage: 'local', path: config.duckdbPath, format: 'duckdb' };
    case 'clickhouse':
      return {
        kind,
        host: '127.0.0.1',
        port: 18123,
        database: FLEET_DATABASE,
        user: FLEET_USER,
        secure: false,
      };
    case 'trino':
      return {
        kind,
        host: '127.0.0.1',
        port: 18081,
        catalog: 'riosoma_postgres',
        schema: 'public',
        user: FLEET_USER,
        auth: 'none',
        secure: false,
      };
    case 'druid':
      return { kind, host: '127.0.0.1', port: 18888, secure: false };
    case 'db2':
      return { kind, host: '127.0.0.1', port: 15000, database: 'riosoma', user: 'db2inst1', secure: false };
    case 'informix':
      return {
        kind,
        host: '127.0.0.1',
        port: 19089,
        database: FLEET_DATABASE,
        user: INFORMIX_USER,
        secure: false,
      };
    case 'bucket':
      return {
        kind,
        endpoint: 'http://127.0.0.1:19100',
        region: 'us-east-1',
        bucket: 'riosoma-test',
        prefix: 'contract/',
        pathStyle: true,
        format: 'csv',
      };
    case 'sftp':
      return {
        kind,
        host: '127.0.0.1',
        port: 12222,
        user: FLEET_USER,
        path: 'upload/*.csv',
        auth: 'password',
        hostKey: config.sftpHostKey,
        format: 'csv',
      };
    case 'ftp':
      return { kind, host: '127.0.0.1', port: 12121, user: FLEET_USER, path: '*.csv', format: 'csv' };
    case 'ftps':
      return { kind, host: '127.0.0.1', port: 12121, user: FLEET_USER, path: '*.csv', format: 'csv' };
    case 'webdav':
      return {
        kind,
        url: 'http://127.0.0.1:18090',
        path: '*.csv',
        auth: 'basic',
        user: FLEET_USER,
        format: 'csv',
      };
    case 'file-url':
      return { kind, url: `${config.httpBaseUrl}/file/items.csv`, format: 'csv' };
    case 'graphql':
      return {
        kind,
        baseUrl: `${config.httpBaseUrl}/graphql`,
        query:
          'query($after: String) { items(after: $after) { nodes { id name amount active day } pageInfo { hasNextPage endCursor } } }',
        records: 'data.items.nodes',
        paging: { style: 'cursor', pageInfo: 'data.items.pageInfo', variable: 'after' },
        requestsPerSecond: 100,
      };
    case 'odata':
      return { kind, baseUrl: `${config.httpBaseUrl}/odata`, requestsPerSecond: 100 };
    case 'rest':
      return {
        kind,
        baseUrl: config.httpBaseUrl,
        endpoints: [
          {
            name: 'items',
            path: '/rest/items',
            records: 'items',
            paging: {
              style: 'offset',
              offsetParam: 'offset',
              limitParam: 'limit',
              limit: 3,
              totalPath: 'total',
            },
          },
        ],
        requestsPerSecond: 100,
      };
    case 'feed':
      return { kind, url: `${config.httpBaseUrl}/feed/items.xml` };
    case 'mongodb':
      return {
        kind,
        address: 'host',
        host: '127.0.0.1',
        port: 17017,
        database: FLEET_DATABASE,
        user: FLEET_USER,
        authSource: 'admin',
        tls: { mode: 'off' },
      };
    case 'dynamodb':
      return { kind, endpoint: 'http://127.0.0.1:18000', region: 'us-east-1', segments: 1 };
    case 'couchdb':
      return { kind, endpoint: 'http://127.0.0.1:15984', user: FLEET_USER };
    case 'couchbase':
      return { kind, endpoint: 'http://127.0.0.1:18093', user: 'Administrator' };
    case 'cosmosdb':
      return { kind, endpoint: 'http://127.0.0.1:18082', database: FLEET_DATABASE, auth: 'master-key' };
    case 'elasticsearch':
      return { kind, endpoint: 'http://127.0.0.1:19200', auth: 'basic', user: 'elastic' };
    case 'opensearch':
      return { kind, endpoint: 'http://127.0.0.1:19201', auth: 'none' };
    case 'meilisearch':
      return { kind, endpoint: 'http://127.0.0.1:17700', auth: 'api-key' };
    case 'typesense':
      return { kind, endpoint: 'http://127.0.0.1:18108', auth: 'api-key' };
    case 'neo4j':
      return { kind, endpoint: 'http://127.0.0.1:17474', auth: 'basic', user: 'neo4j', database: 'neo4j' };
    case 'influxdb':
      return {
        kind,
        endpoint: 'http://127.0.0.1:18181',
        auth: 'none',
        version: '3',
        database: FLEET_DATABASE,
      };
    case 'prometheus':
      return {
        kind,
        endpoint: 'http://127.0.0.1:19090',
        auth: 'none',
        query: 'up',
        stepSeconds: 15,
        windowMinutes: 15,
      };
    default:
      throw new Error(`Unknown target connector kind: ${kind}`);
  }
}

function accountSettingsForKind(kind, options = {}) {
  const connection = connectionForKind(kind, options);
  switch (kind) {
    case 'duckdb-file':
      return { connection, object: { schema: 'main', name: 'contract_items' }, keyColumns: ['id'] };
    case 'clickhouse':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: FLEET_DATABASE, name: 'contract_items' },
        keyColumns: ['id'],
      };
    case 'trino':
      return { connection, object: { schema: 'public', name: 'contract_items' }, keyColumns: ['id'] };
    case 'druid':
      return { connection, object: { schema: null, name: 'contract_items' }, keyColumns: ['id'] };
    case 'db2':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: 'DB2INST1', name: 'CONTRACT_ITEMS' },
        keyColumns: ['ID'],
      };
    case 'informix':
      return {
        connection,
        secrets: { password: INFORMIX_PASSWORD },
        object: { schema: INFORMIX_USER, name: 'contract_items' },
        keyColumns: ['id'],
      };
    case 'bucket':
      return {
        connection,
        secrets: { accessKeyId: FLEET_USER, secretAccessKey: FLEET_PASSWORD },
        object: { schema: null, name: 'contract/items.csv' },
        keyColumns: ['id'],
      };
    case 'sftp':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: 'upload/items.csv' },
        keyColumns: ['id'],
      };
    case 'ftp':
    case 'ftps':
    case 'webdav':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: 'items.csv' },
        keyColumns: ['id'],
      };
    case 'file-url':
      return { connection, object: { schema: null, name: 'items.csv' }, keyColumns: ['id'] };
    case 'graphql':
      return { connection, object: { schema: null, name: 'query' }, keyColumns: ['id'] };
    case 'odata':
      return { connection, object: { schema: null, name: 'Items' }, keyColumns: ['id'] };
    case 'rest':
      return { connection, object: { schema: null, name: 'items' }, keyColumns: ['id'] };
    case 'feed':
      return { connection, object: { schema: null, name: 'items' }, keyColumns: ['id'] };
    case 'mongodb':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: 'contract_items' },
        keyColumns: ['_id'],
      };
    case 'dynamodb':
      return {
        connection,
        secrets: { accessKeyId: 'riosoma', secretAccessKey: FLEET_PASSWORD },
        object: { schema: null, name: 'contract_items' },
        keyColumns: ['pk', 'id'],
      };
    case 'couchdb':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: FLEET_DATABASE },
        keyColumns: ['_id'],
      };
    case 'couchbase':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: JSON.stringify([FLEET_DATABASE, '_default']), name: '_default' },
        keyColumns: ['_id'],
      };
    case 'cosmosdb':
      return {
        connection,
        secrets: { secretAccessKey: COSMOS_EMULATOR_KEY },
        object: { schema: null, name: 'contract_items' },
        keyColumns: ['id'],
      };
    case 'elasticsearch':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: 'contract_items' },
        keyColumns: ['_index', '_id'],
      };
    case 'opensearch':
      return { connection, object: { schema: null, name: 'contract_items' }, keyColumns: ['_index', '_id'] };
    case 'meilisearch':
    case 'typesense':
      return {
        connection,
        secrets: { apiKey: FLEET_PASSWORD },
        object: { schema: null, name: 'contract_items' },
        keyColumns: ['id'],
      };
    case 'neo4j':
      return {
        connection,
        secrets: { password: FLEET_PASSWORD },
        object: { schema: null, name: 'ContractItem' },
        keyColumns: ['_id'],
      };
    case 'influxdb':
      return { connection, object: { schema: null, name: 'contract_items' }, keyColumns: ['_timeKey'] };
    case 'prometheus':
      return { connection, object: { schema: null, name: 'query' }, keyColumns: ['_series', 'time'] };
    default:
      throw new Error(`No account settings for kind: ${kind}`);
  }
}

export function fleetSettingsEnv(kinds = TARGET_KINDS, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const env = {};
  for (const kind of kinds) {
    if (kind === 'postgres' || kind === 'webhook') continue;
    if (kind === 'mysql') {
      env.RIOSOMA_TEST_MYSQL_URL = `mysql://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:13306/${FLEET_DATABASE}`;
      continue;
    }
    if (kind === 'sqlserver') {
      env.RIOSOMA_TEST_MSSQL_URL = `mssql://sa:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:11433/master`;
      continue;
    }
    if (kind === 'oracle') {
      env.RIOSOMA_TEST_ORACLE_URL = `oracle://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:11521/FREEPDB1`;
      continue;
    }
    if (kind === 'firebird') {
      env.RIOSOMA_TEST_FIREBIRD_URL = `firebird://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:13050//var/lib/firebird/data/riosoma_test.fdb`;
      continue;
    }
    env[settingsEnvName(kind)] = JSON.stringify(accountSettingsForKind(kind, config));
    if (kind === 'db2' || kind === 'informix') env.RIOSOMA_DRIVERS_DIR = config.driversDir;
    if (kind === 'clickhouse') {
      env.RIOSOMA_TEST_CLICKHOUSE_URL = `http://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:18123/${FLEET_DATABASE}`;
    }
    if (kind === 'druid') env.RIOSOMA_TEST_DRUID_URL = 'http://127.0.0.1:18888';
    if (kind === 'mongodb') {
      env.RIOSOMA_TEST_MONGODB_URL = `mongodb://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:17017/?authSource=admin`;
    }
    if (kind === 'bucket') {
      env.RIOSOMA_TEST_MINIO_URL = 'http://127.0.0.1:19100';
      env.RIOSOMA_TEST_MINIO_ACCESS_KEY = FLEET_USER;
      env.RIOSOMA_TEST_MINIO_SECRET_KEY = FLEET_PASSWORD;
    }
  }
  return env;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const kinds = args.length ? args : TARGET_KINDS;
  const options = {};
  if (process.env.RIOSOMA_FIXTURE_URL) options.httpBaseUrl = process.env.RIOSOMA_FIXTURE_URL;
  if (process.env.RIOSOMA_DUCKDB_FILE) options.duckdbPath = process.env.RIOSOMA_DUCKDB_FILE;
  if (process.env.RIOSOMA_DRIVERS_DIR) options.driversDir = process.env.RIOSOMA_DRIVERS_DIR;
  if (process.env.RIOSOMA_SFTP_HOST_KEY) options.sftpHostKey = process.env.RIOSOMA_SFTP_HOST_KEY;
  const env = fleetSettingsEnv(kinds, options);
  for (const [name, value] of Object.entries(env))
    process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
}

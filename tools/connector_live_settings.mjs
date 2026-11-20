import { SourceConnection, SourceSecrets, sharePointSiteOf, dataverseEnvironmentOf } from '../packages/contracts/dist/index.js'
import { SHIPPED_CONNECTORS } from '../packages/connectors/dist/index.js'

const prefix = (kind) => `RIOSOMA_TEST_${kind.toUpperCase().replaceAll('-', '_')}_`
const legacy = {
  postgres: ['RIOSOMA_TEST_DATABASE_URL'],
  mysql: ['RIOSOMA_TEST_MYSQL_URL'],
  sqlserver: ['RIOSOMA_TEST_MSSQL_URL'],
  oracle: ['RIOSOMA_TEST_ORACLE_URL'],
  firebird: ['RIOSOMA_TEST_FIREBIRD_URL'],
  mongodb: ['RIOSOMA_TEST_MONGODB_URL'],
  snowflake: ['RIOSOMA_TEST_SNOWFLAKE_ACCOUNT'],
  bigquery: ['RIOSOMA_TEST_BIGQUERY_PROJECT', 'RIOSOMA_TEST_BIGQUERY_CREDENTIALS'],
  databricks: ['RIOSOMA_TEST_DATABRICKS_HOST', 'RIOSOMA_TEST_DATABRICKS_HTTP_PATH', 'RIOSOMA_TEST_DATABRICKS_TOKEN'],
  motherduck: ['RIOSOMA_TEST_MOTHERDUCK_DATABASE', 'RIOSOMA_TEST_MOTHERDUCK_TOKEN'],
  redshift: ['RIOSOMA_TEST_REDSHIFT_HOST'],
  athena: ['RIOSOMA_TEST_ATHENA_REGION', 'RIOSOMA_TEST_ATHENA_DATABASE'],
  clickhouse: ['RIOSOMA_TEST_CLICKHOUSE_URL'],
  trino: ['RIOSOMA_TEST_TRINO_URL'],
  druid: ['RIOSOMA_TEST_DRUID_URL'],
  teradata: ['RIOSOMA_TERADATA_HOST', 'RIOSOMA_TERADATA_USER', 'RIOSOMA_TERADATA_PASSWORD'],
  db2: ['RIOSOMA_DB2_HOST', 'RIOSOMA_DB2_DATABASE', 'RIOSOMA_DB2_USER', 'RIOSOMA_DB2_PASSWORD'],
  informix: ['RIOSOMA_INFORMIX_HOST', 'RIOSOMA_INFORMIX_DATABASE', 'RIOSOMA_INFORMIX_USER', 'RIOSOMA_INFORMIX_PASSWORD'],
  bucket: ['RIOSOMA_TEST_MINIO_URL'],
  'google-sheets': ['RIOSOMA_TEST_GOOGLE_SA_KEY', 'RIOSOMA_TEST_GOOGLE_SHEET_ID'],
  airtable: ['RIOSOMA_TEST_AIRTABLE_TOKEN', 'RIOSOMA_TEST_AIRTABLE_BASE'],
  'sharepoint-list': ['RIOSOMA_TEST_M365_TENANT_ID', 'RIOSOMA_TEST_M365_CLIENT_ID', 'RIOSOMA_TEST_M365_CLIENT_SECRET', 'RIOSOMA_TEST_SHAREPOINT_SITE'],
  'excel-online': ['RIOSOMA_TEST_M365_TENANT_ID', 'RIOSOMA_TEST_M365_CLIENT_ID', 'RIOSOMA_TEST_M365_CLIENT_SECRET', 'RIOSOMA_TEST_SHAREPOINT_SITE'],
  dataverse: ['RIOSOMA_TEST_M365_TENANT_ID', 'RIOSOMA_TEST_M365_CLIENT_ID', 'RIOSOMA_TEST_M365_CLIENT_SECRET', 'RIOSOMA_TEST_DATAVERSE_URL'],
}

export const LIVE_CONNECTOR_SETTINGS = Object.fromEntries(SHIPPED_CONNECTORS.map((kind) => [kind, {
  json: `${prefix(kind)}SETTINGS`, required: legacy[kind] ?? [],
}]))

/** Uses the account suites' setting names and the existing serialized fleet settings */
export function liveSettings(kind, env = process.env) {
  const descriptor = LIVE_CONNECTOR_SETTINGS[kind]
  if (!descriptor) throw new Error('sources.contract.unknownConnector')
  const raw = env[descriptor.json]
  if (raw) {
    const settings = JSON.parse(raw)
    const connection = SourceConnection.parse(settings.connection)
    if (connection.kind !== kind) throw new Error('sources.contract.kindMismatch')
    return { ...settings, context: { connection, secrets: SourceSecrets.parse(settings.secrets ?? {}),
      timeoutMs: 30000, driversDir: env.RIOSOMA_DRIVERS_DIR, sourceId: settings.sourceId } }
  }
  if (!descriptor.required.length || !descriptor.required.every((key) => env[key])) return undefined
  const value = (key) => env[`${prefix(kind)}${key}`] || undefined
  const connection = { kind }
  const secrets = {}
  let object
  let keyColumns
  if (['clickhouse', 'trino', 'druid', 'mongodb'].includes(kind)) {
    const url = new URL(value('URL'))
    Object.assign(connection, { host: url.hostname, port: Number(url.port || (kind === 'mongodb' ? 27017 : url.protocol === 'https:' ? 443 : 80)),
      user: decodeURIComponent(url.username), secure: url.protocol === 'https:', database: decodeURIComponent(url.pathname.slice(1)) || 'default' })
    secrets.password = decodeURIComponent(url.password)
    if (kind === 'trino') Object.assign(connection, { catalog: connection.database, schema: 'public', auth: secrets.password ? 'password' : 'none' })
    if (kind === 'mongodb') Object.assign(connection, { address: 'connection-string', connectionString: url.href })
  } else if (kind === 'snowflake') {
    Object.assign(connection, { account: value('ACCOUNT'), user: value('USER'), warehouse: value('WAREHOUSE'), database: value('DATABASE'),
      schema: value('SCHEMA') ?? 'PUBLIC', role: value('ROLE'), auth: value('PRIVATE_KEY') ? 'key-pair' : 'password' })
    Object.assign(secrets, { password: value('PASSWORD'), privateKeyPem: value('PRIVATE_KEY'), privateKeyPassphrase: value('PRIVATE_KEY_PASSPHRASE') })
  } else if (kind === 'bigquery') {
    Object.assign(connection, { projectId: value('PROJECT'), dataset: value('DATASET'), location: value('LOCATION') })
    secrets.serviceAccountJson = value('CREDENTIALS')
  } else if (kind === 'databricks') {
    Object.assign(connection, { host: value('HOST'), httpPath: value('HTTP_PATH'), catalog: value('CATALOG'), schema: value('SCHEMA') ?? 'default' })
    secrets.token = value('TOKEN')
  } else if (kind === 'motherduck') {
    connection.database = value('DATABASE')
    secrets.token = value('TOKEN')
  } else if (kind === 'redshift' || kind === 'athena') {
    Object.assign(connection, { host: value('HOST'), port: Number(value('PORT') ?? 5439), database: value('DATABASE'), region: value('REGION'),
      user: value('USER'), auth: value('PASSWORD') ? 'password' : 'iam', deployment: value('WORKGROUP') ? 'serverless' : 'provisioned',
      workgroup: value('WORKGROUP'), clusterIdentifier: value('CLUSTER_IDENTIFIER'), catalog: value('CATALOG') ?? 'AwsDataCatalog',
      resultsLocation: value('RESULTS_LOCATION'), maxScannedBytes: Number(value('MAX_SCANNED_BYTES') ?? 1000000000) })
    Object.assign(secrets, { password: value('PASSWORD'), accessKeyId: value('ACCESS_KEY_ID'), secretAccessKey: value('SECRET_ACCESS_KEY'), sessionToken: value('SESSION_TOKEN') })
    object = { schema: value('SCHEMA') ?? (kind === 'redshift' ? 'public' : value('DATABASE')), name: value('TABLE') }
    keyColumns = [value('KEY_COLUMN')]
  } else if (['teradata', 'db2', 'informix'].includes(kind)) {
    const get = (key) => env[`RIOSOMA_${kind.toUpperCase()}_${key}`]
    Object.assign(connection, { host: get('HOST'), port: get('PORT') ? Number(get('PORT')) : undefined,
      database: get('DATABASE'), user: get('USER'), server: get('SERVER'), secure: get('TLS') === 'on' })
    secrets.password = get('PASSWORD')
  } else if (kind === 'google-sheets') {
    connection.spreadsheets = [env.RIOSOMA_TEST_GOOGLE_SHEET_ID.match(/\/d\/([^/]+)/)?.[1] ?? env.RIOSOMA_TEST_GOOGLE_SHEET_ID]
    secrets.serviceAccountJson = env.RIOSOMA_TEST_GOOGLE_SA_KEY
  } else if (kind === 'airtable') {
    connection.bases = [env.RIOSOMA_TEST_AIRTABLE_BASE]
    secrets.token = env.RIOSOMA_TEST_AIRTABLE_TOKEN
    if (env.RIOSOMA_TEST_AIRTABLE_TABLE) object = { schema: env.RIOSOMA_TEST_AIRTABLE_BASE, name: env.RIOSOMA_TEST_AIRTABLE_TABLE }
  } else if (['sharepoint-list', 'excel-online', 'dataverse'].includes(kind)) {
    Object.assign(connection, { tenantId: env.RIOSOMA_TEST_M365_TENANT_ID, clientId: env.RIOSOMA_TEST_M365_CLIENT_ID,
      sites: [sharePointSiteOf(env.RIOSOMA_TEST_SHAREPOINT_SITE) ?? env.RIOSOMA_TEST_SHAREPOINT_SITE], workbooks: env.RIOSOMA_TEST_EXCEL_WORKBOOK ? [env.RIOSOMA_TEST_EXCEL_WORKBOOK] : [],
      environmentUrl: env.RIOSOMA_TEST_DATAVERSE_URL ? dataverseEnvironmentOf(env.RIOSOMA_TEST_DATAVERSE_URL) : undefined })
    secrets.clientSecret = env.RIOSOMA_TEST_M365_CLIENT_SECRET
  } else if (kind === 'bucket') {
    Object.assign(connection, { endpoint: env.RIOSOMA_TEST_MINIO_URL, bucket: env.RIOSOMA_TEST_MINIO_BUCKET ?? 'connector-contract', region: 'us-east-1', format: 'csv' })
    secrets.accessKeyId = env.RIOSOMA_TEST_MINIO_ACCESS_KEY ?? ['minio', 'admin'].join('')
    secrets.secretAccessKey = env.RIOSOMA_TEST_MINIO_SECRET_KEY ?? ['minio', 'admin'].join('')
  } else {
    // The relational adapters own their isolated databases and seeded tables.
    return undefined
  }
  const discoverWorkbooks = kind === 'excel-online' && !connection.workbooks.length
  return { discoverWorkbooks, object: object?.name ? object : undefined, keyColumns: keyColumns?.filter(Boolean),
    context: { connection: SourceConnection.parse(discoverWorkbooks ? { ...connection, kind: 'sharepoint-list' } : connection), secrets: SourceSecrets.parse(Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== undefined))), timeoutMs: 30000, driversDir: env.RIOSOMA_DRIVERS_DIR } }
}

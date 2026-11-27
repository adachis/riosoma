import { SourceConnection, workbookAddressOf } from '../packages/contracts/dist/index.js'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { lookup } from 'node:dns/promises'
import * as connectors from '../packages/connectors/dist/index.js'
import { accountVersion } from './connector_live_version.mjs'
import { webhookAdapter } from './connector_live_webhook.mjs'
import { liveSettings, LIVE_CONNECTOR_SETTINGS } from './connector_live_settings.mjs'

const requireDriver = createRequire(new URL('../packages/connectors/package.json', import.meta.url))
const requireWarehouseDriver = createRequire(new URL('../packages/connector-drivers/package.json', import.meta.url))
const relational = new Set(['postgres', 'mysql', 'sqlserver', 'oracle', 'firebird'])
// Each kind names its package, module, and factory.  The driver-based warehouses moved to connector-drivers.
export const warehouseModules = {
  snowflake: ['connector-drivers', 'snowflake', 'createSnowflakeConnector'],
  bigquery: ['connector-drivers', 'bigquery', 'createBigQueryConnector'],
  databricks: ['connector-drivers', 'databricks', 'createDatabricksConnector'],
  clickhouse: ['connector-drivers', 'clickhouse', 'createClickHouseConnector'],
  trino: ['connectors', 'trino', 'createTrinoConnector'], druid: ['connectors', 'druid', 'createDruidConnector'],
  redshift: ['connectors', 'redshift', 'createRedshiftConnector'], athena: ['connectors', 'athena', 'createAthenaConnector'],
  motherduck: ['connectors', 'motherduck', 'createMotherDuckConnector'],
  'duckdb-file': ['connectors', 'duckdb-file', 'createDuckDbFileConnector'],
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
/** Adding, filling, and deleting the runner's own tab needs more than a source ever asks for. */
const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

/**
 * A tab of typed rows for the contract to read, in a spreadsheet whose first tab may be empty.
 * Setup and cleanup use the raw fetch and a write token, so the connector's boundary never counts
 * them and the connector itself keeps reading with its own read-only scope.  Failures carry only
 * message keys, never the token or a Google answer body.
 */
export async function createSheetsFixture({ fetch, token, spreadsheetId, randomId }) {
  const title = `riosoma-contract-${randomId ?? randomBytes(4).toString('hex')}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const batchUpdate = async (requests) => {
    const response = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers, body: JSON.stringify({ requests }),
    })
    connectors.invariant(response.ok, 'live.sheetsFixture')
    return response.json()
  }
  let sheetId
  const remove = async () => {
    if (sheetId === undefined) return
    await batchUpdate([{ deleteSheet: { sheetId } }])
    sheetId = undefined
  }
  try {
    // The tab goes first, since a connection test reads the first sheet's header.
    const added = await batchUpdate([{ addSheet: { properties: { title, index: 0,
      gridProperties: { rowCount: 50, columnCount: 6 } } } }])
    sheetId = added.replies[0].addSheet.properties.sheetId
    const range = `'${title}'!A1`
    const response = await fetch(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers,
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [
        ['id', 'name', 'amount', 'active', 'day'],
        [1, 'Alpha', 12.5, true, '2026-01-15'],
        [2, 'Bravo', 3.75, false, '2026-01-16'],
        [3, 'Charlie', 40, true, '2026-01-17'],
        [4, 'Delta', 8.25, false, '2026-01-18'],
        [5, 'Echo', 19.99, true, '2026-01-19'],
      ] }),
    })
    connectors.invariant(response.ok, 'live.sheetsFixture')
    return { title, remove }
  } catch (error) {
    // The tab exists once addSheet answered, so every later failure still takes it down.
    try { await remove() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'live.sheetsFixture')
    }
    throw error
  }
}

/**
 * A table of typed rows in the connection's dataset, which the account suites leave empty between
 * runs.  The admin client is separate from the connector and never crosses its boundary.  Names
 * come from settings and go into SQL, so only plain identifier characters are accepted.  Failures
 * carry only message keys, never the key or a BigQuery error body.
 */
export async function createBigQueryFixture({ client, projectId, dataset, randomId }) {
  connectors.invariant(typeof projectId === 'string' && /^[A-Za-z0-9_-]+$/.test(projectId), 'live.bigqueryFixture')
  connectors.invariant(typeof dataset === 'string' && /^[A-Za-z0-9_]+$/.test(dataset), 'live.bigqueryFixture')
  const table = `riosoma_contract_${randomId ?? randomBytes(4).toString('hex')}`
  const qualified = `\`${projectId}\`.\`${dataset}\`.\`${table}\``
  const query = async (sql) => {
    try { await client.query(sql) } catch { throw new connectors.ContractViolation('live.bigqueryFixture') }
  }
  let created = false
  const remove = async () => {
    if (!created) return
    await query(`DROP TABLE IF EXISTS ${qualified}`)
    created = false
  }
  try {
    await query(`CREATE TABLE ${qualified} (id INT64, name STRING, amount NUMERIC, active BOOL, day DATE)`)
    // The table exists once CREATE answered, so every later failure still takes it down.
    created = true
    await query(`INSERT INTO ${qualified} (id, name, amount, active, day) VALUES
      (1, 'Alpha', NUMERIC '12.5', TRUE, DATE '2026-01-15'),
      (2, 'Bravo', NUMERIC '3.75', FALSE, DATE '2026-01-16'),
      (3, 'Charlie', NUMERIC '40', TRUE, DATE '2026-01-17'),
      (4, 'Delta', NUMERIC '8.25', FALSE, DATE '2026-01-18'),
      (5, 'Echo', NUMERIC '19.99', TRUE, DATE '2026-01-19')`)
    return { table, remove }
  } catch (error) {
    try { await remove() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'live.bigqueryFixture')
    }
    throw error
  }
}

function patchMethods(target, methods, boundary, restores) {
  for (const method of methods) {
    const original = target[method]
    if (typeof original !== 'function') continue
    target[method] = function (...args) {
      return boundary.wrap({ [method]: (...values) => Reflect.apply(original, this, values) })[method](...args)
    }
    restores.push(() => { target[method] = original })
  }
}

/** The configured service remains the data source while diagnostic probes stall its actual transport */
export async function accountAdapter(kind, settings) {
  if (kind === 'webhook') return webhookAdapter()
  const boundary = new connectors.ContractTransport()
  boundary.context = settings.context
  const restores = []
  const cleanup = async () => {
    boundary.reset()
    let failure
    // Each restore may be async (a fixture tab deletion).  One failure never skips the rest,
    // and the first failure still throws so the runner records it as live.cleanup.
    for (const restore of restores.splice(0).reverse()) {
      try { await restore() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }
  try {
    const files = await import('../apps/server/dist/sources/files.js')
    const versionHeaders = new Map()
    const capture = (response) => {
      const headers = response.headers instanceof Headers ? response.headers.entries() : Object.entries(response.headers ?? {})
      for (const [name, value] of headers) if (value) versionHeaders.set(name.toLowerCase(), String(value))
      return response
    }
    const nativeNetwork = files.fileNetwork({
      resolve: (host) => lookup(host, { all: true }), allowPrivate: () => true,
    })
    const request = nativeNetwork.request.bind(nativeNetwork)
    nativeNetwork.request = async (...args) => capture(await request(...args))
    const network = boundary.wrap(nativeNetwork)
    const { nodeNetwork } = await import('../packages/connectors/dist/warehouses/frame.js')
    const diagnostics = boundary.wrap({ ...nodeNetwork, proxied: () => false })
    const options = { network, sockets: boundary.wrap(connectors.nodeSockets), spreadsheet: files.spreadsheetReader,
      observeDriver: (driver) => boundary.wrap(driver), fetch: boundary.wrap(async (...args) => capture(await globalThis.fetch(...args)), 'fetch') }
    if (kind === 'excel-online' && settings.discoverWorkbooks) {
      const { MicrosoftCall, microsoftConfig, GRAPH_API_URL } = await import('../packages/connectors/dist/microsoft/client.js')
      const { findSite, graphAddress } = await import('../packages/connectors/dist/microsoft/graph.js')
      const ctx = settings.context
      const call = new MicrosoftCall(microsoftConfig(options), ctx, ctx.connection, GRAPH_API_URL, 30000)
      const site = await findSite(call, GRAPH_API_URL, ctx.connection.sites[0], 'sources.excel.denied', 'sources.excel.site')
      // Graph gives an Office file's webUrl as an Excel for the web link, which isn't a workbook's address, so the
      // address is the library's own plus the file's name.
      const library = await call.get(graphAddress(GRAPH_API_URL, `/sites/${site.id}/drive`, { $select: 'webUrl' }))
      connectors.invariant(library.status === 200, 'live.workbooks')
      const libraryUrl = call.json(library).webUrl
      const answer = await call.get(graphAddress(GRAPH_API_URL, `/sites/${site.id}/drive/root/children`, { $select: 'file,name' }))
      connectors.invariant(answer.status === 200, 'live.workbooks')
      const books = call.json(answer).value.filter((item) => item.file && /\.xlsx$/i.test(item.name))
        .map((item) => workbookAddressOf(`${libraryUrl}/${encodeURIComponent(item.name)}`)).filter(Boolean).slice(0, 20)
      connectors.invariant(books.length, 'live.workbooks')
      ctx.connection = SourceConnection.parse({ ...ctx.connection, kind: 'excel-online', workbooks: books })
    }
    let connector
    if (warehouseModules[kind]) {
      const [packageDir, module, factory] = warehouseModules[kind]
      const exports = await import(`../packages/${packageDir}/dist/warehouses/${module}.js`)
      const warehouseOptions = { network: diagnostics, observeDriver: options.observeDriver, fetch: options.fetch }
      if (kind === 'motherduck') warehouseOptions.openInstance = boundary.wrap((path) =>
        requireDriver('@duckdb/node-api').DuckDBInstance.create(path), 'openInstance')
      if (kind === 'duckdb-file') {
        Object.assign(warehouseOptions, { network, allowedRoots: settings.allowedRoots ??
          (settings.context.connection.path ? [dirname(settings.context.connection.path)] : []) })
        patchMethods(requireDriver('@duckdb/node-api').DuckDBConnection.prototype,
          ['prepare', 'run', 'runAndReadAll', 'streamAndReadAll', 'disconnectSync'], boundary, restores)
      }
      if (kind === 'redshift') {
        const pg = requireDriver('pg')
        warehouseOptions.client = boundary.wrap((config) => new pg.Client(config), 'client')
      }
      connector = exports[factory](warehouseOptions)
    } else if (['file-url', 'bucket', 'sftp', 'ftp', 'ftps', 'webdav'].includes(kind)) {
      const { remoteTransport } = await import('../packages/connectors/dist/files/remote.js')
      connector = connectors.createFileConnector(kind, { ...options,
        ...(['sftp', 'ftp', 'ftps', 'webdav'].includes(kind)
          ? { transport: boundary.wrap(remoteTransport(network, () => true)) } : {}) })
    } else if (kind === 'mongodb') {
      const { createMongoConnector } = await import('../packages/connector-drivers/dist/index.js')
      patchMethods(requireWarehouseDriver('mongodb').MongoClient.prototype, ['connect', 'db', 'close'], boundary, restores)
      connector = createMongoConnector()
    } else if (kind === 'google-sheets') connector = connectors.createGoogleSheetsConnector(options)
    else if (kind === 'sharepoint-list') connector = connectors.createSharePointListConnector(options)
    else if (kind === 'excel-online') connector = connectors.createExcelOnlineConnector(options)
    else if (kind === 'dataverse') connector = connectors.createDataverseConnector(options)
    else if (kind === 'airtable') {
      const { createAirtableSourceConnector } = await import('../apps/server/dist/sources/airtable.js')
      connector = createAirtableSourceConnector(options)
    } else if (kind === 'graphql') connector = connectors.createGraphQlConnector(options)
    else if (kind === 'odata') connector = connectors.createODataConnector(options)
    else if (kind === 'rest') connector = connectors.createRestConnector(options)
    else if (kind === 'feed') connector = connectors.createFeedConnector(options)
    else if (['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb'].includes(kind))
      connector = connectors.createNoSqlConnector(kind, { fetch: options.fetch })
    else if (['elasticsearch', 'opensearch', 'meilisearch', 'typesense', 'neo4j', 'influxdb', 'prometheus'].includes(kind))
      connector = connectors.createHttpEngineConnector(kind, { fetch: options.fetch, network: diagnostics })
    else if (['teradata', 'db2', 'informix'].includes(kind)) {
      const processes = requireDriver('node:child_process')
      const fork = processes.fork
      processes.fork = (...args) => boundary.wrap(fork(...args))
      syncBuiltinESMExports()
      restores.push(() => { processes.fork = fork; syncBuiltinESMExports() })
      connector = connectors.connectorFor(kind)
    } else throw new connectors.ContractViolation('live.connectorAdapter')
    const context = settings.context
    let fixture
    if (kind === 'google-sheets' && !settings.object) {
      // The shared spreadsheet's first tab may be empty, so the contract reads a tab of its own.
      const key = connectors.readServiceAccountKey(context.secrets.serviceAccountJson)
      connectors.invariant(key, 'live.sheetsFixture')
      const assertion = connectors.serviceAccountAssertion(key, SHEETS_WRITE_SCOPE,
        connectors.GOOGLE_TOKEN_URL, Math.floor(Date.now() / 1000))
      const answer = await globalThis.fetch(connectors.GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      })
      connectors.invariant(answer.ok, 'live.sheetsFixture')
      const token = (await answer.json()).access_token
      connectors.invariant(typeof token === 'string' && token.length > 0, 'live.sheetsFixture')
      fixture = await createSheetsFixture({ fetch: globalThis.fetch, token,
        spreadsheetId: context.connection.spreadsheets[0], randomId: randomBytes(4).toString('hex') })
      restores.push(() => fixture.remove())
    } else if (kind === 'bigquery' && !settings.object) {
      // The test dataset has no tables between runs, so the contract reads a table of its own.
      const { credentialsOf } = await import('../packages/connector-drivers/dist/warehouses/bigquery.js')
      const { BigQuery } = requireWarehouseDriver('@google-cloud/bigquery')
      const connection = context.connection
      const admin = new BigQuery({ projectId: connection.projectId,
        credentials: credentialsOf(context.secrets.serviceAccountJson),
        ...(connection.location ? { location: connection.location } : {}) })
      fixture = await createBigQueryFixture({ client: admin, projectId: connection.projectId,
        dataset: connection.dataset, randomId: randomBytes(4).toString('hex') })
      restores.push(() => fixture.remove())
    }
    const objects = await connector.listObjects(context)
    // A sheet object's name is its numeric sheet ID, and its label is the tab title.
    const object = fixture
      ? (kind === 'bigquery'
        ? objects.find((entry) => entry.schema === context.connection.dataset && entry.name === fixture.table)
        : objects.find((entry) => entry.label === fixture.title))
      : settings.object ?? objects.find((object) => object.rowEstimate > 1 && object.rowEstimate <= 1000) ?? objects[0]
    connectors.invariant(object, 'live.object')
    const select = { kind: 'object', object }
    const preview = await connector.preview(context, select, 1001)
    const caps = connectors.declaredCapabilities(kind)
    connectors.invariant(!caps.read || preview.rows.length > 1 && preview.rows.length <= 1000, 'live.fixtureSize')
    const columns = preview.columns.filter((column) => column.suggested)
    const keys = await connector.keyCandidates(context, object)
    const keyColumns = fixture ? ['id']
      : settings.keyColumns?.length ? settings.keyColumns : keys[0] ?? columns.map((column) => column.name)
    const index = (name) => preview.columns.findIndex((column) => column.name === name)
    const adapter = connectors.contractAdapter({
      connector, context, select, columns, keys,
      read: { columns: columns.map((column) => column.name), keyColumns, batchSize: 1,
        types: Object.fromEntries(columns.map((column) => [column.name, column.suggested.type])) },
      expectedRows: preview.rows.map((row) => ({ key: JSON.stringify(keyColumns.map((name) => row[index(name)])),
        values: Object.fromEntries(columns.map((column) => [column.name, row[index(column.name)] ?? null])) })),
      requests: () => boundary.requests,
      failure: async (ctx) => {
        boundary.mode = 'failure'
        try { return await connector.preview(ctx, select, 1) } finally { boundary.reset() }
      },
      timeout: async (ctx) => {
        boundary.mode = 'slow'
        boundary.stopped = false
        try {
          if (['mongodb', 'redshift', 'athena', 'teradata', 'db2', 'informix', 'duckdb-file'].includes(kind))
            return await connector.preview(ctx, select, 1)
          const test = await connector.test(ctx)
          connectors.invariant(!test.ok, 'timeout.expectedFailure')
          const failed = test.steps.find((step) => step.status === 'failed')
          connectors.invariant(failed?.messageKey, 'timeout.classification')
          throw new connectors.ConnectorError(failed.messageKey, failed.detail)
        } finally { boundary.mode = 'normal' }
      },
      stopped: async () => {
        const until = Date.now() + 1000
        while (!boundary.stopped && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
        return boundary.stopped
      },
    })
    return { ...adapter, cleanup, serverVersion: () => accountVersion(kind, context, options, boundary.requests, versionHeaders) }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function accountContracts(env = process.env) {
  return Object.keys(LIVE_CONNECTOR_SETTINGS).filter((kind) => !relational.has(kind)).flatMap((kind) => {
    const descriptor = LIVE_CONNECTOR_SETTINGS[kind]
    if (kind === 'webhook') return [{ connector: { kind }, prepare: webhookAdapter }]
    if (!env[descriptor.json] && (!descriptor.required.length || !descriptor.required.every((key) => env[key]))) return []
    return [{ connector: { kind }, prepare: async () => accountAdapter(kind, liveSettings(kind, env)) }]
  })
}

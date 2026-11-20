import { SourceConnection, workbookAddressOf } from '../packages/contracts/dist/index.js'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'
import { lookup } from 'node:dns/promises'
import * as connectors from '../packages/connectors/dist/index.js'
import { accountVersion } from './connector_live_version.mjs'
import { webhookAdapter } from './connector_live_webhook.mjs'
import { liveSettings, LIVE_CONNECTOR_SETTINGS } from './connector_live_settings.mjs'

const requireDriver = createRequire(new URL('../packages/connectors/package.json', import.meta.url))
const relational = new Set(['postgres', 'mysql', 'sqlserver', 'oracle', 'firebird'])
const warehouseModules = {
  snowflake: ['snowflake', 'createSnowflakeConnector'], bigquery: ['bigquery', 'createBigQueryConnector'],
  databricks: ['databricks', 'createDatabricksConnector'], clickhouse: ['clickhouse', 'createClickHouseConnector'],
  trino: ['trino', 'createTrinoConnector'], druid: ['druid', 'createDruidConnector'],
  redshift: ['redshift', 'createRedshiftConnector'], athena: ['athena', 'createAthenaConnector'],
  motherduck: ['motherduck', 'createMotherDuckConnector'], 'duckdb-file': ['duckdb-file', 'createDuckDbFileConnector'],
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
    for (const restore of restores.reverse()) restore()
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
      const answer = await call.get(graphAddress(GRAPH_API_URL, `/sites/${site.id}/drive/root/children`, { $select: 'webUrl,file,name' }))
      connectors.invariant(answer.status === 200, 'live.workbooks')
      const books = call.json(answer).value.filter((item) => item.file && /\.xlsx$/i.test(item.name))
        .map((item) => workbookAddressOf(item.webUrl)).filter(Boolean).slice(0, 20)
      connectors.invariant(books.length, 'live.workbooks')
      ctx.connection = SourceConnection.parse({ ...ctx.connection, kind: 'excel-online', workbooks: books })
    }
    let connector
    if (warehouseModules[kind]) {
      const [module, factory] = warehouseModules[kind]
      const exports = await import(`../packages/connectors/dist/warehouses/${module}.js`)
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
      patchMethods(requireDriver('mongodb').MongoClient.prototype, ['connect', 'db', 'close'], boundary, restores)
      connector = connectors.createMongoConnector()
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
    const objects = await connector.listObjects(context)
    const object = settings.object ?? objects.find((object) => object.rowEstimate > 1 && object.rowEstimate <= 1000) ?? objects[0]
    connectors.invariant(object, 'live.object')
    const select = { kind: 'object', object }
    const preview = await connector.preview(context, select, 1001)
    const caps = connectors.declaredCapabilities(kind)
    connectors.invariant(!caps.read || preview.rows.length > 1 && preview.rows.length <= 1000, 'live.fixtureSize')
    const columns = preview.columns.filter((column) => column.suggested)
    const keys = await connector.keyCandidates(context, object)
    const keyColumns = settings.keyColumns?.length ? settings.keyColumns : keys[0] ?? columns.map((column) => column.name)
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

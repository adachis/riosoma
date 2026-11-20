import { createConnection } from 'node:net'
import { invariant } from '../packages/connectors/dist/index.js'

/** Uses actual version responses or a versioned service API observed during the contract */
export async function accountVersion(kind, context, options, requests, headers) {
  if (['sftp', 'ftp', 'ftps'].includes(kind)) {
    const port = context.connection.port ?? (kind === 'sftp' ? 22 : 21)
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ host: context.connection.host, port })
      let text = ''
      const finish = (error, banner) => {
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(banner)
      }
      const timer = setTimeout(() => finish(new Error('sources.contract.versionTimeout')), 3000)
      socket.once('error', (error) => finish(error))
      socket.on('data', (bytes) => {
        text += bytes.toString('utf8')
        const banner = text.split(/\r?\n/).find((line) => kind === 'sftp' ? line.startsWith('SSH-') : line.startsWith('220'))
        if (banner) finish(undefined, banner.slice(0, 300))
        else if (text.length > 8192) finish(new Error('sources.contract.versionResponse'))
      })
      socket.once('end', () => { if (!socket.destroyed) finish(new Error('sources.contract.versionResponse')) })
    })
  }
  if (['elasticsearch', 'opensearch', 'meilisearch', 'typesense', 'neo4j', 'influxdb', 'prometheus'].includes(kind)) {
    const { EngineHttp } = await import('../packages/connectors/dist/http-engines/http.js')
    const http = new EngineHttp(context, options)
    try {
      let version
      if (kind === 'elasticsearch' || kind === 'opensearch') version = (await http.json('/')).version?.number
      else if (kind === 'meilisearch') version = (await http.json('/version')).pkgVersion
      else if (kind === 'typesense') version = (await http.json('/debug')).version
      else if (kind === 'prometheus') version = (await http.json('/api/v1/status/buildinfo')).data?.version
      else if (kind === 'influxdb') version = (await http.json('/health')).version
      else {
        const { GraphMetricsSession } = await import('../packages/connectors/dist/http-engines/graph-metrics.js')
        const rows = await new GraphMetricsSession(http).cypher('CALL dbms.components() YIELD versions RETURN versions')
        version = rows[0]?.versions?.join(', ')
      }
      invariant(typeof version === 'string' && version.length, 'live.serverVersion')
      return `${kind} ${version}`
    } finally { await http.close() }
  }
  if (kind === 'couchdb' || kind === 'couchbase') {
    const { client, endpoint } = await import('../packages/connectors/dist/nosql/http.js')
    const http = client(context, options)
    const authorization = `Basic ${Buffer.from(`${context.connection.user}:${context.secrets.password}`).toString('base64')}`
    const url = endpoint(context.connection)
    const { data } = await http(`${url}${kind === 'couchdb' ? '/' : '/query/service'}`, {
      headers: { authorization, 'content-type': 'application/json' },
      ...(kind === 'couchbase' ? { method: 'POST', body: JSON.stringify({ statement: 'SELECT VERSION() AS version', readonly: true }) } : {}),
    })
    const version = kind === 'couchdb' ? data.version : data.results?.[0]?.version
    invariant(typeof version === 'string' && version.length, 'live.serverVersion')
    return `${kind} ${version}`
  }
  const protocols = {
    'google-sheets': ['/v4/spreadsheets', 'Google Sheets API v4'],
    airtable: ['/v0/', 'Airtable API v0'],
    'sharepoint-list': ['/v1.0/', 'Microsoft Graph API v1.0'],
    'excel-online': ['/v1.0/', 'Microsoft Graph API v1.0'],
    dataverse: ['/api/data/v9.2', 'Dataverse API v9.2'],
    dynamodb: ['DynamoDB_20120810', 'DynamoDB API 2012-08-10'],
    firestore: ['/v1/projects/', 'Firestore API v1'],
    cosmosdb: ['2018-12-31', 'Cosmos DB API 2018-12-31'],
  }
  const protocol = protocols[kind]
  if (protocol && requests.some((request) => request.includes(protocol[0]))) return protocol[1]
  return headers.get('odata-version') ?? headers.get('x-influxdb-version') ?? headers.get('server')
}

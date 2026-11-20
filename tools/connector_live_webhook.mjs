import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SourceConnection } from '../packages/contracts/dist/index.js'
import { contractAdapter, invariant } from '../packages/connectors/dist/index.js'
import { startTestPostgres } from '../packages/testkit/dist/index.js'
import { startServer } from '../apps/server/dist/test/fixture.js'
import { createWebhookConnector } from '../apps/server/dist/sources/webhook.js'

/** Posts use the public inbound route after an authorized source creation command */
export async function webhookAdapter() {
  const database = await startTestPostgres({ password: randomBytes(24).toString('hex') })
  let server
  const cleanup = async () => {
    try { await server?.close() } finally { await database.stop() }
  }
  try {
    server = await startServer(database, 'connectorcontract')
    const created = await server.app.inject({ method: 'POST', url: '/api/sources', headers: server.owner.headers,
      payload: { name: 'Contract', connection: { kind: 'webhook' }, secrets: {} } })
    invariant(created.statusCode === 200, 'live.webhookSource')
    const source = created.json()
    const connector = createWebhookConnector(server.app.ctx)
    const context = { connection: SourceConnection.parse({ kind: 'webhook' }), sourceId: source.id,
      secrets: { signingSecret: randomBytes(24).toString('hex') } }
    const select = { kind: 'object', object: { schema: null, name: 'posts' } }
    await connector.preview(context, select, 3)
    const posted = await server.app.inject({ method: 'POST', url: source.webhookPath,
      payload: [{ id: 1, title: 'First' }, { id: 2, title: 'Second' }] })
    invariant(posted.statusCode === 202, 'live.webhookPosts')
    await server.ctx.inbound.drain()
    const preview = await connector.preview(context, select, 3)
    invariant(preview.rows.length === 2, 'live.webhookSamples')
    const { version } = JSON.parse(await readFile(new URL('../apps/server/package.json', import.meta.url), 'utf8'))
    return { ...contractAdapter({ connector, context, select, columns: preview.columns,
      keys: await connector.keyCandidates(context, select.object), expectedRows: [],
      read: { columns: preview.columns.map((column) => column.name), types: {}, keyColumns: [] },
      requests: () => [],
      failure: (ctx) => connector.preview(ctx, { kind: 'object', object: { schema: null, name: 'missing' } }, 1),
    }), cleanup, serverVersion: async () => `Riosoma ${version}` }
  } catch (error) { await cleanup(); throw error }
}

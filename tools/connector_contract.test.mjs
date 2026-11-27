import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const runner = await import('./connector_contract.mjs')
const kit = await import('../packages/connectors/dist/contract/index.js')

test('requires complete strict results instead of partial observations', () => {
  const observations = new Map(kit.SHIPPED_CONNECTORS.map((kind) => [
    kind, new Set(['list', 'describe', 'keys', 'read', 'paging']),
  ]))
  const gaps = runner.fixtureGaps(kit, observations, [])
  assert.ok(gaps.some(({ connector, check }) => connector === 'postgres' && check === 'query'))
  assert.ok(gaps.some(({ connector, check }) => connector === 'postgres' && check === 'filter'))
  assert.ok(gaps.some(({ connector, check }) => connector === 'postgres' && check === 'sort'))
  assert.ok(gaps.some(({ connector, check }) => connector === 'postgres' && check === 'secrets'))
  assert.ok(gaps.some(({ connector, check }) => connector === 'postgres' && check === 'timeout'))
  assert.ok(gaps.some(({ check }) => check === 'contract.result'))
})

test('retains independent successful certifications when another account suite fails', async () => {
  const written = []
  const cleaned = []
  const adapters = ['postgres', 'mysql', 'oracle'].map((kind) => ({
    connector: { kind, test: async () => ({ ok: true, serverVersion: 'test-1', steps: [] }) },
    context: {},
    cleanup: async () => cleaned.push(kind),
  }))
  const fake = {
    ...kit,
    runConnectorContract: async ({ connector }) => ({
      connector: connector.kind, capabilitiesPassed: kit.requiredCapabilities(connector.kind),
    }),
    assertSecretFree() {},
    writeCertification: async (_directory, result) => written.push(result.connector),
  }
  const outcomes = await runner.runLiveAdapters(fake, adapters, '1', '.', new Set(['oracle']))
  assert.deepEqual(written, ['postgres', 'mysql'])
  assert.deepEqual(cleaned, ['postgres', 'mysql', 'oracle'])
  assert.equal(outcomes.find(({ connector }) => connector === 'oracle').check, 'live.protocolSuite')
})

test('provides a settings adapter for every shipped connector kind', async () => {
  const live = await import(pathToFileURL(new URL('./connector_live_sql.mjs', import.meta.url).pathname).href)
  assert.deepEqual(Object.keys(live.LIVE_CONNECTOR_SETTINGS ?? {}).sort(), [...kit.SHIPPED_CONNECTORS].sort())
})

test('waits for the seeded Oracle table to be visible in a read-only transaction', async (t) => {
  const require = createRequire(new URL('../packages/connector-drivers/package.json', import.meta.url))
  const oracle = require('oracledb')
  const statements = []
  const admin = {
    async execute(sql) {
      statements.push(sql)
      if (/^SELECT \* FROM /.test(sql)) {
        const attempts = statements.filter((statement) => /^SELECT \* FROM /.test(statement)).length
        if (attempts === 1) throw Object.assign(new Error('stale snapshot'), { code: 'ORA-01466' })
        if (attempts === 2) return { rows: [] }
        return {
          rows: [
            [1, 'item-1'],
            [2, 'item-2'],
            [3, 'item-3'],
          ],
        }
      }
    },
    async commit() {
      statements.push('COMMIT')
    },
    async rollback() {
      statements.push('ROLLBACK')
    },
    async close() {},
  }
  t.mock.method(oracle, 'getConnection', async () => admin)
  const previous = process.env.RIOSOMA_TEST_ORACLE_URL
  process.env.RIOSOMA_TEST_ORACLE_URL = 'oracle://reader:test@127.0.0.1:1521/FREEPDB1'
  try {
    const { contracts } = await import('./connector_live_sql.mjs?oracle-fixture-test')
    const candidate = (await contracts()).find(({ connector }) => connector.kind === 'oracle')
    const adapter = await candidate.prepare()
    try {
      const { schema, name } = adapter.select.object
      const select = `SELECT * FROM "${schema}"."${name}"`
      assert.deepEqual(statements.slice(statements.indexOf('SET TRANSACTION READ ONLY')), [
        'SET TRANSACTION READ ONLY',
        select,
        'ROLLBACK',
        'SET TRANSACTION READ ONLY',
        select,
        'ROLLBACK',
        'SET TRANSACTION READ ONLY',
        select,
        'ROLLBACK',
      ])
    } finally {
      await adapter.cleanup()
    }
  } finally {
    if (previous === undefined) delete process.env.RIOSOMA_TEST_ORACLE_URL
    else process.env.RIOSOMA_TEST_ORACLE_URL = previous
  }
})

test('schedules a strict adapter for every remaining configured connector', async () => {
  const { accountContracts } = await import('./connector_live_accounts.mjs')
  const { LIVE_CONNECTOR_SETTINGS } = await import('./connector_live_settings.mjs')
  const relational = new Set(['postgres', 'mysql', 'sqlserver', 'oracle', 'firebird'])
  const kinds = kit.SHIPPED_CONNECTORS.filter((kind) => !relational.has(kind))
  const env = Object.fromEntries(kinds.map((kind) => [LIVE_CONNECTOR_SETTINGS[kind].json, JSON.stringify({ connection: { kind } })]))
  const adapters = accountContracts(env)
  assert.deepEqual(adapters.map(({ connector }) => connector.kind).sort(), [...kinds].sort())
  assert.ok(adapters.every(({ prepare }) => typeof prepare === 'function'))
})

test('continues after an independent adapter preparation failure', async () => {
  const written = []
  const fake = { ...kit,
    runConnectorContract: async ({ connector }) => ({ connector: connector.kind, capabilitiesPassed: kit.requiredCapabilities(connector.kind) }),
    assertSecretFree() {}, writeCertification: async (_directory, result) => written.push(result.connector),
  }
  const prepared = { connector: { kind: 'mysql', test: async () => ({ ok: true, serverVersion: '1', steps: [] }) }, context: {} }
  await runner.runLiveAdapters(fake, [
    { connector: { kind: 'postgres' }, prepare: async () => { throw new Error('sources.contract.setupFailed') } },
    { connector: { kind: 'mysql' }, prepare: async () => prepared },
  ], '1', '.')
  assert.deepEqual(written, ['mysql'])
})

test('reports each adapter failure step with only a message key or error class', async () => {
  const secret = 'private-connection-string'
  const keyed = Object.assign(new Error(secret), { messageKey: 'sources.test.timeout', detail: secret })
  const plain = new TypeError(secret)
  const fail = (error) => async () => {
    throw error
  }
  const adapters = [
    { connector: { kind: 'postgres' }, prepare: fail(keyed) },
    { connector: { kind: 'mysql' } },
    { connector: { kind: 'oracle', test: fail(plain) } },
    { connector: { kind: 'bigquery', test: async () => ({}) }, serverVersion: fail(keyed) },
    { connector: { kind: 'sheets', test: async () => ({}) } },
  ]
  const fake = {
    ...kit,
    async runConnectorContract({ connector }) {
      if (connector.kind === 'mysql') throw plain
    },
    assertSecretFree() {},
    writeCertification: fail(plain),
  }
  const outcomes = await runner.runLiveAdapters(fake, adapters, '1', '.')
  assert.deepEqual(outcomes.slice(0, adapters.length), [
    { connector: 'postgres', status: 'failed', check: 'live.prepare', reason: 'sources.test.timeout' },
    { connector: 'mysql', status: 'failed', check: 'live.contract', reason: 'TypeError' },
    { connector: 'oracle', status: 'failed', check: 'live.test', reason: 'TypeError' },
    { connector: 'bigquery', status: 'failed', check: 'live.version', reason: 'sources.test.timeout' },
    { connector: 'sheets', status: 'failed', check: 'live.certificate', reason: 'TypeError' },
  ])
  assert.ok(!JSON.stringify(outcomes).includes(secret))
})

test('runs a configured HTTP account adapter through the real transport', async () => {
  const { createServer } = await import('node:http')
  const { SourceConnection } = await import('../packages/contracts/dist/index.js')
  const { accountAdapter } = await import('./connector_live_accounts.mjs')
  const secret = crypto.randomUUID()
  const service = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.setHeader('server', 'Contract/1')
    response.end(JSON.stringify([1, 2, 3].map((id) => ({ id, title: `row${id}` }))))
  })
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve))
  let adapter
  try {
    const address = service.address()
    adapter = await accountAdapter('rest', {
      context: { connection: SourceConnection.parse({ kind: 'rest', baseUrl: `http://${address.address}:${address.port}`,
        endpoints: [{ name: 'rows', path: '/rows' }], requestsPerSecond: 100 }), secrets: { password: secret }, timeoutMs: 30000 },
      keyColumns: ['id'],
    })
    const result = await kit.runConnectorContract(adapter)
    assert.deepEqual(result.capabilitiesPassed, kit.requiredCapabilities('rest').sort())
    assert.equal(await adapter.serverVersion(), 'Contract/1')
  } finally {
    await adapter?.cleanup()
    service.closeAllConnections()
    await new Promise((resolve) => service.close(resolve))
  }
})

test('parses and applies RIOSOMA_CONTRACT_KINDS filter without altering default behavior', async () => {
  assert.equal(runner.parseKindFilter(undefined, kit.SHIPPED_CONNECTORS), null)
  assert.equal(runner.parseKindFilter('  ', kit.SHIPPED_CONNECTORS), null)
  assert.throws(() => runner.parseKindFilter('not-a-connector', kit.SHIPPED_CONNECTORS))

  const filter = runner.parseKindFilter('mysql, clickhouse', kit.SHIPPED_CONNECTORS)
  assert.deepEqual([...filter], ['mysql', 'clickhouse'])

  const filteredEnv = runner.filterEnvForKinds({
    RIOSOMA_TEST_DATABASE_URL: 'postgres://localhost/db',
    RIOSOMA_TEST_MYSQL_URL: 'mysql://localhost/db',
    RIOSOMA_TEST_CLICKHOUSE_SETTINGS: '{}',
    RIOSOMA_TEST_TRINO_URL: 'http://localhost:8080/tpch',
    RIOSOMA_TEST_INFLUXDB3_SETTINGS: '{}',
  }, filter)
  assert.equal(filteredEnv.RIOSOMA_TEST_DATABASE_URL, 'postgres://localhost/db')
  assert.equal(filteredEnv.RIOSOMA_TEST_MYSQL_URL, 'mysql://localhost/db')
  assert.equal(filteredEnv.RIOSOMA_TEST_CLICKHOUSE_SETTINGS, '{}')
  assert.equal(filteredEnv.RIOSOMA_TEST_TRINO_URL, undefined)
  assert.equal(filteredEnv.RIOSOMA_TEST_INFLUXDB3_SETTINGS, undefined)

  const written = []
  const fake = {
    ...kit,
    runConnectorContract: async ({ connector }) => ({
      connector: connector.kind,
      capabilitiesPassed: kit.requiredCapabilities(connector.kind),
    }),
    assertSecretFree() {},
    writeCertification: async (_directory, result) => written.push(result.connector),
  }
  const adapters = ['postgres', 'mysql', 'oracle'].map((kind) => ({
    connector: { kind, test: async () => ({ ok: true, serverVersion: 'test-1', steps: [] }) },
    context: {},
  }))
  const outcomes = await runner.runLiveAdapters(fake, adapters, '1', '.', new Set(), filter)
  assert.deepEqual(written, ['mysql'])
  assert.deepEqual(outcomes, [
    { connector: 'mysql', status: 'passed' },
    { connector: 'clickhouse', status: 'unconfigured' },
  ])
})

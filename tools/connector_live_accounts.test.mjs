import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createBigQueryFixture, createSheetsFixture, warehouseModules } from './connector_live_accounts.mjs'

const TOKEN = 'fixture-token-0123456789'

function jsonAnswer(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('every warehouse kind maps to a source module that exports its factory', async () => {
  for (const kind of ['snowflake', 'bigquery', 'databricks', 'clickhouse'])
    assert.equal(warehouseModules[kind][0], 'connector-drivers', `${kind} lives in connector-drivers`)
  for (const [kind, [packageDir, module, factory]] of Object.entries(warehouseModules)) {
    const source = await readFile(new URL(`../packages/${packageDir}/src/warehouses/${module}.ts`, import.meta.url), 'utf8')
    assert.match(source, new RegExp(`export function ${factory}\\(`), `${kind} must export ${factory}`)
  }
})

test('createSheetsFixture adds its tab, writes typed rows to a quoted range, and deletes the same sheet', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) })
    if (calls.length === 1) return jsonAnswer({ replies: [{ addSheet: { properties: { sheetId: 42 } } }] })
    return jsonAnswer({})
  }
  const fixture = await createSheetsFixture({ fetch, token: TOKEN, spreadsheetId: 'sheet-1', randomId: 'abcd1234' })
  assert.equal(fixture.title, 'riosoma-contract-abcd1234')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'POST')
  assert.ok(calls[0].url.endsWith('/spreadsheets/sheet-1:batchUpdate'))
  const added = calls[0].body.requests[0].addSheet
  assert.equal(added.properties.title, fixture.title)
  assert.equal(added.properties.index, 0)
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(calls[1].method, 'PUT')
  const range = `'riosoma-contract-abcd1234'!A1`
  assert.ok(calls[1].url.includes(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`))
  assert.equal(calls[1].body.range, range)
  const values = calls[1].body.values
  assert.deepEqual(values[0], ['id', 'name', 'amount', 'active', 'day'])
  assert.equal(values.length, 6)
  assert.deepEqual(values.slice(1).map((row) => row[0]), [1, 2, 3, 4, 5])
  for (const row of values.slice(1)) {
    assert.equal(typeof row[1], 'string')
    assert.equal(typeof row[2], 'number')
    assert.equal(typeof row[3], 'boolean')
    assert.match(row[4], /^\d{4}-\d{2}-\d{2}$/)
  }
  await fixture.remove()
  assert.equal(calls.length, 3)
  assert.ok(calls[2].url.endsWith('/spreadsheets/sheet-1:batchUpdate'))
  assert.deepEqual(calls[2].body.requests, [{ deleteSheet: { sheetId: 42 } }])
  await fixture.remove()
  assert.equal(calls.length, 3, 'a second remove is a no-op')
})

test('a failed values write still deletes the tab it added', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    if (calls.length === 1) return jsonAnswer({ replies: [{ addSheet: { properties: { sheetId: 7 } } }] })
    if (calls.length === 2) return jsonAnswer({ error: { message: 'write denied' } }, 403)
    return jsonAnswer({})
  }
  await assert.rejects(createSheetsFixture({ fetch, token: TOKEN, spreadsheetId: 'sheet-1', randomId: 'abcd1234' }))
  assert.equal(calls.length, 3)
  assert.ok(calls[2].url.endsWith(':batchUpdate'))
  assert.deepEqual(calls[2].body.requests, [{ deleteSheet: { sheetId: 7 } }])
})

test('fixture failures never carry the token or a Google answer body', async () => {
  const secretBody = JSON.stringify({ error: { message: `invalid grant for ${TOKEN}` } })
  for (const failAt of [1, 2]) {
    let count = 0
    const fetch = async () => {
      count += 1
      if (count === failAt) return new Response(secretBody, { status: 403 })
      return jsonAnswer({ replies: [{ addSheet: { properties: { sheetId: 9 } } }] })
    }
    const error = await createSheetsFixture({ fetch, token: TOKEN, spreadsheetId: 'sheet-1', randomId: 'abcd1234' })
      .then(() => null, (thrown) => thrown)
    assert.ok(error, `call ${failAt} must fail the fixture`)
    const text = [error.message, error.check, ...(error.errors ?? []).map((entry) => `${entry.message} ${entry.check}`)].join(' ')
    assert.ok(!text.includes(TOKEN), 'the token never reaches an error')
    assert.ok(!text.includes('invalid grant'), 'a Google answer body never reaches an error')
  }
})

const BIGQUERY_BODY = 'access denied for fixture-key-0123456789'

function fakeBigQuery(failAt) {
  const statements = []
  const client = {
    query: async (sql) => {
      statements.push(sql)
      if (statements.length === failAt) throw new Error(BIGQUERY_BODY)
      return [[], {}]
    },
  }
  return { client, statements }
}

const violationOf = (error) => error.check ?? error.message

test('createBigQueryFixture creates and fills a qualified table, and drops the same name', async () => {
  const { client, statements } = fakeBigQuery()
  const fixture = await createBigQueryFixture({ client, projectId: 'proj-1', dataset: 'data_set', randomId: 'abcd1234' })
  assert.equal(fixture.table, 'riosoma_contract_abcd1234')
  const qualified = '`proj-1`.`data_set`.`riosoma_contract_abcd1234`'
  assert.equal(statements.length, 2)
  assert.match(statements[0], /^CREATE TABLE/)
  assert.ok(statements[0].includes(qualified), 'CREATE uses the fully qualified name')
  for (const column of ['id INT64', 'name STRING', 'amount NUMERIC', 'active BOOL', 'day DATE'])
    assert.ok(statements[0].includes(column), `CREATE declares ${column}`)
  assert.match(statements[1], /^INSERT INTO/)
  assert.ok(statements[1].includes(qualified), 'INSERT uses the fully qualified name')
  assert.match(statements[1], /VALUES/)
  assert.deepEqual([...statements[1].matchAll(/\((\d+), '/g)].map((match) => Number(match[1])), [1, 2, 3, 4, 5])
  await fixture.remove()
  assert.equal(statements.length, 3)
  assert.equal(statements[2], `DROP TABLE IF EXISTS ${qualified}`)
  await fixture.remove()
  assert.equal(statements.length, 3, 'a second remove is a no-op')
})

test('a failed insert still drops the table it created, with only a message key', async () => {
  const { client, statements } = fakeBigQuery(2)
  const error = await createBigQueryFixture({ client, projectId: 'proj-1', dataset: 'data_set', randomId: 'abcd1234' })
    .then(() => null, (thrown) => thrown)
  assert.ok(error, 'the failed insert must fail the fixture')
  assert.equal(violationOf(error), 'live.bigqueryFixture')
  assert.ok(!`${error.message} ${error.check}`.includes(BIGQUERY_BODY), 'a BigQuery error body never reaches an error')
  assert.equal(statements.length, 3)
  assert.equal(statements[2], 'DROP TABLE IF EXISTS `proj-1`.`data_set`.`riosoma_contract_abcd1234`')
})

test('a failed drop still throws, so cleanup records it', async () => {
  const { client, statements } = fakeBigQuery(3)
  const fixture = await createBigQueryFixture({ client, projectId: 'proj-1', dataset: 'data_set', randomId: 'abcd1234' })
  const error = await fixture.remove().then(() => null, (thrown) => thrown)
  assert.ok(error, 'the failed drop must throw')
  assert.equal(violationOf(error), 'live.bigqueryFixture')
  assert.ok(!`${error.message} ${error.check}`.includes(BIGQUERY_BODY), 'a BigQuery error body never reaches an error')
  assert.match(statements[2], /^DROP TABLE IF EXISTS/)
})

test('unsafe project or dataset names are refused before any statement is sent', async () => {
  const bad = [
    ['proj`ect', 'data_set'], ['proj;ect', 'data_set'], ['proj ect', 'data_set'], ['proj.ect', 'data_set'],
    ['proj/ect', 'data_set'], ['', 'data_set'], ['proj-1', 'data`set'], ['proj-1', 'data-set'],
    ['proj-1', 'data.set'], ['proj-1', 'data set'], ['proj-1', 'data;'], ['proj-1', ''],
  ]
  for (const [projectId, dataset] of bad) {
    const { client, statements } = fakeBigQuery()
    const error = await createBigQueryFixture({ client, projectId, dataset, randomId: 'abcd1234' })
      .then(() => null, (thrown) => thrown)
    assert.ok(error, `${projectId}.${dataset} must be refused`)
    assert.equal(violationOf(error), 'live.bigqueryFixture')
    assert.equal(statements.length, 0, 'no statement is sent for an unsafe name')
  }
})

import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COSMOS_EMULATOR_KEY,
  FLEET_DATABASE,
  FLEET_PASSWORD,
  FLEET_USER,
  INFORMIX_PASSWORD,
  INFORMIX_USER,
} from './contract-settings.mjs';
import { FIXTURE_ROWS } from './fixture-server.mjs';
import { payloadHash, signAwsRequest } from '../../packages/connectors/dist/files/s3.js';
import { cosmosAuthorization } from '../../packages/connectors/dist/nosql/cosmos.js';

const FLEET_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const COMPOSE_FILE = resolve(FLEET_DIR, 'compose.yaml');
const requireConnector = createRequire(new URL('../../packages/connectors/package.json', import.meta.url));
const requireDriver = createRequire(
  new URL('../../packages/connector-drivers/package.json', import.meta.url),
);

function csvBody() {
  const header = 'id,name,amount,active,day';
  const lines = FIXTURE_ROWS.map(
    (row) => `${row.id},${row.name},${row.amount.toFixed(2)},${row.active},${row.day}`,
  );
  return `${[header, ...lines].join('\n')}\n`;
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchJson(url, init = {}, okStatuses = [200, 201, 202, 204]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!okStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, text, json: safeJsonParse(text) };
}

function composeExec(service, command, input) {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', service, 'sh', '-c', command], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

export async function seedDuckDbFile(dbPath = resolve(FLEET_DIR, '.fixtures/contract.duckdb')) {
  const { DuckDBInstance } = requireConnector('@duckdb/node-api');
  await mkdir(dirname(dbPath), { recursive: true });
  await rm(dbPath, { force: true });
  await rm(`${dbPath}.wal`, { force: true });
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    await connection.run(
      'CREATE TABLE contract_items (id INTEGER PRIMARY KEY, name VARCHAR, amount DECIMAL(12, 2), active BOOLEAN, day DATE)',
    );
    for (const row of FIXTURE_ROWS) {
      await connection.run(
        `INSERT INTO contract_items VALUES (${row.id}, '${row.name.replaceAll("'", "''")}', ${row.amount.toFixed(2)}, ${row.active}, DATE '${row.day}')`,
      );
    }
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
  return dbPath;
}

export async function seedMinio() {
  const endpoint = 'http://127.0.0.1:19100';
  const bucket = 'riosoma-test';
  const credentials = { accessKeyId: FLEET_USER, secretAccessKey: FLEET_PASSWORD };
  const s3 = async (method, path, body = '') => {
    const url = new URL(`${endpoint}${path}`);
    const headers = signAwsRequest({
      method,
      url,
      region: 'us-east-1',
      service: 's3',
      credentials,
      hash: payloadHash(body),
      payloadHeader: true,
    });
    return fetch(url, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000) });
  };
  const made = await s3('PUT', `/${bucket}`);
  if (![200, 409].includes(made.status)) {
    throw new Error(`MinIO bucket create failed with HTTP ${made.status}: ${await made.text()}`);
  }
  await made.body?.cancel();
  const put = await s3('PUT', `/${bucket}/contract/items.csv`, csvBody());
  if (!put.ok) {
    throw new Error(`MinIO object upload failed with HTTP ${put.status}: ${await put.text()}`);
  }
  await put.body?.cancel();
}

export async function seedSftp() {
  composeExec(
    'sftp',
    'cat > /home/riosoma_test/upload/items.csv && chown 1001:1001 /home/riosoma_test/upload/items.csv',
    csvBody(),
  );
  const pub = composeExec('sftp', 'cat /etc/ssh/ssh_host_ed25519_key.pub').trim();
  const parts = pub.split(/\s+/);
  return `${parts[0]} ${parts[1]}`;
}

export async function seedFtp() {
  composeExec(
    'ftp',
    'cat > /home/riosoma_test/items.csv && chown 1000:1000 /home/riosoma_test/items.csv',
    csvBody(),
  );
  const cert = composeExec('ftp', 'openssl x509 -in /etc/ssl/private/pure-ftpd.pem');
  const caPath = resolve(FLEET_DIR, '.fixtures/ftps-ca.pem');
  await mkdir(dirname(caPath), { recursive: true });
  await writeFile(caPath, cert, 'utf8');
  return caPath;
}

export async function seedWebdav() {
  const auth = `Basic ${Buffer.from(`${FLEET_USER}:${FLEET_PASSWORD}`).toString('base64')}`;
  await fetchJson('http://127.0.0.1:18090/items.csv', {
    method: 'PUT',
    headers: { authorization: auth, 'content-type': 'text/csv; charset=utf-8' },
    body: csvBody(),
  });
}

export async function seedClickHouse() {
  const headers = {
    'x-clickhouse-user': FLEET_USER,
    'x-clickhouse-key': FLEET_PASSWORD,
  };
  const query = async (sql, body) => {
    const url = `http://127.0.0.1:18123/?database=${encodeURIComponent(FLEET_DATABASE)}&query=${encodeURIComponent(sql)}`;
    await fetchJson(url, { method: 'POST', headers, ...(body ? { body } : {}) });
  };
  await query('DROP TABLE IF EXISTS contract_items');
  await query(
    'CREATE TABLE contract_items (id Int32, name String, amount Decimal(12, 2), active Bool, day Date) ENGINE = MergeTree ORDER BY id',
  );
  await query(
    'INSERT INTO contract_items FORMAT JSONEachRow',
    FIXTURE_ROWS.map((row) => JSON.stringify(row)).join('\n'),
  );
}

export async function seedTrinoPostgres() {
  const pg = requireConnector('pg');
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 15435,
    user: FLEET_USER,
    password: FLEET_PASSWORD,
    database: FLEET_DATABASE,
  });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS public.contract_items');
    await client.query(
      'CREATE TABLE public.contract_items (id INTEGER PRIMARY KEY, name VARCHAR(80), amount NUMERIC(12, 2), active BOOLEAN, day DATE)',
    );
    for (const row of FIXTURE_ROWS) {
      await client.query(
        'INSERT INTO public.contract_items (id, name, amount, active, day) VALUES ($1, $2, $3, $4, $5)',
        [row.id, row.name, row.amount.toFixed(2), row.active, row.day],
      );
    }
  } finally {
    await client.end();
  }
}

export async function seedDruid() {
  const base = 'http://127.0.0.1:18888';
  const existing = await fetch(`${base}/druid/v2/sql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM "contract_items"' }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (existing?.ok) {
    const rows = await existing.json();
    if (rows?.[0]?.n === FIXTURE_ROWS.length) return;
  }
  const inline = FIXTURE_ROWS.map((row) =>
    JSON.stringify({
      ts: `${row.day}T00:00:00Z`,
      id: row.id,
      name: row.name,
      amount: row.amount,
      active: row.active,
      day: row.day,
    }),
  ).join('\n');
  const input = JSON.stringify({ type: 'inline', data: inline }).replaceAll("'", "''");
  const signature = JSON.stringify([
    { name: 'ts', type: 'string' },
    { name: 'id', type: 'long' },
    { name: 'name', type: 'string' },
    { name: 'amount', type: 'double' },
    { name: 'active', type: 'long' },
    { name: 'day', type: 'string' },
  ]);
  const { json: task } = await fetchJson(`${base}/druid/v2/sql/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `REPLACE INTO "contract_items" OVERWRITE ALL
        SELECT TIME_PARSE("ts") AS "__time", "id", "name", "amount", CASE WHEN "active" = 1 THEN TRUE ELSE FALSE END AS "active", "day"
        FROM TABLE(EXTERN('${input}', '{"type":"json"}', '${signature}'))
        PARTITIONED BY DAY`,
      context: { maxNumTasks: 2 },
    }),
  });
  for (let tries = 0; tries < 150; tries++) {
    const { json: status } = await fetchJson(`${base}/druid/indexer/v1/task/${task.taskId}/status`);
    if (status.status.status === 'SUCCESS') break;
    if (status.status.status === 'FAILED') {
      throw new Error(`Druid ingestion failed: ${status.status.errorMsg ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  for (let tries = 0; tries < 60; tries++) {
    const resp = await fetch(`${base}/druid/v2/sql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM "contract_items"' }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (resp?.ok) {
      const data = await resp.json();
      if (data?.[0]?.n === FIXTURE_ROWS.length) return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('Druid datasource contract_items did not load');
}

export async function ensureIbmDriver(driversDir = resolve(FLEET_DIR, '.drivers')) {
  const { DRIVER_CATALOG, catalogHash, installedDriver, licenseHash } =
    await import('../../packages/connectors/dist/index.js');
  const existing = await installedDriver(driversDir, 'ibm_db').catch(() => null);
  if (existing) return driversDir;
  const { DriverInstaller } = await import('../../apps/server/dist/drivers/installer.js');
  const definition = DRIVER_CATALOG.find((driver) => driver.id === 'ibm_db');
  const installer = new DriverInstaller(driversDir, true, async () => {});
  await installer.install('ibm_db', {
    licenseHash: licenseHash(definition),
    catalogHash: catalogHash(definition),
  });
  return driversDir;
}

export async function seedDb2() {
  const driversDir = await ensureIbmDriver();
  for (let tries = 0; tries < 20; tries++) {
    try {
      composeExec(
        'db2',
        "su - db2inst1 -c 'db2 connect to riosoma >/dev/null && db2 connect reset >/dev/null'",
      );
      break;
    } catch (error) {
      if (tries === 19) throw error;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  const inserts = FIXTURE_ROWS.map(
    (row) =>
      `INSERT INTO DB2INST1.CONTRACT_ITEMS (ID, NAME, AMOUNT, ACTIVE, DAY) VALUES (${row.id}, '${row.name.replaceAll("'", "''")}', ${row.amount.toFixed(2)}, ${row.active ? 'TRUE' : 'FALSE'}, '${row.day}');`,
  ).join('\n');
  const script = [
    'CONNECT TO riosoma;',
    'CREATE TABLE DB2INST1.CONTRACT_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(80), AMOUNT DECIMAL(12, 2), ACTIVE BOOLEAN, DAY DATE);',
    inserts,
    'COMMIT;',
    'CONNECT RESET;',
  ].join('\n');
  composeExec(
    'db2',
    "su - db2inst1 -c 'db2 connect to riosoma >/dev/null && db2 DROP TABLE DB2INST1.CONTRACT_ITEMS >/dev/null 2>&1 || true'",
  );
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  composeExec(
    'db2',
    `su - db2inst1 -c "echo '${b64}' | base64 -d > /tmp/contract_seed.sql && db2 -tvf /tmp/contract_seed.sql"`,
  );
  return driversDir;
}

export async function seedInformix() {
  const driversDir = await ensureIbmDriver();
  const retryDbAccess = async (cmd, input) => {
    for (let tries = 0; tries < 15; tries++) {
      try {
        return composeExec('informix', cmd, input);
      } catch (error) {
        const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`;
        if ((text.includes('425:') || text.includes('107:')) && tries < 14) {
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        throw error;
      }
    }
  };
  const dbCheck = await retryDbAccess(
    '. /opt/ibm/scripts/informix_inf.env && dbaccess sysmaster - 2>&1',
    `SELECT name FROM sysdatabases WHERE name = '${FLEET_DATABASE}';\n`,
  );
  if (!dbCheck.includes(FLEET_DATABASE)) {
    await retryDbAccess(
      '. /opt/ibm/scripts/informix_inf.env && dbaccess sysmaster -',
      `CREATE DATABASE ${FLEET_DATABASE} WITH LOG;\n`,
    );
  }
  const inserts = FIXTURE_ROWS.map((row) => {
    const [year, month, day] = row.day.split('-').map(Number);
    return `INSERT INTO contract_items (id, name, amount, active, day) VALUES (${row.id}, '${row.name.replaceAll("'", "''")}', ${row.amount.toFixed(2)}, '${row.active ? 't' : 'f'}', MDY(${month}, ${day}, ${year}));`;
  }).join('\n');
  const script = [
    'DROP TABLE IF EXISTS contract_items;',
    'CREATE TABLE contract_items (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(80), amount DECIMAL(12, 2), active BOOLEAN, day DATE);',
    inserts,
  ].join('\n');
  await retryDbAccess(`. /opt/ibm/scripts/informix_inf.env && dbaccess ${FLEET_DATABASE} -`, `${script}\n`);
  return driversDir;
}

export async function seedMongoDb() {
  const { MongoClient } = requireDriver('mongodb');
  const uri = `mongodb://${FLEET_USER}:${encodeURIComponent(FLEET_PASSWORD)}@127.0.0.1:17017/?authSource=admin`;
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const collection = client.db(FLEET_DATABASE).collection('contract_items');
    await collection.drop().catch(() => undefined);
    await collection.insertMany(
      FIXTURE_ROWS.map((row) => ({
        _id: row.id,
        id: row.id,
        name: row.name,
        amount: row.amount,
        active: row.active,
        day: new Date(`${row.day}T00:00:00.000Z`),
      })),
    );
  } finally {
    await client.close();
  }
}

export async function seedCouchDb() {
  const base = 'http://127.0.0.1:15984';
  const headers = {
    authorization: `Basic ${Buffer.from(`${FLEET_USER}:${FLEET_PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  await fetchJson(`${base}/${FLEET_DATABASE}`, { method: 'PUT', headers }, [201, 202, 412]);
  for (const row of FIXTURE_ROWS) {
    const id = String(row.id);
    const current = await fetch(`${base}/${FLEET_DATABASE}/${id}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    let rev;
    if (current.ok) {
      const existing = await current.json();
      rev = existing._rev;
    } else {
      await current.body?.cancel();
    }
    await fetchJson(`${base}/${FLEET_DATABASE}/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...row, ...(rev ? { _rev: rev } : {}) }),
    });
  }
  await fetchJson(`${base}/${FLEET_DATABASE}/_index`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ index: { fields: ['_id'] }, name: 'contract-id-index', type: 'json' }),
  });
}

export async function seedCouchbase() {
  const base = 'http://127.0.0.1:18093';
  const headers = {
    authorization: `Basic ${Buffer.from(`Administrator:${FLEET_PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  const query = async (statement, args = []) => {
    const { json } = await fetchJson(`${base}/query/service`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement, args }),
    });
    if (json.status !== 'success') throw new Error(`Couchbase query failed: ${JSON.stringify(json)}`);
  };
  for (let tries = 0; tries < 30; tries++) {
    try {
      await query(`CREATE PRIMARY INDEX IF NOT EXISTS ON \`${FLEET_DATABASE}\``);
      break;
    } catch (error) {
      if (tries === 29) throw error;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  for (const row of FIXTURE_ROWS) {
    await query(`UPSERT INTO \`${FLEET_DATABASE}\` (KEY, VALUE) VALUES ($1, $2)`, [String(row.id), row]);
  }
}

export async function seedDynamoDb() {
  const url = new URL('http://127.0.0.1:18000');
  const credentials = { accessKeyId: 'riosoma', secretAccessKey: FLEET_PASSWORD };
  const call = async (operation, data, okStatuses = [200]) => {
    const body = JSON.stringify(data);
    const headers = signAwsRequest({
      method: 'POST',
      url,
      region: 'us-east-1',
      service: 'dynamodb',
      credentials,
      hash: payloadHash(body),
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `DynamoDB_20120810.${operation}`,
      },
    });
    return fetchJson(url.href, { method: 'POST', headers, body }, okStatuses);
  };
  await call('DeleteTable', { TableName: 'contract_items' }, [200, 400]);
  await call('CreateTable', {
    TableName: 'contract_items',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'id', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'id', AttributeType: 'N' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  for (const row of FIXTURE_ROWS) {
    await call('PutItem', {
      TableName: 'contract_items',
      Item: {
        pk: { S: 'fixture' },
        id: { N: String(row.id) },
        name: { S: row.name },
        amount: { N: String(row.amount) },
        active: { BOOL: row.active },
        day: { S: row.day },
      },
    });
  }
}

export async function seedCosmosDb() {
  const base = 'http://127.0.0.1:18082';
  const call = async (method, path, type, link, body, extra = {}, okStatuses = [200, 201, 204]) => {
    const date = new Date().toUTCString();
    return fetchJson(
      `${base}/${path}`,
      {
        method,
        headers: {
          authorization: cosmosAuthorization(COSMOS_EMULATOR_KEY, method, type, link, date),
          'x-ms-date': date,
          'x-ms-version': '2018-12-31',
          'content-type': 'application/json',
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      okStatuses,
    );
  };
  for (let tries = 0; tries < 40; tries++) {
    try {
      await call('POST', 'dbs', 'dbs', '', { id: FLEET_DATABASE }, {}, [201, 409]);
      break;
    } catch (error) {
      if (tries === 39 || !String(error?.message).includes('HTTP 503')) throw error;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  await call(
    'DELETE',
    `dbs/${FLEET_DATABASE}/colls/contract_items`,
    'colls',
    `dbs/${FLEET_DATABASE}/colls/contract_items`,
    undefined,
    {},
    [204, 404],
  );
  await call('POST', `dbs/${FLEET_DATABASE}/colls`, 'colls', `dbs/${FLEET_DATABASE}`, {
    id: 'contract_items',
    partitionKey: { paths: ['/id'], kind: 'Hash' },
  });
  for (const row of FIXTURE_ROWS) {
    const id = String(row.id);
    await call(
      'POST',
      `dbs/${FLEET_DATABASE}/colls/contract_items/docs`,
      'docs',
      `dbs/${FLEET_DATABASE}/colls/contract_items`,
      { ...row, id },
      { 'x-ms-documentdb-partitionkey': JSON.stringify([id]) },
    );
  }
}

async function seedElasticLike(base, headers) {
  await fetchJson(`${base}/contract_items`, { method: 'DELETE', headers }, [200, 404]);
  await fetchJson(`${base}/contract_items`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mappings: {
        properties: {
          id: { type: 'integer' },
          name: { type: 'keyword' },
          amount: { type: 'double' },
          active: { type: 'boolean' },
          day: { type: 'date' },
        },
      },
    }),
  });
  for (const row of FIXTURE_ROWS) {
    await fetchJson(`${base}/contract_items/_doc/${row.id}?refresh=true`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(row),
    });
  }
}

export async function seedElasticsearch() {
  await seedElasticLike('http://127.0.0.1:19200', {
    authorization: `Basic ${Buffer.from(`elastic:${FLEET_PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  });
}

export async function seedOpensearch() {
  await seedElasticLike('http://127.0.0.1:19201', {
    'content-type': 'application/json',
  });
}

export async function seedMeilisearch() {
  const base = 'http://127.0.0.1:17700';
  const headers = {
    authorization: `Bearer ${FLEET_PASSWORD}`,
    'content-type': 'application/json',
  };
  const waitTask = async (task) => {
    const uid = task.taskUid ?? task.uid;
    for (let tries = 0; tries < 100; tries++) {
      const { json } = await fetchJson(`${base}/tasks/${uid}`, { headers });
      if (json.status === 'succeeded') return;
      if (json.status === 'failed' || json.status === 'canceled') {
        throw new Error(`Meilisearch task ${uid} failed: ${JSON.stringify(json)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Meilisearch task ${uid} timed out`);
  };
  const check = await fetch(`${base}/indexes/contract_items`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  await check.body?.cancel();
  if (check.ok) {
    const del = await fetchJson(`${base}/indexes/contract_items`, { method: 'DELETE', headers }, [202, 404]);
    if (del.status === 202) await waitTask(del.json);
  }
  const created = await fetchJson(`${base}/indexes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uid: 'contract_items', primaryKey: 'id' }),
  });
  await waitTask(created.json);
  const settings = await fetchJson(`${base}/indexes/contract_items/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      filterableAttributes: ['id', 'name', 'amount', 'active', 'day'],
      sortableAttributes: ['id', 'name', 'amount', 'active', 'day'],
    }),
  });
  await waitTask(settings.json);
  const added = await fetchJson(`${base}/indexes/contract_items/documents`, {
    method: 'POST',
    headers,
    body: JSON.stringify(FIXTURE_ROWS),
  });
  await waitTask(added.json);
}

export async function seedTypesense() {
  const base = 'http://127.0.0.1:18108';
  const headers = {
    'x-typesense-api-key': FLEET_PASSWORD,
    'content-type': 'application/json',
  };
  await fetchJson(`${base}/collections/contract_items`, { method: 'DELETE', headers }, [200, 404]);
  await fetchJson(`${base}/collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'contract_items',
      fields: [
        { name: 'name', type: 'string', sort: true },
        { name: 'amount', type: 'float', sort: true },
        { name: 'active', type: 'bool', sort: true },
        { name: 'day', type: 'string', sort: true },
      ],
    }),
  });
  for (const row of FIXTURE_ROWS) {
    await fetchJson(`${base}/collections/contract_items/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...row, id: String(row.id) }),
    });
  }
}

export async function seedNeo4j() {
  const url = 'http://127.0.0.1:17474/db/neo4j/query/v2';
  const headers = {
    authorization: `Basic ${Buffer.from(`neo4j:${FLEET_PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  const run = async (statement, parameters = {}) => {
    const { json } = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement, parameters, accessMode: 'Write' }),
    });
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new Error(`Neo4j error: ${JSON.stringify(json.errors)}`);
    }
  };
  await run('MATCH (n:ContractItem) DETACH DELETE n');
  for (const row of FIXTURE_ROWS) {
    await run(
      'CREATE (:ContractItem { id: $id, name: $name, amount: $amount, active: $active, day: $day })',
      row,
    );
  }
}

export async function seedInfluxDb3() {
  const base = 'http://127.0.0.1:18181';
  await fetchJson(
    `${base}/api/v3/configure/database`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ db: FLEET_DATABASE }),
    },
    [200, 201, 204, 409],
  );
  const nowNs = BigInt(Date.now() - 10_000) * 1_000_000n;
  const lines = FIXTURE_ROWS.map(
    (row) =>
      `contract_items,source=seed id=${row.id}i,name="${row.name}",amount=${row.amount},active=${row.active},day="${row.day}" ${nowNs + BigInt(row.id) * 1_000_000n}`,
  ).join('\n');
  await fetchJson(`${base}/api/v3/write_lp?db=${encodeURIComponent(FLEET_DATABASE)}&precision=nanosecond`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: lines,
  });
}

export async function waitPrometheus() {
  const base = 'http://127.0.0.1:19090';
  for (let tries = 0; tries < 40; tries++) {
    const end = new Date();
    const start = new Date(end.getTime() - 15 * 60_000);
    const params = new URLSearchParams({
      query: 'up',
      start: start.toISOString(),
      end: end.toISOString(),
      step: '15',
    });
    const { json } = await fetchJson(`${base}/api/v1/query_range?${params}`).catch(() => ({ json: null }));
    const count = (json?.data?.result ?? []).reduce((sum, series) => sum + (series.values?.length ?? 0), 0);
    if (count >= 2) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error('Prometheus did not accumulate enough samples for query up');
}

const SEEDERS = {
  'duckdb-file': () => seedDuckDbFile(),
  bucket: () => seedMinio(),
  sftp: () => seedSftp(),
  ftp: () => seedFtp(),
  ftps: () => seedFtp(),
  webdav: () => seedWebdav(),
  clickhouse: () => seedClickHouse(),
  trino: () => seedTrinoPostgres(),
  druid: () => seedDruid(),
  db2: () => seedDb2(),
  informix: () => seedInformix(),
  mongodb: () => seedMongoDb(),
  dynamodb: () => seedDynamoDb(),
  couchdb: () => seedCouchDb(),
  couchbase: () => seedCouchbase(),
  cosmosdb: () => seedCosmosDb(),
  elasticsearch: () => seedElasticsearch(),
  opensearch: () => seedOpensearch(),
  meilisearch: () => seedMeilisearch(),
  typesense: () => seedTypesense(),
  neo4j: () => seedNeo4j(),
  influxdb: () => seedInfluxDb3(),
  prometheus: () => waitPrometheus(),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const kinds = process.argv.slice(2);
  const done = new Set();
  const outputs = {};
  for (const kind of kinds) {
    const seeder = SEEDERS[kind];
    if (!seeder || done.has(seeder)) continue;
    done.add(seeder);
    const result = await seeder();
    if (kind === 'sftp' && typeof result === 'string') outputs.RIOSOMA_SFTP_HOST_KEY = result;
    if (kind === 'duckdb-file' && typeof result === 'string') outputs.RIOSOMA_DUCKDB_FILE = result;
    if ((kind === 'ftp' || kind === 'ftps') && typeof result === 'string')
      outputs.NODE_EXTRA_CA_CERTS = result;
    if ((kind === 'db2' || kind === 'informix') && typeof result === 'string') {
      outputs.RIOSOMA_DRIVERS_DIR = result;
    }
  }
  if (Object.keys(outputs).length) process.stdout.write(`${JSON.stringify(outputs)}\n`);
}

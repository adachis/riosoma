import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { signAwsRequest, payloadHash } from '../../packages/connectors/dist/files/s3.js';
import { cosmosAuthorization } from '../../packages/connectors/dist/nosql/cosmos.js';

const env = { ...process.env };
const project = env.RIOSOMA_TEST_NOSQL_PROJECT ?? 'rio-sources-nosql';
const address = (port) => `http://127.0.0.1:${port}`;
async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} during fleet setup`);
  return response.json();
}
function settings(kind, connection, secrets, object) {
  env[`RIOSOMA_TEST_${kind.toUpperCase()}_SETTINGS`] = JSON.stringify({
    connection: { kind, ...connection },
    secrets,
    object,
  });
}
const keys = {
  accessKeyId: randomBytes(10).toString('hex'),
  secretAccessKey: randomBytes(32).toString('hex'),
};
async function dynamo(operation, data) {
  const body = JSON.stringify(data);
  const url = new URL(address(18000));
  const headers = signAwsRequest({
    method: 'POST',
    url,
    region: 'us-east-1',
    service: 'dynamodb',
    credentials: keys,
    hash: payloadHash(body),
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': `DynamoDB_20120810.${operation}`,
    },
  });
  return request(url, { method: 'POST', headers, body });
}
const table = `rio_nosql_${randomBytes(4).toString('hex')}`;
await dynamo('CreateTable', {
  TableName: table,
  KeySchema: [
    { AttributeName: 'id', KeyType: 'HASH' },
    { AttributeName: 'rank', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: [
    { AttributeName: 'id', AttributeType: 'S' },
    { AttributeName: 'rank', AttributeType: 'N' },
  ],
  BillingMode: 'PAY_PER_REQUEST',
});
for (let i = 0; i < 3; i++)
  await dynamo('PutItem', {
    TableName: table,
    Item: {
      id: { S: String(i).padStart(3, '0') },
      rank: { N: String(i) },
      name: { S: `Row ${i}` },
      tags: { SS: ['north', 'east'] },
      nested: { M: { count: { N: '3' } } },
      precise: { N: '9007199254740993' },
      binary: { B: randomBytes(4).toString('base64') },
    },
  });
settings('dynamodb', { endpoint: address(18000), region: 'us-east-1', segments: 3 }, keys, {
  schema: null,
  name: table,
});

const configuration = JSON.parse(
  execFileSync('docker', ['inspect', `${project}-couchdb-1`], { encoding: 'utf8' }),
)[0].Config.Env;
const value = (name) => configuration.find((entry) => entry.startsWith(`${name}=`)).slice(name.length + 1);
const user = value('COUCHDB_USER');
const password = value('COUCHDB_PASSWORD');
const basic = {
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  'content-type': 'application/json',
};
const database = `rio_nosql_${randomBytes(4).toString('hex')}`;
await request(`${address(15984)}/${database}`, { method: 'PUT', headers: basic });
for (let i = 0; i < 3; i++)
  await request(`${address(15984)}/${database}/${String(i).padStart(3, '0')}`, {
    method: 'PUT',
    headers: basic,
    body: JSON.stringify({ name: `Row ${i}`, nested: { count: i } }),
  });
settings('couchdb', { endpoint: address(15984), user }, { password }, { schema: null, name: database });

const projectId = 'riosoma-test';
const collection = `items_${randomBytes(4).toString('hex')}`;
for (let i = 0; i < 3; i++)
  await request(
    `${address(18083)}/v1/projects/${projectId}/databases/(default)/documents/${collection}/item${i}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {
          name: { stringValue: `Row ${i}` },
          n: { integerValue: String(i) },
          precise: { integerValue: '9007199254740993' },
        },
      }),
    },
  );
settings(
  'firestore',
  { endpoint: address(18083), projectId, emulator: true, collectionGroups: [collection] },
  {},
  { schema: 'group', name: collection },
);

if (process.env.RIOSOMA_TEST_COUCHBASE_LOCAL === '1') {
  const initialization = JSON.parse(
    execFileSync('docker', ['inspect', `${project}-couchbase-init-1`], { encoding: 'utf8' }),
  )[0].Config.Cmd.join('\n');
  const bucketPassword = initialization.match(/--cluster-password '([^']+)'/)?.[1];
  if (!bucketPassword) throw new Error('Couchbase test configuration is missing');
  const headers = {
    authorization: `Basic ${Buffer.from(`Administrator:${bucketPassword}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  async function statement(sql, args = []) {
    const result = await request(`${address(18093)}/query/service`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement: sql, args }),
    });
    if (result.status !== 'success') throw new Error('Couchbase fixture setup failed');
  }
  await statement('CREATE PRIMARY INDEX IF NOT EXISTS ON `riosoma_test`');
  for (let i = 0; i < 3; i++)
    await statement('UPSERT INTO `riosoma_test` (KEY, VALUE) VALUES ($1, $2)', [
      String(i).padStart(3, '0'),
      { name: `Row ${i}`, n: i },
    ]);
  settings(
    'couchbase',
    { endpoint: address(18093), user: 'Administrator' },
    { password: bucketPassword },
    { schema: JSON.stringify(['riosoma_test', '_default']), name: '_default' },
  );
}

if (process.env.RIOSOMA_TEST_COSMOSDB_LOCAL === '1') {
  const key = randomBytes(64).toString('base64');
  execFileSync('docker', ['exec', '-i', `${project}-cosmos-1`, 'sh', '-c', 'cat > /data/source-test-key'], {
    input: key,
  });
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'ops/test-fleet/compose.yaml',
      '-f',
      '-',
      '--profile',
      'sources-nosql',
      'up',
      '-d',
      'cosmos',
    ],
    {
      input: 'services:\n  cosmos:\n    environment:\n      KEY_FILE: /data/source-test-key\n',
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  async function cosmos(path, type, link, body, extra = {}) {
    const date = new Date().toUTCString();
    return request(`${address(18082)}/${path}`, {
      method: 'POST',
      headers: {
        authorization: cosmosAuthorization(key, 'POST', type, link, date),
        'x-ms-date': date,
        'x-ms-version': '2018-12-31',
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }
  const db = `rio_nosql_${randomBytes(4).toString('hex')}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await cosmos('dbs', 'dbs', '', { id: db });
      break;
    } catch (error) {
      if (attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await cosmos(`dbs/${db}/colls`, 'colls', `dbs/${db}`, {
    id: 'items',
    partitionKey: { paths: ['/tenant'], kind: 'Hash' },
  });
  for (let i = 0; i < 3; i++)
    await cosmos(
      `dbs/${db}/colls/items/docs`,
      'docs',
      `dbs/${db}/colls/items`,
      {
        id: String(i).padStart(3, '0'),
        tenant: 'north',
        name: `Row ${i}`,
        n: i,
      },
      { 'x-ms-documentdb-partitionkey': JSON.stringify(['north']) },
    );
  // The emulator conflates some partition hashes, so shared-ID cases stay in protocol fixtures.
  for (const [index, tenant] of [null, undefined, '', 0, '0', false].entries())
    await cosmos(
      `dbs/${db}/colls/items/docs`,
      'docs',
      `dbs/${db}/colls/items`,
      { id: `partition-${index}`, tenant, name: 'Partition identity' },
      { 'x-ms-documentdb-partitionkey': JSON.stringify([tenant === undefined ? {} : tenant]) },
    );
  settings(
    'cosmosdb',
    { endpoint: address(18082), database: db, auth: 'master-key' },
    { secretAccessKey: key },
    { schema: null, name: 'items' },
  );
}

const run = spawnSync(
  'pnpm',
  [
    '--filter',
    '@riosoma/connectors',
    'exec',
    'vitest',
    'run',
    'src/nosql/nosql.live.test.ts',
    '--maxWorkers=3',
  ],
  { env, stdio: 'inherit' },
);
process.exitCode = run.status ?? 1;

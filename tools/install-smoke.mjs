// Uses the image's runtime, so the host needs no JavaScript runtime or JSON parser.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Response bodies can contain session credentials, so failures stay on one message-key line.
process.on('uncaughtException', (error) => {
  const firstLine = error.message.split('\n')[0];
  console.error(firstLine.startsWith('installSmoke.') ? firstLine : 'installSmoke.failed');
  process.exit(1);
});

const baseUrl = process.env.RIOSOMA_BASE_URL;
const setupToken = process.env.RIOSOMA_SETUP_TOKEN;
const expectedVersion = process.env.INSTALL_SMOKE_VERSION;
assert(baseUrl && setupToken && expectedVersion, 'installSmoke.configurationMissing');

const id = (prefix) => prefix + randomBytes(7).toString('hex');
const name = id('smoke');
const owner = {
  orgName: name,
  name,
  email: `${name}@example.test`,
  password: randomBytes(32).toString('base64url'),
  locale: 'en-US',
};
let cookie;
let csrfToken;

async function request(method, path, body, setup = false) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(setup ? { 'x-setup-token': setupToken } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrfToken && method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `installSmoke.httpFailed ${method} ${path} ${response.status}`);
  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith('rio_session='));
  if (sessionCookie) cookie = sessionCookie.split(';')[0];
  return response.status === 204 ? undefined : response.json();
}

console.log('installSmoke.setupStatus');
assert.deepEqual(await request('GET', '/api/setup/status'), { stage: 'owner', databaseManaged: true });

console.log('installSmoke.unlock');
await request('POST', '/api/setup/unlock', undefined, true);

console.log('installSmoke.createOwner');
const created = await request('POST', '/api/setup/owner', owner, true);
assert.equal(created.user.email, owner.email, 'installSmoke.ownerMismatch');
assert.equal(created.membership.kind, 'owner', 'installSmoke.ownerRoleMismatch');
assert(cookie && created.csrfToken, 'installSmoke.sessionMissing');
assert.deepEqual(await request('GET', '/api/setup/status'), { stage: 'ready', databaseManaged: true });

console.log('installSmoke.signIn');
// Discard setup's session to prove password sign-in establishes a fresh one.
cookie = undefined;
const session = await request('POST', '/api/auth/sign-in', { email: owner.email, password: owner.password });
assert(cookie && session.csrfToken, 'installSmoke.sessionMissing');
assert.equal(session.user.id, created.user.id, 'installSmoke.ownerMismatch');
csrfToken = session.csrfToken;
assert.equal((await request('GET', '/api/auth/session')).user.id, created.user.id, 'installSmoke.ownerMismatch');

console.log('installSmoke.createDatabaseAndTable');
const databaseId = id('db');
const tableId = id('tbl');
const fieldId = id('fld');
const viewId = id('viw');
const schema = await request('POST', '/api/databases', {
  id: databaseId,
  name,
  table: {
    id: tableId,
    name,
    fields: [{ id: fieldId, name, type: 'text' }],
    view: { id: viewId, name },
    records: [],
  },
});
assert.equal(schema.database.id, databaseId, 'installSmoke.databaseMismatch');
assert(schema.tables.some((table) => table.id === tableId), 'installSmoke.tableMissing');

console.log('installSmoke.createRecord');
const recordId = id('rec');
const value = randomBytes(16).toString('hex');
const result = await request('POST', `/api/databases/${databaseId}/commands`, {
  clientId: id('cli'),
  commands: [{
    id: id('cmd'),
    groupId: id('act'),
    kind: 'record.create',
    tableId,
    records: [{ id: recordId, values: { [fieldId]: value } }],
  }],
});
// A rejected command still returns HTTP 200, so transport success alone is insufficient.
assert.deepEqual(result.results.map((item) => item.status), ['applied'], 'installSmoke.commandRejected');

console.log('installSmoke.readRecord');
const row = await request('GET', `/api/tables/${tableId}/records/${recordId}`);
assert.equal(row.id, recordId, 'installSmoke.recordMismatch');
assert.equal(row.values[fieldId], value, 'installSmoke.valueMismatch');

console.log('installSmoke.checkVersion');
// The connector service answers too, so every kind of source can connect.
assert.deepEqual(await request('GET', '/healthz'), { status: 'ok', version: expectedVersion, connectors: 'ok' });

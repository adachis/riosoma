import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { definition, messages, root } from '../app.mjs';
import {
  component,
  contract,
  document,
  fieldId,
  ids,
  json,
  loaded,
  payload,
  plain,
  project,
  read,
  record,
  render,
  runner,
  runtime,
  table,
  types,
  validate,
} from './runtime.mjs';

const schema = { tables: [table] };
const response = (request) => ({ body: request.url.endsWith('/tables') ? schema : { records: [record] } });
const moduleRun = (name, parameters = {}, respond = response) => {
  const run = runner(parameters);
  const scopes =
    name === 'apiCall'
      ? ['schema.bases:read', 'schema.bases:write', 'data.records:read', 'data.records:write']
      : component('module', name, 'scope');
  const value = run.execute(component('module', name, 'communication'), respond, scopes);
  return { ...run, value };
};

// The interpreter only covers expressions used by this app, and never claims to be Make's engine.
test('every source parses and generated native files match the catalog and definition', async () => {
  async function walk(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const path = directory + entry.name;
      if (entry.isDirectory()) await walk(path + '/');
      else if (path.endsWith('.json')) JSON.parse(await read(path));
      else if (/\.(?:mjs|js)$/.test(path))
        execFileSync(process.execPath, ['--check', fileURLToPath(new URL(path, root))], { stdio: 'pipe' });
    }
  }
  await walk('');
  for (const [path, expected] of await definition()) assert.equal(await read(path), expected, path);
  assert.equal(project.fileVersion, 1);
  assert.deepEqual(project.origins, []);
  assert.equal(loaded.app.name, 'riosoma');
  assert.equal(loaded.app.label, messages['app.name']);
  const values = new Set(Object.values(messages));
  function localized(value) {
    if (Array.isArray(value)) value.forEach(localized);
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (
          ['label', 'help', 'description', 'message'].includes(key) &&
          typeof entry === 'string' &&
          !entry.includes('{{')
        )
          assert.ok(values.has(entry), entry);
        localized(entry);
      }
    }
  }
  for (const [path, contents] of loaded.files) if (path.endsWith('.json')) localized(JSON.parse(contents));
  for (const key of Object.keys(project.components.function))
    assert.ok((await read(project.components.function[key].codeFiles.code)).length <= 5000, key);
  const packageFile = JSON.parse(await read('package.json'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    assert.equal(packageFile[key], undefined);
});

test('the connection verifies a token with an HTTPS authenticated database read and sanitizes it', () => {
  const communication = component('connection', 'riosoma', 'communication');
  const context = runner({ server: 'https://riosoma.example.invalid/', token: 'unused' }).context;
  const request = render(
    { url: communication.url, method: communication.method, headers: communication.headers },
    context,
  );
  contract(request, ['schema.bases:read']);
  assert.equal(request.url, 'https://riosoma.example.invalid/api/v1/databases');
  assert.equal(request.headers.Authorization, 'Bearer unused');
  assert.equal(communication.followRedirects, false);
  assert.equal(communication.followAllRedirects, false);
  assert.ok(communication.log.sanitize.includes('request.headers.Authorization'));
  const params = component('connection', 'riosoma', 'params');
  assert.equal(params.find((entry) => entry.name === 'token').type, 'password');
  assert.match(params.find((entry) => entry.name === 'token').help, /Settings, then Personal access tokens/);
  const base = json(project.generalCodeFiles.base);
  assert.ok(base.log.sanitize.includes('request.headers.Authorization'));
  assert.ok(base.log.sanitize.includes('response.body.secret'));
  const f = runtime();
  for (const value of [
    'http://localhost',
    'https://user:password@example.invalid',
    'https://example.invalid/api/v1',
    'https://example.invalid/?query',
    'https://example.invalid/#fragment',
    'https://example.invalid:0',
    'https://example.invalid:65536',
    'https://example.invalid\\other',
  ])
    assert.throws(() => f.riosomaOrigin(value));
});

test('database, table, and view RPCs produce the label and value options their modules use', () => {
  const examples = {
    databases: { databases: [{ id: ids.database, name: 'Database' }] },
    tables: schema,
    views: schema,
  };
  for (const [name, body] of Object.entries(examples)) {
    const run = runner();
    const result = run.execute(component('rpc', name, 'communication'), () => ({ body }), [
      'schema.bases:read',
    ]);
    assert.equal(result.length, 1);
    assert.deepEqual(Object.keys(result[0]).sort(), ['label', 'value']);
    assert.equal(typeof result[0].label, 'string');
    assert.equal(
      result[0].value,
      ids[name === 'databases' ? 'database' : name === 'tables' ? 'table' : 'view'],
    );
  }
  for (const name of ['createRecord', 'updateRecord', 'getRecord', 'searchRecords']) {
    const inputs = component('module', name, 'mappableParams');
    assert.equal(inputs[0].options.store, 'rpc://databases');
    assert.equal(inputs[0].options.nested[0].options.store, 'rpc://tables');
    assert.equal(inputs[0].mappable, false);
  }
  assert.equal(
    component('webhook', 'watchNewRecordsInView', 'params')[0].options.nested[0].options.nested[0].options,
    'rpc://views',
  );
});

test('writable field RPCs produce typed dynamic inputs and omit every computed field', () => {
  const run = runner();
  const fields = run.execute(component('rpc', 'fields', 'communication'), () => ({ body: schema }), [
    'schema.bases:read',
  ]);
  assert.equal(fields.length, 23);
  assert.deepEqual(
    fields.map((entry) => entry.name),
    table.fields.slice(0, 23).map((field) => field.id),
  );
  assert.equal(fields.find((entry) => entry.name === fieldId(1)).type, 'number');
  assert.equal(fields.find((entry) => entry.name === fieldId(18)).type, 'date');
  assert.equal(fields.find((entry) => entry.name === fieldId(19)).type, 'url');
  assert.equal(fields.find((entry) => entry.name === fieldId(20)).type, 'email');
  const checkbox = fields.find((entry) => entry.name === fieldId(2));
  assert.equal(checkbox.type, 'select');
  assert.deepEqual(
    checkbox.options.map((entry) => entry.value),
    [true, false],
  );
  assert.equal(checkbox.default, undefined);
  assert.deepEqual(fields.find((entry) => entry.name === fieldId(3)).options, [
    { label: 'Ready', value: 'Ready' },
  ]);
  for (const index of [5, 6, 7, 8, 9, 10, 11, 12, 13])
    assert.equal(fields.find((entry) => entry.name === fieldId(index)).help, messages['field.json']);
  for (const name of ['createRecord', 'updateRecord']) {
    const inputs = component('module', name, 'mappableParams')[0].options.nested[0].options.nested;
    assert.equal(inputs.find((entry) => entry.name === 'fields').spec, 'rpc://fields');
  }
  const search = runner().execute(
    component('rpc', 'searchFields', 'communication'),
    () => ({ body: schema }),
    ['schema.bases:read'],
  );
  assert.equal(search.length, 12);
  for (const entry of search)
    assert.ok(
      [
        'text',
        'longText',
        'url',
        'email',
        'phone',
        'barcode',
        'number',
        'currency',
        'percent',
        'duration',
        'rating',
        'checkbox',
      ].includes(table.fields.find((field) => field.id === entry.value).type),
    );
  assert.throws(() => runtime().riosomaTable([], ids.table));
});

test('create and update requests conform to their OpenAPI scopes and request schemas', () => {
  const fields = {
    [fieldId(0)]: '',
    [fieldId(1)]: 0,
    [fieldId(2)]: false,
    [fieldId(5)]: '[]',
    [fieldId(9)]: '{"nested":true}',
    [fieldId(23)]: 'ignored',
    unknown: 'ignored',
  };
  for (const name of ['createRecord', 'updateRecord']) {
    const run = moduleRun(name, { fields, record: `${ids.record}:42` });
    assert.deepEqual(run.value, record);
    const request = run.calls[1];
    assert.equal(request.method, name === 'createRecord' ? 'POST' : 'PATCH');
    assert.deepEqual(request.body.records[0].fields, {
      [fieldId(0)]: '',
      [fieldId(1)]: 0,
      [fieldId(2)]: false,
      [fieldId(5)]: [],
      [fieldId(9)]: { nested: true },
    });
    assert.deepEqual(Object.keys(request.body).sort(), ['fieldKey', 'records']);
    assert.equal(request.body.records[0].id, name === 'createRecord' ? undefined : ids.record);
    assert.deepEqual(request.qs, { shape: 'airtable', fieldKey: 'id' });
  }
  const run = moduleRun('updateRecord', {
    fields: { [fieldId(0)]: 'Only this', [fieldId(1)]: undefined, [fieldId(2)]: null },
  });
  assert.deepEqual(run.calls[1].body.records[0].fields, { [fieldId(0)]: 'Only this' });
  for (const bad of [
    {},
    { [fieldId(1)]: '' },
    { [fieldId(1)]: 'Infinity' },
    { [fieldId(2)]: 'yes' },
    { [fieldId(9)]: '{broken' },
  ])
    assert.throws(() => moduleRun('createRecord', { fields: bad }));
  validate(document.components.schemas.RecordsWrite, { records: [{ fields: {} }] });
  assert.throws(() =>
    validate(document.components.schemas.RecordsWrite, { records: [{ fields: {}, id: 'invalid' }] }),
  );
});

test('Get a Record uses the record route, response shape, and read scope', () => {
  const run = moduleRun('getRecord');
  assert.equal(new URL(run.calls[0].url).pathname, `/api/v1/tables/${ids.table}/records/${ids.record}`);
  assert.deepEqual(run.value, record);
  assert.throws(() => moduleRun('getRecord', {}, () => ({ body: { records: [] } })));
});

test('date inputs serialize as API strings and invalid dates use a localized error', () => {
  const run = moduleRun('createRecord', { fields: { [fieldId(18)]: new Date('2026-10-18T12:00:00Z') } });
  assert.equal(run.calls[1].body.records[0].fields[fieldId(18)], '2026-10-18T12:00:00.000Z');
  assert.throws(
    () => moduleRun('createRecord', { fields: { [fieldId(18)]: new Date('invalid') } }),
    (error) => error.message === messages['error.input'],
  );
});

test('equality searches match text, numeric, and checkbox behavior and reject unsupported fields', () => {
  for (const [index, value, operator, expected] of [
    [0, 'Hello', 'is', 'Hello'],
    [1, '3.5', 'eq', 3.5],
    [2, 'false', 'is', false],
  ]) {
    const run = moduleRun('searchRecords', { searchField: fieldId(index), searchValue: value });
    assert.deepEqual(run.value, [record]);
    const filter = JSON.parse(run.calls[1].qs.filter);
    assert.deepEqual(filter, {
      conjunction: 'and',
      conditions: [{ id: 'match', fieldId: fieldId(index), operator, value: expected }],
    });
  }
  for (const [index, value] of [
    [0, ''],
    [1, 'NaN'],
    [2, 'yes'],
    [3, 'Ready'],
    [5, '[]'],
    [23, 'text'],
  ])
    assert.throws(() => moduleRun('searchRecords', { searchField: fieldId(index), searchValue: value }));
});

test('search follows cursors until completion or 1,000 records and rejects repeated cursors', () => {
  let page = 0;
  const run = moduleRun('searchRecords', { searchField: fieldId(0), searchValue: 'Example' }, (request) => {
    if (request.url.endsWith('/tables')) return { body: schema };
    page++;
    assert.equal(request.qs.cursor, page === 1 ? undefined : `page-${page}`);
    return { body: { records: Array.from({ length: 100 }, () => record), offset: `page-${page + 1}` } };
  });
  assert.equal(run.value.length, 1000);
  assert.equal(page, 10);
  assert.throws(
    () =>
      moduleRun('searchRecords', { searchField: fieldId(0), searchValue: 'Example' }, (request) => ({
        body: request.url.endsWith('/tables') ? schema : { records: [record], offset: 'repeated' },
      })),
    /cursor/,
  );
  const short = moduleRun(
    'searchRecords',
    { searchField: fieldId(0), searchValue: 'Example' },
    (request) => ({ body: request.url.endsWith('/tables') ? schema : { records: [] } }),
  );
  assert.deepEqual(short.value, []);
  assert.equal(short.calls.length, 2);
});

test('the universal call stays on the connection origin and under /api/v1', () => {
  const run = moduleRun('apiCall', { path: '/api/v1/databases', method: 'GET' }, () => ({
    body: { databases: [] },
  }));
  assert.equal(run.calls[0].url, 'https://riosoma.example.invalid/api/v1/databases');
  assert.equal(run.calls[0].headers.Authorization, 'Bearer unused');
  assert.deepEqual(run.value, { body: { databases: [] }, headers: {}, statusCode: 200 });
  const write = moduleRun('apiCall', {
    path: `/api/v1/tables/${ids.table}/records`,
    method: 'PATCH',
    query: [{ key: 'shape', value: 'airtable' }],
    body: JSON.stringify({
      fieldKey: 'id',
      records: [{ id: ids.record, fields: { [fieldId(0)]: 'Changed' } }],
    }),
  });
  assert.equal(write.calls[0].method, 'PATCH');
  assert.equal(write.calls[0].body.records[0].fields[fieldId(0)], 'Changed');
  const f = runtime();
  for (const path of [
    'https://elsewhere.invalid/api/v1/databases',
    '//elsewhere.invalid',
    '/api/v10/databases',
    '/api/v1/../tokens',
    '/api/v1/./databases',
    '/api/v1/%2e%2e/tokens',
    '/api/v1/%252e%252e/tokens',
    '/api/v1/records?key=value',
    '/api/v1/records#part',
    '/api/v1\\other',
    '/api/v1//other',
  ])
    assert.throws(() => f.riosomaApi('path', path));
  assert.equal(f.riosomaApi('path', '/api/v1/openapi.json'), '/api/v1/openapi.json');
  assert.throws(() => f.riosomaApi('method', 'CONNECT'));
});

test('all three webhooks attach and detach through scoped API routes and keep their database and hook IDs', () => {
  for (const [name, event] of [
    ['watchNewRecords', 'record.created'],
    ['watchUpdatedRecords', 'record.updated'],
    ['watchNewRecordsInView', 'record.created'],
  ]) {
    const run = runner({}, { webhook: { url: 'https://hooks.example.invalid/receive' } });
    const scopes = component('webhook', name, 'requiredScope');
    const attach = component('webhook', name, 'attach');
    run.execute(attach, () => ({ body: { id: ids.hook, secret: 'unused' } }), scopes);
    assert.deepEqual(run.calls[0].body, {
      url: 'https://hooks.example.invalid/receive',
      events: [event],
      tableIds: [ids.table],
    });
    const saved = plain(render(attach.response.data, run.context));
    assert.equal(saved.hookId, ids.hook);
    assert.equal(saved.database, ids.database);
    assert.equal(saved.secret, undefined);
    const detach = runner({}, { webhook: saved });
    detach.execute(component('webhook', name, 'detach'), () => ({ status: 204 }), scopes);
    assert.equal(
      new URL(detach.calls[0].url).pathname,
      `/api/v1/databases/${ids.database}/webhooks/${ids.hook}`,
    );
    assert.equal(detach.calls[0].method, 'DELETE');
    runner({}, { webhook: saved }).execute(
      component('webhook', name, 'detach'),
      () => ({ status: 404 }),
      scopes,
    );
    assert.equal(project.components.module[name].webhook, name);
  }
});

test('webhook batches filter the event, database, and table, sort events, and fetch current records', () => {
  for (const [name, event] of [
    ['watchNewRecords', 'record.created'],
    ['watchUpdatedRecords', 'record.updated'],
    ['watchNewRecordsInView', 'record.created'],
  ]) {
    const communication = component('webhook', name, 'communication');
    const context = runner().context;
    context.body = {
      ...payload,
      events: [
        { ...payload.events[0], event, seq: 2 },
        { ...payload.events[0], event, seq: 1 },
        { ...payload.events[0], event: 'record.deleted' },
        { ...payload.events[0], event, tableId: 'other' },
        { ...payload.events[0], event, databaseId: 'other' },
      ],
    };
    const events = render(communication.iterate.container, context);
    assert.equal(events.length, 2);
    assert.deepEqual(plain(events.map((entry) => entry.seq)), [1, 2]);
    for (const item of events) {
      context.item = item;
      const bundle = render(communication.output, context);
      const run = runner({}, { payload: bundle });
      const output = run.execute(
        component('module', name, 'communication'),
        () => ({ body: { records: [record] } }),
        component('module', name, 'scope'),
      );
      assert.equal(output.recordId, ids.record);
      assert.equal(output.id, event === 'record.updated' ? `${ids.record}:${item.seq}` : ids.record);
      assert.deepEqual(output.fields, record.fields);
      assert.equal(run.calls[0].qs.view, name === 'watchNewRecordsInView' ? ids.view : undefined);
    }
    const missing = runner({}, { payload: events[0] });
    assert.equal(
      missing.execute(
        component('module', name, 'communication'),
        () => ({ status: 404, body: { error: {} } }),
        component('module', name, 'scope'),
      ),
      undefined,
    );
    assert.equal(runtime().riosomaRecord({ records: [] }, events[0]), undefined);
  }
  const f = runtime();
  assert.deepEqual(plain(f.riosomaEvents({ ...payload, databaseId: 'other' }, ids, 'record.created')), []);
  assert.deepEqual(
    plain(f.riosomaEvents({ ...payload, events: Array(101).fill(payload.events[0]) }, ids, 'record.created')),
    [],
  );
});

test('documented limitations include raw-body signatures, enrichment, and owner deployment', async () => {
  const readme = await read('README.md');
  assert.match(readme, /cannot verify.*signature/i);
  assert.match(readme, /raw.*body/i);
  assert.match(readme, /custom IML functions/i);
  assert.match(readme, /sdk-apps:read/);
  assert.match(readme, /sdk-apps:write/);
  assert.match(readme, /not.*deploy|No.*deploy/i);
  assert.equal(
    Object.values(project.components.module).filter((entry) => entry.moduleType === 'instant_trigger').length,
    3,
  );
  assert.equal(
    Object.keys(project.components.module).some((name) => /delete/i.test(name)),
    false,
  );
  assert.equal(types.length, 35);
});

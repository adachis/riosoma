import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deploy, deploymentPlan, loadApp } from '../deploy.mjs';
import { root } from '../app.mjs';

function account() {
  const state = { apps: [], functions: [], connections: [], webhooks: [], rpcs: [], modules: [] };
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.host, 'us2.make.com');
    assert.equal(options.redirect, 'error');
    const path = parsed.pathname.replace('/api/v2', '');
    const body =
      options.body === undefined
        ? undefined
        : options.headers['Content-Type'] === 'application/json'
          ? JSON.parse(options.body)
          : options.body;
    calls.push({ method: options.method, path, body, mime: options.headers['Content-Type'] });
    const result = (value) => ({ ok: true, status: 200, json: async () => value });
    const method = options.method;
    if (method === 'GET' && /^\/sdk\/apps\/riosoma\/1\/modules\/[A-Za-z0-9_-]+$/.test(path)) {
      return result({ appModule: state.modules.find((entry) => entry.name === path.split('/').at(-1)) });
    }
    if (path === '/sdk/apps') {
      if (method === 'GET') return result({ apps: state.apps });
      assert.equal(method, 'POST');
      state.apps.push({ ...body.app });
      return result({ app: body.app });
    }
    const match = /^\/sdk\/apps\/riosoma(?:\/1)?\/(functions|connections|webhooks|rpcs|modules)$/.exec(path);
    if (match) {
      const kind = match[1];
      const keys = {
        functions: ['appFunctions', 'appFunction'],
        connections: ['appConnections', 'appConnection'],
        webhooks: ['appWebhooks', 'appWebhook'],
        rpcs: ['appRpcs', 'appRpc'],
        modules: ['appModules', 'appModule'],
      };
      if (method === 'GET') return result({ [keys[kind][0]]: state[kind] });
      assert.equal(method, 'POST');
      if (kind === 'connections') assert.equal(body.type, 'basic');
      const name = body.name || `riosoma-${kind}-${state[kind].length + 1}`;
      const value = { ...body, name };
      if (kind === 'webhooks' || kind === 'modules' || kind === 'rpcs') {
        assert.ok(state.connections.some((entry) => entry.name === body.connection));
      }
      if (kind === 'modules' && body.typeId === 10)
        assert.ok(state.webhooks.some((entry) => entry.name === body.webhook));
      if (kind === 'modules' && body.typeId === 12) assert.equal(body.subtype, 'Universal');
      state[kind].push(value);
      return result({ [keys[kind][1]]: value });
    }
    if (method === 'PATCH') return result({ changed: true });
    if (path.endsWith('/base')) assert.equal(method, 'POST');
    else assert.equal(method, 'PUT');
    if (path.endsWith('/code')) assert.equal(options.headers['Content-Type'], 'application/javascript');
    if (path.endsWith('/readme')) assert.equal(options.headers['Content-Type'], 'text/markdown');
    return result({ changed: true });
  };
  return { state, calls, fetch };
}

test('--check is credential-free, validates files, lists every part, and never calls a transport', async () => {
  const app = await loadApp();
  const log = [];
  await deploy({
    check: true,
    env: {},
    fetch: () => assert.fail('Offline check called the network'),
    log: (line) => log.push(line),
  });
  assert.equal(log.length, deploymentPlan(app).length + 1);
  for (const name of deploymentPlan(app)) assert.ok(log.includes(`${name} 1 planned`), name);
  assert.equal(log.at(-1), 'riosoma 1 valid');
  const stdout = execFileSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,globalThis.fetch=()=>{throw new Error("network disabled")}',
      'deploy.mjs',
      '--check',
    ],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, MAKE_API_TOKEN: '', MAKE_ZONE: '' },
      encoding: 'utf8',
    },
  );
  assert.match(stdout, /riosoma 1 valid/);
  assert.match(stdout, /watchNewRecordsInView\/attach 1 planned/);
});

test('deployment creates every component and section with the documented endpoints and assigned names', async () => {
  const mock = account();
  const output = [];
  const token = randomUUID();
  const options = {
    env: { MAKE_API_TOKEN: token, MAKE_ZONE: 'us2.make.com' },
    fetch: mock.fetch,
    log: (line) => output.push(line),
  };
  await deploy(options);
  assert.equal(mock.state.apps.length, 1);
  assert.equal(mock.state.connections.length, 1);
  assert.equal(mock.state.webhooks.length, 3);
  assert.equal(mock.state.modules.length, 8);
  assert.equal(mock.state.rpcs.length, 5);
  const app = await loadApp();
  assert.equal(mock.state.functions.length, Object.keys(app.project.components.function).length);
  const codeIndex = mock.calls.findIndex((entry) => entry.path.endsWith('/functions/riosomaOrigin/code'));
  const connectionIndex = mock.calls.findIndex(
    (entry) => entry.path.endsWith('/connections') && entry.method === 'POST',
  );
  assert.ok(codeIndex < connectionIndex);
  assert.ok(mock.calls.some((entry) => entry.method === 'POST' && entry.path === '/sdk/apps/riosoma/1/base'));
  const section = {
    communication: 'api',
    params: 'parameters',
    staticParams: 'parameters',
    mappableParams: 'expect',
    requiredScope: 'scope',
  };
  for (const [kind, components] of Object.entries(app.project.components)) {
    for (const [name, component] of Object.entries(components)) {
      const remote =
        kind === 'connection'
          ? mock.state.connections.find((entry) => entry.label === component.label).name
          : kind === 'webhook'
            ? mock.state.webhooks.find((entry) => entry.label === component.label).name
            : name;
      for (const [key, file] of Object.entries(component.codeFiles)) {
        const path = ['connection', 'webhook'].includes(kind)
          ? `/sdk/apps/${kind}s/${remote}/${section[key] || key}`
          : `/sdk/apps/riosoma/1/${kind}s/${remote}/${section[key] || key}`;
        const request = mock.calls.find((entry) => entry.method === 'PUT' && entry.path === path);
        assert.ok(request, path);
        assert.deepEqual(
          request.body,
          file.endsWith('.js') ? app.files.get(file) : JSON.parse(app.files.get(file)),
        );
      }
    }
  }
  const creations = mock.calls.filter(
    (entry) => entry.method === 'POST' && !entry.path.endsWith('/base'),
  ).length;
  await deploy(options);
  assert.equal(
    mock.calls.filter((entry) => entry.method === 'POST' && !entry.path.endsWith('/base')).length,
    creations,
  );
  assert.equal(mock.state.connections.length, 1);
  assert.equal(mock.state.webhooks.length, 3);
  assert.ok(output.every((line) => /^[A-Za-z0-9_/-]+ 1 (?:created|updated)$/.test(line)));
  assert.equal(output.join('\n').includes(token), false);
});

test('deployment creates the basic connection declared in the local app', async () => {
  const mock = account();
  await deploy({
    env: { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'us2.make.com' },
    fetch: mock.fetch,
    log: () => {},
  });
  assert.equal(mock.state.connections[0].type, 'basic');
});

test('deployment reuses an existing basic connection and uploads its sections', async () => {
  const mock = account();
  const connection = { name: 'riosoma-existing', label: 'Riosoma', type: 'basic' };
  mock.state.connections.push(connection);
  await deploy({
    env: { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'us2.make.com' },
    fetch: mock.fetch,
    log: () => {},
  });
  assert.equal(mock.state.connections.length, 1);
  assert.equal(
    mock.calls.some((entry) => entry.method === 'POST' && entry.path === '/sdk/apps/riosoma/connections'),
    false,
  );
  for (const section of ['parameters', 'api'])
    assert.ok(
      mock.calls.some(
        (entry) =>
          entry.method === 'PUT' && entry.path === `/sdk/apps/connections/${connection.name}/${section}`,
      ),
    );
  for (const module of mock.state.modules) assert.equal(module.connection, connection.name);
});

test('deployment reads the appRpcs envelope, reuses existing RPCs, and continues through module uploads', async () => {
  const mock = account();
  mock.state.rpcs.push({ name: 'databases', label: 'Databases' });
  await deploy({
    env: { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'us2.make.com' },
    fetch: mock.fetch,
    log: () => {},
  });
  assert.equal(mock.state.rpcs.length, 5);
  assert.equal(
    mock.calls.some(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/rpcs') && entry.body.name === 'databases',
    ),
    false,
  );
  for (const section of ['api', 'parameters'])
    assert.ok(
      mock.calls.some(
        (entry) => entry.method === 'PUT' && entry.path === `/sdk/apps/riosoma/1/rpcs/databases/${section}`,
      ),
    );
  assert.equal(mock.state.modules.length, 8);
  assert.ok(
    mock.calls.some(
      (entry) => entry.method === 'PUT' && entry.path === '/sdk/apps/riosoma/1/modules/apiCall/api',
    ),
  );
});

test('deployment creates Make an API Call with the required Universal subtype', async () => {
  const mock = account();
  await deploy({
    env: { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'us2.make.com' },
    fetch: mock.fetch,
    log: () => {},
  });
  const module = mock.state.modules.find((entry) => entry.name === 'apiCall');
  assert.equal(module.typeId, 12);
  assert.equal(module.subtype, 'Universal');
  assert.equal(module.moduleInitMode, 'blank');
  for (const other of mock.state.modules.filter((entry) => entry.name !== 'apiCall'))
    assert.equal(Object.hasOwn(other, 'subtype'), false);
});

test('bad zones, missing credentials, API failures, ambiguous matches, and incompatible types stop safely', async () => {
  for (const env of [
    {},
    { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'https://us2.make.com' },
    { MAKE_API_TOKEN: randomUUID(), MAKE_ZONE: 'us2.make.com.attacker.invalid' },
  ])
    await assert.rejects(
      deploy({ env, fetch: () => assert.fail('Invalid environment called the network'), log: () => {} }),
    );
  const token = randomUUID();
  const env = { MAKE_API_TOKEN: token, MAKE_ZONE: 'us2.make.com' };
  const log = [];
  let readBody = false;
  await assert.rejects(
    deploy({
      env,
      log: (line) => log.push(line),
      fetch: async () => ({
        ok: false,
        status: 403,
        json: async () => {
          readBody = true;
          return { token };
        },
      }),
    }),
    (error) => !error.message.includes(token),
  );
  assert.equal(readBody, false);
  assert.equal(log.length, 0);
  await assert.rejects(
    deploy({
      env,
      log: () => {},
      fetch: async () => {
        throw new Error(token);
      },
    }),
    (error) => !error.message.includes(token),
  );
  const ambiguous = account();
  ambiguous.state.apps.push({ name: 'riosoma', version: 1 }, { name: 'riosoma', version: 1 });
  await assert.rejects(deploy({ env, fetch: ambiguous.fetch, log: () => {} }));
  assert.equal(ambiguous.calls.length, 1);
  const mismatch = account();
  mismatch.state.connections.push({ name: 'riosoma', label: 'Riosoma', type: 'oauth' });
  await assert.rejects(deploy({ env, fetch: mismatch.fetch, log: () => {} }));
  assert.equal(
    mismatch.calls.some((entry) => entry.path.startsWith('/sdk/apps/connections/') && entry.method !== 'GET'),
    false,
  );
});

test('CLI errors print only names, versions, and statuses', () => {
  const result = spawnSync(process.execPath, ['deploy.mjs', '--unknown'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'riosoma 1 failed\n');
});

test('--check refuses stale or malformed generated files without contacting Make', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riosoma-make-'));
  try {
    await cp(fileURLToPath(root), directory, { recursive: true });
    const path = join(directory, 'modules/updateRecord/communication.iml.json');
    for (const content of ['{', '{}\n']) {
      await writeFile(path, content);
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'data:text/javascript,globalThis.fetch=()=>{throw new Error("network disabled")}',
          'deploy.mjs',
          '--check',
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'riosoma 1 failed\n');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

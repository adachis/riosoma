import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { standIn, unreachableScanner } from './scan-test-support.js';
import { checkFileSafety, outsideFilesAllowed } from './safety.js';
import { actorFor } from '../../automations/run.js';
import { runOrganizationCommand } from '../commands/organization.js';
import { fileSafetySettings } from './settings.js';

let kit: TestPostgres;
let server: ServerFixture;
let scanner: Awaited<ReturnType<typeof standIn>>;
let security: SignedIn;
let people: SignedIn;
let member: SignedIn;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'scannercontrols');
  scanner = await standIn();
  server.config.clamavApprovedUrls = [scanner.url];
  security = await server.addMember();
  people = await server.addMember();
  member = await server.addMember();
  for (const [person, roles] of [
    [security, ['security']],
    [people, ['people']],
  ] as const) {
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: server.owner.headers,
      payload: { kind: 'organization.roles', userId: person.userId, roles },
    });
    expect(result.statusCode, result.body).toBe(200);
  }
}, 60_000);
afterAll(async () => {
  await server?.close();
  await scanner?.close();
  await kit?.stop();
});
const call = (who: SignedIn, method: 'GET' | 'POST' | 'PUT', suffix = '', payload?: object) =>
  server.app.inject({
    method,
    url: `/api/org/files/scanner${suffix}`,
    headers: who.headers,
    ...(payload ? { payload } : {}),
  });
const settings = (enabled: boolean, address: string | null = scanner.url) => ({
  enabled,
  address,
  oversizedPolicy: 'quarantine',
});

it('restricts all scanner controls to owners and organization Security admins', async () => {
  for (const who of [member, people]) {
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['POST', '/detect', { address: scanner.url }],
      ['POST', '/test', { address: scanner.url }],
      ['PUT', '', settings(true)],
    ] as const) {
      expect((await call(who, method, suffix, payload)).statusCode).toBe(403);
    }
  }
  expect(scanner.received).toHaveLength(0);
});

it('detects, tests, enables, and disables scanning without changing the upload cap', async () => {
  expect((await call(server.owner, 'GET')).json().settings).toEqual(settings(false, null));
  for (const action of ['detect', 'test']) {
    const result = await call(security, 'POST', `/${action}`, { address: scanner.url });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ reachable: true, tested: true, lastError: null });
  }
  const enabled = await call(security, 'PUT', '', settings(true));
  expect(enabled.statusCode, enabled.body).toBe(200);
  expect(enabled.json().settings).toEqual(settings(true));
  expect((await call(server.owner, 'GET')).json()).toMatchObject({
    settings: settings(true),
    status: { reachable: true, signatureDate: '2026-10-01T08:00:00.000Z' },
  });
  expect((await call(server.owner, 'PUT', '', settings(false))).statusCode).toBe(200);
  expect((await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()).toEqual({
    maxUploadBytes: null,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const events = await server.pool.query(
    `SELECT action FROM "${server.schemas.audit}".events WHERE action LIKE 'organization.files.scanner.%'`,
  );
  expect(events.rows.map((event) => event.action)).toEqual(
    expect.arrayContaining([
      'organization.files.scanner.detect',
      'organization.files.scanner.test',
      'organization.files.scanner.changed',
    ]),
  );
});

it('refuses to enable unreachable or incorrectly configured scanners and reports the last error', async () => {
  const missing = await unreachableScanner();
  server.config.clamavApprovedUrls!.push(missing);
  const result = await call(server.owner, 'PUT', '', settings(true, missing));
  expect(result.statusCode).toBe(503);
  expect((await call(server.owner, 'GET')).json().settings.enabled).toBe(false);
  const failing = await standIn({ result: 'stream: OK\0' });
  server.config.clamavApprovedUrls!.push(failing.url);
  try {
    expect((await call(server.owner, 'PUT', '', settings(false, failing.url))).statusCode).toBe(200);
    const tested = await call(server.owner, 'POST', '/test', { address: failing.url });
    expect(tested.json().lastError).toBe('files.scanner.testFailed');
    expect((await call(server.owner, 'GET')).json().status.lastError).toBe('files.scanner.testFailed');
    expect((await call(server.owner, 'PUT', '', settings(true, failing.url))).statusCode).toBe(503);
    expect((await call(server.owner, 'GET')).json().settings.enabled).toBe(false);
  } finally {
    await failing.close();
  }
});

it('rejects malformed addresses and missing addresses before enabling scanning', async () => {
  for (const address of [
    null,
    'http://127.0.0.1:3310',
    `tcp://${randomUUID()}:${randomUUID()}@127.0.0.1:3310`,
    'tcp://localhost:99999',
    'unix://host/path',
  ]) {
    const result = await call(server.owner, 'PUT', '', settings(true, address));
    expect([400, 422]).toContain(result.statusCode);
  }
});

it('defaults outside files to requiring a tested scanner and audits authorized policy changes', async () => {
  const orgId = server.owner.info.org.id;
  const context = { db: server.pool, schema: server.schemas.app, orgId, config: server.config };
  const defaults = { outsideFiles: 'requireScanner', allowOutsideMacros: false };
  const changed = { outsideFiles: 'builtInChecksOnly', allowOutsideMacros: true };
  expect(await fileSafetySettings(server.pool, server.schemas.app, orgId)).toEqual(defaults);
  expect(await outsideFilesAllowed(context)).toBe(false);
  for (const who of [member, people]) {
    expect((await server.app.inject({ url: '/api/org/files/safety', headers: who.headers })).statusCode).toBe(
      403,
    );
    for (const url of ['/api/org/files/safety', '/api/org/admin-commands']) {
      const response = await server.app.inject({
        method: url.endsWith('safety') ? 'PUT' : 'POST',
        url,
        headers: who.headers,
        payload: url.endsWith('safety') ? changed : { kind: 'organization.files.safety', ...changed },
      });
      expect(response.statusCode, response.body).toBe(403);
    }
  }
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/org/admin-commands',
    headers: security.headers,
    payload: { kind: 'organization.files.safety', ...changed },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().fileSafety).toEqual(changed);
  expect(
    (await server.app.inject({ url: '/api/org/files/safety', headers: security.headers })).json(),
  ).toEqual(changed);
  expect(await outsideFilesAllowed(context)).toBe(true);
  const audit = await server.pool.query(
    `SELECT actor_id, metadata FROM "${server.schemas.audit}".events WHERE action = 'organization.files.safety'`,
  );
  expect(audit.rows).toContainEqual(
    expect.objectContaining({
      actor_id: security.userId,
      metadata: expect.objectContaining({ before: defaults, after: changed }),
    }),
  );
  const actor = await actorFor(server.pool, server.schemas, security.userId, orgId);
  await expect(
    runOrganizationCommand(
      server.app,
      { ...actor!, demo: true },
      { kind: 'organization.files.safety', ...defaults },
    ),
  ).rejects.toThrow('demo.readOnly');
  expect(await fileSafetySettings(server.pool, server.schemas.app, orgId)).toEqual(changed);
  expect(
    (
      await server.pool.query(
        `SELECT count(*)::int AS count FROM "${server.schemas.audit}".events WHERE action = 'organization.files.safety'`,
      )
    ).rows[0].count,
  ).toBe(1);
  const reset = await server.app.inject({
    method: 'PUT',
    url: '/api/org/files/safety',
    headers: security.headers,
    payload: defaults,
  });
  expect(reset.statusCode, reset.body).toBe(200);
});

it('requires the active approved scanner, a passing last self-test, and no recorded outage', async () => {
  const orgId = server.owner.info.org.id;
  const context = { db: server.pool, schema: server.schemas.app, orgId, config: server.config };
  const set = (value: object) =>
    server.pool.query(`UPDATE "${server.schemas.app}".orgs SET settings = $1 WHERE id = $2`, [
      JSON.stringify(value),
      orgId,
    ]);
  await set({ fileScanner: settings(true) });
  expect(await outsideFilesAllowed(context)).toBe(false);
  expect((await call(security, 'POST', '/test', { address: scanner.url })).json().tested).toBe(true);
  expect(await outsideFilesAllowed(context)).toBe(true);
  // Ordinary settings saves and health observations do not overwrite the last self-test.
  expect((await call(security, 'PUT', '', settings(true))).statusCode).toBe(200);
  expect(await outsideFilesAllowed(context)).toBe(true);
  expect((await call(security, 'PUT', '', settings(false))).statusCode).toBe(200);
  expect(await outsideFilesAllowed(context)).toBe(false);
  expect((await call(security, 'PUT', '', settings(true))).statusCode).toBe(200);
  const approved = server.config.clamavApprovedUrls;
  server.config.clamavApprovedUrls = [];
  expect(await outsideFilesAllowed(context)).toBe(false);
  expect(await checkFileSafety(context, { bytes: Buffer.from('private file') })).toMatchObject({
    state: 'held',
    reason: 'files.scanner.addressNotApproved',
  });
  server.config.clamavApprovedUrls = approved;
  const missing = await unreachableScanner();
  server.config.clamavApprovedUrls!.push(missing);
  await set({
    fileScanner: settings(true, missing),
    fileScannerSelfTest: { address: scanner.url, tested: true, reachable: true, lastError: null },
  });
  expect(await outsideFilesAllowed(context)).toBe(false);
  await set({
    fileScanner: settings(true),
    fileScannerSelfTest: {
      address: scanner.url,
      tested: false,
      reachable: true,
      lastError: 'files.scanner.testFailed',
    },
  });
  expect(await outsideFilesAllowed(context)).toBe(false);
  await set({
    fileScanner: settings(true),
    fileScannerSelfTest: { address: scanner.url, tested: true, reachable: true, lastError: null },
    fileScannerStatus: { address: scanner.url, reachable: false },
  });
  expect(await outsideFilesAllowed(context)).toBe(false);
  await set({});
});

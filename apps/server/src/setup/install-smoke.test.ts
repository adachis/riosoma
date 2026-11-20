import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { NO_SESSIONS } from '../http/policy.js';
import { MIGRATIONS } from '../migrations/index.js';
import { VERSION } from '../version.js';
import { SetupState } from './state.js';
import { testConnectorService } from '../test/fixture.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../../tools/install-smoke.mjs', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
let kit: TestPostgres;

beforeAll(async () => {
  kit = await startTestPostgres();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function freshServer() {
  const database = await kit.createDatabase('install_smoke');
  cleanups.push(() => database.drop());
  const configDir = mkdtempSync(join(tmpdir(), 'riosoma-install-smoke-'));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  const config = {
    ...loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      RIOSOMA_ARCHIVE_WORK_DIR: join(configDir, 'archives'),
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_DATABASE_PROFILE: JSON.stringify(database.profile),
      NODE_ENV: 'production',
    }),
    logLevel: 'silent' as const,
    embeddingsPollMs: 0,
    libraryIndexPollMs: 0,
  };
  const pool = createPool(database.profile);
  cleanups.push(() => pool.end());
  await migrate(pool, database.profile.schemas, MIGRATIONS);
  const setup = new SetupState(configDir, undefined);
  await setup.refresh(pool, database.profile.schemas.app);
  const app = await buildApp({
    config,
    pool,
    setup,
    sessions: NO_SESSIONS,
    mailer: null,
    connectorService: testConnectorService,
  });
  cleanups.push(() => app.close());
  const routes: string[] = [];
  app.addHook('onRequest', async (request) => {
    routes.push(`${request.method} ${request.routeOptions.url}`);
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  config.baseUrl = baseUrl;
  return {
    app,
    setup,
    routes,
    env: {
      ...process.env,
      RIOSOMA_BASE_URL: baseUrl,
      RIOSOMA_SETUP_TOKEN: setup.currentToken!,
      INSTALL_SMOKE_VERSION: VERSION,
    },
  };
}

it('runs the exact smoke HTTP flow against real routes on a fresh database', async () => {
  const server = await freshServer();
  const { stdout, stderr } = await run(process.execPath, [script], { env: server.env });
  expect(stderr).toBe('');
  expect(stdout.trim().split('\n')).toEqual([
    'installSmoke.setupStatus',
    'installSmoke.unlock',
    'installSmoke.createOwner',
    'installSmoke.signIn',
    'installSmoke.createDatabaseAndTable',
    'installSmoke.createRecord',
    'installSmoke.readRecord',
    'installSmoke.checkVersion',
  ]);
  expect(server.routes).toEqual([
    'GET /api/setup/status',
    'POST /api/setup/unlock',
    'POST /api/setup/owner',
    'GET /api/setup/status',
    'POST /api/auth/sign-in',
    'GET /api/auth/session',
    'POST /api/databases',
    'POST /api/databases/:databaseId/commands',
    'GET /api/tables/:tableId/records/:recordId',
    'GET /healthz',
  ]);
  expect(server.setup.stage).toBe('ready');
  expect(server.setup.verify(server.env.RIOSOMA_SETUP_TOKEN)).toBe(false);
});

it('stops at a rejected setup token before creating an owner or any data', async () => {
  const server = await freshServer();
  await expect(
    run(process.execPath, [script], {
      env: { ...server.env, RIOSOMA_SETUP_TOKEN: randomBytes(32).toString('hex') },
    }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: 'installSmoke.setupStatus\ninstallSmoke.unlock\n',
  });
  expect(server.routes).toEqual(['GET /api/setup/status', 'POST /api/setup/unlock']);
  expect(server.setup.stage).toBe('owner');
});

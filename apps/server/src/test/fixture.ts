import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestCallback, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { newId, type DatabaseProfile, type SessionInfo } from '@riosoma/contracts';
import { createPool, migrate } from '@riosoma/db';
import type { TestPostgres } from '@riosoma/testkit';
import { buildApp, type AppContext } from '../app.js';
import { hashPassword } from '../auth/passwords.js';
import { loadConfig, type RuntimeConfig } from '../config.js';
import { NO_SESSIONS } from '../http/policy.js';
import { MIGRATIONS } from '../migrations/index.js';
import { SetupState } from '../setup/state.js';
import type { ConnectorServiceLink } from '../sources/connector-service.js';

let connectorService: Promise<{ url: string; token: string }> | undefined;

/**
 * The connector service for a test worker's servers: the real service, in this process on a port of
 * this machine, started the first time a test reaches a source it runs.
 */
export const testConnectorService: ConnectorServiceLink = {
  async endpoint() {
    connectorService ??= import('@riosoma/connector-service').then(({ startConnectorService }) =>
      startConnectorService(randomBytes(32).toString('base64url')),
    );
    const { url, token } = await connectorService;
    return { url, token };
  },
};

/**
 * A running server on a fresh database with an owner signed in, for tests that go through the
 * API.  Each call gets its own database and schema names, so test files never share state.
 */
export interface SignedIn {
  userId: string;
  email: string;
  /** Send with every request; includes the CSRF header state-changing requests need */
  headers: { cookie: string; 'x-csrf-token': string };
  info: SessionInfo;
}

export interface ServerFixture {
  app: FastifyInstance;
  ctx: AppContext;
  pool: pg.Pool;
  config: RuntimeConfig;
  schemas: { app: string; data: string; audit: string };
  owner: SignedIn;
  /** Adds a member (or guest) to the organization and signs them in */
  addMember(options?: { name?: string; kind?: 'member' | 'guest' }): Promise<SignedIn>;
  close(): Promise<void>;
}

const PASSWORD = 'a long test password';

function cookieOf(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error(`no session cookie (status ${response.statusCode})`);
  return value.split(';')[0]!;
}

async function signIn(app: FastifyInstance, email: string): Promise<SignedIn> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    payload: { email, password: PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  const info = response.json<SessionInfo>();
  return {
    userId: info.user.id,
    email,
    headers: { cookie: cookieOf(response), 'x-csrf-token': info.csrfToken },
    info,
  };
}

/** Requests use the configured main authority unless a test supplies a different host. */
export function useMainAuthority(app: FastifyInstance, config: RuntimeConfig): void {
  const inject = app.inject.bind(app);
  app.inject = ((options?: InjectOptions | string, callback?: LightMyRequestCallback) => {
    if (options === undefined) return inject();
    const input = typeof options === 'string' ? { url: options } : options;
    const request =
      config.baseUrl && (typeof input.url !== 'string' || !/^https?:/.test(input.url))
        ? { authority: new URL(config.baseUrl).host, ...input }
        : input;
    return callback ? inject(request, callback) : inject(request);
  }) as FastifyInstance['inject'];
}

export async function startServer(
  kit: TestPostgres,
  prefix = 'srv',
  overrides: Partial<RuntimeConfig> = {},
): Promise<ServerFixture> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const database = await kit.createDatabase(prefix);
  cleanups.push(() => database.drop());
  const configDir = mkdtempSync(join(tmpdir(), `rio-${prefix}-`));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  const schemas = { app: `${prefix}_app`, data: `${prefix}_data`, audit: `${prefix}_audit` };
  const profile: DatabaseProfile = { ...database.profile, schemas };
  const config: RuntimeConfig = {
    ...loadConfig({
      RIOSOMA_CONFIG_DIR: configDir,
      // Each test server keeps its own working folders, so no other test run's cleanup reaches them.
      RIOSOMA_ARCHIVE_WORK_DIR: join(configDir, 'archives'),
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_DATABASE_PROFILE: JSON.stringify(profile),
      NODE_ENV: 'production',
    }),
    logLevel: 'silent',
    // Indexing tests drive each pass explicitly, keeping unrelated request measurements deterministic.
    embeddingsPollMs: 0,
    libraryIndexPollMs: 0,
    ...overrides,
  };
  const migrationPool = createPool(profile);
  try {
    await migrate(migrationPool, schemas, MIGRATIONS);
  } finally {
    await migrationPool.end();
  }
  const pool = createPool(profile);
  const setup = new SetupState(config.configDir, undefined);
  await setup.refresh(pool, schemas.app);
  const ctx: AppContext = {
    config,
    pool,
    setup,
    sessions: NO_SESSIONS,
    mailer: null,
    // A test that names the service's address reaches it there instead.
    ...(overrides.connectorServiceUrl ? {} : { connectorService: testConnectorService }),
  };
  const app = await buildApp(ctx);
  useMainAuthority(app, config);
  cleanups.push(async () => {
    await app.close();
    await pool.end();
  });

  const ownerEmail = `owner-${prefix}@example.test`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/setup/owner',
    headers: { 'x-setup-token': setup.currentToken! },
    payload: { orgName: 'Test organization', name: 'Owner', email: ownerEmail, password: PASSWORD },
  });
  if (created.statusCode !== 200) throw new Error(`owner setup failed: ${created.body}`);
  const owner = await signIn(app, ownerEmail);

  let members = 0;
  return {
    app,
    ctx,
    pool,
    config,
    schemas,
    owner,
    async addMember(options = {}) {
      members += 1;
      const userId = newId('user');
      const email = `member${members}-${prefix}@example.test`;
      await pool.query(
        `INSERT INTO "${schemas.app}".users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
        [userId, email, options.name ?? `Member ${members}`, await hashPassword(PASSWORD)],
      );
      await pool.query(
        `INSERT INTO "${schemas.app}".memberships (org_id, user_id, kind) VALUES ($1, $2, $3)`,
        [owner.info.org.id, userId, options.kind ?? 'member'],
      );
      return signIn(app, email);
    },
    async close() {
      while (cleanups.length) await cleanups.pop()?.();
    },
  };
}

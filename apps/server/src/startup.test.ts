import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { ChangedMigrationError, MigrationError, NewerDatabaseError } from '@riosoma/db';
import { refusedPort } from '@riosoma/testkit';
import { waitForDatabase } from './startup-database.js';
import { startupFailure } from './configuration-error.js';
import { loggerOptions } from './logger.js';

// The server's own failure is its last JSON line on stderr.  Node may print its own warnings, such
// as deprecations from dependencies, which vary by Node version.
const lastJson = (stderr: string): unknown =>
  JSON.parse(
    stderr
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .at(-1) ?? 'null',
  );

it.each([
  { setting: 'RIOSOMA_DATABASE_URL', value: 'postgres://user:synthetic-secret@localhost:invalid/db' },
  { setting: 'RIOSOMA_DATABASE_PROFILE', value: '{"password":"synthetic-secret",broken}' },
  { setting: 'RIOSOMA_SETUP_TOKEN', value: 'synthetic-secret+=' },
  { setting: 'RIOSOMA_SMTP_URL', value: 'smtp://user:synthetic-secret@localhost:invalid' },
])('prints only safe diagnostics for $setting', async ({ setting, value }) => {
  const dir = mkdtempSync(join(tmpdir(), 'rio-startup-'));
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      // Compiling and starting the server takes much longer on a machine busy with other tests.
      timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        RIOSOMA_CONFIG_DIR: dir,
        RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
        [setting]: value,
      },
    }).then(
      () => {
        throw new Error('Expected startup failure');
      },
      (error) => error as { code: number; stdout: string; stderr: string },
    );
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('synthetic-secret');
    expect(lastJson(result.stderr)).toMatchObject({ code: 'configuration_invalid', setting });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('stops at start when file storage fails its check, naming why but no key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rio-startup-'));
  // A port nothing answers on, and one no other test's server can be holding in the meantime.
  const port = await refusedPort();
  const start = (env: Record<string, string>) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        RIOSOMA_CONFIG_DIR: dir,
        RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
        RIOSOMA_FILES_STORAGE: 's3',
        RIOSOMA_FILES_S3_ACCESS_KEY_ID: 'synthetic-key',
        RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
        ...env,
      },
    }).then(
      () => {
        throw new Error('Expected startup failure');
      },
      (error) => error as { code: number; stdout: string; stderr: string },
    );
  try {
    const missing = await start({ RIOSOMA_FILES_S3_REGION: 'us-east-1' });
    expect(missing.code).toBe(1);
    expect(lastJson(missing.stderr)).toMatchObject({
      code: 'configuration_invalid',
      setting: 'RIOSOMA_FILES_S3_BUCKET',
      message: 'RIOSOMA_FILES_S3_BUCKET is required for S3-compatible file storage',
    });
    const refused = await start({
      RIOSOMA_FILES_S3_BUCKET: 'files',
      RIOSOMA_FILES_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      RIOSOMA_FILES_S3_PATH_STYLE: 'true',
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout + refused.stderr).not.toContain('synthetic-secret');
    expect(lastJson(refused.stderr)).toMatchObject({
      code: 'configuration_invalid',
      setting: 'RIOSOMA_FILES_STORAGE',
      detail: 'ECONNREFUSED',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not serialize arbitrary driver error details, causes, codes, or stacks', () => {
  const error = Object.assign(new Error('synthetic-secret', { cause: { token: 'synthetic-secret' } }), {
    code: 'synthetic-secret',
    input: 'synthetic-secret',
  });
  expect(startupFailure(error)).toEqual({ code: 'startup_failed', messageKey: 'server.startup.failed' });
});

it('names a database error by its SQLSTATE and nothing else', () => {
  const error = Object.assign(new Error('canceling statement due to lock timeout on synthetic-secret'), {
    code: '55P03',
  });
  expect(startupFailure(error)).toEqual({
    code: 'startup_failed',
    messageKey: 'server.startup.failed',
    sqlstate: '55P03',
  });
});

it('logs only a failed migration ID, its message key, and a safe SQLSTATE', () => {
  const cause = Object.assign(new Error('SELECT synthetic-secret FROM private_table'), {
    code: '22P02',
    detail: 'synthetic-secret',
    connection: 'postgres://owner:synthetic-secret@private-host/private-database',
  });
  const error = new MigrationError('0083_automation_steps', 'server.startup.migrationStatementFailed', {
    cause,
  });
  expect(startupFailure(error)).toEqual({
    code: 'startup_failed',
    migrationId: '0083_automation_steps',
    messageKey: 'server.startup.migrationStatementFailed',
    message: 'A database migration statement failed.  Check the migration ID and SQLSTATE in the server log.',
    sqlstate: '22P02',
  });
  const changed = startupFailure(new ChangedMigrationError('0083_automation_steps'));
  expect(changed).toMatchObject({
    migrationId: '0083_automation_steps',
    messageKey: 'server.startup.migrationChanged',
    message: expect.stringContaining('add a new migration instead'),
  });
  const newer = startupFailure(new NewerDatabaseError('9999_future'));
  expect(newer).toMatchObject({ migrationId: '9999_future', messageKey: 'server.startup.databaseNewer' });
  const unsafeCode = startupFailure(
    new MigrationError('0083_automation_steps', 'server.startup.migrationStatementFailed', {
      cause: Object.assign(cause, { code: 'synthetic-secret' }),
    }),
  );
  expect(unsafeCode).not.toHaveProperty('sqlstate');
  expect(JSON.stringify([startupFailure(error), changed, newer, unsafeCode])).not.toContain(
    'synthetic-secret',
  );
});

it('redacts URL userinfo in messages, fields, errors, and request paths', () => {
  let output = '';
  const logger = pino(loggerOptions('info', true), {
    write: (line: string) => {
      output += line;
    },
  });
  const url = 'postgres://synthetic-user:synthetic-secret@localhost:invalid/db';
  logger.info({ nested: { url } }, `Failed at ${url}`);
  logger.error(
    { err: new Error(`Failed at ${url}`), req: { method: 'GET', url: `${url}?token=hidden`, id: '1' } },
    'failed',
  );
  logger.info('Details: %j', { url });
  logger.child({ url }).warn('child');
  expect(output).not.toContain('synthetic-user');
  expect(output).not.toContain('synthetic-secret');
  expect(output).not.toContain('token=hidden');
  expect(output).toContain('[redacted]@localhost:invalid/db');
});

it('warns at startup when plaintext SMTP is explicitly enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rio-startup-'));
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      // Compiling and starting the server takes much longer on a machine busy with other tests.
      timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        RIOSOMA_CONFIG_DIR: dir,
        RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
        RIOSOMA_SMTP_ALLOW_PLAINTEXT: 'true',
        // A nonlocal bind address exits after startup warnings without leaving a server running.
        RIOSOMA_HOST: '192.0.2.1',
      },
    }).then(
      () => {
        throw new Error('Expected bind failure');
      },
      (error) => error as { code: number; stdout: string; stderr: string },
    );
    expect(result.code).toBe(1);
    const warning = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.setting === 'RIOSOMA_SMTP_ALLOW_PLAINTEXT');
    expect(warning).toMatchObject({ level: 40, messageKey: 'config.smtp.plaintextAllowed' });
    expect(lastJson(result.stderr)).toMatchObject({ code: 'startup_failed' });
    expect(result.stdout).not.toContain('#token=');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('explains why a newer database cannot start and how to recover', () => {
  expect(startupFailure(new NewerDatabaseError())).toEqual({
    code: 'database_newer',
    messageKey: 'server.startup.databaseNewer',
    message:
      'This database was upgraded by a newer Riosoma.  Run that version or restore the backup taken before upgrading.',
  });
});

it('keeps environment reads in the built server configuration module', () => {
  const root = new URL('../dist/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.js'),
  );
  expect(files).toContain('main.js');
  const violations: string[] = [];
  for (const file of files) {
    // Test helpers are built too, and read their own RIOSOMA_TEST_* settings.
    if (file === 'config.js' || file.startsWith('test/') || /\.test(?:-helpers)?\.js$/.test(file)) continue;
    const source = readFileSync(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])/g)) {
      if (!/^\.NODE_ENV\b/.test(source.slice(match.index + match[0].length))) violations.push(file);
    }
  }
  expect(violations).toEqual([]);
});

afterEach(() => vi.useRealTimers());

const unavailable = () => Object.assign(new Error('synthetic-secret'), { code: 'ECONNREFUSED' });
const database = () => ({
  pool: {} as Awaited<ReturnType<typeof waitForDatabase>>['pool'],
  close: vi.fn(async () => {}),
});

it('retries with doubling waits until the database becomes available', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const ready = database();
  const connect = vi
    .fn()
    .mockRejectedValueOnce(unavailable())
    .mockRejectedValueOnce(unavailable())
    .mockResolvedValue(ready);
  const warn = vi.fn();
  const result = waitForDatabase(connect, 120, warn);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toBe(ready);
  expect(connect).toHaveBeenCalledTimes(3);
  expect(warn.mock.calls.map(([fields]) => fields.waitSeconds)).toEqual([1, 2]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
});

it('stops at the total budget when the database never becomes available', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const connect = vi.fn().mockRejectedValue(unavailable());
  const warn = vi.fn();
  const result = waitForDatabase(connect, 120, warn).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120000);
  expect(await result).toMatchObject({ code: 'ECONNREFUSED' });
  expect(warn.mock.calls.map(([fields]) => fields.waitSeconds)).toEqual([1, 2, 4, 8, 16, 32, 57]);
  expect(connect).toHaveBeenCalledTimes(7);
  expect(vi.getTimerCount()).toBe(0);
});

it('counts slow connection attempts against the wait budget and closes late connections', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const ready = database();
  let resolve!: (value: typeof ready) => void;
  const connect = vi.fn(
    () =>
      new Promise<typeof ready>((done) => {
        resolve = done;
      }),
  );
  const warn = vi.fn();
  const result = waitForDatabase(connect, 2, warn).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  expect(connect).toHaveBeenCalledExactlyOnceWith(2000);
  expect(warn).not.toHaveBeenCalled();
  resolve(ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(ready.close).toHaveBeenCalledOnce();
});

it.each(['28P01', '28000', '3D000', '42501', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
  'stops immediately for authentication or configuration error %s',
  async (code) => {
    const error = Object.assign(new Error('synthetic-secret'), { code });
    const connect = vi.fn().mockRejectedValue(error);
    const warn = vi.fn();
    await expect(waitForDatabase(connect, 120, warn)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  },
);

it('tries only once when waiting is disabled', async () => {
  const connect = vi.fn().mockRejectedValue(unavailable());
  const warn = vi.fn();
  await expect(waitForDatabase(connect, 0, warn)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  expect(connect).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});

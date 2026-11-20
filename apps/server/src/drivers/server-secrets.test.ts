import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, secretSettingValues, writeStored } from '../config.js';
import { serverSecrets } from './server-secrets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const standIn = () => randomBytes(18).toString('base64url');

it('gathers every secret the server holds, from its settings, its configuration, and its stored file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rio-server-secrets-'));
  dirs.push(dir);
  const password = standIn();
  const env = {
    RIOSOMA_CONFIG_DIR: dir,
    RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
    RIOSOMA_DATABASE_URL: `postgres://riosoma:${password}@db.internal:5432/riosoma`,
    RIOSOMA_SMTP_URL: `smtps://mailer:${standIn()}@mail.internal:465`,
    RIOSOMA_TLS_ASK_TOKEN: standIn() + standIn(),
    RIOSOMA_OPENAI_API_KEY: standIn(),
    RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: standIn(),
    RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET: standIn(),
  };
  const setupToken = standIn();
  writeStored(dir, { setupToken });
  const config = loadConfig(env);
  const found = serverSecrets(config, secretSettingValues(env));
  const { RIOSOMA_CONFIG_DIR: _dir, ...secrets } = env;
  for (const value of [...Object.values(secrets), password, setupToken]) expect(found).toContain(value);
  // The key in each form it's written in, whether it came from the settings or the stored file
  const key = Buffer.from(env.RIOSOMA_SECRET_KEY, 'base64');
  for (const form of ['base64url', 'hex'] as const) expect(found).toContain(key.toString(form));
  expect(found).not.toContain(dir);
  expect(found).not.toContain('');
});

it('covers a secret key the server generated and kept in its stored file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rio-server-secrets-'));
  dirs.push(dir);
  const env = { RIOSOMA_CONFIG_DIR: dir };
  const config = loadConfig(env);
  expect(serverSecrets(config, secretSettingValues(env))).toContain(config.secretKey.toString('base64'));
});

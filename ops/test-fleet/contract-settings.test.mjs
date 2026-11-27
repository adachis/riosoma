import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceConnection, SourceSecrets } from '../../packages/contracts/dist/index.js';
import {
  connectionForKind,
  COSMOS_EMULATOR_KEY,
  FLEET_DATABASE,
  FLEET_PASSWORD,
  FLEET_USER,
  fleetSettingsEnv,
  INFORMIX_PASSWORD,
  INFORMIX_USER,
  TARGET_KINDS,
} from './contract-settings.mjs';

const ALLOWED_CREDENTIALS = new Set([
  FLEET_USER,
  FLEET_PASSWORD,
  FLEET_DATABASE,
  COSMOS_EMULATOR_KEY,
  'riosoma-test',
  'riosoma',
  'sa',
  'master',
  'db2inst1',
  INFORMIX_USER,
  INFORMIX_PASSWORD,
  'Administrator',
  'elastic',
  'neo4j',
  'FREEPDB1',
]);

test('generates valid SourceConnection objects for all 32 target kinds', () => {
  assert.equal(TARGET_KINDS.length, 32);
  for (const kind of TARGET_KINDS) {
    const raw = connectionForKind(kind);
    const parsed = SourceConnection.parse(raw);
    assert.equal(parsed.kind, kind);
  }
});

test('generates valid environment settings for all 32 target kinds using only documented fleet credentials', () => {
  const env = fleetSettingsEnv(TARGET_KINDS);
  for (const kind of TARGET_KINDS) {
    const jsonKey = `RIOSOMA_TEST_${kind.toUpperCase().replaceAll('-', '_')}_SETTINGS`;
    if (jsonKey in env) {
      const parsed = JSON.parse(env[jsonKey]);
      const connection = SourceConnection.parse(parsed.connection);
      assert.equal(connection.kind, kind);
      const secrets = SourceSecrets.parse(parsed.secrets ?? {});
      for (const secret of Object.values(secrets)) {
        assert.ok(ALLOWED_CREDENTIALS.has(secret), `unexpected secret value for ${kind}`);
      }
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith('_URL') && value.includes('@')) {
      const parsed = new URL(value);
      assert.ok(ALLOWED_CREDENTIALS.has(decodeURIComponent(parsed.username)), `unexpected user in ${key}`);
      assert.ok(
        ALLOWED_CREDENTIALS.has(decodeURIComponent(parsed.password)),
        `unexpected password in ${key}`,
      );
    }
  }
});

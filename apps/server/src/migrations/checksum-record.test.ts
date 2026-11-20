import { readFileSync } from 'node:fs';
import { checksum, type Migration } from '@riosoma/db';
import { expect, it } from 'vitest';
import {
  addMigrationChecksums,
  checkMigrationChecksums,
  RECORD_MIGRATIONS_COMMAND,
  type MigrationChecksum,
} from './checksum-record.js';
import { MIGRATIONS } from './index.js';

const recorded = JSON.parse(
  readFileSync(new URL('./checksums.json', import.meta.url), 'utf8'),
) as MigrationChecksum[];

it('keeps every shipped migration present with its recorded checksum', () => {
  checkMigrationChecksums(MIGRATIONS, recorded);
});

it('registers demo sessions after the shipped notification migration with unique migration IDs', () => {
  const ids = MIGRATIONS.map((migration) => migration.id);
  expect(ids.filter((id) => ['0133_notification_kinds', '0134_demo_sessions'].includes(id))).toEqual([
    '0133_notification_kinds',
    '0134_demo_sessions',
  ]);
  expect(new Set(ids).size).toBe(MIGRATIONS.length);
});

it.each([
  {
    id: '0083_automation_steps',
    expectedChecksum: '4e2547f5697c16d0e13d8c7beab59ae40c75c0d9b580cb717344ca3f9dfd0b16',
  },
  {
    id: '0088_notification_vault_kind',
    expectedChecksum: '4ee368d38d52b1c6160256b47bf2e54a017dd966cd65012dec2c502c5a380b11',
  },
])('pins the restored shipped SQL for $id and accepts it when recording', ({ id, expectedChecksum }) => {
  const migration = MIGRATIONS.find((entry) => entry.id === id)!;
  const entry = recorded.find((entry) => entry.id === id)!;
  expect(checksum(migration.sql)).toBe(expectedChecksum);
  expect(entry).toEqual({ id, checksum: expectedChecksum });
  expect(addMigrationChecksums([migration], [entry])).toEqual([entry]);
});

it.each(['0083_automation_steps', '0088_notification_vault_kind'])(
  'rejects a SQL edit to shipped migration %s against the real record',
  (id) => {
    const edited = MIGRATIONS.map((migration) =>
      migration.id === id ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
    );
    expect(() => checkMigrationChecksums(edited, recorded)).toThrow(
      `Recorded migration ${id} changed after it shipped. Restore it and add a new migration instead.`,
    );
  },
);

const shipped: Migration = { id: '0001_shipped', sql: 'SELECT 1;' };
const newMigration: Migration = { id: '0002_new', sql: 'SELECT 2;' };
const pinned = [{ id: shipped.id, checksum: checksum(shipped.sql) }];

it('names an edited migration and refuses to record it again', () => {
  const edited = [{ ...shipped, sql: `${shipped.sql} SELECT 3;` }];
  for (const check of [checkMigrationChecksums, addMigrationChecksums]) {
    expect(() => check(edited, pinned)).toThrow(/0001_shipped.*add a new migration instead/);
  }
});

it('names a missing migration and refuses to remove its record', () => {
  for (const check of [checkMigrationChecksums, addMigrationChecksums]) {
    expect(() => check([], pinned)).toThrow(/0001_shipped.*add a new migration instead/);
  }
});

it('gives the recording command for a new migration and keeps existing pins', () => {
  expect(() => checkMigrationChecksums([shipped, newMigration], pinned)).toThrow(RECORD_MIGRATIONS_COMMAND);
  expect(() => checkMigrationChecksums([shipped, newMigration], pinned)).toThrow(newMigration.id);
  const next = addMigrationChecksums([newMigration, shipped], pinned);
  expect(next).toEqual([...pinned, { id: newMigration.id, checksum: checksum(newMigration.sql) }]);
  expect(() => checkMigrationChecksums([shipped, newMigration], next)).not.toThrow();
  expect(addMigrationChecksums([shipped, newMigration], next)).toEqual(next);
});

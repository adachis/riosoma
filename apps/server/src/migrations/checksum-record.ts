import { checksum, type Migration } from '@riosoma/db';

export interface MigrationChecksum {
  id: string;
  checksum: string;
}

export const RECORD_MIGRATIONS_COMMAND =
  'pnpm --filter @riosoma/server exec tsx ../../tools/record-migrations.ts';

/** Recording new migrations must never bless changes to ones already shipped. */
export function addMigrationChecksums(
  migrations: Migration[],
  recorded: MigrationChecksum[],
): MigrationChecksum[] {
  const current = new Map<string, Migration>();
  for (const migration of migrations) {
    if (current.has(migration.id)) throw new Error(`Duplicate migration id ${migration.id}`);
    current.set(migration.id, migration);
  }
  const pinned = new Set<string>();
  for (const entry of recorded) {
    if (pinned.has(entry.id)) throw new Error(`Duplicate recorded migration id ${entry.id}`);
    pinned.add(entry.id);
    const migration = current.get(entry.id);
    if (!migration) {
      throw new Error(`Recorded migration ${entry.id} is gone. Restore it and add a new migration instead.`);
    }
    if (checksum(migration.sql) !== entry.checksum) {
      throw new Error(
        `Recorded migration ${entry.id} changed after it shipped. Restore it and add a new migration instead.`,
      );
    }
  }
  return [
    ...recorded,
    ...migrations
      .filter((migration) => !pinned.has(migration.id))
      .map((migration) => ({ id: migration.id, checksum: checksum(migration.sql) })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function checkMigrationChecksums(migrations: Migration[], recorded: MigrationChecksum[]): void {
  const next = addMigrationChecksums(migrations, recorded);
  const pinned = new Set(recorded.map((entry) => entry.id));
  const added = next.filter((entry) => !pinned.has(entry.id));
  if (added.length) {
    throw new Error(
      `New migrations are not recorded: ${added.map((entry) => entry.id).join(', ')}. Run ${RECORD_MIGRATIONS_COMMAND}`,
    );
  }
}

import { createHash } from 'node:crypto';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type pg from 'pg';
import type { FileRow } from './metadata.js';
import { failureCode, StorageServiceError } from './remote.js';
import { fileStorage, type FileStorage, type FileStorageConfig, type StorageKind } from './storage.js';

/**
 * Moving attachments from one store to another.  Each file is copied to the new store with its
 * previews, read back there and checked against the size and checksum its row recorded at upload,
 * and only then is its row pointed at the new store, one file at a time.  A file that fails its
 * check stays where it was, and what was copied of it is removed.  The old copies stay until an
 * admin removes them with `removeOldCopies`, so nothing is lost if the new store turns out wrong.
 *
 * Stopping partway is safe, and running again picks up where it stopped: files already in the new
 * store are skipped, and a file copied partly is copied again from the start.
 */

export interface MoveFailure {
  id: string;
  /** `checksum` when the bytes read back don't match, `missing` when the old copy is gone, or the error's code */
  reason: string;
}

export interface MoveReport {
  moved: number;
  bytes: number;
  failed: MoveFailure[];
}

interface Part {
  key: string;
  size: number;
  sha256: string;
}

function partsOf(file: FileRow): Part[] {
  const parts: Part[] = [{ key: file.storage_key, size: Number(file.size), sha256: file.sha256 }];
  for (const size of ['small', 'large'] as const) {
    const preview = file.thumbnails?.[size];
    if (preview) parts.push({ key: preview.key, size: preview.size, sha256: preview.sha256 });
  }
  return parts;
}

class ChecksumMismatch extends Error {
  constructor() {
    super('The copy does not match the checksum recorded at upload');
  }
}

async function verify(storage: FileStorage, part: Part): Promise<void> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of storage.read(part.key)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  if (size !== part.size || hash.digest('hex') !== part.sha256) throw new ChecksumMismatch();
}

function reasonOf(error: unknown): string {
  if (error instanceof ChecksumMismatch) return 'checksum';
  if (error instanceof StorageServiceError)
    return `${error.status}${error.serviceCode ? ` ${error.serviceCode}` : ''}`;
  const code = failureCode(error);
  if (code === 'ENOENT') return 'missing';
  return code ?? (error instanceof Error ? error.name : 'error');
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Another move, or a removal of old copies, is already running against this database. */
export class MoveRunning extends Error {
  constructor() {
    super('Another move or removal of files is already running');
    this.name = 'MoveRunning';
  }
}

/**
 * Runs one move or removal at a time, in any process.  Two moves at once could each copy a file
 * and then remove the copy the other had just switched to, so the second to start stops instead.
 */
async function exclusively<T>(pool: pg.Pool, appSchema: string, work: () => Promise<T>): Promise<T> {
  const name = `${appSchema}:file-moves`;
  const client = await pool.connect();
  try {
    const locked = await query<{ locked: boolean }>(
      client,
      sql`SELECT pg_try_advisory_lock(hashtextextended(${name}, 0)) AS locked`,
    );
    if (!locked.rows[0]?.locked) throw new MoveRunning();
    try {
      return await work();
    } finally {
      await query(client, sql`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`).catch(
        () => undefined,
      );
    }
  } finally {
    client.release();
  }
}

/** Moves every file that isn't in `target` into it. */
export function moveFiles(
  pool: pg.Pool,
  appSchema: string,
  config: FileStorageConfig,
  target: StorageKind,
  log: (line: string) => void = () => undefined,
): Promise<MoveReport> {
  return exclusively(pool, appSchema, () => move(pool, appSchema, config, target, log));
}

async function move(
  pool: pg.Pool,
  appSchema: string,
  config: FileStorageConfig,
  target: StorageKind,
  log: (line: string) => void,
): Promise<MoveReport> {
  const files = ident(appSchema, 'files');
  const moves = ident(appSchema, 'file_moves');
  const report: MoveReport = { moved: 0, bytes: 0, failed: [] };
  const destination = fileStorage(target, pool, appSchema, config);
  const remaining = await query<{ count: string }>(
    pool,
    sql`SELECT count(*) FROM ${files} WHERE scan_state = 'clean' AND storage <> ${target}`,
  );
  const total = Number(remaining.rows[0]!.count);
  log(`${total} file${total === 1 ? '' : 's'} to move to ${target}`);
  let last = '';
  for (;;) {
    const batch = await query<FileRow>(
      pool,
      sql`SELECT * FROM ${files} WHERE scan_state = 'clean' AND storage <> ${target} AND id > ${last} ORDER BY id LIMIT 100`,
    );
    for (const file of batch.rows) {
      last = file.id;
      const current = await query(
        pool,
        sql`SELECT 1 FROM ${files} WHERE id = ${file.id} AND storage <> ${target}`,
      );
      if (!current.rowCount) continue;
      const parts = partsOf(file);
      try {
        const source = fileStorage(file.storage, pool, appSchema, config);
        for (const part of parts) {
          // A copy an earlier run left partway, or an old copy from a move the other way, goes first.
          await destination.delete(part.key);
          await destination.write(part.key, source.read(part.key));
          await verify(destination, part);
        }
        const switched = await withTransaction(pool, async (db: Queryable) => {
          // Aliases created during a move must switch with the original before old bytes are removed.
          await query(
            db,
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${appSchema}:file:${file.storage_key}`}, 0))`,
          );
          const updated = await query(
            db,
            sql`UPDATE ${files} SET storage = ${target} WHERE scan_state = 'clean' AND storage_key = ${file.storage_key} AND storage = ${file.storage}`,
          );
          if (!updated.rowCount) return false;
          await query(
            db,
            sql`INSERT INTO ${moves} (file_id, storage, storage_keys)
            VALUES (${file.id}, ${file.storage}, ${parts.map((part) => part.key)}::text[])
            ON CONFLICT (file_id, storage) DO UPDATE SET storage_keys = EXCLUDED.storage_keys, moved_at = now()`,
          );
          // Bytes back in a store they once left are live again, not an old copy.
          await query(db, sql`DELETE FROM ${moves} WHERE file_id = ${file.id} AND storage = ${target}`);
          return true;
        });
        if (!switched) {
          // Deleted or moved by someone else meanwhile: the copy isn't needed.
          for (const part of parts) await destination.delete(part.key).catch(() => undefined);
          continue;
        }
        report.moved++;
        report.bytes += parts.reduce((sum, part) => sum + part.size, 0);
        if (report.moved % 100 === 0) log(`moved ${report.moved} of ${total} (${mb(report.bytes)})`);
      } catch (error) {
        for (const part of parts) await destination.delete(part.key).catch(() => undefined);
        const failure = { id: file.id, reason: reasonOf(error) };
        report.failed.push(failure);
        log(`could not move ${failure.id}: ${failure.reason}`);
      }
    }
    if (batch.rows.length < 100) break;
  }
  log(
    `moved ${report.moved} file${report.moved === 1 ? '' : 's'} (${mb(report.bytes)}) to ${target}` +
      (report.failed.length ? `, and ${report.failed.length} could not be moved` : ''),
  );
  return report;
}

export interface RemovalReport {
  removed: number;
  failed: MoveFailure[];
}

/**
 * Removes the old copies earlier moves left behind.  A copy whose file has since moved back into
 * that store is live again, so only its record goes.
 */
export function removeOldCopies(
  pool: pg.Pool,
  appSchema: string,
  config: FileStorageConfig,
  log: (line: string) => void = () => undefined,
): Promise<RemovalReport> {
  return exclusively(pool, appSchema, () => removeOld(pool, appSchema, config, log));
}

async function removeOld(
  pool: pg.Pool,
  appSchema: string,
  config: FileStorageConfig,
  log: (line: string) => void,
): Promise<RemovalReport> {
  const moves = ident(appSchema, 'file_moves');
  const report: RemovalReport = { removed: 0, failed: [] };
  let last = { file: '', storage: '' };
  for (;;) {
    const batch = await query<{
      file_id: string;
      storage: StorageKind;
      storage_keys: string[];
      current: StorageKind | null;
    }>(
      pool,
      sql`SELECT m.file_id, m.storage, m.storage_keys, f.storage AS current
      FROM ${moves} m LEFT JOIN ${ident(appSchema, 'files')} f ON f.id = m.file_id
      WHERE (m.file_id, m.storage) > (${last.file}, ${last.storage})
      ORDER BY m.file_id, m.storage LIMIT 100`,
    );
    for (const copy of batch.rows) {
      last = { file: copy.file_id, storage: copy.storage };
      try {
        if (copy.current !== copy.storage) {
          const storage = fileStorage(copy.storage, pool, appSchema, config);
          for (const key of copy.storage_keys) {
            const live = await query(
              pool,
              sql`SELECT 1 FROM ${ident(appSchema, 'files')} WHERE storage = ${copy.storage} AND (storage_key = ${key} OR thumbnails->'small'->>'key' = ${key} OR thumbnails->'large'->>'key' = ${key}) LIMIT 1`,
            );
            if (!live.rowCount) await storage.delete(key);
          }
          report.removed++;
        }
        await query(
          pool,
          sql`DELETE FROM ${moves} WHERE file_id = ${copy.file_id} AND storage = ${copy.storage}`,
        );
      } catch (error) {
        const failure = { id: copy.file_id, reason: reasonOf(error) };
        report.failed.push(failure);
        log(`could not remove the old copy of ${failure.id} in ${copy.storage}: ${failure.reason}`);
      }
    }
    if (batch.rows.length < 100) break;
  }
  log(
    `removed ${report.removed} old cop${report.removed === 1 ? 'y' : 'ies'}` +
      (report.failed.length ? `, and ${report.failed.length} could not be removed` : ''),
  );
  return report;
}

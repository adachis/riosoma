import { newId, type ArchiveAttachment } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import type { FileRow, FileImageMetadata } from '../files/metadata.js';
import { fileStorage, storedInDatabase, type FileStorageConfig, type StorageKind } from '../files/storage.js';

/**
 * Files for a copy.  A stored file's key is unique to one file row, and deleting a file deletes
 * its bytes whatever else refers to them, so the storage layer has no reference counting to share
 * bytes with.  A copy gets bytes of its own, copied from the original under a new key by the store
 * itself: in PostgreSQL by copying the chunk rows, on disk by copying the file, and in a bucket or
 * container by the service's own copy.
 */

export interface CopiedFiles {
  /** Old attachment IDs to new ones, for the files that were copied */
  ids: Map<string, string>;
  /** Files whose stored bytes are gone or no longer match the archive's checksum */
  missing: number;
  /** Keys written outside the database, which a copy that fails has to remove itself */
  written: Array<{ storage: StorageKind; key: string }>;
}

async function copyBytes(
  db: Queryable,
  schemas: DataSchemas,
  config: FileStorageConfig,
  kind: FileRow['storage'],
  from: string,
  to: string,
  written: CopiedFiles['written'],
): Promise<void> {
  const storage = fileStorage(kind, db, schemas.app, config);
  if (!storedInDatabase(kind)) written.push({ storage: kind, key: to });
  await storage.copy(from, to);
}

/**
 * Copies the archive's files into new file rows for the copy's tables and fields.  `target` gives
 * each file's new table and field, or null when its field didn't come across.
 */
export async function copyFiles(
  db: Queryable,
  schemas: DataSchemas,
  config: FileStorageConfig,
  owner: { orgId: string; userId: string },
  attachments: readonly ArchiveAttachment[],
  target: (file: ArchiveAttachment) => { tableId: string; fieldId: string } | null,
): Promise<CopiedFiles> {
  const copied: CopiedFiles = { ids: new Map(), missing: 0, written: [] };
  for (const file of attachments) {
    const place = target(file);
    if (!place) continue;
    // The bytes are found by their key, and only in this organization, and only when they still
    // hold what the archive says they did.  They may have moved to another store since the archive
    // was made, which keeps their key, so the store they're in now is the one they're copied in.
    const found = await query<FileRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'files')}
      WHERE storage_key = ${file.storageKey} AND org_id = ${owner.orgId}`,
    );
    const original = found.rows[0];
    if (!original || original.scan_state !== 'clean' || original.sha256 !== file.sha256) {
      copied.missing++;
      continue;
    }
    const id = newId('attachment');
    try {
      await query(db, sql`SAVEPOINT copy_file`);
      await copyBytes(db, schemas, config, original.storage, original.storage_key, id, copied.written);
      let thumbnails: FileImageMetadata | null = null;
      if (original.thumbnails) {
        thumbnails = { ...(original.thumbnails.source ? { source: original.thumbnails.source } : {}) };
        for (const size of ['small', 'large'] as const) {
          const preview = original.thumbnails[size];
          if (!preview) continue;
          const key = `${id}_${size}`;
          await copyBytes(db, schemas, config, original.storage, preview.key, key, copied.written);
          thumbnails[size] = { ...preview, key };
        }
      }
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'files')}
        (id, org_id, table_id, field_id, name, size, type, width, height, sha256, storage, storage_key,
          thumbnails, created_by, created_at, attached_at)
        VALUES (${id}, ${owner.orgId}, ${place.tableId}, ${place.fieldId}, ${original.name}, ${original.size},
          ${original.type}, ${original.width}, ${original.height}, ${original.sha256}, ${original.storage}, ${id},
          ${thumbnails ? JSON.stringify(thumbnails) : null}::jsonb, ${owner.userId}, ${file.createdAt},
          statement_timestamp())`,
      );
      await query(db, sql`RELEASE SAVEPOINT copy_file`);
      copied.ids.set(file.id, id);
    } catch (error) {
      // A file whose bytes are gone from their store is reported missing rather than failing the copy.
      await query(db, sql`ROLLBACK TO SAVEPOINT copy_file`);
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      copied.missing++;
    }
  }
  return copied;
}

/** Removes what a failed copy wrote outside the database.  PostgreSQL chunks went with its transaction. */
export async function removeWritten(
  db: Queryable,
  schemas: DataSchemas,
  config: FileStorageConfig,
  written: CopiedFiles['written'],
): Promise<void> {
  for (const file of written)
    await fileStorage(file.storage, db, schemas.app, config)
      .delete(file.key)
      .catch(() => undefined);
}

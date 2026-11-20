import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError, type AttachmentMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { RuntimeConfig } from '../../config.js';
import { scannerSettings, uploadLimit } from './settings.js';
import { detectType, SNIFF_BYTES } from './detect.js';
import { type FileRow } from './metadata.js';
import { imagePreviews, type ImageDetails } from './previews.js';
import { fileStorage, storedInDatabase, type StorageKind } from './storage.js';

/** Called inside the transaction that owns the upload and its final metadata. */
export async function finishUpload(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  file: {
    id: string;
    orgId: string;
    userId: string;
    tableId: string;
    fieldId: string;
    name: string;
    storage: StorageKind;
  },
  source: Readable,
  provenance?: AttachmentMeta['source'],
): Promise<FileRow> {
  const storage = fileStorage(file.storage, db, schema, config);
  const limit = await uploadLimit(db, schema, file.orgId);
  let size = 0;
  let head = Buffer.alloc(0);
  const hash = createHash('sha256');
  const measured = Readable.from(
    (async function* () {
      for await (const value of source.iterator({ destroyOnReturn: false })) {
        const bytes = value as Buffer;
        size += bytes.length;
        if (size > limit)
          throw new AppError('payload_too_large', 'data.file.tooLarge', {
            params: { maxUploadBytes: limit },
          });
        hash.update(bytes);
        if (head.length < SNIFF_BYTES)
          head = Buffer.concat([head, bytes.subarray(0, SNIFF_BYTES - head.length)]);
        yield bytes;
      }
    })(),
    { objectMode: false },
  );
  await storage.write(file.id, measured);
  // Hold the policy through finalization so enabling scanning cannot race a clean verdict.
  await query(db, sql`SELECT id FROM ${ident(schema, 'orgs')} WHERE id = ${file.orgId} FOR SHARE`);
  const scanner = await scannerSettings(db, schema, file.orgId, config);
  const type = detectType(head);
  let image: ImageDetails = { width: null, height: null, thumbnails: null };
  // Untrusted image decoders only see files after the scanner has approved them.
  if (!scanner.enabled) {
    await query(db, sql`SAVEPOINT file_previews`);
    try {
      image = await imagePreviews(storage, file.id, type, head);
    } catch {
      await query(db, sql`ROLLBACK TO SAVEPOINT file_previews`);
      if (!storedInDatabase(file.storage))
        for (const suffix of ['small', 'large']) await storage.delete(`${file.id}_${suffix}`);
    }
    await query(db, sql`RELEASE SAVEPOINT file_previews`);
  }
  const result = await query<FileRow>(
    db,
    sql`INSERT INTO ${ident(schema, 'files')}
    (id, org_id, table_id, field_id, name, size, type, width, height, sha256, storage, storage_key, thumbnails, created_by, scan_state)
    VALUES (${file.id}, ${file.orgId}, ${file.tableId}, ${file.fieldId}, ${file.name}, ${size}, ${type},
      ${image.width}, ${image.height}, ${hash.digest('hex')}, ${file.storage}, ${file.id},
      ${image.thumbnails || provenance ? JSON.stringify({ ...image.thumbnails, ...(provenance ? { source: provenance } : {}) }) : null}::jsonb, ${file.userId},
      ${scanner.enabled ? 'quarantined' : 'clean'}) RETURNING *`,
  );
  return result.rows[0]!;
}

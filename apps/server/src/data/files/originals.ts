import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError, SPREADSHEET_LIMITS, newId, type IngestFile } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { RuntimeConfig } from '../../config.js';
import { builtInFileChecks, checkFileSafety, requireSafeFile } from './safety.js';
import { fileSafetySettings, uploadLimit } from './settings.js';
import { fileStorage, type StorageKind } from './storage.js';

export interface OriginalRow {
  id: string;
  org_id: string;
  table_id: string;
  ingest_file_id: string;
  storage: StorageKind;
  storage_key: string;
  size: string;
  sha256: string;
  type: string;
  scan_state?: string;
}

export async function inspectOriginal(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  orgId: string,
  input: { name: string; bytes: Buffer; statedType?: string },
  allowHeld = false,
) {
  const limit = Math.min(SPREADSHEET_LIMITS.uploadBytes, await uploadLimit(db, schema, orgId));
  if (input.bytes.length > limit)
    throw new AppError('payload_too_large', 'data.file.tooLarge', { params: { maxUploadBytes: limit } });
  const organization = await query<{ settings: unknown }>(
    db,
    sql`SELECT settings FROM ${ident(schema, 'orgs')} WHERE id = ${orgId}`,
  );
  const settingsHash = createHash('sha256')
    .update(JSON.stringify(organization.rows[0]?.settings))
    .digest('hex');
  let safety = await checkFileSafety({ db, schema, config, orgId }, input);
  if (allowHeld && safety.state === 'held' && safety.reason === 'files.checks.scannerUnavailable') {
    const builtIn = await builtInFileChecks(input, await fileSafetySettings(db, schema, orgId));
    if (builtIn.state === 'held') safety = builtIn;
  }
  if (!allowHeld) requireSafeFile(safety);
  return {
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    type: safety.type,
    safety,
    settingsHash,
  };
}

/** The ingest row owns these bytes.  Attachment metadata never reads this owner kind. */
export async function storeOriginal(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  owner: { orgId: string; tableId: string; fileId: string; userId: string },
  input: { name: string; bytes: Buffer; statedType?: string },
  onOutsideWrite: (original: OriginalRow) => void,
  inspected?: Awaited<ReturnType<typeof inspectOriginal>>,
): Promise<OriginalRow> {
  // The organization lock keeps a newly enabled scanner from racing the safe verdict.
  const organization = await query<{ settings: unknown }>(
    db,
    sql`SELECT settings FROM ${ident(schema, 'orgs')} WHERE id = ${owner.orgId} FOR SHARE`,
  );
  const checked = inspected ?? (await inspectOriginal(db, schema, config, owner.orgId, input));
  if (
    inspected &&
    (checked.settingsHash !==
      createHash('sha256').update(JSON.stringify(organization.rows[0]?.settings)).digest('hex') ||
      checked.sha256 !== createHash('sha256').update(input.bytes).digest('hex'))
  )
    throw new AppError('unavailable', 'ingest.pipeline.tryLater');
  const pending =
    checked.safety.state === 'held' && checked.safety.reason === 'files.checks.scannerUnavailable';
  if (!pending) requireSafeFile(checked.safety);
  const id = newId('attachment');
  const storage = config.filesStorage ?? 'postgres';
  const row: OriginalRow = {
    id,
    org_id: owner.orgId,
    table_id: owner.tableId,
    ingest_file_id: owner.fileId,
    storage,
    storage_key: id,
    size: String(input.bytes.length),
    sha256: checked.sha256,
    type: checked.type,
  };
  if (storage !== 'postgres') onOutsideWrite(row);
  await fileStorage(storage, db, schema, config).write(id, Readable.from([input.bytes]));
  await query(
    db,
    sql`INSERT INTO ${ident(schema, 'files')}
    (id, org_id, table_id, field_id, ingest_file_id, name, size, type, sha256, storage, storage_key, created_by, scan_state)
    VALUES (${id}, ${owner.orgId}, ${owner.tableId}, NULL, ${owner.fileId}, ${input.name}, ${input.bytes.length},
      ${checked.type}, ${checked.sha256}, ${storage}, ${id}, ${owner.userId}, ${pending ? 'unavailable' : 'clean'})`,
  );
  return row;
}

export async function loadOriginal(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  file: IngestFile,
  rescan = false,
  lease?: { token: string },
): Promise<Buffer | null> {
  if (!file.storedFile) return null;
  const found = await query<OriginalRow>(
    db,
    sql`SELECT * FROM ${ident(schema, 'files')}
    WHERE id = ${file.storedFile} AND org_id = ${file.orgId} AND table_id = ${file.tableId}
      AND ingest_file_id = ${file.id} AND field_id IS NULL AND (scan_state = 'clean' OR (${rescan} AND scan_state = 'unavailable'))`,
  );
  const row = found.rows[0];
  if (!row || Number(row.size) > SPREADSHEET_LIMITS.uploadBytes) return null;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of fileStorage(row.storage, db, schema, config).read(row.storage_key)) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > Number(row.size)) return null;
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    if (rescan && row.scan_state === 'unavailable') {
      const checked = await inspectOriginal(db, schema, config, file.orgId, { name: file.name, bytes });
      if (checked.sha256 !== file.sha256 || size !== Number(row.size)) return null;
      const marked = await query(
        db,
        sql`UPDATE ${ident(schema, 'files')} SET scan_state = 'clean'
        WHERE id = ${row.id} AND org_id = ${file.orgId} AND ingest_file_id = ${file.id}
          ${
            lease
              ? sql`AND EXISTS (SELECT 1 FROM ${ident(schema, 'ingest_files')}
            WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${file.id}
              AND state = 'reading' AND leased_by = ${lease.token} AND lease_until > clock_timestamp())`
              : sql``
          }`,
      );
      if (lease && !marked.rowCount) throw new AppError('conflict', 'ingest.pipeline.leaseLost');
      if (checked.sha256 !== file.sha256) return null;
    }
    return size === Number(row.size) && createHash('sha256').update(bytes).digest('hex') === file.sha256
      ? bytes
      : null;
  } catch (error) {
    if (rescan && error instanceof AppError) throw error;
    return null;
  }
}

/** The caller has checked that the original is unavailable and owns the replacement transaction. */
export async function restoreOriginal(
  db: Queryable,
  schema: string,
  config: RuntimeConfig,
  owner: { orgId: string; tableId: string; fileId: string; userId: string },
  input: { name: string; bytes: Buffer; statedType?: string },
  onOutsideWrite: (original: OriginalRow) => void,
): Promise<OriginalRow> {
  const removed = await query<OriginalRow>(
    db,
    sql`DELETE FROM ${ident(schema, 'files')}
    WHERE org_id = ${owner.orgId} AND table_id = ${owner.tableId} AND ingest_file_id = ${owner.fileId}
      AND field_id IS NULL RETURNING *`,
  );
  for (const row of removed.rows) {
    if (row.storage === 'postgres') await fileStorage('postgres', db, schema, config).delete(row.storage_key);
    else onOutsideWrite(row);
  }
  // Outside bytes are removed after commit, so a rollback retains the original and removes only the new write.
  return storeOriginal(db, schema, config, owner, input, onOutsideWrite);
}

/** The caller owns the transaction and removes outside bytes only after committing it. */
export async function deleteOriginal(
  db: Queryable,
  schema: string,
  file: IngestFile,
): Promise<OriginalRow | null> {
  const owner = await query<{ is_example: boolean; draft_kept: boolean }>(
    db,
    sql`SELECT is_example, EXISTS (SELECT 1 FROM ${ident(schema, 'ingest_drafts')} d
      WHERE d.org_id = ${file.orgId} AND d.table_id = ${file.tableId} AND d.file_id = ${file.id}
        AND d.state IN ('drafting', 'ready', 'failed')) AS draft_kept FROM ${ident(schema, 'ingest_files')}
    WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${file.id} FOR UPDATE`,
  );
  if (!owner.rows[0]) return null;
  if (file.isExample || owner.rows[0].is_example) throw new AppError('conflict', 'ingest.examples.kept');
  if (owner.rows[0].draft_kept) throw new AppError('conflict', 'ingest.drafts.kept');
  const removed = await query<OriginalRow>(
    db,
    sql`DELETE FROM ${ident(schema, 'files')}
    WHERE id = ${file.storedFile} AND org_id = ${file.orgId} AND table_id = ${file.tableId}
      AND ingest_file_id = ${file.id} AND field_id IS NULL RETURNING *`,
  );
  const row = removed.rows[0];
  if (!row) return null;
  await query(
    db,
    sql`UPDATE ${ident(schema, 'ingest_files')} SET stored_file = NULL
    WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${file.id}`,
  );
  if (row.storage === 'postgres') await fileStorage('postgres', db, schema, {}).delete(row.storage_key);
  return row;
}

/** Table retention overrides example retention, with outside bytes removed only after commit. */
export async function purgeOriginals(db: Queryable, schema: string, tableId: string): Promise<OriginalRow[]> {
  const removed = await query<OriginalRow>(
    db,
    sql`DELETE FROM ${ident(schema, 'files')}
    WHERE table_id = ${tableId} AND ingest_file_id IS NOT NULL AND field_id IS NULL RETURNING *`,
  );
  for (const row of removed.rows)
    if (row.storage === 'postgres') await fileStorage('postgres', db, schema, {}).delete(row.storage_key);
  return removed.rows;
}

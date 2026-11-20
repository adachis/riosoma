import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, type AttachmentMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { actorFor } from '../automations/run.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { attachmentMeta, loadFiles, type FileRow } from './files/metadata.js';
import { loadFields } from './metadata.js';
import { loadLiveForm, type LiveForm } from './public-forms.js';
import { editableEmbed, publicSharingPolicy } from './public-sharing.js';

const missing = () => new AppError('not_found', 'errors.notFound');

export async function formFileSelection(db: Queryable, schemas: DataSchemas, formId: string) {
  const result = await query<{ files: string[]; created_by: string | null }>(
    db,
    sql`SELECT files, created_by FROM ${ident(schemas.app, 'public_forms')} WHERE id = ${formId} AND stopped_at IS NULL`,
  );
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}

/** Supporting files must be readable through an unrestricted field and a visible record. */
export async function formFilesForActor(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  tableId: string,
  databaseId: string,
  ids?: string[],
) {
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(databaseId, 'read');
  const fields = scope
    .visibleFields(tableId, await loadFields(db, schemas, [tableId]))
    .filter((field) => field.type === 'attachment' && !scope.restrictedForAnyone(tableId, field));
  const candidates = ids
    ? await loadFiles(db, schemas.app, ids)
    : (
        await query<FileRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'files')} WHERE org_id = ${actor.orgId} AND table_id = ${tableId}
      AND scan_state = 'clean' ORDER BY created_at DESC LIMIT 200`,
        )
      ).rows;
  const files: FileRow[] = [];
  for (const file of candidates) {
    const field = fields.find((item) => item.id === file.field_id);
    if (!field || file.org_id !== actor.orgId || file.table_id !== tableId || file.scan_state !== 'clean')
      continue;
    const held = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.data, tableId)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)})
        AND ${ident(field.columnName)} @> ARRAY[${file.id}]::text[] LIMIT 1`,
    );
    if (held.rowCount) files.push(file);
  }
  return files;
}

export async function editableFormFiles(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  formId: string,
  ids?: string[],
) {
  await editableEmbed(db, schemas, actor, { kind: 'form', linkId: formId });
  const live = await loadLiveForm(db, schemas, formId);
  const selection = await formFileSelection(db, schemas, formId);
  return {
    selected: selection.files,
    files: (await formFilesForActor(db, schemas, actor, live.tableId, live.databaseId, ids)).map(
      attachmentMeta,
    ),
  };
}

function signature(key: Buffer, formId: string, fileId: string, expires: number) {
  return createHmac('sha256', key)
    .update(JSON.stringify(['public-form-file', formId, fileId, expires]))
    .digest('base64url');
}

export function formFileAccepted(
  key: Buffer,
  formId: string,
  fileId: string,
  expires: number,
  signed: string,
  lifetime: number,
  now = Date.now(),
) {
  if (!Number.isInteger(expires) || expires <= now / 1000 || expires > now / 1000 + lifetime) return false;
  const expected = Buffer.from(signature(key, formId, fileId, expires));
  const given = Buffer.from(signed);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function publicFormFiles(
  ctx: AppContext,
  formId: string,
  loaded?: LiveForm,
): Promise<{ files: FileRow[]; metadata: AttachmentMeta[]; lifetime: number }> {
  const { pool, schemas } = dataStore(ctx);
  const live = loaded ?? (await loadLiveForm(pool, schemas, formId));
  const selection = await formFileSelection(pool, schemas, formId);
  if (!selection.files.length) return { files: [], metadata: [], lifetime: 0 };
  const actor = selection.created_by ? await actorFor(pool, schemas, selection.created_by, live.orgId) : null;
  if (!actor) return { files: [], metadata: [], lifetime: 0 };
  const files = await formFilesForActor(pool, schemas, actor, live.tableId, live.databaseId, selection.files);
  const policy = await publicSharingPolicy(pool, schemas, live.orgId);
  if (!policy.publicFiles) return { files: [], metadata: [], lifetime: 0 };
  const expires = Math.floor(Date.now() / 1000) + policy.fileLifetimeSeconds;
  return {
    files,
    lifetime: policy.fileLifetimeSeconds,
    metadata: files.map((file) => ({
      ...attachmentMeta(file),
      createdAt: '',
      scanSignature: null,
      url: `/api/public/forms/${formId}/files/${file.id}?${new URLSearchParams({ expires: String(expires), signature: signature(ctx.config.secretKey, formId, file.id, expires) })}`,
      thumbnails: { small: null, large: null },
    })),
  };
}

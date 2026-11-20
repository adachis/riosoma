import { idsOf, type AttachmentMeta, type RowData } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { isDemoRequest } from '../../demo/boundary.js';
import { encodedName } from './detect.js';
import type { StorageKind } from './storage.js';

export interface PreviewFile {
  key: string;
  size: number;
  sha256: string;
}
export type Thumbnails = Record<'small' | 'large', PreviewFile>;
/** Provenance shares the file's existing JSON metadata and survives preview regeneration. */
export type FileImageMetadata = Partial<Thumbnails> & { source?: AttachmentMeta['source'] };
export interface FileRow {
  id: string;
  org_id: string;
  table_id: string;
  field_id: string;
  name: string;
  size: string;
  type: string;
  width: number | null;
  height: number | null;
  sha256: string;
  storage: StorageKind;
  storage_key: string;
  thumbnails: FileImageMetadata | null;
  created_by: string | null;
  created_at: Date;
  scan_state: 'clean' | 'quarantined' | 'infected' | 'unavailable' | 'too_large' | 'too_large_allowed';
  scan_signature: string | null;
  scan_attempts: number;
  attached_at: Date | null;
}

export function attachmentMeta(file: FileRow): AttachmentMeta {
  const base = `/api/files/${file.id}`;
  // Every record and file-detail consumer gets the same URLs that serving can actually open.
  const accessible = !(isDemoRequest() && (file.storage === 's3' || file.storage === 'azure-blob'));
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size),
    type: file.type,
    width: file.width,
    height: file.height,
    scanState: file.scan_state,
    scanSignature: file.scan_signature,
    ...(file.thumbnails?.source ? { source: file.thumbnails.source } : {}),
    createdAt: file.created_at.toISOString(),
    url:
      accessible && (file.scan_state === 'clean' || file.scan_state === 'too_large_allowed')
        ? `${base}/${encodedName(file.name)}`
        : '',
    thumbnails: {
      small:
        accessible && file.scan_state === 'clean' && file.thumbnails?.small
          ? `${base}/thumbnails/small`
          : null,
      large:
        accessible && file.scan_state === 'clean' && file.thumbnails?.large
          ? `${base}/thumbnails/large`
          : null,
    },
  };
}

export async function loadFiles(
  db: Queryable,
  appSchema: string,
  ids: readonly string[],
): Promise<FileRow[]> {
  if (!ids.length) return [];
  return (
    await query<FileRow>(
      db,
      sql`SELECT * FROM ${ident(appSchema, 'files')}
    WHERE id = ANY(${ids}::text[]) AND field_id IS NOT NULL AND ingest_file_id IS NULL`,
    )
  ).rows;
}

/** The rows and visible fields have already passed the table's read scope. */
export async function rowAttachments(
  db: Queryable,
  appSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  rows: readonly (RowData | null)[],
): Promise<Record<string, AttachmentMeta>> {
  const files = fields.filter((field) => field.type === 'attachment');
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row ? files.flatMap((field) => idsOf(row.values[field.id] ?? null)) : [])),
    ),
  ];
  const loaded = await loadFiles(db, appSchema, ids);
  const allowed = new Set(files.map((field) => field.id));
  return Object.fromEntries(
    loaded
      .filter((file) => file.table_id === tableId && allowed.has(file.field_id))
      .map((file) => [file.id, attachmentMeta(file)]),
  );
}

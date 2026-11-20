import { AppError, idsOf, type RecordAttachment } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadFiles, type FileRow } from '../data/files/metadata.js';
import { fileStorage, type ByteRange, type FileStorageConfig } from '../data/files/storage.js';
import { imagePreviews } from '../data/files/previews.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { formulaRead } from '../data/physical/records.js';
import { publicAccess } from '../data/shared-view-reads.js';
import { readsLive } from '../sources/live.js';
import { unavailable, type LiveSite } from './store.js';
import { naturalCollation } from '../data/dashboards/routes.js';
import { recordsSource } from './reads.js';

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon']);
const VIDEOS = new Set(['video/mp4', 'video/webm', 'video/ogg']);
export interface PictureSize {
  width: number;
  height: number;
}

/** Repeated pictures share one metadata read, including failed reads, for this page render. */
export function pictureSizeReader(db: Queryable, schemas: DataSchemas, config: FileStorageConfig) {
  const sizes = new Map<string, Promise<PictureSize | undefined>>();
  const read = async (file: FileRow): Promise<PictureSize | undefined> => {
    if (file.width && file.height && file.width > 0 && file.height > 0)
      return { width: file.width, height: file.height };
    if (!IMAGES.has(file.type)) return undefined;
    try {
      const size = await imagePreviews(
        fileStorage(file.storage, db, schemas.app, config),
        file.storage_key,
        file.type,
        Buffer.alloc(0),
        true,
      );
      return size.width && size.height ? { width: size.width, height: size.height } : undefined;
    } catch {
      // Missing or unreadable bytes must not prevent the original media from rendering.
      return undefined;
    }
  };
  return (file: FileRow) => {
    let size = sizes.get(file.id);
    if (!size) {
      size = read(file);
      sizes.set(file.id, size);
    }
    return size;
  };
}

export async function readLogoSize(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  sizeOf: ReturnType<typeof pictureSizeReader>,
): Promise<PictureSize | undefined> {
  if (!live.settings.logo) return undefined;
  try {
    const file = (await attachmentFiles(db, schemas, live, live.settings.logo)).find(
      (item) => item.id === live.settings.logo!.attachmentId && publishableFile(item, 'image'),
    );
    return file ? sizeOf(file) : undefined;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
    return undefined;
  }
}

export function publishableFile(file: FileRow, kind: 'image' | 'video'): boolean {
  return (
    file.scan_state === 'clean' &&
    (kind === 'image' ? IMAGES : VIDEOS).has(file.type) &&
    (kind === 'video' || Number(file.size) <= 5 * 1024 * 1024)
  );
}

/** Every attachment read checks the record, field, organization, and publisher anew. */
export async function attachmentFiles(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  reference: Pick<RecordAttachment, 'tableId' | 'recordId' | 'fieldId'>,
): Promise<FileRow[]> {
  const table = await loadTable(db, schemas, reference.tableId);
  if (!table || table.trashed || table.databaseId !== live.row.database_id || readsLive(table)) unavailable();
  const access = publicAccess(live.scope, table.id, await loadFields(db, schemas, [table.id]));
  const field = access.fields.find((item) => item.id === reference.fieldId);
  if (field?.type !== 'attachment' || access.restricted.has(field.id)) unavailable();
  live.scope.requireTableUse(table.id, 'export', [field.id]);
  const read = formulaRead([field]);
  const rows = await query<Parameters<typeof read.decode>[0]>(
    db,
    sql`SELECT ${read.select} FROM ${ident(schemas.data, table.id)}
    WHERE __id = ${reference.recordId} AND __deleted_at IS NULL AND NOT __source_gone AND (${access.allowed})`,
  );
  const row = rows.rows[0] ? read.decode(rows.rows[0]) : null;
  if (!row) unavailable();
  const ids = idsOf(row.values[field.id] ?? null);
  const files = await loadFiles(db, schemas.app, ids);
  return ids.flatMap((id) =>
    files.filter(
      (file) =>
        file.id === id &&
        file.org_id === live.row.org_id &&
        file.table_id === table.id &&
        file.field_id === field.id,
    ),
  );
}

/** Only names made by the published settings or a cover on a published records block resolve. */
async function selectedFile(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  name: string,
): Promise<FileRow> {
  let reference: RecordAttachment | null =
    name === 'favicon'
      ? live.settings.favicon
      : name === 'social'
        ? live.settings.socialImage
        : name === 'logo'
          ? live.settings.logo
          : null;
  let kind: 'image' | 'video' = 'image';
  let poster = false;
  if (!reference) {
    const [pageId, blockId, recordId, attachmentId, extra] = name.split('.');
    if (extra || !pageId || !blockId) unavailable();
    const page = live.pages.find(
      (item) => item.id === pageId && live.settings.pages.some((setting) => setting.pageId === item.id),
    );
    const block = page?.blocks.find((item) => item.id === blockId);
    if (block?.kind === 'hero' && (!recordId || recordId === 'poster') && !attachmentId) {
      reference = block.image;
      poster = recordId === 'poster';
      kind = poster ? 'image' : (block.mediaType ?? 'image');
      if (poster && block.mediaType !== 'video') unavailable();
    } else if (block?.kind === 'media' && (!recordId || recordId === 'poster') && !attachmentId) {
      reference = block.attachment;
      poster = recordId === 'poster';
      kind = poster ? 'image' : block.mediaType;
      if (poster && block.mediaType !== 'video') unavailable();
    } else if (
      page &&
      block?.kind === 'records' &&
      ['cards', 'sections', 'list'].includes(block.display) &&
      block.coverFieldId &&
      recordId &&
      attachmentId
    ) {
      const source = await recordsSource(db, schemas, live, block, {
        timeZone: 'UTC',
        now: new Date(),
        natural: await naturalCollation(db, schemas),
      });
      const allowed = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.data, source.table.id)} WHERE __id = ${recordId} AND (${source.where})`,
      );
      if (!allowed.rowCount) unavailable();
      reference = { tableId: source.table.id, fieldId: block.coverFieldId, recordId, attachmentId };
      if (block.display === 'sections' || block.enlarge || block.playback === 'loop') {
        const selected = (await attachmentFiles(db, schemas, live, reference)).find(
          (file) => file.id === attachmentId,
        );
        if (selected && publishableFile(selected, 'video')) kind = 'video';
      }
    }
  }
  if (!reference) unavailable();
  const files = await attachmentFiles(db, schemas, live, reference);
  const file = poster
    ? files.find((item) => publishableFile(item, 'image'))
    : files.find((item) => item.id === reference.attachmentId && publishableFile(item, kind));
  return file ?? unavailable();
}

/** Single ranges keep playback streamed, including open-ended and suffix requests. */
export function mediaRange(header: string, length: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || length <= 0) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || (!match[1] && last === 0)) return null;
  const start = match[1] ? first : Math.max(0, length - last);
  const end = !match[1] || !match[2] ? length - 1 : Math.min(length - 1, last);
  return start <= end && start < length ? { start, end } : null;
}

/** Media stays on the site's origin, without exposing storage addresses or signed URLs. */
export async function serveImage(request: FastifyRequest, reply: FastifyReply, live: LiveSite, name: string) {
  const { pool, schemas } = dataStore(request.server.ctx);
  const file = await selectedFile(pool, schemas, live, name);
  const length = Number(file.size);
  const etag = `"${file.sha256}"`;
  reply
    .type(file.type)
    .header('x-content-type-options', 'nosniff')
    .header('content-length', length)
    .header('etag', etag);
  let range: ByteRange | undefined;
  if (VIDEOS.has(file.type)) {
    reply.header('accept-ranges', 'bytes');
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const parsed = mediaRange(request.headers.range, length);
      if (!parsed)
        return reply
          .code(416)
          .removeHeader('content-length')
          .header('content-range', `bytes */${length}`)
          .type('application/json')
          .send(new AppError('bad_request', 'data.file.range').toBody());
      range = parsed;
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${length}`)
        .header('content-length', range.end - range.start + 1);
    }
  }
  return reply.send(
    fileStorage(file.storage, pool, schemas.app, request.server.ctx.config).read(file.storage_key, range),
  );
}

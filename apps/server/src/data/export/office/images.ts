import type { Readable } from 'node:stream';
import { idsOf, type RowData } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import sharp from 'sharp';
import { loadFiles, type FileRow } from '../../files/metadata.js';
import { fileStorage, type FileStorageConfig } from '../../files/storage.js';
import type { StoredField, StoredTable } from '../../types.js';

/**
 * Attachment images for a document.  Word and PowerPoint read JPEG, PNG, and GIF but not the WebP
 * Riosoma keeps its previews in, so each image is read from its large preview when it has one, or
 * from the file itself, and written again at a size a page can use.  The files come only from
 * records and fields the person has already been shown, and only from the table and field they
 * belong to, the same check a file download makes.
 */

export interface DocumentImage {
  id: string;
  name: string;
  data: Buffer;
  type: 'png' | 'jpg';
  width: number;
  height: number;
}

export interface ImageSource {
  db: Queryable;
  appSchema: string;
  files: FileStorageConfig;
  table: StoredTable;
}

/** Types an image can be read from when it has no preview of its own */
const READABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The most bytes read for one image, so an enormous original can't hold up a download */
const SOURCE_LIMIT = 25 * 1024 * 1024;

async function bytesOf(stream: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += bytes.length;
    if (size > SOURCE_LIMIT) {
      stream.destroy();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * Whether a file can become a picture on a page.  Only a file the virus scanner has cleared is
 * read or decoded, the same rule its previews follow.
 */
export function isPicture(file: FileRow): boolean {
  return (
    file.scan_state === 'clean' &&
    file.type.startsWith('image/') &&
    (file.thumbnails?.large !== undefined || READABLE.has(file.type))
  );
}

/** An image at most `edge` pixels on its longer side, or null when it can't be read. */
export async function loadImage(
  source: ImageSource,
  file: FileRow,
  edge: number,
): Promise<DocumentImage | null> {
  if (!isPicture(file)) return null;
  const key = file.thumbnails?.large?.key ?? file.storage_key;
  try {
    const storage = fileStorage(file.storage, source.db, source.appSchema, source.files);
    const bytes = await bytesOf(storage.read(key));
    if (!bytes?.length) return null;
    // Transparency needs PNG, and everything else is smaller as JPEG, which a deck of a couple of
    // hundred pictures notices.
    const lossless = (await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata()).hasAlpha;
    const image = sharp(bytes, { limitInputPixels: 50_000_000, animated: false })
      .rotate()
      .resize(edge, edge, { fit: 'inside', withoutEnlargement: true });
    const { data, info } = await (lossless ? image.png() : image.jpeg({ quality: 82 })).toBuffer({
      resolveWithObject: true,
    });
    return {
      id: file.id,
      name: file.name,
      data,
      type: lossless ? 'png' : 'jpg',
      width: info.width,
      height: info.height,
    };
  } catch {
    // A missing or unreadable image leaves its file name, which the document shows anyway.
    return null;
  }
}

/**
 * The files a record holds in a field, in the order the field lists them, each checked to belong
 * to that table and field.
 */
export async function fieldFiles(source: ImageSource, field: StoredField, row: RowData): Promise<FileRow[]> {
  const ids = idsOf(row.values[field.id] ?? null);
  if (field.type !== 'attachment' || !ids.length) return [];
  const byId = new Map(
    (await loadFiles(source.db, source.appSchema, ids))
      .filter(
        (file) =>
          file.org_id === source.table.orgId &&
          file.table_id === source.table.id &&
          file.field_id === field.id,
      )
      .map((file) => [file.id, file]),
  );
  return ids.flatMap((id) => {
    const file = byId.get(id);
    return file ? [file] : [];
  });
}

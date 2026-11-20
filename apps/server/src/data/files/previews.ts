import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import type { FileStorage } from './storage.js';
import type { Thumbnails } from './metadata.js';

export interface ImageDetails {
  width: number | null;
  height: number | null;
  thumbnails: Thumbnails | null;
}

/**
 * The one format each detected type may decode as.  The image library picks its decoder from the
 * bytes by its own rules, so a file is decoded only when both agree on what it is.  A type with no
 * entry, such as a bitmap or a drawing, never reaches a decoder.
 */
const DECODED_AS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/avif': 'heif',
  'image/heic': 'heif',
};

/** The longest one preview may take to render, so a slow image can't hold up an upload or a scan */
const PREVIEW_SECONDS = 20;

function dimension(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

export async function imagePreviews(
  storage: FileStorage,
  key: string,
  type: string,
  head: Buffer,
  dimensionsOnly = false,
): Promise<ImageDetails> {
  const result: ImageDetails = { width: null, height: null, thumbnails: null };
  if (!type.startsWith('image/')) return result;
  if (type === 'image/svg+xml') {
    const root = /<svg\b([^>]*)>/i.exec(head.toString('utf8'))?.[1];
    const width = root && /\bwidth=["'](\d+)(?:px)?["']/i.exec(root)?.[1];
    const height = root && /\bheight=["'](\d+)(?:px)?["']/i.exec(root)?.[1];
    if (width && height && Number(width) > 0 && Number(height) > 0) {
      result.width = dimension(Number(width));
      result.height = dimension(Number(height));
    }
    return result;
  }
  if (type === 'image/bmp' && head.length >= 26) {
    const dib = head.readUInt32LE(14);
    result.width = dimension(dib === 12 ? head.readUInt16LE(18) : Math.abs(head.readInt32LE(18)));
    result.height = dimension(dib === 12 ? head.readUInt16LE(20) : Math.abs(head.readInt32LE(22)));
    if (!result.width || !result.height) {
      result.width = null;
      result.height = null;
    }
  }
  const format = Object.hasOwn(DECODED_AS, type) ? DECODED_AS[type] : undefined;
  if (!format) return result;
  const directory = await mkdtemp(join(tmpdir(), 'rio-preview-'));
  try {
    const source = join(directory, 'source');
    await pipeline(storage.read(key), createWriteStream(source, { mode: 0o600 }));
    try {
      const metadata = await sharp(source, { limitInputPixels: false }).metadata();
      if (metadata.format !== format || !metadata.width || !metadata.height) return result;
      const rotated = (metadata.orientation ?? 1) >= 5;
      result.width = dimension(rotated ? metadata.height : metadata.width);
      result.height = dimension(rotated ? metadata.width : metadata.height);
      // Page rendering only needs dimensions and must not write previews in its read-only transaction.
      if (dimensionsOnly || metadata.width * metadata.height > 50_000_000) return result;
      const thumbnails = {} as Thumbnails;
      for (const [size, edge] of [
        ['small', 256],
        ['large', 1600],
      ] as const) {
        const bytes = await sharp(source, { limitInputPixels: 50_000_000, animated: false })
          .rotate()
          .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
          .webp()
          .timeout({ seconds: PREVIEW_SECONDS })
          .toBuffer();
        const previewKey = `${key}_${size}`;
        await storage.write(previewKey, Readable.from([bytes]));
        thumbnails[size] = {
          key: previewKey,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      result.thumbnails = thumbnails;
    } catch {
      // A corrupt image or an unavailable decoder must not prevent keeping the original file.
      if (!dimensionsOnly) for (const size of ['small', 'large']) await storage.delete(`${key}_${size}`);
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

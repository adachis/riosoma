import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectType } from './detect.js';
import { imagePreviews } from './previews.js';
import type { FileStorage } from './storage.js';

/** A store that keeps bytes in memory, so a test can see which keys were written and read. */
function memoryStorage(files: Map<string, Buffer>, reads: string[]): FileStorage {
  return {
    async write(key, source) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(chunk as Buffer);
      files.set(key, Buffer.concat(chunks));
    },
    read(key) {
      reads.push(key);
      return Readable.from([files.get(key) ?? Buffer.alloc(0)]);
    },
    async delete(key) {
      files.delete(key);
    },
    async copy(from, to) {
      files.set(to, files.get(from)!);
    },
  };
}

// An XML comment that reads as a file type box, ahead of a well-formed drawing.
const disguised = Buffer.from(
  '<!--ftypabcd0000avif--><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30"/></svg>',
);

async function previewsOf(bytes: Buffer, type: string) {
  const files = new Map([['file', bytes]]);
  const reads: string[] = [];
  const details = await imagePreviews(memoryStorage(files, reads), 'file', type, bytes);
  return { details, keys: [...files.keys()], reads };
}

describe('image previews', () => {
  it('decodes a file only as the type its signature named', async () => {
    const none = { width: null, height: null, thumbnails: null };
    // Under a raster or container label, a drawing is never drawn and gives no dimensions.
    for (const type of ['image/avif', 'image/heic', 'image/png'])
      expect(await previewsOf(disguised, type), type).toMatchObject({ details: none, keys: ['file'] });
    // A type no decoder is named for isn't read at all.
    expect(await previewsOf(disguised, 'image/x-unknown')).toEqual({
      details: none,
      keys: ['file'],
      reads: [],
    });
    const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    expect(await previewsOf(jpeg, 'image/png')).toMatchObject({ details: none, keys: ['file'] });
    const matched = await previewsOf(jpeg, 'image/jpeg');
    expect(matched.details).toMatchObject({ width: 30, height: 20 });
    expect(matched.details.thumbnails?.small.key).toBe('file_small');
    expect(matched.keys.sort()).toEqual(['file', 'file_large', 'file_small']);
  });

  it('keeps a bitmap’s header dimensions without reading the file for a decoder', async () => {
    const bitmap = Buffer.alloc(26);
    bitmap.write('BM');
    bitmap.writeUInt32LE(40, 14);
    bitmap.writeInt32LE(12, 18);
    bitmap.writeInt32LE(-9, 22);
    expect(await previewsOf(bitmap, 'image/bmp')).toEqual({
      details: { width: 12, height: 9, thumbnails: null },
      keys: ['file'],
      reads: [],
    });
  });
});

describe('file type boxes', () => {
  const box = (length: number, brands: string) => {
    const bytes = Buffer.alloc(8 + brands.length);
    bytes.writeUInt32BE(length);
    bytes.write(`ftyp${brands}`, 4);
    return bytes;
  };

  it('reads a container type only from a box with a plausible length', () => {
    expect(detectType(disguised)).toBe('image/svg+xml');
    expect(detectType(Buffer.from('    ftypavif0000avif plain text'))).toBe('text/plain');
    expect(detectType(box(24, 'avif0000avifmif1'))).toBe('image/avif');
    expect(detectType(box(24, 'heic0000mif1heic'))).toBe('image/heic');
    expect(detectType(box(32, 'isom00000200isomiso2avc1mp41'))).toBe('video/mp4');
    expect(detectType(box(20, 'qt  00000000qt  '))).toBe('video/quicktime');
    for (const length of [0, 1, 8, 12, 22, 4096])
      expect(detectType(box(length, 'avif0000avifmif1')), String(length)).toBe('application/octet-stream');
  });
});

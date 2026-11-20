import { Readable } from 'node:stream';
import { createInflateRaw, inflateRawSync } from 'node:zlib';

/**
 * The parts of a zip archive held in memory, read from its central directory.  A workbook is a
 * zip of XML parts, and reading the directory lets a reader take the parts in the order it needs
 * them, shared strings before sheets, rather than the order they were written in.
 */

export class ZipError extends Error {}
/** An entry that unpacks to more than the reader allows. */
export class ZipTooLarge extends ZipError {}
export class ZipEncrypted extends ZipError {}

export interface ZipEntry {
  name: string;
  /** 0 is stored and 8 is deflated, the only two a workbook uses */
  method: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts */
  offset: number;
  checksum: number;
}

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const SATURATED = 0xffffffff;

function uint64(bytes: Buffer, at: number): number {
  const value = bytes.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError();
  return Number(value);
}

function endOfDirectory(bytes: Buffer): { count: number; start: number } {
  // The record is 22 bytes, followed by a comment of up to 65,535.
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (bytes.readUInt32LE(at) !== END) continue;
    const count = bytes.readUInt16LE(at + 10);
    const start = bytes.readUInt32LE(at + 16);
    if (count !== 0xffff && start !== SATURATED) return { count, start };
    // A zip64 archive keeps the real numbers in a record of its own, found through a locator.
    if (at < 20 || bytes.readUInt32LE(at - 20) !== END64_LOCATOR) throw new ZipError();
    const record = uint64(bytes, at - 12);
    if (bytes.readUInt32LE(record) !== END64) throw new ZipError();
    return { count: uint64(bytes, record + 32), start: uint64(bytes, record + 48) };
  }
  throw new ZipError();
}

/** Every entry by name.  Anything malformed throws a `ZipError`. */
export function zipEntries(bytes: Buffer, maxEntries = 10000): Map<string, ZipEntry> {
  try {
    const { count, start } = endOfDirectory(bytes);
    if (count > maxEntries) throw new ZipTooLarge();
    const entries = new Map<string, ZipEntry>();
    let at = start;
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(at) !== CENTRAL) throw new ZipError();
      const flags = bytes.readUInt16LE(at + 8);
      const nameLength = bytes.readUInt16LE(at + 28);
      const extraLength = bytes.readUInt16LE(at + 30);
      const commentLength = bytes.readUInt16LE(at + 32);
      const entry: ZipEntry = {
        name: bytes.toString('utf8', at + 46, at + 46 + nameLength),
        method: bytes.readUInt16LE(at + 10),
        compressedSize: bytes.readUInt32LE(at + 20),
        size: bytes.readUInt32LE(at + 24),
        offset: bytes.readUInt32LE(at + 42),
        checksum: bytes.readUInt32LE(at + 16),
      };
      // Encrypted entries can't be read without a password.
      if (flags & 1) throw new ZipEncrypted();
      // Sizes and offsets too big for 32 bits move to a zip64 extra field, in this order.
      const saturated = (['size', 'compressedSize', 'offset'] as const).filter(
        (key) => entry[key] === SATURATED,
      );
      if (saturated.length) {
        let extra = at + 46 + nameLength;
        const end = extra + extraLength;
        while (extra + 4 <= end && bytes.readUInt16LE(extra) !== 1)
          extra += 4 + bytes.readUInt16LE(extra + 2);
        if (extra + 4 > end) throw new ZipError();
        saturated.forEach((key, position) => {
          entry[key] = uint64(bytes, extra + 4 + position * 8);
        });
      }
      if (entries.has(entry.name)) throw new ZipError();
      entries.set(entry.name, entry);
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } catch (error) {
    // Reading past the end of a truncated file lands here as a range error.
    throw error instanceof ZipError ? error : new ZipError(undefined, { cause: error });
  }
}

function compressed(bytes: Buffer, entry: ZipEntry): Buffer {
  const at = entry.offset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== LOCAL) throw new ZipError();
  if (bytes.readUInt16LE(at + 6) & 1) throw new ZipEncrypted();
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  if (start + entry.compressedSize > bytes.length) throw new ZipError();
  return bytes.subarray(start, start + entry.compressedSize);
}

/** An entry's contents as a stream, for parts too large to hold whole. */
export function entryStream(bytes: Buffer, entry: ZipEntry): Readable {
  const data = compressed(bytes, entry);
  if (entry.method === 0) return Readable.from([data]);
  if (entry.method !== 8) throw new ZipError();
  const inflate = createInflateRaw();
  inflate.end(data);
  return inflate;
}

/** An entry's contents whole, refusing any that would grow past `limit` bytes. */
export function entryBytes(bytes: Buffer, entry: ZipEntry, limit: number): Buffer {
  const data = compressed(bytes, entry);
  if (entry.method === 0) {
    if (data.length > limit) throw new ZipTooLarge();
    return data;
  }
  if (entry.method !== 8) throw new ZipError();
  try {
    return inflateRawSync(data, { maxOutputLength: limit });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw code === 'ERR_BUFFER_TOO_LARGE' ? new ZipTooLarge() : new ZipError(undefined, { cause: error });
  }
}

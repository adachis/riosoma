import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { AppError } from '@riosoma/contracts';

/** The most one archive may be, whether it's downloaded or uploaded */
export const MAX_DRIVER_BYTES = 96 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
/** The most one extended header may hold, far more than the times and attributes archives put there */
const MAX_PAX_BYTES = 64 * 1024;
/** How many links one link may pass through on the way to the file it names */
const MAX_LINK_HOPS = 8;
const INTEGRITY = /^(sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/;
/**
 * What an extended header may say about the entry after it: times, owners, and extended attributes,
 * which unpacking ignores.  A key that would change the entry's name, size, or link, or anything
 * else, refuses the archive.
 */
const PAX_KEYS = /^((mtime|atime|ctime|uid|gid|uname|gname)|(SCHILY|LIBARCHIVE)\.xattr\..+)$/;
const invalid = () => new AppError('validation_failed', 'sources.drivers.archiveInvalid');
const mismatch = () => new AppError('validation_failed', 'sources.drivers.integrity');
/** An archive larger than any the catalog pins, refused as its bytes arrive */
export const tooLarge = () => new AppError('payload_too_large', 'sources.drivers.archiveInvalid');

/** The hash an integrity value names, or a refusal when it isn't one the catalog uses */
function integrityHash(integrity: string) {
  if (!INTEGRITY.test(integrity)) throw invalid();
  return {
    hash: createHash(integrity.startsWith('sha256-') ? 'sha256' : 'sha512'),
    expected: Buffer.from(integrity.slice(7), 'base64'),
  };
}

function matches(actual: Buffer, expected: Buffer): void {
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw mismatch();
}

export function verifyIntegrity(bytes: Buffer, integrity: string): void {
  if (bytes.length > MAX_DRIVER_BYTES) throw invalid();
  const { hash, expected } = integrityHash(integrity);
  matches(hash.update(bytes).digest(), expected);
}

/**
 * Writes an archive to a new file at `path` as its bytes arrive, hashing and counting them on the
 * way, so no archive is ever held whole in memory.  One byte past `MAX_DRIVER_BYTES` stops it
 * there, and a file whose hash isn't the catalog's is removed before anything reads it.  The
 * source's own failures, like a dropped connection or a deadline that ended it, pass through for
 * the caller to name.
 */
export async function receiveArchive(
  source: AsyncIterable<Uint8Array | string>,
  integrity: string,
  path: string,
): Promise<number> {
  const { hash, expected } = integrityHash(integrity);
  let size = 0;
  try {
    await pipeline(
      async function* () {
        for await (const chunk of source) {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += bytes.byteLength;
          if (size > MAX_DRIVER_BYTES) throw tooLarge();
          hash.update(bytes);
          yield bytes;
        }
      },
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    matches(hash.digest(), expected);
    return size;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export interface UnpackOptions {
  /** `copy` turns a link to a file in its own folder into a copy of that file */
  links?: 'copy';
}

/** Unpacks an archive `receiveArchive` wrote, checking its hash again as it's read. */
export async function unpackDriverFile(
  path: string,
  integrity: string,
  directory: string,
  root: string,
  options: UnpackOptions = {},
): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_DRIVER_BYTES) throw invalid();
  await unpackDriver(await readFile(path), integrity, directory, root, options);
}

function safeName(name: string): string {
  if (
    !name ||
    /[\\:]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    name.startsWith('/')
  )
    throw invalid();
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw invalid();
  return parts.join('/');
}

/**
 * Reads an extended header's records, each its own length in digits, a space, and `key=value` and a
 * newline, and refuses any key outside `PAX_KEYS`.  Nothing it says is applied.
 */
function checkPax(body: Buffer): void {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    const digits = space < 0 ? '' : body.subarray(offset, space).toString('latin1');
    if (!/^[1-9][0-9]{0,5}$/.test(digits)) throw invalid();
    const end = offset + Number(digits);
    if (end > body.length || body[end - 1] !== 10) throw invalid();
    const equals = body.indexOf(61, space + 1);
    if (equals < 0 || equals >= end) throw invalid();
    if (!PAX_KEYS.test(body.subarray(space + 1, equals).toString('utf8'))) throw invalid();
    offset = end;
  }
}

interface Entry {
  path: string;
  bytes: Buffer;
  directory: boolean;
  /** The file a link names, within the link's own folder */
  link?: string;
}

/**
 * Validate every header before writing anything.  Devices, sparse files, hard links, and any link
 * the archive's options don't allow fail closed, and so does an extended header that says more
 * than times, owners, and attributes.
 */
export async function unpackDriver(
  bytes: Buffer,
  integrity: string,
  directory: string,
  root: string,
  options: UnpackOptions = {},
): Promise<void> {
  verifyIntegrity(bytes, integrity);
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    throw invalid();
  }
  const entries: Entry[] = [];
  const names = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = (b: Buffer) => decoder.decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
  let offset = 0;
  let ended = false;
  let extended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (extended || tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0))
        throw invalid();
      ended = true;
      break;
    }
    const octal = (start: number, length: number) => {
      const value = text(header.subarray(start, start + length)).trim();
      if (!/^[0-7]+$/.test(value)) throw invalid();
      return Number.parseInt(value, 8);
    };
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (octal(148, 8) !== checksum) throw invalid();
    const kind = header[156];
    const size = octal(124, 12);
    if (!Number.isSafeInteger(size) || size > MAX_EXPANDED_BYTES) throw invalid();
    offset += 512;
    if (offset + size > tar.length) throw invalid();
    // An extended header describes the one entry after it, and says only what `checkPax` allows.
    if (kind === 120) {
      if (extended || size > MAX_PAX_BYTES) throw invalid();
      checkPax(tar.subarray(offset, offset + size));
      extended = true;
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    extended = false;
    const prefix = text(header.subarray(345, 500));
    const path = safeName(`${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`);
    if (path !== root && !path.startsWith(`${root}/`)) throw invalid();
    if (names.has(path) || names.size >= 20000) throw invalid();
    names.add(path);
    const directoryEntry = kind === 53;
    const linkEntry = kind === 50;
    if (!directoryEntry && !linkEntry && kind !== 0 && kind !== 48) throw invalid();
    if ((directoryEntry || linkEntry) && size !== 0) throw invalid();
    if (path === root && !directoryEntry) throw invalid();
    let link: string | undefined;
    if (linkEntry) {
      if (options.links !== 'copy') throw invalid();
      link = safeName(text(header.subarray(157, 257)));
      // Only a file in the link's own folder, so a link can never reach past the driver.
      if (link.includes('/')) throw invalid();
    }
    if (path !== root)
      entries.push({
        path: path.slice(root.length + 1),
        bytes: tar.subarray(offset, offset + size),
        directory: directoryEntry,
        link,
      });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !entries.length) throw invalid();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let written = 0;
  for (const entry of entries) {
    let file = entry;
    for (let hops = 0; file.link !== undefined; hops++) {
      const next = byPath.get(posix.join(posix.dirname(file.path), file.link));
      if (!next || next.directory || hops >= MAX_LINK_HOPS) throw invalid();
      file = next;
    }
    written += file.bytes.length;
    if (written > MAX_EXPANDED_BYTES) throw invalid();
    const path = join(directory, entry.path);
    await mkdir(entry.directory ? path : dirname(path), { recursive: true, mode: 0o700 });
    if (!entry.directory) await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
  }
}

/** The one file named `name` in a zip, checked against the size and CRC its directory records */
function zipEntry(zip: Buffer, name: string, size: number): Buffer {
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > zip.length) throw invalid();
    return zip.readUInt16LE(at);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > zip.length) throw invalid();
    return zip.readUInt32LE(at);
  };
  // The directory's end record is the last 22 bytes, or before a comment of at most 65,535.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--)
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw invalid();
  const count = u16(end + 10);
  const start = u32(end + 16);
  if (start + u32(end + 12) > end) throw invalid();
  let found: { flags: number; method: number; crc: number; compressed: number; local: number } | null = null;
  let at = start;
  for (let index = 0; index < count; index++) {
    if (u32(at) !== 0x02014b50) throw invalid();
    const nameLength = u16(at + 28);
    if (at + 46 + nameLength > end) throw invalid();
    if (zip.subarray(at + 46, at + 46 + nameLength).toString('utf8') === name) {
      if (found || u32(at + 24) !== size) throw invalid();
      found = {
        flags: u16(at + 8),
        method: u16(at + 10),
        crc: u32(at + 16),
        compressed: u32(at + 20),
        local: u32(at + 42),
      };
    }
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  // An encrypted entry, or one packed any way but stored or deflated, is refused.
  if (!found || found.flags & 1 || (found.method !== 0 && found.method !== 8)) throw invalid();
  const { local } = found;
  if (u32(local) !== 0x04034b50) throw invalid();
  const localName = u16(local + 26);
  if (zip.subarray(local + 30, local + 30 + localName).toString('utf8') !== name) throw invalid();
  const data = local + 30 + localName + u16(local + 28);
  if (data + found.compressed > start) throw invalid();
  const packed = zip.subarray(data, data + found.compressed);
  let bytes: Buffer;
  try {
    bytes = found.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
  } catch {
    throw invalid();
  }
  if (bytes.length !== size || crc32(bytes) !== found.crc) throw invalid();
  return bytes;
}

/**
 * Takes one native add-on out of a zip an archive unpacked, as the package's own installer would,
 * and writes it to `target` once its SHA-256 matches the catalog's.
 */
export async function extractAddon(
  zipPath: string,
  entry: string,
  sha256: string,
  size: number,
  target: string,
): Promise<void> {
  const info = await lstat(zipPath);
  if (!info.isFile() || info.size > MAX_DRIVER_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw invalid();
  const bytes = zipEntry(await readFile(zipPath), entry, size);
  matches(createHash('sha256').update(bytes).digest(), Buffer.from(sha256, 'hex'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
}

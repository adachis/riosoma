import { crc32 } from 'node:zlib';
import { entryBytes, zipEntries, ZipTooLarge, type ZipEntry } from '../../data/imports/zip.js';
import { ExtractionFailure, LIMITS } from './types.js';

export function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(bytes.readUInt32LE(0));
}

/** Central-directory caps apply before a container parser can allocate or inflate anything. */
export function guardedEntries(bytes: Buffer): Map<string, ZipEntry> {
  let entries: Map<string, ZipEntry>;
  try {
    entries = zipEntries(bytes, LIMITS.members);
  } catch (error) {
    if (error instanceof ZipTooLarge) throw new ExtractionFailure('archive-count');
    throw error;
  }
  let expanded = 0;
  for (const entry of entries.values()) {
    expanded += entry.size;
    if (expanded > LIMITS.expandedBytes) throw new ExtractionFailure('archive-size');
    if (entry.size > Math.max(1, entry.compressedSize) * LIMITS.expansionRatio)
      throw new ExtractionFailure('archive-ratio');
  }
  return entries;
}

/** Actual output, declared sizes, and checksums must agree before a member is handed to a parser. */
export function guardedMember(bytes: Buffer, entry: ZipEntry): Buffer {
  let member: Buffer;
  try {
    member = entryBytes(bytes, entry, Math.max(1, entry.size));
  } catch (error) {
    if (error instanceof ZipTooLarge) throw new ExtractionFailure('archive-size');
    throw error;
  }
  if (member.length !== entry.size || crc32(member) !== entry.checksum)
    throw new ExtractionFailure('invalid');
  return member;
}

import type { ExportFormat } from '@riosoma/contracts';

/**
 * Names for the downloaded file and its worksheet.  Both come from names people type, so both are
 * reduced to what a file system and Excel accept; neither is ever used to build a path here, and
 * the header that carries the file name encodes it per RFC 5987, so a name in any script survives.
 */

const EXTENSION: Record<ExportFormat | 'pdf', string> = {
  csv: '.csv',
  xlsx: '.xlsx',
  docx: '.docx',
  pptx: '.pptx',
  pdf: '.pdf',
};

/** Control characters, and the separators and reserved characters Windows and POSIX refuse. */
const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}]/gu;

/** Excel's own list for worksheet names. */
const UNSAFE_SHEET = /[*?:\\/[\]]/g;

/** Short enough to leave room for a download folder and the extension. */
const NAME_PART = 60;

/** Excel's limit for a worksheet name. */
const SHEET_NAME = 31;

/** Used when sanitizing leaves nothing behind, since both names have to say something. */
const FALLBACK = 'records';

/** An unusable character becomes a space, so `Q1/Q2` reads as two words rather than one dash. */
function tidy(name: string, limit: number, unsafe: RegExp): string {
  return (
    name
      .replace(unsafe, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
      // A trailing dot or space disappears on Windows, which would leave a different name behind.
      .replace(/[.\s]+$/, '')
      .trim()
  );
}

/**
 * `<table> - <view>` plus the format's extension, safe on every file system.  A record's document is
 * named the same way, after its table and its title.
 */
export function exportFileName(tableName: string, viewName: string, format: ExportFormat | 'pdf'): string {
  const parts = [tidy(tableName, NAME_PART, UNSAFE_NAME), tidy(viewName, NAME_PART, UNSAFE_NAME)].filter(
    Boolean,
  );
  return `${parts.length ? parts.join(' - ') : FALLBACK}${EXTENSION[format]}`;
}

/** `<database> - <snapshot>.riosoma.json` for a downloaded snapshot, safe on every file system. */
export function archiveFileName(databaseName: string, snapshotName: string): string {
  const parts = [
    tidy(databaseName, NAME_PART, UNSAFE_NAME),
    tidy(snapshotName, NAME_PART, UNSAFE_NAME),
  ].filter(Boolean);
  return `${parts.length ? parts.join(' - ') : 'database'}.riosoma.json`;
}

/** A worksheet name Excel accepts: its own forbidden characters gone, at most 31 characters. */
export function sheetName(viewName: string): string {
  const name = tidy(viewName, SHEET_NAME, UNSAFE_SHEET)
    .replace(/^'+|'+$/g, '')
    .trim();
  return name || FALLBACK;
}

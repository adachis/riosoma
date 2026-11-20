import type { FileFormat } from '@riosoma/contracts';

/** Which formats keep their own types, and which are cells read the way the upload importer reads them. */
export const CELL_FORMATS: ReadonlySet<FileFormat> = new Set(['csv', 'tsv', 'xlsx']);

const EXTENSIONS: ReadonlyArray<readonly [RegExp, FileFormat]> = [
  [/\.csv$/i, 'csv'],
  [/\.(tsv|tab)$/i, 'tsv'],
  [/\.json$/i, 'json'],
  [/\.(ndjson|jsonl)$/i, 'ndjson'],
  [/\.(parquet|pq)$/i, 'parquet'],
  [/\.xlsx$/i, 'xlsx'],
];

const CONTENT_TYPES: ReadonlyArray<readonly [RegExp, FileFormat]> = [
  [/^text\/csv\b/i, 'csv'],
  [/^text\/tab-separated-values\b/i, 'tsv'],
  [/^application\/(x-)?ndjson\b|^application\/jsonl\b|^application\/x-jsonlines\b/i, 'ndjson'],
  [/^application\/json\b/i, 'json'],
  [/^application\/(vnd\.apache\.)?parquet\b|^application\/x-parquet\b/i, 'parquet'],
  [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\b/i, 'xlsx'],
];

/** A file's format from its name's extension, or null when the name doesn't say. */
export function formatOfName(name: string): FileFormat | null {
  return EXTENSIONS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** A format from an answer's content type, for addresses whose names don't say. */
export function formatOfContentType(contentType: string | undefined): FileFormat | null {
  if (!contentType) return null;
  return CONTENT_TYPES.find(([pattern]) => pattern.test(contentType.trim()))?.[1] ?? null;
}

/** The name DuckDB's readers are given on disk: the file's place in the call and its format. */
export function localName(index: number, format: FileFormat): string {
  return `${index}.${format}`;
}

/**
 * A bucket object that stands for every file of one format under a prefix, written the way a
 * pattern would be: `exports/*.csv`.  A key could hold `*` too, but one that ends like this and
 * names a format is read as the pattern.
 */
export function unionName(prefix: string, format: FileFormat): string {
  return `${prefix}*.${format}`;
}

export function parseUnionName(name: string): { prefix: string; format: FileFormat } | null {
  const found = /^(.*)\*\.(csv|tsv|json|ndjson|parquet|xlsx)$/.exec(name);
  return found ? { prefix: found[1]!, format: found[2] as FileFormat } : null;
}

/** The last part of an address's path, for naming the file a web address points at. */
export function fileNameOf(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  const last = parts.at(-1);
  if (!last) return url.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Whether a file's first bytes look like its format, so a wrong setting is caught before parsing. */
export function looksLike(format: FileFormat, head: Buffer): boolean {
  switch (format) {
    case 'parquet':
      return head.subarray(0, 4).toString('latin1') === 'PAR1';
    case 'xlsx':
      return head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case 'json':
    case 'ndjson': {
      const text = head
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
      return text.startsWith('{') || text.startsWith('[');
    }
    case 'csv':
    case 'tsv': {
      // Text with no NUL bytes, unless it's UTF-16, whose byte order mark says so.
      const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
      return utf16 || !head.includes(0);
    }
  }
}

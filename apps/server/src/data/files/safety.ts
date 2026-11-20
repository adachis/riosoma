import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { AppError, FileSafetySettings } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { RuntimeConfig } from '../../config.js';
import { entryBytes, zipEntries, ZipEncrypted, ZipTooLarge } from '../imports/zip.js';
import { clamAvScanner, ScanTooLarge } from './clamd.js';
import { detectType } from './detect.js';
import { checkPdf } from './safety-pdf.js';
import { fileSafetySettings, requireApprovedScanner, scannerSettings } from './settings.js';

export type FileCheckReason =
  | 'files.checks.typeMismatch'
  | 'files.checks.executable'
  | 'files.checks.macros'
  | 'files.checks.passwordProtected'
  | 'files.checks.archiveRatio'
  | 'files.checks.archiveMembers'
  | 'files.checks.archiveDepth'
  | 'files.checks.archiveSize'
  | 'files.checks.archiveUnsupported'
  | 'files.checks.inspectionLimit'
  | 'files.checks.unreadable'
  | 'files.checks.infected'
  | 'files.checks.scannerUnavailable'
  | 'files.scanner.addressNotApproved'
  | 'files.scanner.tooLarge';
export type FileCheckNote =
  'files.checks.pdfActiveContent' | 'files.checks.htmlActiveContent' | 'files.checks.macrosAllowed';
export type FileSafetyResult =
  | { state: 'safe'; type: string }
  | { state: 'noted'; type: string; notes: FileCheckNote[] }
  | { state: 'held'; type: string; reason: FileCheckReason; signature?: string };

export interface FileSafetyInput {
  bytes: Buffer;
  name?: string;
  statedType?: string;
  origin?: 'organization' | 'outside';
}
export interface FileSafetyContext {
  db: Queryable;
  schema: string;
  orgId: string;
  config: RuntimeConfig;
}

// Bound both declared sizes and actual output, including work repeated by nested containers.
export const FILE_CHECK_LIMITS = {
  expansionRatio: 100,
  members: 1000,
  nestingDepth: 3,
  expandedBytes: 64 * 1024 * 1024,
} as const;

const extensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  txt: 'text/plain',
  csv: 'text/plain',
  tsv: 'text/plain',
  json: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xltm: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsb: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/x-ole-storage',
  xls: 'application/x-ole-storage',
  ppt: 'application/x-ole-storage',
  exe: 'application/x-executable',
  dll: 'application/x-executable',
  sh: 'application/x-script',
  ps1: 'application/x-script',
  bat: 'application/x-script',
  cmd: 'application/x-script',
  js: 'application/x-script',
  py: 'application/x-script',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
const mediaAliases: Record<string, string> = {
  'text/csv': 'text/plain',
  'text/tab-separated-values': 'text/plain',
  'application/json': 'text/plain',
  'application/x-zip-compressed': 'application/zip',
  'application/x-gzip': 'application/gzip',
  'application/x-pdf': 'application/pdf',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'application/msword': 'application/x-ole-storage',
  'application/vnd.ms-excel': 'application/x-ole-storage',
  'application/vnd.ms-powerpoint': 'application/x-ole-storage',
  'application/vnd.ms-word.document.macroenabled.12': extensions.docx!,
  'application/vnd.ms-excel.sheet.macroenabled.12': extensions.xlsx!,
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': extensions.xlsx!,
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': extensions.pptx!,
};

function starts(bytes: Buffer, hex: string) {
  return bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
}

function tarOctal(header: Buffer, start: number, length: number) {
  const text = header
    .toString('ascii', start, start + length)
    .replace(/\0.*$/, '')
    .trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
}

function validTarHeader(header: Buffer) {
  if (header.length !== 512 || header[0] === 0) return false;
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  const signedChecksum = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte > 127 ? byte - 256 : byte),
    0,
  );
  return (
    [checksum, signedChecksum].includes(tarOctal(header, 148, 8)) &&
    Number.isSafeInteger(tarOctal(header, 124, 12))
  );
}

function withoutLeadingComments(source: string): string {
  let text = source.replace(/^\uFEFF/, '').trimStart();
  for (;;) {
    const block = text.startsWith('/*')
      ? ['/*', '*/']
      : text.startsWith('<!--')
        ? ['<!--', '-->']
        : text.startsWith('<#')
          ? ['<#', '#>']
          : undefined;
    if (block) {
      const end = text.indexOf(block[1]!, block[0]!.length);
      if (end < 0) return text;
      text = text.slice(end + block[1]!.length).trimStart();
    } else if (/^(?:\/\/|#(?!!)|::|rem\s)/i.test(text)) {
      const end = text.search(/[\r\n]/);
      if (end < 0) return '';
      text = text.slice(end + 1).trimStart();
    } else return text;
  }
}

function contentType(bytes: Buffer): string {
  if (starts(bytes, '1f8b')) return 'application/gzip';
  if (bytes.toString('ascii', 257, 262) === 'ustar' || validTarHeader(bytes.subarray(0, 512)))
    return 'application/x-tar';
  if (starts(bytes, '526172211a07')) return 'application/vnd.rar';
  if (starts(bytes, '377abcaf271c')) return 'application/x-7z-compressed';
  if (starts(bytes, 'd0cf11e0a1b11ae1')) return 'application/x-ole-storage';
  if (
    ['4d5a', '7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', '0061736d'].some(
      (magic) => starts(bytes, magic),
    )
  )
    return 'application/x-executable';
  const sample = bytes.toString('utf8', 0, Math.min(bytes.length, 65536));
  let prefix = withoutLeadingComments(sample);
  // The sniff window starts after leading comments, including one that spans the first window.
  if (bytes.length > 65536 && (prefix.length < sample.length || /^(?:\/\*|<!--|<#)/.test(prefix)))
    prefix = withoutLeadingComments(bytes.toString('utf8'));
  const text = prefix.slice(0, 65536);
  if (
    /^(?:#!|<\?php\b|@echo\s+off\b|<script\b|(?:Write-Host|Invoke-Expression|Start-Process)\s)/i.test(text) ||
    (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text) && /<script\b|\bon\w+\s*=/i.test(text)) ||
    /^(?:import\s+[^\n]+\s+from\s+['"]|(?:const|let|var)\s+\w+\s*=\s*(?:require\(|\([^)]*\)\s*=>)|(?:function|def)\s+\w+\s*\([^)]*\)\s*[:{]|param\s*\([^)]*\)\s*\n)/i.test(
      text,
    )
  )
    return 'application/x-script';
  // A web page is a document, not a program.  Its scripts are noted where a PDF's active content is.
  if (/^(?:<!doctype\s+html|<html\b)/i.test(text)) return 'text/html';
  const detected = detectType(bytes);
  // SVG active content can follow comments or appear beyond the type-sniffing window.
  if (detected === 'image/svg+xml' && /<(?:[^\s/:<>]+:)?script\b|\bon\w+\s*=/i.test(bytes.toString('utf8')))
    return 'application/x-script';
  return detected;
}

const textTypes = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/x-csv',
]);
function textLike(type: string): boolean {
  return type.startsWith('text/') || textTypes.has(type);
}

/**
 * A label disagrees with a file only when it names a different kind of file.  One text label on
 * another kind of text is no disguise: browsers call Markdown `text/markdown`, and Windows calls a
 * CSV an Excel file.
 */
function agrees(label: string, stated: string | undefined, type: string, bytes: Buffer): boolean {
  if (label === type) return true;
  if (textLike(type)) return textLike(label) || stated === 'application/vnd.ms-excel';
  // Markup has no signature of its own, so a markup label stands on a file that opens with a tag.
  return (
    type === 'application/octet-stream' &&
    /^(?:text\/(?:html|xml)|application\/(?:xml|xhtml\+xml))$/.test(label) &&
    bytes
      .subarray(0, 256)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('<')
  );
}

function mismatch(input: FileSafetyInput, type: string): boolean {
  const extension = input.name?.split('.').at(-1)?.toLowerCase();
  const expected = extension && extensions[extension];
  const stated = input.statedType?.split(';')[0]?.trim().toLowerCase();
  return Boolean(
    (expected && !agrees(expected, undefined, type, input.bytes)) ||
    (stated &&
      stated !== 'application/octet-stream' &&
      !agrees(mediaAliases[stated] ?? stated, stated, type, input.bytes)),
  );
}

class HeldFile extends Error {
  constructor(readonly reason: FileCheckReason) {
    super(reason);
  }
}
function hold(reason: FileCheckReason): never {
  throw new HeldFile(reason);
}
interface Budget {
  members: number;
  expanded: number;
  notes: Set<FileCheckNote>;
}

function expansion(size: number, compressed: number, budget: Budget) {
  if (size > FILE_CHECK_LIMITS.expandedBytes - budget.expanded) hold('files.checks.archiveSize');
  if (size > Math.max(1, compressed) * FILE_CHECK_LIMITS.expansionRatio) hold('files.checks.archiveRatio');
}

function member(budget: Budget) {
  if (++budget.members > FILE_CHECK_LIMITS.members) hold('files.checks.archiveMembers');
}

const officeMacroTypes = new Set([
  'application/vnd.ms-office.vbaproject',
  'application/vnd.ms-word.vbadata+xml',
  'application/vnd.ms-excel.macrosheet+xml',
  'application/vnd.ms-excel.intlmacrosheet+xml',
  'application/vnd.ms-excel.macrosheet',
  'application/vnd.ms-excel.intlmacrosheet',
]);

function xmlAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (!entity.startsWith('#'))
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
          entity.toLowerCase()
        ] ?? match
      );
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '';
  });
}

/** Read bounded package declarations without resolving entities or trusting macro filenames. */
function officeMetadataHasMacros(bytes: Buffer): boolean {
  if (bytes.length > 1024 * 1024) hold('files.checks.archiveSize');
  const source =
    starts(bytes, 'fffe') || starts(bytes, '3c00')
      ? bytes.toString('utf16le')
      : starts(bytes, 'feff') || starts(bytes, '003c')
        ? Buffer.from(bytes).swap16().toString('utf16le')
        : bytes.toString('utf8');
  for (let at = 0; at < source.length;) {
    const start = source.indexOf('<', at);
    if (start < 0) break;
    const terminator = source.startsWith('<!--', start)
      ? '-->'
      : source.startsWith('<![CDATA[', start)
        ? ']]>'
        : source.startsWith('<?', start)
          ? '?>'
          : undefined;
    if (terminator) {
      const end = source.indexOf(terminator, start + 2);
      if (end < 0) hold('files.checks.unreadable');
      at = end + terminator.length;
      continue;
    }
    if (source.startsWith('<!', start)) hold('files.checks.unreadable');
    let end = start + 1;
    let quote: string | undefined;
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === source.length) hold('files.checks.unreadable');
    at = end + 1;
    const tag = source.slice(start + 1, end);
    const element = /^(?:[^\s/:<>]+:)?(Override|Default|Relationship)(?=[\s/>])/i.exec(tag);
    if (!element) continue;
    let cursor = element[0].length;
    while (cursor < tag.length) {
      while (/\s/.test(tag[cursor] ?? '') && cursor < tag.length) cursor++;
      if (cursor === tag.length || tag[cursor] === '/') break;
      const name = /^[^\s=/>]+/.exec(tag.slice(cursor))?.[0];
      if (!name) hold('files.checks.unreadable');
      cursor += name.length;
      while (/\s/.test(tag[cursor] ?? '') && cursor < tag.length) cursor++;
      if (tag[cursor++] !== '=') hold('files.checks.unreadable');
      while (/\s/.test(tag[cursor] ?? '') && cursor < tag.length) cursor++;
      const delimiter = tag[cursor++];
      if (delimiter !== '"' && delimiter !== "'") hold('files.checks.unreadable');
      const end = tag.indexOf(delimiter, cursor);
      if (end < 0) hold('files.checks.unreadable');
      const value = xmlAttribute(tag.slice(cursor, end)).toLowerCase();
      cursor = end + 1;
      if (
        (name.toLowerCase() === 'contenttype' && officeMacroTypes.has(value)) ||
        (element[1]!.toLowerCase() === 'relationship' &&
          name.toLowerCase() === 'type' &&
          /\/(?:vbaProject|vbaData|xlMacrosheet|xlIntlMacrosheet)$/i.test(value))
      )
        return true;
    }
  }
  return false;
}

async function inspect(
  input: FileSafetyInput,
  settings: FileSafetySettings,
  budget: Budget,
  depth: number,
): Promise<string> {
  const { bytes } = input;
  let type = contentType(bytes);
  if (type === 'application/x-executable' || type === 'application/x-script') hold('files.checks.executable');
  const macros = () => {
    if (input.origin === 'outside' && !settings.allowOutsideMacros) hold('files.checks.macros');
    budget.notes.add('files.checks.macrosAllowed');
  };
  if (type === 'application/x-ole-storage') {
    // Compound Office files expose encryption and VBA stream names in UTF-16 directory entries.
    const directory = bytes.toString('utf16le');
    if (/EncryptedPackage|EncryptionInfo|CryptSession10Container/i.test(directory))
      hold('files.checks.passwordProtected');
    if (/(?:VBA|_VBA_PROJECT|Macros)\0/i.test(directory)) macros();
    // Legacy Word encryption is recorded in its FIB, and legacy Excel uses a FILEPASS record.
    const word = /WordDocument\0/.test(directory);
    const excel = /(?:Workbook|Book)\0/.test(directory);
    for (let at = 512; (word || excel) && at + 14 <= bytes.length; at++) {
      if (
        word &&
        at % 64 === 0 &&
        bytes.readUInt16LE(at) === 0xa5ec &&
        [0x00bf, 0x00c1].includes(bytes.readUInt16LE(at + 12)) &&
        bytes.readUInt16LE(at + 10) & 0x100
      )
        hold('files.checks.passwordProtected');
      const length = bytes.readUInt16LE(at + 2);
      if (
        excel &&
        bytes.readUInt16LE(at) === 0x002f &&
        at + 4 + length <= bytes.length &&
        ((length === 6 && bytes.readUInt16LE(at + 4) === 0) ||
          (length >= 6 &&
            bytes.readUInt16LE(at + 4) === 1 &&
            [1, 2, 3, 4].includes(bytes.readUInt16LE(at + 6))))
      )
        hold('files.checks.passwordProtected');
    }
  }
  if (type === 'application/pdf') {
    const result = await checkPdf(bytes);
    if ('reason' in result) hold(result.reason);
    if (result.encrypted) hold('files.checks.passwordProtected');
    if (result.activeContent) budget.notes.add('files.checks.pdfActiveContent');
  }
  if (type === 'text/html' && /<script\b|\bon\w+\s*=|\bjavascript:/i.test(bytes.toString('utf8')))
    budget.notes.add('files.checks.htmlActiveContent');
  if (type === 'application/vnd.rar' || type === 'application/x-7z-compressed') {
    // Without a bounded decoder, these containers cannot receive a safe verdict.
    hold('files.checks.archiveUnsupported');
  }
  if (
    type === 'application/gzip' ||
    type === 'application/x-tar' ||
    type === 'application/zip' ||
    type.startsWith('application/vnd.openxmlformats-officedocument.')
  ) {
    if (depth >= FILE_CHECK_LIMITS.nestingDepth) hold('files.checks.archiveDepth');
    if (type === 'application/gzip') {
      member(budget);
      let expanded: Buffer;
      const remaining = FILE_CHECK_LIMITS.expandedBytes - budget.expanded;
      const limit = Math.min(remaining, bytes.length * FILE_CHECK_LIMITS.expansionRatio);
      try {
        expanded = gunzipSync(bytes, { maxOutputLength: Math.max(1, limit + 1) });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
          hold(remaining <= limit ? 'files.checks.archiveSize' : 'files.checks.archiveRatio');
        hold('files.checks.unreadable');
      }
      expansion(expanded!.length, bytes.length, budget);
      budget.expanded += expanded!.length;
      await inspect({ bytes: expanded!, origin: input.origin }, settings, budget, depth + 1);
    } else if (type === 'application/x-tar') {
      for (let at = 0; at + 512 <= bytes.length;) {
        const header = bytes.subarray(at, at + 512);
        if (header.every((byte) => byte === 0)) break;
        member(budget);
        const size = tarOctal(header, 124, 12);
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          !validTarHeader(header) ||
          at + 512 + size > bytes.length
        )
          hold('files.checks.unreadable');
        expansion(size, size, budget);
        budget.expanded += size;
        await inspect(
          { bytes: bytes.subarray(at + 512, at + 512 + size), origin: input.origin },
          settings,
          budget,
          depth + 1,
        );
        at += 512 + Math.ceil(size / 512) * 512;
      }
    } else {
      try {
        const entries = zipEntries(bytes, FILE_CHECK_LIMITS.members - budget.members);
        const names = [...entries.keys()];
        // The central directory remains authoritative even when an Office marker follows the sniff window.
        if (names.some((name) => name.startsWith('word/'))) type = extensions.docx!;
        else if (names.some((name) => name.startsWith('xl/'))) type = extensions.xlsx!;
        else if (names.some((name) => name.startsWith('ppt/'))) type = extensions.pptx!;
        if (names.some((name) => /(?:^|\/)(?:vbaProject\.bin|macros\/|vba\/)|^xl\/macrosheets\//i.test(name)))
          macros();
        let sizesMatch = true;
        for (const entry of entries.values()) {
          member(budget);
          expansion(entry.size, entry.compressedSize, budget);
          const remaining = FILE_CHECK_LIMITS.expandedBytes - budget.expanded;
          const ratioLimit = Math.max(1, entry.compressedSize) * FILE_CHECK_LIMITS.expansionRatio;
          let expanded: Buffer;
          try {
            expanded = entryBytes(bytes, entry, Math.max(1, Math.min(remaining, ratioLimit) + 1));
          } catch (error) {
            if (error instanceof ZipTooLarge)
              hold(remaining <= ratioLimit ? 'files.checks.archiveSize' : 'files.checks.archiveRatio');
            throw error;
          }
          expansion(expanded.length, entry.compressedSize, budget);
          // Keep actual output bounded and inspect later members before reporting inconsistent metadata.
          if (expanded.length !== entry.size) sizesMatch = false;
          budget.expanded += expanded.length;
          if (
            (entry.name === '[Content_Types].xml' || /\.rels$/i.test(entry.name)) &&
            officeMetadataHasMacros(expanded)
          )
            macros();
          // Macro bytes are never executed, and are checked for encryption and nested containers too.
          await inspect(
            { bytes: expanded, name: entry.name, origin: input.origin },
            settings,
            budget,
            depth + 1,
          );
        }
        if (!sizesMatch) hold('files.checks.unreadable');
      } catch (error) {
        if (error instanceof HeldFile) throw error;
        if (error instanceof ZipEncrypted) hold('files.checks.passwordProtected');
        if (error instanceof ZipTooLarge) hold('files.checks.archiveMembers');
        hold('files.checks.unreadable');
      }
    }
  }
  if (mismatch(input, type)) hold('files.checks.typeMismatch');
  return type;
}

/** Built-in checks always run, including when an organization has no scanner. */
export async function builtInFileChecks(
  input: FileSafetyInput,
  settings = FileSafetySettings.parse({}),
): Promise<FileSafetyResult> {
  const budget: Budget = { members: 0, expanded: 0, notes: new Set() };
  try {
    const type = await inspect(input, settings, budget, 0);
    return budget.notes.size ? { state: 'noted', type, notes: [...budget.notes] } : { state: 'safe', type };
  } catch (error) {
    return {
      state: 'held',
      type: contentType(input.bytes),
      reason: error instanceof HeldFile ? error.reason : 'files.checks.unreadable',
    };
  }
}

export async function checkFileSafety(
  c: FileSafetyContext,
  input: FileSafetyInput,
): Promise<FileSafetyResult> {
  const settings = await scannerSettings(c.db, c.schema, c.orgId, c.config);
  let scannerHold: { reason: FileCheckReason; signature?: string } | undefined;
  if (settings.enabled) {
    try {
      if (!settings.address) throw new Error('Scanner address missing');
      requireApprovedScanner(settings.address, c.config);
      // The scanner receives the original bytes before any archive or document parser opens them.
      const scanned = await clamAvScanner(settings.address).scan(Readable.from([input.bytes]));
      if (scanned.state === 'infected')
        scannerHold = { reason: 'files.checks.infected', signature: scanned.signature };
    } catch (error) {
      scannerHold = {
        reason:
          error instanceof ScanTooLarge
            ? 'files.scanner.tooLarge'
            : error instanceof AppError && error.messageKey === 'files.scanner.addressNotApproved'
              ? 'files.scanner.addressNotApproved'
              : 'files.checks.scannerUnavailable',
      };
    }
  }
  if (scannerHold) return { state: 'held', type: contentType(input.bytes), ...scannerHold };
  const result = await builtInFileChecks(input, await fileSafetySettings(c.db, c.schema, c.orgId));
  return result;
}

/** Translate a held result consistently while allowing a caller's existing invalid-file copy. */
export function requireSafeFile(
  result: FileSafetyResult,
  messages: {
    invalid?: string;
    infected?: string;
    unavailable?: string;
    addressNotApproved?: 'unavailable';
    tooLarge?: { key: string; params?: Record<string, string | number | boolean> };
  } = {},
): void {
  if (result.state !== 'held') return;
  if (result.reason === 'files.scanner.addressNotApproved' && !messages.addressNotApproved)
    throw new AppError('forbidden', result.reason);
  if (
    result.reason === 'files.checks.scannerUnavailable' ||
    result.reason === 'files.scanner.addressNotApproved'
  )
    throw new AppError('unavailable', messages.unavailable ?? result.reason);
  const tooLarge = [
    'files.checks.archiveRatio',
    'files.checks.archiveMembers',
    'files.checks.archiveDepth',
    'files.checks.archiveSize',
    'files.scanner.tooLarge',
  ].includes(result.reason);
  if (tooLarge && messages.tooLarge)
    throw new AppError('payload_too_large', messages.tooLarge.key, { params: messages.tooLarge.params });
  throw new AppError(
    tooLarge ? 'payload_too_large' : 'validation_failed',
    (result.reason === 'files.checks.infected'
      ? messages.infected
      : ['files.checks.typeMismatch', 'files.checks.unreadable', 'files.checks.inspectionLimit'].includes(
            result.reason,
          )
        ? messages.invalid
        : undefined) ?? result.reason,
  );
}

/** A future outside-file entry point can check this gate before accepting any contents. */
export async function outsideFilesAllowed(c: FileSafetyContext): Promise<boolean> {
  const safety = await fileSafetySettings(c.db, c.schema, c.orgId);
  if (safety.outsideFiles === 'builtInChecksOnly') return true;
  const scanner = await scannerSettings(c.db, c.schema, c.orgId, c.config);
  if (!scanner.enabled || !scanner.address) return false;
  try {
    requireApprovedScanner(scanner.address, c.config);
  } catch {
    return false;
  }
  const result = await query<{
    status: { address?: string; reachable?: boolean; tested?: boolean; lastError?: string | null } | null;
    health: { address?: string; reachable?: boolean } | null;
  }>(
    c.db,
    sql`SELECT COALESCE(settings->'fileScannerSelfTest', settings->'fileScannerStatus') AS status,
      settings->'fileScannerStatus' AS health FROM ${ident(c.schema, 'orgs')} WHERE id = ${c.orgId}`,
  );
  const status = result.rows[0]?.status;
  return (
    status?.address === scanner.address &&
    status.reachable === true &&
    status.tested === true &&
    !status.lastError &&
    !(result.rows[0]?.health?.address === scanner.address && result.rows[0].health.reachable === false)
  );
}

import { inflateRawSync, inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';

/** Opens workbooks with the same installed Office parser used by the server's import tests. */
export async function workbookRows(bytes: Buffer): Promise<unknown[][][]> {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  const { Workbook } = require('exceljs') as {
    Workbook: new () => {
      xlsx: { load(bytes: Buffer): Promise<unknown> };
      worksheets: Array<{ eachRow(read: (row: { values: unknown[] }) => void): void }>;
    };
  };
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1)));
    return rows;
  });
}

/** Quoted commas, doubled quotes, and newlines belong to the cell that contains them. */
export function csvRows(bytes: Buffer): string[][] {
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\r' || character === '\n')) {
      row.push(cell);
      cell = '';
      if (character !== ',') {
        rows.push(row);
        row = [];
        if (character === '\r' && source[index + 1] === '\n') index++;
      }
    } else cell += character;
  }
  expect(quoted, 'CSV quotes are balanced').toBe(false);
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/**
 * Reading back the files the app hands out: the zip archive a Word document or a deck is, the
 * iCalendar text of an invitation or a calendar feed, and the pages of a PDF.  Each is read with
 * Node alone, so a test checks what a file holds rather than that one merely arrived.
 */

/** The files in a zip archive, by name. */
export function unzip(bytes: Buffer): Map<string, Buffer> {
  // The directory at the end lists every file, with its size and where its data starts.
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  expect(end, 'the file is a zip archive').toBeGreaterThanOrEqual(0);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(offset), 'a directory entry').toBe(0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** One part of an archive as text. */
export function part(files: Map<string, Buffer>, name: string): string {
  const file = files.get(name);
  expect(file, `the archive has ${name}`).toBeDefined();
  return file!.toString('utf8');
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Every run of text in a part, in order: `w:t` in Word, `a:t` in PowerPoint. */
export function texts(source: string, tag: 'w:t' | 'a:t'): string[] {
  return [...source.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((match) =>
    unescapeXml(match[1]!),
  );
}

/** A Word document's paragraphs, each as its runs' text joined. */
export function paragraphs(document: string): string[] {
  return [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => texts(match[0], 'w:t').join(''));
}

/** A Word document's table rows, each as its cells' text. */
export function tableRows(document: string): string[][] {
  return [...document.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((row) =>
    [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) => texts(cell[0], 'w:t').join('')),
  );
}

/** A deck's slides in order, title slide first, each as its XML. */
export function slides(files: Map<string, Buffer>): string[] {
  return [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((name) => part(files, name));
}

/** A property of an iCalendar event: its parameters, as written, and its value, unescaped. */
export interface CalendarProperty {
  params: string;
  value: string;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char.toLowerCase() === 'n' ? '\n' : char));
}

/**
 * The events in an iCalendar document, each as its properties by name.  Folded lines are joined
 * first, and a value is everything after the first colon outside a quoted parameter.
 */
export function calendarEvents(text: string): Array<Map<string, CalendarProperty>> {
  expect(text.startsWith('BEGIN:VCALENDAR\r\n'), 'an iCalendar document with CRLF line ends').toBe(true);
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  const events: Array<Map<string, CalendarProperty>> = [];
  let current: Map<string, CalendarProperty> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = new Map();
    else if (line === 'END:VEVENT' && current) {
      events.push(current);
      current = null;
    } else if (current) {
      let quoted = false;
      let colon = -1;
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] === '"') quoted = !quoted;
        else if (line[index] === ':' && !quoted) {
          colon = index;
          break;
        }
      }
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const semicolon = head.indexOf(';');
      const name = (semicolon < 0 ? head : head.slice(0, semicolon)).toUpperCase();
      current.set(name, {
        params: semicolon < 0 ? '' : head.slice(semicolon + 1),
        value: unescapeText(line.slice(colon + 1)),
      });
    }
  }
  return events;
}

/** An instant as an iCalendar DATE-TIME in UTC, such as `20260929T140000Z`. */
export function icalInstant(instant: number | string | Date): string {
  return new Date(instant)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** One page of a PDF: its size, the text drawn on it in order, and how many pictures it holds. */
export interface PdfPage {
  width: number;
  height: number;
  text: string[];
  images: number;
}

// What the bytes from 0x80 to 0x9f mean in the standard fonts' encoding.  The rest match Latin-1.
const WIN_ANSI: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

function winAnsi(bytes: number[]): string {
  return bytes.map((byte) => WIN_ANSI[byte] ?? String.fromCharCode(byte)).join('');
}

/** A literal string's bytes, with its backslash escapes undone. */
function literalBytes(body: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== '\\') {
      bytes.push(character.charCodeAt(0));
      continue;
    }
    const next = body[(index += 1)] ?? '';
    const octal = /^[0-7]{1,3}/.exec(body.slice(index))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += octal.length - 1;
    } else if (next in { n: 1, r: 1, t: 1, b: 1, f: 1 })
      bytes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[next as 'n']);
    else if (next !== '\n' && next !== '\r') bytes.push(next.charCodeAt(0));
  }
  return bytes;
}

/** The text a content stream shows, one entry per text-showing operator. */
function shownText(content: string): string[] {
  const string = String.raw`\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>`;
  const decode = (token: string) =>
    token.startsWith('(')
      ? winAnsi(literalBytes(token.slice(1, -1)))
      : winAnsi(
          (token.slice(1, -1).replace(/\s+/g, '').match(/../g) ?? []).map((pair) => parseInt(pair, 16)),
        );
  const shown: string[] = [];
  for (const match of content.matchAll(
    new RegExp(`(${string})\\s*(?:Tj|'|")|\\[((?:${string}|[^\\]])*)\\]\\s*TJ`, 'g'),
  ))
    shown.push(
      match[1] !== undefined
        ? decode(match[1])
        : [...match[2]!.matchAll(new RegExp(string, 'g'))].map((piece) => decode(piece[0])).join(''),
    );
  return shown;
}

/**
 * A PDF's pages in order, read through its cross-reference table or stream as a PDF reader does:
 * the page tree from the catalog down, each page's content streams inflated, and its pictures
 * counted.  Objects packed into object streams are unpacked on the way.
 */
export function readPdf(bytes: Buffer): PdfPage[] {
  const text = bytes.toString('latin1');
  expect(text.startsWith('%PDF-'), 'the file is a PDF').toBe(true);
  interface PdfObject {
    dict: string;
    stream: Buffer | null;
  }
  const refs = (value: string) => [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
  const entry = (dict: string, key: string) =>
    new RegExp(String.raw`/${key}\s*(\[[^\]]*\]|<<[\s\S]*?>>|\d+\s+\d+\s+R|[\d.\s-]+)`).exec(dict)?.[1] ?? '';
  const numbers = (value: string) =>
    value.replace(/[[\]]/g, '').trim().split(/\s+/).filter(Boolean).map(Number);
  const decoded = ({ dict, stream }: PdfObject) => {
    expect(dict, 'no predictor to undo').not.toMatch(/\/Predictor/);
    return /\/FlateDecode/.test(dict) ? inflateSync(stream!) : stream!;
  };
  // Where each object is: at an offset in the file, or at an index in an object stream.
  const offsets = new Map<number, number>();
  const packed = new Map<number, { stream: number; index: number }>();
  const objects = new Map<number, PdfObject>();
  const parseAt = (at: number): PdfObject => {
    const header = /^\d+\s+\d+\s+obj/.exec(text.slice(at, at + 32));
    expect(header, `an object starts at ${at}`).toBeTruthy();
    const from = at + header![0].length;
    const streamAt = text.slice(from).search(/\bstream\r?\n/);
    const endAt = text.indexOf('endobj', from);
    if (streamAt < 0 || from + streamAt > endAt) return { dict: text.slice(from, endAt), stream: null };
    const dict = text.slice(from, from + streamAt);
    const length = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict)!;
    const size = length[2] ? Number(object(Number(length[1])).dict.trim()) : Number(length[1]);
    const dataAt = from + streamAt + /^stream\r?\n/.exec(text.slice(from + streamAt))![0].length;
    return { dict, stream: bytes.subarray(dataAt, dataAt + size) };
  };
  const object = (number: number): PdfObject => {
    const known = objects.get(number);
    if (known) return known;
    const at = offsets.get(number);
    const inside = packed.get(number);
    expect(at !== undefined || inside !== undefined, `the PDF has object ${number}`).toBe(true);
    let found: PdfObject;
    if (at !== undefined) found = parseAt(at);
    else {
      const container = object(inside!.stream);
      const data = decoded(container).toString('latin1');
      const first = Number(entry(container.dict, 'First'));
      const pairs = numbers(data.slice(0, first));
      const begin = first + pairs[inside!.index * 2 + 1]!;
      const end = inside!.index * 2 + 3 < pairs.length ? first + pairs[inside!.index * 2 + 3]! : data.length;
      found = { dict: data.slice(begin, end), stream: null };
    }
    objects.set(number, found);
    return found;
  };
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1]);
  let trailer: string;
  if (text.startsWith('xref', start)) {
    const at = text.indexOf('trailer', start);
    trailer = text.slice(at);
    const tokens = text
      .slice(start + 4, at)
      .trim()
      .split(/\s+/);
    for (let index = 0; index < tokens.length;) {
      const first = Number(tokens[index]);
      const count = Number(tokens[index + 1]);
      index += 2;
      for (let item = 0; item < count; item += 1, index += 3)
        if (tokens[index + 2] === 'n') offsets.set(first + item, Number(tokens[index]));
    }
  } else {
    // A cross-reference stream: rows of fixed-width numbers, a row for each object it covers.
    const xref = parseAt(start);
    expect(xref.dict, 'the PDF ends with a cross-reference stream').toMatch(/\/Type\s*\/XRef\b/);
    trailer = xref.dict;
    const widths = numbers(entry(xref.dict, 'W'));
    const sections = numbers(entry(xref.dict, 'Index')) as number[];
    if (!sections.length) sections.push(0, Number(entry(xref.dict, 'Size')));
    const data = decoded(xref);
    let at = 0;
    const read = (width: number) => {
      let value = 0;
      for (let index = 0; index < width; index += 1) value = value * 256 + data[at++]!;
      return value;
    };
    for (let section = 0; section < sections.length; section += 2)
      for (let item = 0; item < sections[section + 1]!; item += 1) {
        const number = sections[section]! + item;
        const kind = widths[0] ? read(widths[0]) : 1;
        const second = read(widths[1]!);
        const third = read(widths[2]!);
        if (kind === 1) offsets.set(number, second);
        else if (kind === 2) packed.set(number, { stream: second, index: third });
      }
  }
  const root = object(refs(entry(trailer, 'Root'))[0]!);
  const pages: PdfPage[] = [];
  const walk = (number: number) => {
    const node = object(number);
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      for (const kid of refs(entry(node.dict, 'Kids'))) walk(kid);
      return;
    }
    const box = numbers(entry(node.dict, 'MediaBox'));
    const shown: string[] = [];
    for (const content of refs(entry(node.dict, 'Contents')))
      shown.push(...shownText(decoded(object(content)).toString('latin1')));
    const resourcesEntry = entry(node.dict, 'Resources');
    const resources = /^\d+\s+\d+\s+R$/.test(resourcesEntry)
      ? object(refs(resourcesEntry)[0]!).dict
      : node.dict.slice(node.dict.indexOf('/Resources'));
    const xobjects = /\/XObject\s*<<([^>]*)>>/.exec(resources)?.[1] ?? '';
    const images = refs(xobjects).filter((ref) => /\/Subtype\s*\/Image\b/.test(object(ref).dict)).length;
    pages.push({ width: box[2]! - box[0]!, height: box[3]! - box[1]!, text: shown, images });
  };
  walk(refs(entry(root.dict, 'Pages'))[0]!);
  return pages;
}

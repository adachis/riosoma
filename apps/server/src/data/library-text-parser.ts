import { inflateRawSync, inflateSync } from 'node:zlib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectStreamParser,
  PDFRawStream,
  PDFString,
  PDFXRefStreamParser,
  StandardFonts,
} from 'pdf-lib';

const MAX_TEXT = 500000;
const MAX_STREAM = 4 * 1024 * 1024;
const MAX_DECODED = 16 * 1024 * 1024;
const invalid = (): never => {
  throw new Error('libraries.unreadable');
};

const limit = (): never => {
  throw new Error('libraries.limit');
};

function entities(text: string) {
  return text.replace(/&(#x[\da-f]{1,8}|#\d{1,10}|amp|lt|gt|quot|apos|nbsp);/gi, (match, value: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? match;
    const code = value[1]?.toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '';
  });
}

/** Each tag or comment consumes its whole input span, including malformed openers. */
function* markup(source: string): Generator<{ tag?: string; text?: string }> {
  for (let at = 0; at < source.length;) {
    const start = source.indexOf('<', at);
    if (start < 0) {
      yield { text: source.slice(at) };
      return;
    }
    if (start > at) yield { text: source.slice(at, start) };
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      if (end < 0) return;
      at = end + 3;
    } else {
      const end = source.indexOf('>', start + 1);
      if (end < 0) return;
      yield { tag: source.slice(start + 1, end).trim() };
      at = end + 1;
    }
  }
}
function html(source: string, headings = true) {
  const parts: string[] = [];
  let hidden: string | undefined;
  for (const token of markup(source)) {
    if (token.text !== undefined) {
      if (!hidden) parts.push(entities(token.text));
      continue;
    }
    const tag = token.tag!.toLowerCase();
    const name = /^[^\s/]+/.exec(tag.startsWith('/') ? tag.slice(1) : tag)?.[0] ?? '';
    const closing = tag.startsWith('/');
    if (hidden) {
      if (closing && name === hidden) hidden = undefined;
      continue;
    }
    if (!closing && ['script', 'style', 'noscript', 'template'].includes(name)) {
      hidden = name;
      continue;
    }
    if (/^h[1-6]$/.test(name)) parts.push(closing || !headings ? '\n' : `\n${'#'.repeat(Number(name[1]))} `);
    else if (['p', 'div', 'br', 'li', 'tr', 'section', 'article'].includes(name)) parts.push('\n');
  }
  return parts.join('');
}
function wordXml(source: string) {
  const parts: string[] = [];
  let paragraph: string[] = [],
    heading = '',
    inText = false;
  for (const token of markup(source)) {
    if (token.text !== undefined) {
      if (inText) paragraph.push(entities(token.text));
      continue;
    }
    const tag = token.tag!;
    const name = /^[^\s/]+/.exec(tag.startsWith('/') ? tag.slice(1) : tag)?.[0];
    if (name === 'w:p') {
      if (tag.startsWith('/')) parts.push(`${heading}${paragraph.join('')}\n`);
      paragraph = [];
      heading = '';
      inText = false;
    } else if (name === 'w:t') inText = !tag.startsWith('/') && !tag.endsWith('/');
    else if (name === 'w:pStyle') {
      const level = /\bw:val=["']Heading([1-6])["']/i.exec(tag)?.[1];
      if (level) heading = '#'.repeat(Number(level)) + ' ';
    } else if (name === 'w:tab') paragraph.push('\t');
    else if (name === 'w:br') paragraph.push('\n');
  }
  return parts.join('');
}

/** Only the main document is inflated, with a hard output cap and no filesystem extraction. */
function word(bytes: Buffer): string {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557) return invalid();
  const entries = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (entries > 10000) return limit();
  for (let i = 0; i < entries; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return invalid();
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    if (name === 'word/document.xml') {
      if (bytes.readUInt16LE(at + 8) & 1) return invalid();
      const method = bytes.readUInt16LE(at + 10);
      const size = bytes.readUInt32LE(at + 20);
      const expanded = bytes.readUInt32LE(at + 24);
      const local = bytes.readUInt32LE(at + 42);
      if (expanded > MAX_STREAM) return limit();
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) return invalid();
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + size > bytes.length) return invalid();
      if (method === 0 && size > MAX_STREAM) return limit();
      const compressed = bytes.subarray(start, start + size);
      const xml =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_STREAM })
            : invalid();
      return wordXml(xml.toString('utf8'));
    }
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return invalid();
}

class Budget {
  limited = false;
  limit = (): never => {
    this.limited = true;
    return limit();
  };
  decoded = 0;
  operations = 0;
  text = 0;
  scanned = 0;
  step(count = 1) {
    if ((this.operations += count) > 250000) this.limit();
  }
  output(value: string) {
    if ((this.text += value.length) > MAX_TEXT) this.limit();
    return value;
  }
  readonly streams = new WeakMap<PDFRawStream, Buffer>();
  decode(stream: PDFRawStream): Buffer {
    const cached = this.streams.get(stream);
    if (cached) return cached;
    this.step();
    const filters = stream.dict.lookup(PDFName.of('Filter'));
    const list = filters instanceof PDFArray ? filters.asArray() : filters ? [filters] : [];
    if (list.length > 4) return this.limit();
    let bytes = Buffer.from(stream.contents);
    for (const filter of list) {
      this.step();
      if (filter === PDFName.of('FlateDecode')) {
        try {
          bytes = inflateSync(bytes, { maxOutputLength: MAX_STREAM });
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
            return this.limit();
          throw error;
        }
      } else {
        // A single filter is decoded at a time, so its allocation guard also covers filter chains.
        const dict = stream.dict.clone();
        dict.set(PDFName.of('Filter'), stream.dict.context.lookup(filter, PDFName));
        const decoder = decodePDFRawStream(PDFRawStream.of(dict, bytes)) as ReturnType<
          typeof decodePDFRawStream
        > & {
          ensureBuffer?: (size: number) => Uint8Array;
        };
        const allocate = decoder.ensureBuffer;
        if (!allocate) return invalid();
        const exhausted = this.limit;
        decoder.ensureBuffer = function (size) {
          if (!Number.isSafeInteger(size) || size > MAX_STREAM) return exhausted();
          return allocate.call(this, size);
        };
        bytes = Buffer.from(decoder.decode());
      }
      this.decoded += bytes.length;
      if (this.decoded > MAX_DECODED) return this.limit();
    }
    if (!list.length) this.decoded += bytes.length;
    if (bytes.length > MAX_STREAM || this.decoded > MAX_DECODED) return this.limit();
    this.streams.set(stream, bytes);
    return bytes;
  }
}
const delimiter = (char: string) => /[\s\0()[\]<>/%]/.test(char);
/** Strings, names, and operators advance one cursor, so failed terminators never rescan input. */
function* tokens(source: string, budget: Budget): Generator<string> {
  if ((budget.scanned += source.length) > 32 * 1024 * 1024) return budget.limit();
  for (let at = 0; at < source.length;) {
    const start = at,
      char = source[at++]!;
    if (/\s|\0/.test(char)) continue;
    budget.step();
    if (char === '%') {
      while (at < source.length && !/[\r\n]/.test(source[at]!)) at++;
      continue;
    }
    if (char === '(') {
      let depth = 1;
      while (at < source.length && depth) {
        const next = source[at++]!;
        if (next === '\\') at++;
        else if (next === '(') {
          if (++depth > 64) return invalid();
        } else if (next === ')') depth--;
      }
      if (depth) return invalid();
    } else if (char === '<' && source[at] !== '<') {
      const end = source.indexOf('>', at);
      if (end < 0) return invalid();
      at = end + 1;
    } else if (char === '<' || char === '>') {
      if (source[at] === char) at++;
    } else if (char !== '[' && char !== ']' && char !== ')') {
      while (at < source.length && !delimiter(source[at]!)) at++;
    }
    yield source.slice(start, at);
  }
}
function hex(value: string | undefined): string {
  if (!value || !/^<[\da-f\s]+>$/i.test(value)) return invalid();
  return value.slice(1, -1).replace(/\s/g, '').toUpperCase();
}
function unicode(value: string) {
  if (value.length > 64 || value.length % 4) return invalid();
  return Buffer.from(value, 'hex').swap16().toString('utf16le');
}
type CharacterMap = { values: Map<string, string>; sizes: number[] };
function characterMap(stream: PDFRawStream, budget: Budget): CharacterMap {
  const input = [...tokens(budget.decode(stream).toString('latin1'), budget)];
  const values = new Map<string, string>();
  const set = (key: string, value: string) => {
    budget.step();
    if (key.length > 8 || values.size >= 65536) invalid();
    // Range expansion writes hexadecimal letters in lowercase, and PDF strings normalize uppercase.
    values.set(key.toUpperCase(), unicode(value));
  };
  for (let at = 0; at < input.length; at++) {
    const mode = input[at];
    if (mode !== 'beginbfchar' && mode !== 'beginbfrange') continue;
    const end = mode === 'beginbfchar' ? 'endbfchar' : 'endbfrange';
    while (++at < input.length && input[at] !== end) {
      const firstHex = hex(input[at]);
      if (mode === 'beginbfchar') {
        set(firstHex, hex(input[++at]));
        continue;
      }
      const lastHex = hex(input[++at]);
      if (firstHex.length > 8 || lastHex.length > 8) return invalid();
      const first = parseInt(firstHex, 16),
        last = parseInt(lastHex, 16);
      if (last < first || last - first > 10000) return invalid();
      const array = input[++at] === '[';
      const base = array ? '' : hex(input[at]);
      if (!array && base.length > 8) return invalid();
      for (let code = first; code <= last; code++) {
        const value = array
          ? hex(input[++at])
          : (parseInt(base, 16) + code - first).toString(16).padStart(base.length, '0');
        set(code.toString(16).padStart(firstHex.length, '0'), value);
      }
      if (array && input[++at] !== ']') return invalid();
    }
    if (input[at] !== end) return invalid();
  }
  return { values, sizes: [...new Set([...values.keys()].map((key) => key.length))].sort((a, b) => b - a) };
}
interface PdfGlyph {
  code: number;
  text: string;
}

function mappedText(value: string, budget: Budget, map?: CharacterMap): PdfGlyph[] {
  const token = value.startsWith('<') ? PDFHexString.of(hex(value)) : PDFString.of(value.slice(1, -1));
  if (!map?.values.size) {
    const text = budget.output(token.decodeText());
    return Array.from(token.asBytes(), (code, index) => ({ code, text: text[index] ?? '' }));
  }
  const encoded = Buffer.from(token.asBytes()).toString('hex').toUpperCase();
  const glyphs: PdfGlyph[] = [];
  for (let at = 0; at < encoded.length;) {
    budget.step();
    const size = map.sizes.find((size) => map.values.has(encoded.slice(at, at + size)));
    if (!size) return invalid();
    const code = encoded.slice(at, at + size);
    glyphs.push({ code: parseInt(code, 16), text: budget.output(map.values.get(code)!) });
    at += size;
  }
  return glyphs;
}

/** Font advances distinguish a word gap from repositioning the next glyph in the same word. */
function fontWidths(font: PDFDict, document: PDFDocument, budget: Budget) {
  const widths = new Map<number, number>();
  const number = (dict: PDFDict, key: string) => dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
  const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  const cid = descendants?.lookupMaybe(0, PDFDict);
  if (cid) {
    const entries = cid.lookupMaybe(PDFName.of('W'), PDFArray);
    for (let index = 0; entries && index < entries.size();) {
      budget.step();
      const first = entries.lookup(index++, PDFNumber).asNumber();
      const next = entries.lookup(index++);
      if (!Number.isSafeInteger(first) || first < 0 || first > 65535) return invalid();
      if (next instanceof PDFArray) {
        budget.step(next.size());
        if (first + next.size() > 65536) return invalid();
        for (let offset = 0; offset < next.size(); offset++)
          widths.set(first + offset, next.lookup(offset, PDFNumber).asNumber());
      } else if (next instanceof PDFNumber) {
        const last = next.asNumber();
        if (!Number.isSafeInteger(last) || last < first || last > 65535) return invalid();
        budget.step(last - first + 1);
        const width = entries.lookup(index++, PDFNumber).asNumber();
        for (let code = first; code <= last; code++) widths.set(code, width);
      } else return invalid();
    }
  } else {
    const entries = font.lookupMaybe(PDFName.of('Widths'), PDFArray);
    const first = number(font, 'FirstChar') ?? 0;
    if (entries) {
      budget.step(entries.size());
      if (!Number.isSafeInteger(first) || first < 0 || first + entries.size() > 256) return invalid();
      for (let index = 0; index < entries.size(); index++)
        widths.set(first + index, entries.lookup(index, PDFNumber).asNumber());
    }
  }
  const base = font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText();
  const standard = Object.values(StandardFonts).find((name) => name === base);
  const metrics = standard ? document.embedStandardFont(standard) : undefined;
  const descriptor = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const fallback = cid ? (number(cid, 'DW') ?? 1000) : descriptor && number(descriptor, 'MissingWidth');
  return (glyph: PdfGlyph): number => {
    const width = widths.get(glyph.code);
    if (width !== undefined) return width;
    if (metrics && glyph.text) {
      try {
        return metrics.widthOfTextAtSize(glyph.text, 1000);
      } catch {
        // A missing standard-font character still needs a bounded advance for gap detection.
      }
    }
    return fallback ?? 500;
  };
}

export interface PdfInspection {
  encrypted: boolean;
  activeContent: boolean;
}

/** Bounded decoding also covers the parser's implicit object and cross-reference streams. */
async function pdf(bytes: Buffer): Promise<string>;
async function pdf(bytes: Buffer, pagesOnly: true): Promise<number>;
async function pdf(bytes: Buffer, pagesOnly: false, separatePages: true): Promise<string[]>;
async function pdf(bytes: Buffer, mode: 'safety'): Promise<PdfInspection>;
async function pdf(
  bytes: Buffer,
  mode: boolean | 'safety' = false,
  separatePages = false,
): Promise<string | number | string[] | PdfInspection> {
  const budget = new Budget();
  const objectParser = PDFObjectStreamParser.forStream;
  const xrefParser = PDFXRefStreamParser.forStream;
  const bounded = (stream: PDFRawStream) => {
    const dict = stream.dict.clone();
    dict.delete(PDFName.of('Filter'));
    dict.delete(PDFName.of('DecodeParms'));
    return PDFRawStream.of(dict, budget.decode(stream));
  };
  PDFObjectStreamParser.forStream = (stream, tick) => {
    const count = stream.dict.lookup(PDFName.of('N'), PDFNumber).asNumber();
    if (!Number.isSafeInteger(count) || count < 0) return invalid();
    budget.step(count);
    return objectParser(bounded(stream), tick);
  };
  PDFXRefStreamParser.forStream = (stream) => {
    const count = stream.dict.lookup(PDFName.of('Size'), PDFNumber).asNumber();
    if (!Number.isSafeInteger(count) || count < 0) return invalid();
    budget.step(count);
    const ranges = stream.dict.lookup(PDFName.of('Index'));
    if (ranges instanceof PDFArray) {
      if (ranges.size() > 10000) return invalid();
      for (let index = 1; index < ranges.size(); index += 2) {
        const count = ranges.lookup(index, PDFNumber).asNumber();
        if (!Number.isSafeInteger(count) || count < 0) return invalid();
        budget.step(count);
      }
    }
    return xrefParser(bounded(stream));
  };
  try {
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
      ignoreEncryption: mode === 'safety',
    });
    if (mode === 'safety') {
      if (document.isEncrypted) return { encrypted: true, activeContent: false };
      let activeContent = false;
      const seen = new Set<unknown>();
      const pending: unknown[] = document.context.enumerateIndirectObjects().map(([, value]) => value);
      while (pending.length) {
        budget.step();
        const value = pending.pop();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        if (
          value instanceof PDFName &&
          [
            'JavaScript',
            'JS',
            'Launch',
            'OpenAction',
            'AA',
            'RichMedia',
            'SubmitForm',
            'ImportData',
            'URI',
            'GoToR',
            'EmbeddedFile',
            'XFA',
            'Rendition',
            'Sound',
            'Movie',
          ].includes(value.decodeText())
        )
          activeContent = true;
        if (value instanceof PDFRawStream) pending.push(value.dict);
        else if (value instanceof PDFDict) {
          for (const [key, child] of value.entries()) {
            budget.step();
            pending.push(key, child);
          }
        } else if (value instanceof PDFArray) {
          budget.step(value.size());
          pending.push(...value.asArray());
        }
      }
      return { encrypted: false, activeContent };
    }
    if (mode) return document.getPageCount();
    if (document.getPageCount() > 500) return budget.limit();
    const mappingCache = new WeakMap<PDFRawStream, CharacterMap>();
    const widthCache = new WeakMap<PDFDict, ReturnType<typeof fontWidths>>();
    const pages: string[] = [];
    const activeForms = new Set<PDFRawStream>();
    for (const page of document.getPages()) {
      budget.step();
      const contents = page.node.lookup(PDFName.of('Contents'));
      const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
      const lines: string[] = [];
      const render = (
        refs: (PDFObject | undefined)[],
        resources: PDFDict | undefined,
        depth: number,
      ): void => {
        if (depth > 16) return budget.limit();
        const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
        const maps = new Map<string, CharacterMap>();
        const advances = new Map<string, ReturnType<typeof fontWidths>>();
        for (const [name, ref] of fonts?.entries() ?? []) {
          budget.step();
          const font = document.context.lookup(ref);
          if (!(font instanceof PDFDict)) continue;
          let widths = widthCache.get(font);
          if (!widths) {
            widths = fontWidths(font, document, budget);
            widthCache.set(font, widths);
          }
          advances.set(name.decodeText(), widths);
          const mapping = font.lookup(PDFName.of('ToUnicode'));
          if (mapping instanceof PDFRawStream) {
            let map = mappingCache.get(mapping);
            if (!map) {
              map = characterMap(mapping, budget);
              mappingCache.set(mapping, map);
            }
            maps.set(name.decodeText(), map);
          }
        }
        const run: string[] = [];
        type Position = { x: number; y: number };
        let end: Position | undefined;
        let start: Position | undefined;
        const flush = () => {
          end = undefined;
          start = undefined;
          if (!run.length) return;
          lines.push(run.join('') + budget.output('\n'));
          run.length = 0;
        };
        let font = '',
          size = 0,
          leading = 0,
          characterSpace = 0,
          wordSpace = 0,
          horizontalScale = 1,
          inText = false;
        let matrix = [1, 0, 0, 1, 0, 0];
        let position: Position = { x: 0, y: 0 };
        const advance = (distance: number) => {
          if (!Number.isFinite(distance)) return invalid();
          position = {
            x: position.x + matrix[0]! * distance,
            y: position.y + matrix[1]! * distance,
          };
        };
        const moveLine = (x: number, y: number) => {
          matrix[4] = matrix[4]! + matrix[0]! * x + matrix[2]! * y;
          matrix[5] = matrix[5]! + matrix[1]! * x + matrix[3]! * y;
          position = { x: matrix[4]!, y: matrix[5]! };
        };
        const show = (value: string) => {
          const glyphs = mappedText(value, budget, maps.get(font));
          const text = glyphs.map((glyph) => glyph.text).join('');
          // Glyph decoding and output length already bound the work done for advances.
          const distance = glyphs.reduce((total, glyph) => {
            const width = advances.get(font)?.(glyph) ?? 500;
            return (
              total +
              ((width * size) / 1000 + characterSpace + (glyph.code === 32 ? wordSpace : 0)) * horizontalScale
            );
          }, 0);
          if (text) {
            if (end) {
              const scale = Math.hypot(matrix[0]!, matrix[1]!) || 1;
              const dx = position.x - end.x,
                dy = position.y - end.y;
              const gap = (dx * matrix[0]! + dy * matrix[1]!) / scale ** 2;
              const backwardGap = start
                ? ((start.x - position.x) * matrix[0]! + (start.y - position.y) * matrix[1]!) / scale ** 2 -
                  distance
                : 0;
              const cross = (dy * matrix[0]! - dx * matrix[1]!) / scale ** 2;
              if (Math.abs(cross) > Math.max(1, Math.abs(size) * 0.25)) flush();
              else if (
                Math.max(gap, backwardGap) > Math.abs(size * horizontalScale) * 0.2 &&
                !/\s$/.test(run.at(-1) ?? '') &&
                !/^\s/.test(text)
              )
                run.push(budget.output(' '));
            }
            if (!run.length && !separatePages)
              run.push(budget.output(size >= 18 ? '# ' : size >= 16 ? '## ' : ''));
            run.push(text);
            start = { ...position };
          }
          advance(distance);
          if (text) end = { ...position };
        };
        for (const ref of refs) {
          budget.step();
          const stream = document.context.lookup(ref);
          if (!(stream instanceof PDFRawStream)) continue;
          const operands: string[] = [];
          for (const token of tokens(budget.decode(stream).toString('latin1'), budget)) {
            if (token === 'Do') {
              const name = operands.at(-1);
              const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
              const form = name?.startsWith('/') ? objects?.lookup(PDFName.of(name.slice(1))) : undefined;
              if (
                form instanceof PDFRawStream &&
                form.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form')
              ) {
                // Invoked forms have their own resources and text state, but share the page's decoding budget.
                if (activeForms.has(form)) return budget.limit();
                flush();
                activeForms.add(form);
                render(
                  [form],
                  form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources,
                  depth + 1,
                );
                activeForms.delete(form);
              }
              operands.length = 0;
              continue;
            }
            if (token === 'BT' || token === 'ET') {
              flush();
              inText = token === 'BT';
              if (inText) {
                matrix = [1, 0, 0, 1, 0, 0];
                position = { x: 0, y: 0 };
              }
              operands.length = 0;
              continue;
            }
            if (!inText) {
              if (token.startsWith('/')) operands.push(token);
              else operands.length = 0;
              continue;
            }
            if (token === 'Tf') {
              size = Number(operands.at(-1));
              font = operands.at(-2)?.slice(1) ?? '';
            } else if (token === 'TL') {
              leading = Number(operands.at(-1));
            } else if (token === 'Tc') {
              characterSpace = Number(operands.at(-1));
            } else if (token === 'Tw') {
              wordSpace = Number(operands.at(-1));
            } else if (token === 'Tz') {
              horizontalScale = Number(operands.at(-1)) / 100;
            } else if (['Tj', 'TJ', "'", '"'].includes(token)) {
              if (token === "'" || token === '"') {
                flush();
                moveLine(0, -leading);
                if (token === '"') {
                  wordSpace = Number(operands[0]);
                  characterSpace = Number(operands[1]);
                }
              }
              for (const part of operands) {
                if (part.startsWith('(') || (part.startsWith('<') && !part.startsWith('<<'))) show(part);
                else if (token === 'TJ' && part !== '[' && part !== ']')
                  advance((-Number(part) * size * horizontalScale) / 1000);
              }
            } else if (token === 'Tm') {
              if (operands.length !== 6 || !operands.every((part) => Number.isFinite(Number(part))))
                return invalid();
              matrix = operands.map(Number);
              position = { x: matrix[4]!, y: matrix[5]! };
            } else if (token === 'Td' || token === 'TD') {
              const x = Number(operands.at(-2)),
                y = Number(operands.at(-1));
              if (token === 'TD') leading = -y;
              if (y !== 0) flush();
              moveLine(x, y);
            } else if (token === 'T*') {
              flush();
              moveLine(0, -leading);
            } else if (
              token.startsWith('/') ||
              token.startsWith('(') ||
              token.startsWith('<') ||
              token === '[' ||
              token === ']' ||
              /^[+\-.\d]/.test(token)
            ) {
              operands.push(token);
              continue;
            }
            operands.length = 0;
          }
        }
        flush();
      };
      render(refs, page.node.Resources(), 0);
      pages.push(lines.join('') + budget.output('\n'));
    }
    return separatePages ? pages : pages.join('');
  } catch (error) {
    if (budget.limited) return limit();
    throw error;
  } finally {
    PDFObjectStreamParser.forStream = objectParser;
    PDFXRefStreamParser.forStream = xrefParser;
  }
}

/** Called only by an isolated worker with a deadline and heap limit. */
export async function parseLibraryText(name: string, bytes: Buffer, maxText: number) {
  if (bytes.length > 10 * 1024 * 1024) return limit();
  let text: string;
  if (/\.pdf$/i.test(name) && bytes.subarray(0, 5).toString() === '%PDF-') text = await pdf(bytes);
  else if (/\.docx$/i.test(name)) text = word(bytes);
  else if (/\.(md|markdown|txt|html|htm)$/i.test(name)) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/\.html?$/i.test(name)) text = html(text);
  } else return invalid();
  if (text.length > Math.min(MAX_TEXT, maxText)) return limit();
  if (!text.trim() || text.includes('\0')) return invalid();
  return text.trim();
}

/** Called only inside a bounded worker, including the object-stream decoding budget. */
export async function countPdfPages(bytes: Buffer): Promise<number> {
  if (bytes.length > 10 * 1024 * 1024) return limit();
  return pdf(bytes, true);
}

/** Page boundaries are retained for extraction, using the same bounded stream decoder. */
export async function extractPdfPages(bytes: Buffer): Promise<string[]> {
  if (bytes.length > 10 * 1024 * 1024) return limit();
  return pdf(bytes, false, true);
}

/** Converts markup to inert text without fetching resources or running scripts. */
export function extractHtmlText(source: string): string {
  return html(source, false);
}

/** Safety inspection shares the decoder limits and runs only inside an isolated worker. */
export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  if (bytes.length > 10 * 1024 * 1024) return limit();
  return pdf(bytes, 'safety');
}

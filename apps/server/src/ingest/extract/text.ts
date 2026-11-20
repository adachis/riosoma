import { cell, EMPTY_CELL, type Cell } from '@riosoma/ingest';
import { ExtractionFailure, LIMITS } from './types.js';

function printable(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159) || code === 65533)
      return false;
  }
  return true;
}

/** BOMs and alternating zero bytes distinguish UTF-16 before a single-byte fallback is considered. */
export function decodeText(bytes: Buffer): string | undefined {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.length >= 8 && bytes.length % 2 === 0) {
    const sample = bytes.subarray(0, 4096);
    let even = 0,
      odd = 0;
    for (let at = 0; at < sample.length; at++) {
      if (sample[at] === 0) {
        if (at % 2) odd++;
        else even++;
      }
    }
    if (odd > sample.length * 0.3 && even < sample.length * 0.1) encoding = 'utf-16le';
    else if (even > sample.length * 0.3 && odd < sample.length * 0.1) encoding = 'utf-16be';
  }
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return printable(decoded) ? decoded : undefined;
  } catch {
    if (encoding !== 'utf-8') return undefined;
    // Legacy single-byte text still needs a mostly ASCII sample, so arbitrary binary is not claimed.
    let ascii = 0;
    for (const byte of bytes) if ((byte >= 32 && byte < 127) || [9, 10, 13].includes(byte)) ascii++;
    if (ascii < bytes.length * 0.5) return undefined;
    const decoded = new TextDecoder('windows-1252', { fatal: true }).decode(bytes);
    return printable(decoded) ? decoded : undefined;
  }
}

interface Field {
  text: string;
  quoted: boolean;
}

/** A linear scanner keeps embedded newlines, escaped quotes, and empty fields at their coordinates. */
function delimited(text: string, delimiter: string): Field[][] {
  const rows: Field[][] = [];
  let row: Field[] = [],
    value = '',
    quoted = false,
    inQuote = false,
    closed = false;
  const push = () => {
    row.push({ text: value, quoted });
    value = '';
    quoted = false;
    closed = false;
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (inQuote) {
      if (char === '"' && text[at + 1] === '"') {
        value += '"';
        at++;
      } else if (char === '"') {
        inQuote = false;
        closed = true;
      } else value += char;
    } else if (char === '"' && value === '') {
      if (closed) throw new ExtractionFailure('invalid');
      quoted = true;
      inQuote = true;
    } else if (char === delimiter) push();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      push();
      rows.push(row);
      row = [];
    } else {
      if (closed && !/\s/.test(char)) throw new ExtractionFailure('invalid');
      if (!closed) value += char;
    }
    if (row.length > LIMITS.cells || rows.length > LIMITS.cells) throw new ExtractionFailure('size-limit');
  }
  if (inQuote) throw new ExtractionFailure('invalid');
  if (value || quoted || row.length || !rows.length) {
    push();
    rows.push(row);
  }
  return rows;
}

export function textGrid(text: string): Cell[][] {
  let chosen: Field[][] | undefined;
  let score = 0;
  for (const delimiter of ['\t', ',', ';', '|']) {
    if (!text.includes(delimiter)) continue;
    let rows: Field[][];
    try {
      rows = delimited(text, delimiter);
    } catch (error) {
      if (error instanceof ExtractionFailure && error.code === 'size-limit') throw error;
      continue;
    }
    const counts = rows.filter((row) => row.some((field) => field.text.trim())).map((row) => row.length);
    // Repeated widths can begin after a preamble.  Favor more matching rows so incidental footer
    // separators cannot replace the delimiter used by the main grid.
    const frequencies = new Map<number, number>();
    let frequency = 0;
    for (let start = counts.length - 1; start >= 0; start--) {
      const width = counts[start]!;
      if (width > 1) {
        const matches = (frequencies.get(width) ?? 0) + 1;
        frequencies.set(width, matches);
        frequency = Math.max(frequency, matches);
      }
      const confidence = frequency / (counts.length - start);
      const candidate = frequency * confidence;
      if (confidence >= 0.6 && (start === 0 || frequency >= 2) && candidate > score) {
        chosen = rows;
        score = candidate;
      }
    }
  }
  if (!chosen) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const nonblank = lines.filter((line) => line.trim());
    // Shared whitespace gaps define fixed-width boundaries without treating single spaces as separators.
    const first = nonblank.reduce(
      (best, line) =>
        [...line.matchAll(/ {2,}(?=\S)/g)].length > [...best.matchAll(/ {2,}(?=\S)/g)].length ? line : best,
      '',
    );
    const cuts = [...first.matchAll(/ {2,}(?=\S)/g)]
      .map((match) => match.index + match[0].length)
      .filter((cut) => nonblank.every((line) => line.length <= cut || / {2}$/.test(line.slice(0, cut))));
    chosen = lines.map((line) => {
      const ends = [...cuts, Math.max(line.length, cuts.at(-1) ?? 0)];
      let start = 0;
      return ends.map((end) => {
        const value = { text: cuts.length ? line.slice(start, end).trim() : line, quoted: true };
        start = end;
        return value;
      });
    });
  }
  const width = chosen.reduce((max, row) => Math.max(max, row.length), 0);
  if (chosen.length * width > LIMITS.cells) throw new ExtractionFailure('size-limit');
  // Text formats carry no stored numeric type, so conversion waits for a later cleaner.
  return chosen.map((row) =>
    Array.from({ length: width }, (_, column) => (row[column] ? cell(row[column]!.text) : EMPTY_CELL)),
  );
}

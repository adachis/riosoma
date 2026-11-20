import { LIMITS } from '@riosoma/contracts';

export class CsvError extends Error {}

/** State survives chunk boundaries, including the middle of an escaped quote or CRLF. */
export class CsvParser {
  private cell = '';
  private row: string[] = [];
  private quoted = false;
  private closed = false;
  private cr = false;
  private started = false;
  constructor(private readonly delimiter: string) {}
  *push(text: string, final = false): Generator<string[]> {
    for (const char of text) {
      if (!this.started) {
        this.started = true;
        if (char === '\uFEFF') continue;
      }
      if (this.cr) {
        this.cr = false;
        if (char === '\n') continue;
      }
      if (this.quoted) {
        if (char === '"') {
          this.quoted = false;
          this.closed = true;
        } else this.cell += char;
      } else if (this.closed && char === '"') {
        this.cell += '"';
        this.quoted = true;
        this.closed = false;
      } else if (char === this.delimiter || char === '\r' || char === '\n') {
        this.row.push(this.cell);
        this.cell = '';
        this.closed = false;
        if (this.row.length > LIMITS.fieldsPerTable) throw new CsvError();
        if (char !== this.delimiter) {
          yield this.row;
          this.row = [];
          this.cr = char === '\r';
        }
      } else if (char === '"' && this.cell === '' && !this.closed) {
        this.quoted = true;
      } else {
        if (this.closed || char === '"' || char === '\0') throw new CsvError();
        this.cell += char;
      }
      if (this.cell.length > LIMITS.longTextLength) throw new CsvError();
    }
    if (final) {
      if (this.quoted) throw new CsvError();
      if (this.cell || this.row.length || this.closed) {
        this.row.push(this.cell);
        if (this.row.length > LIMITS.fieldsPerTable) throw new CsvError();
        yield this.row;
      }
      this.cell = '';
      this.row = [];
      this.closed = false;
    }
  }
}

export function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const counts = candidates.map(() => [0]);
  let quoted = false;
  let line = 0;
  for (let i = 0; i < text.length && line < 20; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++;
      for (const count of counts) count.push(0);
    } else if (!quoted) {
      const index = candidates.indexOf(char ?? '');
      if (index >= 0) counts[index]![line]!++;
    }
  }
  const scores = counts.map((values) => {
    const complete = line ? values.slice(0, line) : values;
    const positive = complete.filter((n) => n > 0);
    const frequencies = new Map<number, number>();
    const firstWidth = complete[0] ?? 0;
    for (const count of positive) {
      // Missing trailing fields still fit the first row's width, while extra punctuation does not.
      const width = count <= firstWidth ? firstWidth : count;
      frequencies.set(width, (frequencies.get(width) ?? 0) + 1);
    }
    return [
      positive.length,
      Math.max(0, ...frequencies.values()),
      positive.length ? Math.min(...positive) : 0,
    ];
  });
  // Coverage and compatible widths matter before the amount of punctuation in a value.
  let best = 0;
  for (let index = 1; index < scores.length; index++) {
    for (let part = 0; part < scores[index]!.length; part++) {
      const difference = scores[index]![part]! - scores[best]![part]!;
      if (difference > 0) best = index;
      if (difference !== 0) break;
    }
  }
  return candidates[best]!;
}

/** Unmarked files may use a Windows encoding; decide before yielding any rows. */
async function unmarkedEncoding(
  file: Blob,
  chunkSize: number,
  progress: (fraction: number) => void,
): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
    try {
      decoder.decode(bytes, { stream: true });
    } catch {
      return 'windows-1252';
    }
    progress(Math.min(0.5, (offset + chunkSize) / file.size / 2));
  }
  try {
    decoder.decode();
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** Reads bounded byte slices; the decoder retains split UTF-8 and UTF-16 code units. */
export async function* csvRows(
  file: Blob,
  progress: (fraction: number) => void = () => undefined,
  chunkSize = 64 * 1024,
): AsyncGenerator<string[]> {
  const signature = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  const marked =
    (signature[0] === 255 && signature[1] === 254) ||
    (signature[0] === 254 && signature[1] === 255) ||
    (signature[0] === 239 && signature[1] === 187 && signature[2] === 191);
  const encoding =
    signature[0] === 255 && signature[1] === 254
      ? 'utf-16le'
      : signature[0] === 254 && signature[1] === 255
        ? 'utf-16be'
        : marked
          ? 'utf-8'
          : await unmarkedEncoding(file, chunkSize, progress);
  const start = marked ? 0 : 0.5;
  if (!marked) progress(start);
  const decoder = new TextDecoder(encoding, { fatal: true });
  let parser: CsvParser | undefined;
  let sample = '';
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
    const text = decoder.decode(bytes, { stream: true });
    if (!parser) {
      sample += text;
      if (sample.length < 65536 && offset + chunkSize < file.size) continue;
      parser = new CsvParser(detectDelimiter(sample));
      yield* parser.push(sample);
      sample = '';
    } else yield* parser.push(text);
    progress(start + (1 - start) * Math.min(1, (offset + chunkSize) / file.size));
  }
  parser ??= new CsvParser(detectDelimiter(sample));
  yield* parser.push(sample + decoder.decode(), true);
  progress(1);
}

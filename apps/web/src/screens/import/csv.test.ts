import { describe, expect, it } from 'vitest';
import { CsvParser, csvRows, detectDelimiter } from './csv';

async function read(file: Blob, chunkSize = 7) {
  const rows: string[][] = [];
  for await (const row of csvRows(file, undefined, chunkSize)) rows.push(row);
  return rows;
}
describe('CSV parsing', () => {
  it('retains quoting state across every character boundary', () => {
    const parser = new CsvParser(',');
    const source = '\uFEFFName,Note,End\r\n"A, B","a ""quote""\r\nand line",\r\nlast,,""';
    const rows = [...source].flatMap((char) => [...parser.push(char)]);
    rows.push(...parser.push('', true));
    expect(rows).toEqual([
      ['Name', 'Note', 'End'],
      ['A, B', 'a "quote"\r\nand line', ''],
      ['last', '', ''],
    ]);
  });
  it.each([',', ';', '\t', '|'])('detects %j outside quoted fields', async (delimiter) => {
    const source = `Name${delimiter}Note\r\nA${delimiter}"comma,semi;tab\tbar|"\r\nB${delimiter}C`;
    expect(detectDelimiter(source)).toBe(delimiter);
    expect(await read(new Blob([source]))).toEqual([
      ['Name', 'Note'],
      ['A', 'comma,semi;tab\tbar|'],
      ['B', 'C'],
    ]);
  });
  it.each(['utf8', 'le', 'be'])('reads %s byte order marks and split code units', async (encoding) => {
    const text = '\uFEFFA,B\n雪,😀';
    const bytes = encoding === 'utf8' ? new TextEncoder().encode(text) : new Uint8Array(text.length * 2);
    if (encoding !== 'utf8') {
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), encoding === 'le');
    }
    expect(await read(new Blob([bytes]), 1)).toEqual([
      ['A', 'B'],
      ['雪', '😀'],
    ]);
  });
  it('preserves ragged rows, blank records, and trailing empty fields', async () => {
    expect(await read(new Blob(['A,B\n1\n2,3,4\n\n5,']))).toEqual([
      ['A', 'B'],
      ['1'],
      ['2', '3', '4'],
      [''],
      ['5', ''],
    ]);
  });
  it('does not invent a final blank record', async () => {
    expect(await read(new Blob(['A\r\n']))).toEqual([['A']]);
    expect(await read(new Blob([]))).toEqual([]);
  });
  it.each(['"unclosed', 'a"b', '"a"trailing'])('rejects malformed quoting %s', async (source) => {
    await expect(read(new Blob([source]))).rejects.toThrow();
  });
  it.each([
    [0xef, 0xbb, 0xbf, 0xff, 0xff],
    [0xff, 0xfe, 0x61],
    [0xfe, 0xff, 0x61],
  ])('rejects malformed text with an explicit byte order mark %j', async (...bytes) => {
    await expect(read(new Blob([new Uint8Array(bytes)]))).rejects.toThrow();
  });
  it('keeps unmarked Windows-1252 text valid and rejects binary nulls', async () => {
    expect(await read(new Blob([new Uint8Array([0xff, 0xff])]))).toEqual([['ÿÿ']]);
    await expect(read(new Blob([new Uint8Array([0x61, 0, 0xff])]))).rejects.toThrow();
  });
  it('detects a separator by row consistency before the punctuation in one long value', async () => {
    const note = Array.from({ length: 250 }, (_, index) => `item ${index}`).join(',');
    const source = `Name|Note\nSynthetic|${note}\n`;
    expect(detectDelimiter(source)).toBe('|');
    expect(await read(new Blob([source]))).toEqual([
      ['Name', 'Note'],
      ['Synthetic', note],
    ]);
  });
  it.each(['', '\n'])(
    'detects ragged pipe rows with consistent commas in values and ending %j',
    async (ending) => {
      const source =
        'Name|Note, label|Amount|Optional\nAlpha|One, two|1|extra\nBeta|Three, four|2\nGamma|Five, six|3' +
        ending;
      expect(detectDelimiter(source)).toBe('|');
      expect(await read(new Blob([source]))).toEqual([
        ['Name', 'Note, label', 'Amount', 'Optional'],
        ['Alpha', 'One, two', '1', 'extra'],
        ['Beta', 'Three, four', '2'],
        ['Gamma', 'Five, six', '3'],
      ]);
    },
  );
  it('prefers column widths over long punctuation in both headers and values', async () => {
    const label = 'Note, with, several, comma, separated, labels';
    const note = Array.from({ length: 250 }, (_, index) => `item ${index}`).join(',');
    const source = `Name|${label}|Amount\nSynthetic|${note}|1\n`;
    expect(detectDelimiter(source)).toBe('|');
    expect(await read(new Blob([source]))).toEqual([
      ['Name', label, 'Amount'],
      ['Synthetic', note, '1'],
    ]);
  });
  it('reads Windows-1252 characters even when the first non-ASCII byte is beyond the sample', async () => {
    const prefix = `Name,Note\nSynthetic,${'x'.repeat(70_000)}`;
    const file = new Blob([
      prefix,
      new Uint8Array([0xe9, 0x20, 0x80, 0x20, 0x93]),
      'quoted',
      new Uint8Array([0x94]),
    ]);
    expect(await read(file, 4096)).toEqual([
      ['Name', 'Note'],
      ['Synthetic', `${'x'.repeat(70_000)}é € “quoted”`],
    ]);
  });
  it('streams 100,000 rows in bounded chunks and reports byte progress', async () => {
    const file = new Blob(['A,B\n', ...Array.from({ length: 100_000 }, (_, i) => `${i},value\n`)]);
    let count = 0;
    let last = 0;
    let reports = 0;
    for await (const row of csvRows(
      file,
      (fraction) => {
        expect(fraction).toBeGreaterThanOrEqual(last);
        last = fraction;
        reports++;
      },
      4096,
    )) {
      expect(row).toHaveLength(2);
      count++;
    }
    expect(count).toBe(100_001);
    expect(last).toBe(1);
    expect(reports).toBeGreaterThan(100);
  });
});

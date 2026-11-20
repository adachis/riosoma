import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, readCsv } from './csv.js';

/**
 * Reading and writing CSV.  The file comes in chunks whose boundaries fall wherever the disk puts
 * them, so every case here is read one character at a time as well as whole, and a quoted field
 * split across chunks has to come out the same as one that wasn't.
 */

async function* chunks(text: string, size: number): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

async function rows(text: string, size = 1, delimiter?: string): Promise<string[][]> {
  const found: string[][] = [];
  for await (const row of readCsv(chunks(text, size), delimiter ? { delimiter } : {})) found.push(row);
  return found;
}

describe('reading CSV', () => {
  it('reads rows, whether or not the file ends with a line break', async () => {
    expect(await rows('Name,Amount\nAda,10\nGrace,20\n')).toEqual([
      ['Name', 'Amount'],
      ['Ada', '10'],
      ['Grace', '20'],
    ]);
    expect(await rows('Name,Amount\nAda,10')).toEqual([
      ['Name', 'Amount'],
      ['Ada', '10'],
    ]);
  });

  it('reads a line ending a spreadsheet writes, and a mark a file may start with', async () => {
    expect(await rows('\uFEFFName,Amount\r\nAda,10\r\n')).toEqual([
      ['Name', 'Amount'],
      ['Ada', '10'],
    ]);
  });

  it('keeps a delimiter, a line break, and a quote inside a quoted field', async () => {
    expect(await rows('Name,Notes\nAda,"one, two"\nGrace,"a\nb"\n"Say ""hi""",3\n')).toEqual([
      ['Name', 'Notes'],
      ['Ada', 'one, two'],
      ['Grace', 'a\nb'],
      ['Say "hi"', '3'],
    ]);
  });

  it('reads an empty field, and a row of nothing at all', async () => {
    expect(await rows('a,b\n1,\n,\n2,3\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['', ''],
      ['2', '3'],
    ]);
    // A line with nothing on it isn't a row, and an import skips a row of empty cells itself.
    expect(await rows('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    // A quoted empty field is a value, not a blank line.
    expect(await rows('a\n""\n')).toEqual([['a'], ['']]);
  });

  it('reads a delimiter of its own, which is how a tab-separated file works', async () => {
    expect(await rows('Name\tAmount\nAda\t10\n', 1, '\t')).toEqual([
      ['Name', 'Amount'],
      ['Ada', '10'],
    ]);
  });

  it('reads the same rows whatever size the chunks arrive in', async () => {
    const text = 'Name,Notes\nAda,"one, two"\nGrace,"a\nb"\n"Say ""hi""",3\n';
    const whole = await rows(text, text.length);
    for (const size of [1, 2, 3, 7, 13]) expect(await rows(text, size)).toEqual(whole);
  });
});

describe('writing CSV', () => {
  it('quotes only what has to be quoted, and doubles a quote inside', () => {
    expect(csvRow(['Ada', '10'])).toBe('Ada,10');
    expect(csvRow(['one, two', 'plain'])).toBe('"one, two",plain');
    expect(csvRow(['say "hi"', 'x'])).toBe('"say ""hi""",x');
    expect(csvRow(['a\nb', 'x'])).toBe('"a\nb",x');
    // A field that starts or ends with a space would lose it unquoted.
    expect(csvRow([' padded ', 'x'])).toBe('" padded ",x');
    expect(csvRow(['a', 'b'], '\t')).toBe('a\tb');
  });

  it('writes a value as text, and a value with parts as JSON', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(['one', 'two'])).toBe('["one","two"]');
    expect(csvCell({ id: 'att1' })).toBe('{"id":"att1"}');
  });

  it('survives a round trip through the reader', async () => {
    const values = ['Ada', 'one, two', 'say "hi"', 'a\nb', '', ' padded ', '12.5'];
    expect(await rows(`${csvRow(values)}\n`, 3)).toEqual([values]);
  });
});

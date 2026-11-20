import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPREADSHEET_LIMITS } from '@riosoma/contracts';
import { ApiError } from '../../api';
import { numberedRows, SourceError } from './source';
import { isSpreadsheet, uploadSpreadsheet } from './spreadsheet';

afterEach(() => vi.unstubAllGlobals());

function answer(body: string | Response) {
  const fetch = vi.fn(async () => (typeof body === 'string' ? new Response(body) : body));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const lines = (...values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join('');
async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe('uploading a spreadsheet', () => {
  it('gathers each sheet’s rows in tab order', async () => {
    const fetch = answer(
      lines(
        { sheet: 'Second', position: 1 },
        [1, 'Total'],
        [4, 12.5],
        { rows: 2, total: 2 },
        { sheet: 'First', position: 0 },
        [1, 'Name', 'Born'],
        [2, 'Ada', { date: '1990-01-02' }],
        [3, 'Bea', null, { error: '#N/A' }],
        { rows: 3, total: 9 },
        { done: true },
      ),
    );
    const file = new File(['PK'], 'book.xlsx');
    const workbook = await uploadSpreadsheet(file);
    expect(fetch).toHaveBeenCalledWith(
      '/api/imports/spreadsheet',
      expect.objectContaining({ method: 'POST', body: file }),
    );
    expect(workbook.sheets.map(({ name, sent, total }) => ({ name, sent, total }))).toEqual([
      { name: 'First', sent: 3, total: 9 },
      { name: 'Second', sent: 2, total: 2 },
    ]);
    expect(await all(numberedRows(workbook.sheets[0]!))).toEqual([
      { number: 1, cells: ['Name', 'Born'] },
      { number: 2, cells: ['Ada', { date: '1990-01-02' }] },
      { number: 3, cells: ['Bea', null, { error: '#N/A' }] },
    ]);
    expect(await all(numberedRows(workbook.sheets[1]!))).toEqual([
      { number: 1, cells: ['Total'] },
      { number: 4, cells: [12.5] },
    ]);
  });

  it('turns a refusal, or a failure part way, into the server’s message', async () => {
    answer(
      new Response(
        JSON.stringify({
          error: { code: 'payload_too_large', messageKey: 'import.spreadsheet.tooLarge', userFault: true },
        }),
        { status: 413 },
      ),
    );
    await expect(uploadSpreadsheet(new File(['PK'], 'book.xlsx'))).rejects.toMatchObject({
      status: 413,
      info: { messageKey: 'import.spreadsheet.tooLarge' },
    });
    answer(
      lines({ sheet: 'First', position: 0 }, [1, 'Name'], {
        error: { code: 'validation_failed', messageKey: 'import.spreadsheet.timeout', userFault: true },
      }),
    );
    await expect(uploadSpreadsheet(new File(['PK'], 'book.xlsx'))).rejects.toMatchObject({
      info: { messageKey: 'import.spreadsheet.timeout' },
    });
  });

  it('refuses an answer that stops short or doesn’t make sense', async () => {
    answer(lines({ sheet: 'First', position: 0 }, [1, 'Name'], { rows: 1, total: 1 }));
    await expect(uploadSpreadsheet(new File(['PK'], 'book.xlsx'))).rejects.toMatchObject({
      info: { messageKey: 'import.spreadsheet.unreadable' },
    });
    answer(lines([1, 'Name'], { done: true }));
    await expect(uploadSpreadsheet(new File(['PK'], 'book.xlsx'))).rejects.toBeInstanceOf(ApiError);
    answer('{"sheet":\n');
    await expect(uploadSpreadsheet(new File(['PK'], 'book.xlsx'))).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a workbook past the limit before sending it', async () => {
    const fetch = answer(lines({ done: true }));
    const large = { size: SPREADSHEET_LIMITS.uploadBytes + 1 } as Blob;
    await expect(uploadSpreadsheet(large)).rejects.toMatchObject({
      status: 413,
      info: { messageKey: 'import.spreadsheet.tooLarge', params: { megabytes: 50 } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('knows a workbook by its name or its first bytes', async () => {
    expect(await isSpreadsheet(new File(['Name,Total'], 'Totals.XLSX'))).toBe(true);
    expect(await isSpreadsheet(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])], 'renamed'))).toBe(
      true,
    );
    expect(await isSpreadsheet(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1])], 'old'))).toBe(true);
    expect(await isSpreadsheet(new File(['Name,Total\nAda,12'], 'people.csv'))).toBe(false);
  });
});

describe('reading a sheet’s rows', () => {
  it('refuses a row line that isn’t one', async () => {
    const source = { kind: 'sheet' as const, rows: new Blob([lines([1, 'Ada'], [2, { when: 'now' }])]) };
    await expect(all(numberedRows(source))).rejects.toBeInstanceOf(SourceError);
    const broken = { kind: 'sheet' as const, rows: new Blob(['[1, "Ada"\n']) };
    await expect(all(numberedRows(broken))).rejects.toBeInstanceOf(SourceError);
  });

  it('numbers a CSV file’s rows in order', async () => {
    const source = { kind: 'csv' as const, file: new Blob(['Name\nAda\nBea']) };
    expect((await all(numberedRows(source))).map((row) => [row.number, row.cells])).toEqual([
      [1, ['Name']],
      [2, ['Ada']],
      [3, ['Bea']],
    ]);
  });
});

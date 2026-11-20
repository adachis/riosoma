import { PassThrough } from 'node:stream';
import { crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { AppError, SPREADSHEET_LIMITS, type SheetCell } from '@riosoma/contracts';
import { readSpreadsheet, type SpreadsheetOptions } from './spreadsheet.js';
import { zipEntries } from './zip.js';

interface Sheet {
  name: string;
  position: number;
  rows: Array<{ number: number; cells: SheetCell[] }>;
  sent: number;
  total: number;
}

async function workbook(build: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  build(book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function read(bytes: Buffer, options?: SpreadsheetOptions): Promise<Sheet[]> {
  const sheets: Sheet[] = [];
  for await (const event of readSpreadsheet(bytes, options)) {
    if (event.kind === 'sheet')
      sheets.push({ name: event.name, position: event.position, rows: [], sent: 0, total: 0 });
    else if (event.kind === 'row') sheets.at(-1)!.rows.push({ number: event.number, cells: event.cells });
    else Object.assign(sheets.at(-1)!, { sent: event.rows, total: event.total });
  }
  return sheets;
}

async function refusal(bytes: Buffer, options?: SpreadsheetOptions): Promise<string> {
  try {
    await read(bytes, options);
  } catch (error) {
    if (error instanceof AppError) return error.messageKey;
    throw error;
  }
  throw new Error('the file was read');
}

const RELATIONS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A zip of plain stored files, for archives written by hand. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('reading a spreadsheet', () => {
  it('reads a workbook produced by the streaming ZIP writer', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: true });
    const sheet = book.addWorksheet('Streaming');
    sheet.addRow(['Name', 'Amount']).commit();
    sheet.addRow(['Archive compatibility', 42]).commit();
    sheet.commit();
    await book.commit();

    const sheets = await read(Buffer.concat(chunks));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe('Streaming');
    expect(sheets[0]!.rows.map((row) => row.cells)).toEqual([
      ['Name', 'Amount'],
      ['Archive compatibility', 42],
    ]);
  });

  it('reads text, numbers, booleans, dates, times, rich text, links, and errors as their own types', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('People');
      sheet.addRow(['Name', 'Count', 'Ready', 'Born', 'Seen', 'Clock', 'Note', 'Site', 'Lookup']);
      sheet.addRow([
        'José 雪',
        0.1 + 0.2,
        true,
        new Date(Date.UTC(1990, 0, 2)),
        new Date(Date.UTC(2024, 4, 3, 10, 30, 15)),
        new Date(Date.UTC(1899, 11, 30, 9, 45)),
        { richText: [{ text: 'Bold ', font: { bold: true } }, { text: 'move' }] },
        { text: 'Riosoma', hyperlink: 'https://example.test' },
        { error: '#N/A' },
      ]);
      sheet.addRow(['Bea', -12, false, new Date(Date.UTC(2024, 1, 29)), new Date(Date.UTC(2024, 1, 29))]);
      sheet.getCell('E2').numFmt = 'yyyy-mm-dd hh:mm:ss';
      // A midnight that the format shows with a time is still a moment, not a day.
      sheet.getCell('E3').numFmt = 'm/d/yy h:mm';
      sheet.getCell('F2').numFmt = 'h:mm';
    });
    const [sheet] = await read(bytes);
    expect(sheet!.rows).toEqual([
      {
        number: 1,
        cells: ['Name', 'Count', 'Ready', 'Born', 'Seen', 'Clock', 'Note', 'Site', 'Lookup'],
      },
      {
        number: 2,
        cells: [
          'José 雪',
          0.3,
          true,
          { date: '1990-01-02' },
          { date: '2024-05-03T10:30:15' },
          '9:45',
          'Bold move',
          'Riosoma',
          { error: '#N/A' },
        ],
      },
      {
        number: 3,
        cells: ['Bea', -12, false, { date: '2024-02-29' }, { date: '2024-02-29T00:00:00' }],
      },
    ]);
  });

  it('answers each formula’s cached result, zeros and shared formulas included', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Sums');
      sheet.getCell('A1').value = { formula: '2*3', result: 6 };
      sheet.getCell('B1').value = { formula: 'A1*0', result: 0 };
      sheet.getCell('C1').value = { formula: 'UPPER("ada")', result: 'ADA' };
      sheet.getCell('D1').value = { formula: 'DATE(2023,3,15)', result: 45000 };
      sheet.getCell('D1').numFmt = 'yyyy-mm-dd';
      sheet.getCell('E1').value = { formula: '1/0', result: { error: '#DIV/0!' } };
      sheet.getCell('F1').value = { formula: 'NOW()' };
      sheet.getCell('A2').value = { sharedFormula: 'A1', result: 0 };
      sheet.getCell('A3').value = { sharedFormula: 'A1', result: 7 };
    });
    const [sheet] = await read(bytes);
    expect(sheet!.rows).toEqual([
      // A formula saved without a result is empty, and an error keeps only the fact of the error.
      { number: 1, cells: [6, 0, 'ADA', { date: '2023-03-15' }, { error: '' }] },
      { number: 2, cells: [0] },
      { number: 3, cells: [7] },
    ]);
  });

  it('reads every sheet in tab order, with its own rows and counts', async () => {
    const bytes = await workbook((book) => {
      book.addWorksheet('People').addRow(['Ada']);
      const orders = book.addWorksheet('Orders');
      orders.addRows([['Order'], [1], [2]]);
      book.addWorksheet('Empty');
      // Moving a tab changes the workbook's order without renaming its sheet files.
      (orders as unknown as { orderNo: number }).orderNo = -1;
    });
    const sheets = await read(bytes);
    expect(sheets.map(({ name, position, sent, total }) => ({ name, position, sent, total }))).toEqual([
      { name: 'Orders', position: 0, sent: 3, total: 3 },
      { name: 'People', position: 1, sent: 1, total: 1 },
      { name: 'Empty', position: 2, sent: 0, total: 0 },
    ]);
    expect(sheets[0]!.rows.map((row) => row.cells)).toEqual([['Order'], [1], [2]]);
  });

  it('fills a merged value into every cell the merge covers', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Regions');
      sheet.addRow(['Region', 'City', 'Sales', 'Q1', null]);
      sheet.mergeCells('D1:E1');
      sheet.addRow(['West', 'Los Angeles', 10]);
      sheet.addRow([null, 'Seattle', 20]);
      sheet.addRow([null, 'Portland', 30]);
      sheet.mergeCells('A2:A4');
    });
    const [sheet] = await read(bytes);
    expect(sheet!.rows.map((row) => row.cells)).toEqual([
      ['Region', 'City', 'Sales', 'Q1', 'Q1'],
      ['West', 'Los Angeles', 10],
      ['West', 'Seattle', 20],
      ['West', 'Portland', 30],
    ]);
  });

  it('leaves out empty rows and the empty cells at a row’s end, keeping each row’s number', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Gaps');
      sheet.getCell('B3').value = 'Name';
      sheet.getCell('C3').value = 'Total';
      // Formatting alone doesn't make a row.
      sheet.getRow(4).getCell(1).font = { bold: true };
      sheet.getCell('D4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      sheet.getCell('B6').value = 'Ada';
      sheet.getCell('C6').value = 12;
      sheet.getCell('E6').numFmt = '0.00';
      sheet.getCell('B9').value = 'Bea';
    });
    const [sheet] = await read(bytes);
    expect(sheet!.rows).toEqual([
      { number: 3, cells: [null, 'Name', 'Total'] },
      { number: 6, cells: [null, 'Ada', 12] },
      { number: 9, cells: [null, 'Bea'] },
    ]);
    expect(sheet!.total).toBe(3);
  });

  it('sends a sheet’s rows only up to the cap, and counts the rest', async () => {
    expect(SPREADSHEET_LIMITS.rowsPerSheet).toBe(200_000);
    const bytes = await workbook((book) => {
      book.addWorksheet('Long').addRows(Array.from({ length: 7 }, (_, index) => [`Row ${index + 1}`]));
      book.addWorksheet('Short').addRows([['Only']]);
    });
    const sheets = await read(bytes, { rowsPerSheet: 5 });
    expect(sheets[0]!.rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(sheets[0]).toMatchObject({ sent: 5, total: 7 });
    expect(sheets[1]).toMatchObject({ sent: 1, total: 1 });
  });

  it('refuses a row wider than a table can be', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Wide');
      sheet.getCell(1, 1).value = 'First';
      sheet.getCell(1, 501).value = 'Too far';
    });
    await expect(refusal(bytes)).resolves.toBe('import.spreadsheet.tooWide');
  });

  it('keeps text whole where the file is read in pieces', async () => {
    const line = 'José, 雪, and ☃ '.repeat(40);
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Text');
      for (let index = 0; index < 3_000; index++) sheet.addRow([`${index} ${line}`]);
    });
    const [sheet] = await read(bytes);
    expect(sheet!.rows).toHaveLength(3_000);
    expect(sheet!.rows.every((row, index) => row.cells[0] === `${index} ${line}`)).toBe(true);
  });

  it('refuses files that aren’t spreadsheets', async () => {
    await expect(refusal(Buffer.from('Name,Total\nAda,12\n'))).resolves.toBe(
      'import.spreadsheet.notSpreadsheet',
    );
    await expect(refusal(Buffer.alloc(0))).resolves.toBe('import.spreadsheet.notSpreadsheet');
    // An older `.xls` workbook, or one with a password, is a compound file.
    const compound = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
    ]);
    await expect(refusal(compound)).resolves.toBe('import.spreadsheet.legacy');
    const document = zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>' });
    expect([...zipEntries(document).keys()]).toEqual(['[Content_Types].xml', 'word/document.xml']);
    await expect(refusal(document)).resolves.toBe('import.spreadsheet.notSpreadsheet');
    const bytes = await workbook((book) => {
      book.addWorksheet('People').addRow(['Ada']);
    });
    await expect(refusal(bytes.subarray(0, bytes.length / 2))).resolves.toBe('import.spreadsheet.unreadable');
    // A workbook whose parts are all there, but one sheet's XML breaks off part way.
    const minimal = (sheet: string) =>
      zipOf({
        'xl/workbook.xml': `<workbook xmlns:r="${RELATIONS}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${RELATIONS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        'xl/worksheets/sheet1.xml': sheet,
      });
    const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Ada</t></is></c></row>';
    await expect(read(minimal(`<worksheet><sheetData>${rows}</sheetData></worksheet>`))).resolves.toEqual([
      { name: 'A', position: 0, rows: [{ number: 1, cells: ['Ada'] }], sent: 1, total: 1 },
    ]);
    await expect(refusal(minimal(`<worksheet><sheetData>${rows}<row r="2"><c r=</sheetData>`))).resolves.toBe(
      'import.spreadsheet.unreadable',
    );
  });

  it('stops with a clear message once the time limit passes', async () => {
    const bytes = await workbook((book) => {
      book.addWorksheet('People').addRows([['Ada'], ['Bea'], ['Cy']]);
    });
    await expect(refusal(bytes, { signal: AbortSignal.abort() })).resolves.toBe('import.spreadsheet.timeout');
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of readSpreadsheet(bytes, { signal: controller.signal })) {
          seen.push(event.kind);
          if (event.kind === 'row') controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ messageKey: 'import.spreadsheet.timeout', params: { minutes: 2 } });
    expect(seen).toEqual(['sheet', 'row']);
  });
});

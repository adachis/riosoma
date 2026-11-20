import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ExtractedSource } from '@riosoma/ingest';
import { entryBytes, zipEntries } from '../../data/imports/zip.js';
import { extractSource } from './index.js';
import { textQuality } from './pdf.extractor.js';
import { LIMITS } from './types.js';

interface Member {
  name: string;
  data: Buffer;
  deflate?: boolean;
  encrypted?: boolean;
  size?: number;
}

/** Generated archives let each cap be tested without storing documents or expanding large fixtures. */
function zip(members: Member[]): Buffer {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name),
      data = member.deflate ? deflateRawSync(member.data) : member.data;
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(member.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(member.data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(member.size ?? member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(member.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(member.data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(member.size ?? member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const entries = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, entries, end]);
}

function rewriteParts(bytes: Buffer, rewrite: (name: string, data: Buffer) => Buffer): Buffer {
  return zip(
    [...zipEntries(bytes).values()].map((entry) => ({
      name: entry.name,
      data: rewrite(entry.name, entryBytes(bytes, entry, LIMITS.expandedBytes)),
      deflate: true,
    })),
  );
}

async function source(bytes: Buffer, name = 'fixture'): Promise<ExtractedSource> {
  const result = await extractSource(name, bytes);
  expect(result.status, JSON.stringify(result)).toBe('extracted');
  if (result.status !== 'extracted') throw new Error('Fixture extraction failed');
  return result.source;
}

function eml(body: string, headers = 'Content-Type: text/plain; charset=utf-8'): Buffer {
  return Buffer.from(
    [
      'From: Sender <sender@example.test>',
      'Subject: Fixture email',
      'Date: Sun, 11 Oct 2026 09:00:00 -0700',
      'Message-ID: <fixture@example.test>',
      'MIME-Version: 1.0',
      headers,
      '',
      body,
    ].join('\r\n'),
  );
}

let boundaryIndex = 0;
function mime(parts: string[], subtype = 'mixed'): Buffer {
  const boundary = `fixture-boundary-${boundaryIndex++}`;
  return eml(
    parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`,
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
  );
}

describe('content-based workbook extraction', () => {
  it('ignores formatting across all remaining columns and 5,000 blank rows on three sheets', async () => {
    const book = new ExcelJS.Workbook();
    const values = Array.from({ length: 200 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) => row * 9 + column),
    );
    for (let index = 0; index < 3; index++) {
      const sheet = book.addWorksheet(`Table ${index + 1}`);
      sheet.addRows(values);
      sheet.getCell('A1').numFmt = '0';
      sheet.pageSetup.printArea = 'A1:XFD5200';
    }
    const original = Buffer.from(await book.xlsx.writeBuffer());
    const bytes = zip(
      [...zipEntries(original).values()].map((entry) => {
        let data = entryBytes(original, entry, LIMITS.expandedBytes);
        if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) {
          const blankRows = Array.from(
            { length: 5000 },
            (_, row) => `<row r="${row + 201}" s="1" customFormat="1" ht="15"/>`,
          ).join('');
          data = Buffer.from(
            data
              .toString()
              .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD5200"/>')
              .replace(
                '<sheetData>',
                '<cols><col min="10" max="16384" width="12" style="1"/></cols><sheetData>',
              )
              .replace('</sheetData>', `${blankRows}</sheetData>`),
          );
        }
        return { name: entry.name, data, deflate: true };
      }),
    );
    expect(bytes.length).toBeLessThan(300 * 1024);
    const result = await source(bytes);
    expect(result.sheets).toHaveLength(3);
    for (const sheet of result.sheets!) {
      expect(sheet.rows).toHaveLength(200);
      expect(sheet.rows.every((row) => row.length === 9)).toBe(true);
      expect(sheet.rows.map((row) => row.map((item) => item.v))).toEqual(values);
    }
  });

  it('ignores a width on column 16,384 while retaining a value in A31', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Wide');
    sheet.getCell('A31').value = 'Last row';
    sheet.getColumn(16384).width = 24;
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows).toEqual([
      ...Array.from({ length: 30 }, () => [{ v: null, t: 'empty' }]),
      [{ v: 'Last row', t: 'text' }],
    ]);
  });

  it('ignores a width on column 4 when only A1 holds a value', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Columns');
    sheet.getCell('A1').value = 'Label';
    sheet.getColumn(4).width = 24;
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows).toEqual([[{ v: 'Label', t: 'text' }]]);
  });

  it('reads absolute worksheet and drawing relationship targets with every value in place', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Drawing');
    sheet.addRows([
      ['Label', 42],
      ['Next', false],
    ]);
    book.addWorksheet('Second').getCell('D7').value = 'Last';
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const imageId = book.addImage({ base64: image.toString('base64'), extension: 'png' });
    sheet.addImage(imageId, 'C1:D2');
    const bytes = rewriteParts(Buffer.from(await book.xlsx.writeBuffer()), (name, data) => {
      if (name === 'xl/_rels/workbook.xml.rels')
        return Buffer.from(data.toString().replace(/Target="worksheets\//g, 'Target="/xl/worksheets/'));
      if (name === 'xl/worksheets/_rels/sheet1.xml.rels')
        return Buffer.from(data.toString().replace(/Target="\.\.\/drawings\//g, 'Target="/xl/drawings/'));
      return data;
    });
    const result = await source(bytes);
    expect(result.sheets!.map((item) => item.name)).toEqual(['Drawing', 'Second']);
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Label', 42],
      ['Next', false],
    ]);
    expect(result.sheets![1]!.rows[6]![3]).toEqual({ v: 'Last', t: 'text' });
  });

  it('extracts 3,255 rows by 13 columns ten times under the worker memory limit', async () => {
    const book = new ExcelJS.Workbook();
    const values = Array.from({ length: 3255 }, (_, row) =>
      Array.from({ length: 13 }, (_, column) => (column % 2 ? `Value ${row}:${column}` : row * 13 + column)),
    );
    book.addWorksheet('Values').addRows(values);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    expect(bytes.length).toBeLessThan(300 * 1024);
    for (let run = 0; run < 10; run++) {
      const result = await source(bytes);
      expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual(values);
    }
  });

  it('keeps interior blank rows and columns between B2 and D7', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Positions');
    sheet.getCell('B2').value = 'First';
    sheet.getCell('D7').value = 'Last';
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows).toEqual(
      Array.from({ length: 7 }, (_, row) =>
        Array.from({ length: 4 }, (_, column) =>
          row === 1 && column === 1
            ? { v: 'First', t: 'text' }
            : row === 6 && column === 3
              ? { v: 'Last', t: 'text' }
              : { v: null, t: 'empty' },
        ),
      ),
    );
  });

  it('clips a full-width label merge to five valued columns and drops merges outside the grid', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Merges');
    sheet.getCell('A1').value = 'Table';
    sheet.mergeCells('A1:XFD1');
    sheet.addRow([1, 2, 3, 4, 5]);
    sheet.mergeCells('G9:H10');
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Table', null, null, null, null],
      [1, 2, 3, 4, 5],
    ]);
    expect(result.sheets![0]!.merges).toEqual([{ top: 1, left: 1, bottom: 1, right: 5 }]);
  });

  it('rejects valued extents over the cell cap before allocating the grid', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Limit');
    sheet.getCell('A1').value = 'First';
    sheet.getCell('XFD31').value = 'Last';
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const started = performance.now();
    expect(await extractSource('', bytes)).toMatchObject({ status: 'failed', code: 'size-limit' });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('checks valued extents summed across sheets before allocating any grid', async () => {
    const book = new ExcelJS.Workbook();
    for (const name of ['First', 'Second']) book.addWorksheet(name).getCell('IV1000').value = 0;
    expect(await extractSource('', Buffer.from(await book.xlsx.writeBuffer()))).toMatchObject({
      status: 'failed',
      code: 'size-limit',
    });
  });

  it.each([false, true])(
    'keeps dates, errors, rich text, links, and booleans with date1904=%s',
    async (date1904) => {
      const book = new ExcelJS.Workbook();
      book.properties.date1904 = date1904;
      book
        .addWorksheet('Types')
        .addRow([
          new Date('2026-03-01T00:00:00Z'),
          { error: '#N/A' },
          { richText: [{ text: 'Bold ', font: { bold: true } }, { text: 'label' }] },
          { text: 'Link label', hyperlink: 'https://example.test' },
          false,
          { formula: '1/0', result: { error: '#DIV/0!' } },
        ]);
      const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
      expect(result.sheets![0]!.rows[0]).toEqual([
        { v: '2026-03-01', t: 'date' },
        { v: '#N/A', t: 'text' },
        { v: 'Bold label', t: 'text' },
        { v: 'Link label', t: 'text' },
        { v: false, t: 'bool' },
        { v: '#DIV/0!', t: 'text' },
      ]);
    },
  );

  it('keeps the existing outcomes for workbooks without sheets or with only empty sheets', async () => {
    const book = new ExcelJS.Workbook();
    expect(await extractSource('', Buffer.from(await book.xlsx.writeBuffer()))).toMatchObject({
      status: 'empty',
    });
    const sheet = book.addWorksheet('Empty');
    sheet.getCell('D20').font = { bold: true };
    sheet.mergeCells('A30:B31');
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows).toEqual([]);
    expect(result.sheets![0]!.merges).toEqual([]);
    expect(result.warnings).toEqual(['ingest.extract.empty']);
  });

  async function workbook(): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Visible');
    sheet.getCell('B1').value = 'Group';
    sheet.mergeCells('B1:B2');
    sheet.getCell('B3').value = 'Identifier';
    sheet.getCell('C3').value = 'Amount';
    sheet.getCell('B4').value = '00412';
    sheet.getCell('C4').value = 0;
    sheet.getCell('D4').value = '42';
    sheet.getCell('E4').value = new Date('2026-03-01T00:00:00Z');
    sheet.getCell('F4').value = true;
    sheet.getCell('G4').value = { formula: '1-1', result: 0 };
    sheet.getCell('H4').value = { formula: 'UNAVAILABLE()' };
    sheet.getCell('I4').value = 412;
    sheet.getCell('I4').numFmt = '00000';
    sheet.getCell('B6').value = 'Last';
    sheet.getCell('J7').font = { bold: true };
    book.addWorksheet('Hidden', { state: 'hidden' }).getCell('C2').value = 'secret';
    book.addWorksheet('Very hidden', { state: 'veryHidden' }).getCell('B3').value = 5;
    book.addWorksheet('Empty');
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  it.each(['xlsx', 'xlsm'])(
    'retains every coordinate, type, sheet, and merge in %s content',
    async (format) => {
      let bytes = await workbook();
      if (format === 'xlsm')
        bytes = zip(
          [...zipEntries(bytes).values()]
            .map((entry) => {
              let data: Buffer = entryBytes(bytes, entry, LIMITS.expandedBytes);
              if (entry.name === '[Content_Types].xml')
                data = Buffer.from(
                  data
                    .toString()
                    .replace(
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
                      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
                    ),
                );
              return { name: entry.name, data, deflate: true };
            })
            .concat([{ name: 'xl/vbaProject.bin', data: Buffer.from('Inert macro fixture'), deflate: true }]),
        );
      const result = await source(bytes, 'misleading.txt');
      expect(result.kind).toBe('workbook');
      expect(result.sheets!.map((sheet) => [sheet.name, sheet.hidden])).toEqual([
        ['Visible', false],
        ['Hidden', true],
        ['Very hidden', true],
        ['Empty', false],
      ]);
      const sheet = result.sheets![0]!;
      expect(sheet.rows).toHaveLength(6);
      expect(sheet.rows.every((row) => row.length === 9)).toBe(true);
      expect(sheet.rows[0]![0]).toEqual({ v: null, t: 'empty' });
      expect(sheet.rows[0]![1]).toEqual({ v: 'Group', t: 'text' });
      expect(sheet.rows[1]![1]).toEqual({ v: null, t: 'empty' });
      expect(sheet.merges).toEqual([{ top: 1, left: 2, bottom: 2, right: 2 }]);
      expect(sheet.rows[2]![1]).toEqual({ v: 'Identifier', t: 'text' });
      expect(sheet.rows[3]!.slice(1, 9)).toEqual([
        { v: '00412', t: 'text' },
        { v: 0, t: 'number' },
        { v: '42', t: 'text' },
        { v: '2026-03-01', t: 'date' },
        { v: true, t: 'bool' },
        { v: 0, t: 'number' },
        { v: null, t: 'empty' },
        { v: '00412', t: 'text' },
      ]);
      expect(sheet.rows[4]!.every((item) => item.t === 'empty')).toBe(true);
      expect(sheet.rows[5]![1]).toEqual({ v: 'Last', t: 'text' });
      expect(result.sheets![1]!.rows[1]![2]).toEqual({ v: 'secret', t: 'text' });
      expect(result.sheets![2]!.rows[2]![1]).toEqual({ v: 5, t: 'number' });
      expect(result.sheets![3]!.rows).toEqual([]);
    },
  );

  it('keeps cached formula dates, strings, booleans, and shared results without evaluating missing results', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Cached');
    sheet.getCell('A1').value = { formula: 'DATE(2023,3,15)', result: 45000 };
    sheet.getCell('A1').numFmt = 'yyyy-mm-dd';
    sheet.getCell('B1').value = { formula: 'UPPER("ada")', result: 'ADA' };
    sheet.getCell('C1').value = { formula: 'TRUE()', result: true };
    sheet.getCell('D1').value = { formula: '1+1', result: 2 };
    sheet.getCell('D2').value = { sharedFormula: 'D1', result: 0 };
    const result = await source(Buffer.from(await book.xlsx.writeBuffer()));
    expect(result.sheets![0]!.rows).toEqual([
      [
        { v: '2023-03-15', t: 'date' },
        { v: 'ADA', t: 'text' },
        { v: true, t: 'bool' },
        { v: 2, t: 'number' },
      ],
      [
        { v: null, t: 'empty' },
        { v: null, t: 'empty' },
        { v: null, t: 'empty' },
        { v: 0, t: 'number' },
      ],
    ]);
  });

  it('retains true, false, and error formula results across XML chunk boundaries', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Cached types');
    sheet.getCell('A1').value = { formula: 'TRUE()', result: true };
    sheet.getCell('B1').value = { formula: 'FALSE()', result: false };
    sheet.getCell('C1').font = { bold: true };
    sheet.getCell('D1').value = { formula: '1/0', result: { error: '#DIV/0!' } };
    const bytes = rewriteParts(Buffer.from(await book.xlsx.writeBuffer()), (name, data) => {
      if (name !== 'xl/worksheets/sheet1.xml') return data;
      const xml = data.toString().replace('<c r="A1"', '<c\nr="A1"');
      const start = xml.indexOf('<c\nr="A1"');
      const split = xml.indexOf('<v>', start) + 2;
      // Put the first cached value across the reader's chunk boundary without changing XML content.
      return Buffer.from(
        (xml.slice(0, start) + ' '.repeat(16 * 1024 - split) + xml.slice(start)).replace(
          '#DIV/0!',
          '#DIV&#47;0!',
        ),
      );
    });
    const result = await source(bytes);
    expect(result.sheets![0]!.rows[0]).toEqual([
      { v: true, t: 'bool' },
      { v: false, t: 'bool' },
      { v: null, t: 'empty' },
      { v: '#DIV/0!', t: 'text' },
    ]);
  });

  it.each([false, true])('keeps every inline rich-text run with a chunk split=%s', async (split) => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Inline runs');
    sheet.getCell('B2').value = 'Placeholder';
    sheet.getCell('D7').value = 'Last';
    const bytes = rewriteParts(Buffer.from(await book.xlsx.writeBuffer()), (name, data) => {
      if (name !== 'xl/worksheets/sheet1.xml') return data;
      let xml = data
        .toString()
        .replace(
          /<c r="B2"[^>]*>[\s\S]*?<\/c>/,
          '<c r="B2" t="inlineStr"><is><r><rPr><b/><color rgb="FFFF0000"/></rPr><t xml:space="preserve">First </t></r><r><t>label</t></r><r><t></t></r></is></c>',
        );
      if (split) {
        const start = xml.indexOf('<c r="B2"');
        const boundary = xml.indexOf('First ', start) + 3;
        xml = xml.slice(0, start) + ' '.repeat(16 * 1024 - boundary) + xml.slice(start);
      }
      return Buffer.from(xml);
    });
    const result = await source(bytes);
    expect(result.sheets![0]!.rows).toHaveLength(7);
    expect(result.sheets![0]!.rows.every((row) => row.length === 4)).toBe(true);
    expect(result.sheets![0]!.rows[1]![1]).toEqual({ v: 'First label', t: 'text' });
    expect(result.sheets![0]!.rows[6]![3]).toEqual({ v: 'Last', t: 'text' });
  });

  it('decodes inline text once and preserves literal entity text in plain and rich strings', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Inline entities').addRow(['Plain', 'Rich', 'Split entity']);
    const bytes = rewriteParts(Buffer.from(await book.xlsx.writeBuffer()), (name, data) => {
      if (name !== 'xl/worksheets/sheet1.xml') return data;
      return Buffer.from(
        data
          .toString()
          .replace(
            /<c r="A1"[^>]*>[\s\S]*?<\/c>/,
            '<c r="A1" t="inlineStr"><is><t>&amp;amp; &amp;lt; &amp;#48; &#65; &#x42;</t></is></c>',
          )
          .replace(
            /<c r="B1"[^>]*>[\s\S]*?<\/c>/,
            '<c r="B1" t="inlineStr"><is><r><t>&amp;amp;</t></r><r><t xml:space="preserve"> &amp;lt; &amp;#48; &#65; &#x42;</t></r></is></c>',
          )
          .replace(
            /<c r="C1"[^>]*>[\s\S]*?<\/c>/,
            '<c r="C1" t="inlineStr"><is><r><t>&amp;am</t></r><r><t>p;</t></r></is></c>',
          ),
      );
    });
    const result = await source(bytes);
    expect(result.sheets![0]!.rows[0]).toEqual([
      { v: '&amp; &lt; &#48; A B', t: 'text' },
      { v: '&amp; &lt; &#48; A B', t: 'text' },
      { v: '&amp;', t: 'text' },
    ]);
  });

  it.each(['&#48;', '&#x30;'])(
    'decodes cached false formula character reference %s before reading its boolean value',
    async (reference) => {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Boolean references');
      sheet.getCell('A1').value = { formula: 'FALSE()', result: false };
      sheet.getCell('B1').value = { formula: 'TRUE()', result: true };
      const bytes = rewriteParts(Buffer.from(await book.xlsx.writeBuffer()), (name, data) => {
        if (name !== 'xl/worksheets/sheet1.xml') return data;
        return Buffer.from(
          data.toString().replace('<v>0</v>', `<v>${reference}</v>`).replace('<v>1</v>', '<v>&#49;</v>'),
        );
      });
      const result = await source(bytes);
      expect(result.sheets![0]!.rows[0]).toEqual([
        { v: false, t: 'bool' },
        { v: true, t: 'bool' },
      ]);
    },
  );
});

describe('text extraction', () => {
  it('recognizes a consistent region after punctuation in introductory rows', async () => {
    const result = await source(
      Buffer.from('Report, owner, date\nGenerated for review\nName,Code\nAda,00412'),
    );
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Report', ' owner', ' date'],
      ['Generated for review', null, null],
      ['Name', 'Code', null],
      ['Ada', '00412', null],
    ]);
  });

  it('prefers a larger delimited region to incidental separators near the end', async () => {
    const result = await source(
      Buffer.from(
        [
          'Name,Code',
          ...Array.from({ length: 8 }, (_, index) => `Row ${index},00412`),
          'Generated\t2026',
          'Reviewed\t2026',
        ].join('\n'),
      ),
    );
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Name', 'Code'],
      ...Array.from({ length: 8 }, (_, index) => [`Row ${index}`, '00412']),
      ['Generated\t2026', null],
      ['Reviewed\t2026', null],
    ]);
  });

  it.each([',', '\t', ';', '|'])(
    'recognizes a %s region after introductory rows and pads their blank columns',
    async (delimiter) => {
      const result = await source(
        Buffer.from(`Report\nGenerated for review\n\nName${delimiter}Code\nAda${delimiter}00412\n\n`),
      );
      expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
        ['Report', null],
        ['Generated for review', null],
        [null, null],
        ['Name', 'Code'],
        ['Ada', '00412'],
        [null, null],
      ]);
    },
  );

  it.each([',', '\t', ';', '|'])(
    'sniffs %s without a filename and keeps blank coordinates',
    async (delimiter) => {
      const rows = [
        ['Title', ''],
        ['', ''],
        ['Identifier', 'Amount'],
        ['00412', '0'],
        ['', ''],
        ['"42"', '=1+1'],
      ];
      const result = await source(
        Buffer.from(rows.map((row) => row.join(delimiter)).join('\r\n')),
        'fake.xlsx',
      );
      expect(result.sheets![0]!.rows).toEqual([
        [
          { v: 'Title', t: 'text' },
          { v: null, t: 'empty' },
        ],
        [
          { v: null, t: 'empty' },
          { v: null, t: 'empty' },
        ],
        [
          { v: 'Identifier', t: 'text' },
          { v: 'Amount', t: 'text' },
        ],
        [
          { v: '00412', t: 'text' },
          { v: '0', t: 'text' },
        ],
        [
          { v: null, t: 'empty' },
          { v: null, t: 'empty' },
        ],
        [
          { v: '42', t: 'text' },
          { v: '=1+1', t: 'text' },
        ],
      ]);
    },
  );

  it('retains large identifiers and decimal text without numeric conversion', async () => {
    const result = await source(
      Buffer.from('Identifier,Value\n12345678901234567890,1234567890.1234567890\n00412,0'),
    );
    expect(result.sheets![0]!.rows[1]).toEqual([
      { v: '12345678901234567890', t: 'text' },
      { v: '1234567890.1234567890', t: 'text' },
    ]);
    expect(result.sheets![0]!.rows[2]).toEqual([
      { v: '00412', t: 'text' },
      { v: '0', t: 'text' },
    ]);
  });

  it('keeps every formula prefix as text, including negative and positive numbers', async () => {
    const result = await source(Buffer.from('=1+1,+42,-42,@name\n"a,b","two\nlines",,0\n'));
    expect(result.sheets![0]!.rows[0]).toEqual(
      ['=1+1', '+42', '-42', '@name'].map((v) => ({ v, t: 'text' })),
    );
    expect(result.sheets![0]!.rows[1]).toEqual([
      { v: 'a,b', t: 'text' },
      { v: 'two\nlines', t: 'text' },
      { v: null, t: 'empty' },
      { v: '0', t: 'text' },
    ]);
  });

  it.each(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'])(
    'sniffs %s and preserves row positions',
    async (encoding) => {
      const value = 'Label\tCode\r\n\r\nCafé\t00412';
      let bytes: Buffer;
      if (encoding === 'windows-1252') bytes = Buffer.from(value, 'latin1');
      else if (encoding === 'utf-8')
        bytes = Buffer.concat([Buffer.from('efbbbf', 'hex'), Buffer.from(value)]);
      else {
        const data = Buffer.from(value, 'utf16le');
        bytes = encoding === 'utf-16be' ? Buffer.concat([Buffer.from('feff', 'hex'), data.swap16()]) : data;
      }
      const result = await source(bytes);
      expect(result.sheets![0]!.rows[1]).toEqual([
        { v: null, t: 'empty' },
        { v: null, t: 'empty' },
      ]);
      expect(result.sheets![0]!.rows[2]).toEqual([
        { v: 'Café', t: 'text' },
        { v: '00412', t: 'text' },
      ]);
    },
  );

  it('sniffs fixed-width columns with an introductory line and blank rows', async () => {
    const result = await source(
      Buffer.from('Report\n\nName      Code      Amount\nAda       00412     42\n\nEve       00500     0\n'),
    );
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Report', null, null],
      [null, null, null],
      ['Name', 'Code', 'Amount'],
      ['Ada', '00412', '42'],
      [null, null, null],
      ['Eve', '00500', '0'],
    ]);
  });
});

describe('PDF and image extraction', () => {
  it('reads invoked nested PDF forms with local and inherited font resources in page order', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Text on the first page stays first.', { font, size: 12 });
    const page = pdf.addPage();
    const inner = pdf.context.register(
      pdf.context.flateStream('BT /F1 12 Tf (Readable text inside the nested form.) Tj ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 400, 100],
      }),
    );
    const outer = pdf.context.register(
      pdf.context.flateStream(
        'BT /F1 12 Tf (Before the nested form.) Tj ET /Inner Do BT /F1 12 Tf (After the nested form.) Tj ET',
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 100],
          Resources: { Font: { F1: font.ref }, XObject: { Inner: inner } },
        },
      ),
    );
    // A conflicting page font makes the form's local resource dictionary observable.
    const mapping = pdf.context.register(pdf.context.flateStream('1 beginbfchar <42> <0058> endbfchar'));
    const otherFont = pdf.context.register(
      pdf.context.obj({ Type: 'Font', Subtype: 'Type0', ToUnicode: mapping }),
    );
    page.node.set(
      PDFName.of('Resources'),
      pdf.context.obj({ Font: { F1: otherFont }, XObject: { Outer: outer } }),
    );
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream('/Outer Do')));
    const result = await source(Buffer.from(await pdf.save()));
    expect(result.pages!.map((item) => [item.number, item.text.trim(), item.textQuality])).toEqual([
      [1, 'Text on the first page stays first.', 'clean'],
      [2, 'Before the nested form.\nReadable text inside the nested form.\nAfter the nested form.', 'clean'],
    ]);
  });

  it('bounds recursive PDF form invocations', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const resources = pdf.context.obj({});
    const form = pdf.context.register(
      pdf.context.flateStream('/Loop Do', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 10, 10],
        Resources: resources,
      }),
    );
    resources.set(PDFName.of('XObject'), pdf.context.obj({ Loop: form }));
    page.node.set(PDFName.of('Resources'), resources);
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream('/Loop Do')));
    expect(await extractSource('', Buffer.from(await pdf.save()))).toMatchObject({
      status: 'failed',
      code: 'size-limit',
    });
  });

  it.each(['depth', 'decoded size'])('retains the PDF %s budget for invoked forms', async (limit) => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    let form = pdf.context.register(
      pdf.context.flateStream(limit === 'decoded size' ? ' '.repeat(4 * 1024 * 1024 + 1) : '', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 10, 10],
      }),
    );
    if (limit === 'depth') {
      for (let depth = 0; depth < 17; depth++) {
        form = pdf.context.register(
          pdf.context.flateStream('/Child Do', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 10, 10],
            Resources: { XObject: { Child: form } },
          }),
        );
      }
    }
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Form: form } }));
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream('/Form Do')));
    expect(await extractSource('', Buffer.from(await pdf.save()))).toMatchObject({
      status: 'failed',
      code: 'size-limit',
    });
  });

  it('retains clean, garbled, and empty PDF pages in their original positions', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('A clean page with enough readable characters.', { font, size: 24 });
    pdf.addPage().drawText('(cid:42) (cid:43) (cid:44) missing glyphs', { font, size: 12 });
    pdf.addPage();
    const result = await source(Buffer.from(await pdf.save()), 'wrong.csv');
    expect(result.pages!.map((page) => [page.number, page.textQuality])).toEqual([
      [1, 'clean'],
      [2, 'garbled'],
      [3, 'none'],
    ]);
    expect(result.pages![0]!.text.trim()).toBe('A clean page with enough readable characters.');
    expect(result.pages![1]!.text.trim()).toBe('(cid:42) (cid:43) (cid:44) missing glyphs');
    expect(result.pages![2]!.text.trim()).toBe('');
    expect(textQuality('Readable text with \uE000\uE001\uE002\uE003\uE004\uE005 glyphs')).toBe('garbled');
    expect(textQuality('文字を読むための十分に長い文章をここに書きます')).toBe('clean');
    expect(textQuality('x')).toBe('garbled');
  });

  it('explains a PDF with no text while retaining its empty pages', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const result = await source(Buffer.from(await pdf.save()));
    expect(result.pages![0]).toMatchObject({ number: 1, textQuality: 'none' });
    expect(result.warnings).toEqual(['ingest.extract.empty']);
  });

  it.each(['png', 'jpeg', 'webp', 'tiff', 'gif', 'avif'] as const)(
    'reads only %s image dimensions',
    async (format) => {
      const bytes = await sharp({ create: { width: 7, height: 11, channels: 3, background: '#abcdef' } })
        .toFormat(format)
        .toBuffer();
      const result = await source(bytes, 'wrong.pdf');
      expect(result.images).toEqual([{ index: 1, width: 7, height: 11 }]);
      expect(result.pages).toBeUndefined();
    },
  );
});

describe('email extraction', () => {
  it('reads a multipart message without a closing boundary', async () => {
    const bytes = eml(
      '--open\r\nContent-Type: text/plain\r\n\r\nRecovered body',
      'Content-Type: multipart/mixed; boundary="open"',
    );
    expect((await source(bytes)).email!.bodyText).toBe('Recovered body');
  });

  it('decodes an unknown charset as Windows-1252 and reports a catalog warning', async () => {
    const bytes = Buffer.concat([
      eml('', 'Content-Type: text/plain; charset=unknown-fixture-charset'),
      Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]),
    ]);
    const result = await source(bytes);
    expect(result.email!.bodyText).toBe('Café €');
    expect(result.warnings).toContain('ingest.extract.emailCharset');
  });

  it('reads a header block containing a malformed line', async () => {
    const result = await source(eml('Recovered body', 'Malformed header line\r\nContent-Type: text/plain'));
    expect(result.kind).toBe('email');
    expect(result.email!.subject).toBe('Fixture email');
    expect(result.email!.bodyText).toBe('Recovered body');
  });

  it('ignores stray characters in a base64 body', async () => {
    const result = await source(
      eml('UmVj!b3Zl#cmVkIGJvZHk=', 'Content-Type: text/plain\r\nContent-Transfer-Encoding: base64'),
    );
    expect(result.email!.bodyText).toBe('Recovered body');
  });

  it('reads an HTML-only body and keeps table coordinates', async () => {
    const result = await source(
      eml('<p>HTML body</p><table><tr><td>00412</td><td>0</td></tr></table>', 'Content-Type: text/html'),
    );
    expect(result.kind).toBe('email');
    expect(result.email!.bodyText).toContain('HTML body');
    expect(result.email!.tables).toEqual([[['00412', '0']]]);
  });

  it('does not claim ordinary text with a misleading email filename', async () => {
    expect((await source(Buffer.from('Ordinary text'), 'message.eml')).kind).toBe('text');
  });

  it.each(['parts', 'depth'])('retains the MIME %s limit', async (limit) => {
    let bytes: Buffer;
    if (limit === 'parts')
      bytes = mime(Array.from({ length: LIMITS.mimeParts }, () => 'Content-Type: text/plain\r\n\r\nBody'));
    else {
      let part = 'Content-Type: text/plain\r\n\r\nBody';
      for (let depth = 0; depth <= LIMITS.mimeDepth; depth++)
        part = `Content-Type: multipart/mixed; boundary="depth-${depth}"\r\n\r\n--depth-${depth}\r\n${part}\r\n--depth-${depth}--`;
      bytes = eml(part.slice(part.indexOf('\r\n\r\n') + 4), part.slice(0, part.indexOf('\r\n\r\n')));
    }
    expect(await extractSource('', bytes)).toMatchObject({ status: 'failed', code: 'email-limit' });
  });

  it('keeps the exact bytes of the last attachment in an unclosed multipart', async () => {
    const bytes = eml(
      '--open\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="last.bin"\r\n\r\nTail bytes',
      'Content-Type: multipart/mixed; boundary="open"',
    );
    const result = await source(bytes);
    expect(Buffer.from(result.parts![0]!.bytes)).toEqual(Buffer.from('Tail bytes'));
  });

  it('shares the MIME part cap with an attached message at the exact outer limit', async () => {
    const bytes = mime([
      ...Array.from({ length: LIMITS.mimeParts - 2 }, () => 'Content-Type: text/plain\r\n\r\nBody'),
      'Content-Type: message/rfc822\r\n\r\n' + eml('Attached body').toString(),
    ]);
    expect(await extractSource('', bytes)).toMatchObject({ status: 'failed', code: 'email-limit' });
  });

  it('reads MIME parts when the boundary itself ends in two hyphens', async () => {
    const result = await source(
      eml(
        '--fixture--\r\nContent-Type: text/plain\r\n\r\nExpected body\r\n--fixture----\r\n',
        'Content-Type: multipart/mixed; boundary="fixture--"',
      ),
    );
    expect(result.email!.bodyText).toBe('Expected body');
  });

  it.each(['\r\n', '\n'])('accepts a headerless default text part with %j line endings', async (newline) => {
    const result = await source(
      eml(
        ['--fixture', '', 'Expected body', '--fixture--', ''].join(newline),
        'Content-Type: multipart/mixed; boundary="fixture"',
      ),
    );
    expect(result.email!.bodyText).toBe('Expected body');
  });

  it('preserves mixed body order and chooses equivalent text only inside alternatives', async () => {
    const result = await source(
      mime([
        'Content-Type: text/html\r\n\r\n<p>Opening</p>',
        'Content-Type: text/plain\r\n\r\nIntroduction',
        'Content-Type: multipart/alternative; boundary="alternative"\r\n\r\n' +
          '--alternative\r\nContent-Type: text/plain\r\n\r\nEquivalent text\r\n' +
          '--alternative\r\nContent-Type: text/html\r\n\r\n<p>Equivalent HTML</p><table><tr><td>00412</td></tr></table>\r\n' +
          '--alternative--',
        'Content-Type: text/html\r\n\r\n<p>Unrelated content</p>',
        'Content-Type: text/plain\r\n\r\nClosing',
      ]),
    );
    expect(result.email!.bodyText.split(/\n+/).filter(Boolean)).toEqual([
      'Opening',
      'Introduction',
      'Equivalent text',
      'Unrelated content',
      'Closing',
    ]);
    expect(result.email!.tables).toEqual([[['00412']]]);
  });

  it('retains envelope, table coordinates, attachment bytes, and an inline image', async () => {
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#000000' } })
      .png()
      .toBuffer();
    const bytes = mime([
      'Content-Type: text/html; charset=utf-8\r\n\r\n<h1>Body</h1><script>ignored()</script>' +
        '<table><tr><th>Code</th><th>Amount</th></tr><tr><td>00412</td><td>42 &amp; 0</td></tr><tr><td></td><td>End</td></tr></table>' +
        '<table><tr><td colspan="2">Label</td></tr><tr><td>A</td><td>B</td></tr></table>',
      'Content-Type: text/csv\r\nContent-Disposition: attachment; filename="part.csv"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        Buffer.from('Code,Value\n00412,0').toString('base64'),
      'Content-Type: image/png\r\nContent-Disposition: inline\r\nContent-ID: <picture>\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        image.toString('base64'),
    ]);
    const result = await source(bytes, 'wrong.bin');
    expect(result.email).toMatchObject({
      from: 'Sender <sender@example.test>',
      subject: 'Fixture email',
      date: '2026-10-11T16:00:00.000Z',
      messageId: '<fixture@example.test>',
      tables: [
        [
          ['Code', 'Amount'],
          ['00412', '42 & 0'],
          ['', 'End'],
        ],
        [
          ['Label', ''],
          ['A', 'B'],
        ],
      ],
    });
    expect(result.email!.bodyText.trimStart().startsWith('Body')).toBe(true);
    expect(result.email!.bodyText).not.toContain('ignored');
    expect(result.parts!.map((part) => [part.name, part.inline, part.contentId])).toEqual([
      ['part.csv', false, undefined],
      ['', true, 'picture'],
    ]);
    expect(Buffer.from(result.parts![0]!.bytes).toString()).toBe('Code,Value\n00412,0');
    expect(Buffer.from(result.parts![1]!.bytes)).toEqual(image);
    const attachment = await source(Buffer.from(result.parts![0]!.bytes));
    expect(attachment.sheets![0]!.rows[1]![0]).toEqual({ v: '00412', t: 'text' });
  });

  it('reads the original sender and date from a quoted forwarded header block', async () => {
    const result = await source(
      eml(
        'Forwarded message\r\n> From: Original <original@example.test>\r\n> Sent: Sat, 10 Oct 2026 08:00:00 -0700\r\n> To: Sender\r\n> Subject: Original subject\r\n> Old body',
      ),
    );
    expect(result.email).toMatchObject({
      originalFrom: 'Original <original@example.test>',
      originalDate: '2026-10-10T15:00:00.000Z',
      from: 'Sender <sender@example.test>',
      date: '2026-10-11T16:00:00.000Z',
    });
  });

  it('reads nested messages one level deep and retains deeper bytes explicitly', async () => {
    const deepest = eml('Deep body');
    const inner = mime([
      'Content-Type: text/plain\r\n\r\nInner body',
      'Content-Type: message/rfc822\r\n\r\n' + deepest.toString(),
    ]);
    const result = await source(mime(['Content-Type: message/rfc822\r\n\r\n' + inner.toString()]));
    const part = result.parts![0]!;
    expect(part.emailDepth).toBe(1);
    expect(part.source!.email!.bodyText).toBe('Inner body');
    expect(part.source!.parts![0]!.source).toBeUndefined();
    expect(part.source!.parts![0]!.emailDepth).toBe(2);
    expect(Buffer.from(part.source!.parts![0]!.bytes)).toEqual(deepest);
    expect(part.source!.warnings).toContain('ingest.extract.nestedMessage');
    expect(await extractSource('', part.source!.parts![0]!.bytes, part.source!.parts![0])).toMatchObject({
      status: 'unclaimed',
    });
  });

  it.each([12, 13])('caps nested messages at twelve with %i messages', async (count) => {
    const bytes = mime(
      Array.from(
        { length: count },
        () => 'Content-Type: message/rfc822\r\n\r\n' + eml('Nested body').toString(),
      ),
    );
    const result = await extractSource('', bytes);
    if (count === 12) {
      expect(result.status).toBe('extracted');
      if (result.status === 'extracted') expect(result.source.parts).toHaveLength(12);
    } else expect(result).toMatchObject({ status: 'failed', code: 'email-limit' });
  });

  it('decodes encoded headers, quoted-printable text, and extended attachment filenames', async () => {
    const bytes = mime([
      'Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9',
      "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=utf-8''caf%C3%A9.txt\r\n\r\nAttachment",
    ]);
    const encoded = Buffer.from(
      bytes
        .toString()
        .replace(
          'Subject: Fixture email',
          'Subject: =?UTF-8?B?' + Buffer.from('題名').toString('base64') + '?=',
        ),
    );
    const result = await source(encoded);
    expect(result.email!.subject).toBe('題名');
    expect(result.email!.bodyText).toBe('Café');
    expect(result.parts![0]!.name).toBe('café.txt');
  });
});

describe('archive guards and explicit outcomes', () => {
  it('charges expanded ZIP buffers against the worker memory budget', async () => {
    const seed = randomBytes(16 * 1024);
    const data = Buffer.concat(Array.from({ length: 3840 }, () => seed));
    const bytes = zip([{ name: 'large.bin', data, deflate: true }]);
    expect(bytes.length).toBeLessThan(LIMITS.inputBytes);
    expect(data.length / bytes.length).toBeLessThan(LIMITS.expansionRatio);
    expect(await extractSource('', bytes, { memoryMb: 48 })).toMatchObject({
      status: 'failed',
      code: 'memory-limit',
      messageKey: 'ingest.extract.memoryLimit',
    });
  });

  it('opens one level and keeps members as in-memory parts in directory order', async () => {
    const inner = zip([{ name: 'deep.txt', data: Buffer.from('Deep') }]);
    const result = await source(
      zip([
        { name: 'folder/', data: Buffer.alloc(0) },
        { name: '../label.csv', data: Buffer.from('Code,Value\n00412,0'), deflate: true },
        { name: 'nested.zip', data: inner },
      ]),
      'wrong.txt',
    );
    expect(result.parts!.map((part) => [part.name, part.archiveDepth])).toEqual([
      ['../label.csv', 1],
      ['nested.zip', 1],
    ]);
    expect(Buffer.from(result.parts![0]!.bytes).toString()).toBe('Code,Value\n00412,0');
    expect(await extractSource('nested', result.parts![1]!.bytes, result.parts![1])).toMatchObject({
      status: 'failed',
      code: 'archive-depth',
    });
    expect(await extractSource('member', result.parts![0]!.bytes, result.parts![0])).toMatchObject({
      status: 'extracted',
    });
  });

  it('refuses member-count, expansion-ratio, expanded-size, and lying-size bombs', async () => {
    const cases: Array<[Buffer, string]> = [
      [
        zip(
          Array.from({ length: LIMITS.members + 1 }, (_, index) => ({
            name: String(index),
            data: Buffer.alloc(0),
          })),
        ),
        'archive-count',
      ],
      [zip([{ name: 'ratio', data: Buffer.alloc(1000000, 65), deflate: true }]), 'archive-ratio'],
      [zip([{ name: 'size', data: Buffer.alloc(1), size: LIMITS.expandedBytes + 1 }]), 'archive-size'],
      [zip([{ name: 'lie', data: Buffer.alloc(10000, 65), deflate: true, size: 100 }]), 'archive-size'],
    ];
    for (const [bytes, code] of cases)
      expect(await extractSource('', bytes)).toMatchObject({ status: 'failed', code });
  });

  it('rejects duplicate names and corrupted member checksums', async () => {
    const duplicate = zip([
      { name: 'same', data: Buffer.from('A') },
      { name: 'same', data: Buffer.from('B') },
    ]);
    expect(await extractSource('', duplicate)).toMatchObject({ status: 'failed', code: 'invalid' });
    const corrupt = zip([{ name: 'a', data: Buffer.from('A') }]);
    corrupt[31] = 66;
    expect(await extractSource('', corrupt)).toMatchObject({ status: 'failed', code: 'invalid' });
  });

  it('returns password outcomes for encrypted ZIP, Office, and PDF containers', async () => {
    expect(
      await extractSource('', zip([{ name: 'locked', data: Buffer.from('X'), encrypted: true }])),
    ).toMatchObject({ status: 'needs-password' });
    const compound = Buffer.concat([
      Buffer.from('d0cf11e0a1b11ae1', 'hex'),
      Buffer.alloc(512),
      Buffer.from('EncryptionInfo\0EncryptedPackage', 'utf16le'),
    ]);
    expect(await extractSource('', compound)).toMatchObject({ status: 'needs-password' });
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.context.trailerInfo.Encrypt = pdf.context.register(
      pdf.context.obj({ Filter: PDFName.of('Standard') }),
    );
    expect(await extractSource('', Buffer.from(await pdf.save()))).toMatchObject({
      status: 'needs-password',
      sniffedType: 'application/pdf',
    });
  });

  it.each([
    ['Workbook', 'application/vnd.ms-excel'],
    ['__properties_version1.0', 'application/vnd.ms-outlook'],
  ])('leaves unsupported %s containers unclaimed', async (marker, type) => {
    const bytes = Buffer.concat([
      Buffer.from('d0cf11e0a1b11ae1', 'hex'),
      Buffer.alloc(512),
      Buffer.from(marker, 'utf16le'),
    ]);
    expect(await extractSource('misleading.txt', bytes)).toMatchObject({
      status: 'unclaimed',
      sniffedType: type,
    });
  });

  it.each([
    ['ID3', 'audio/mpeg'],
    ['RIFF\0\0\0\0WAVE', 'audio/wav'],
    ['fLaC', 'audio/flac'],
    ['RIFF\0\0\0\0AVI ', 'video/x-msvideo'],
    ['OggS\0theora', 'video/ogg'],
    ['\x1a\x45\xdf\xa3webm', 'video/webm'],
  ])('returns an outside-feature result for %s content', async (signature, type) => {
    expect(await extractSource('fake.csv', Buffer.from(signature, 'latin1'))).toMatchObject({
      status: 'outside-feature',
      sniffedType: type,
    });
  });

  it('falls back to readable text and explains empty, damaged, oversized, and unclaimed input', async () => {
    expect((await source(Buffer.from('<root>Readable fallback</root>'))).kind).toBe('text');
    expect(await extractSource('fake.pdf', Buffer.from([0, 1, 2, 255, 0, 255]))).toMatchObject({
      status: 'unclaimed',
      sniffedType: 'application/octet-stream',
    });
    expect(await extractSource('', Buffer.alloc(0))).toMatchObject({ status: 'empty' });
    expect(await extractSource('', Buffer.from(' \n\t '))).toMatchObject({ status: 'empty' });
    expect(await extractSource('', zip([]))).toMatchObject({ status: 'empty' });
    expect(await extractSource('', Buffer.from('%PDF-damaged'))).toMatchObject({
      status: 'failed',
      code: 'invalid',
    });
    expect(await extractSource('', Buffer.alloc(LIMITS.inputBytes + 1))).toMatchObject({
      status: 'failed',
      code: 'size-limit',
    });
  });
});

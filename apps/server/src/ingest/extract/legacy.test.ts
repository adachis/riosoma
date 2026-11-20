import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ExtractedSource } from '@riosoma/ingest';
import { extractSource } from './index.js';
import { LIMITS } from './types.js';

async function source(bytes: Buffer): Promise<ExtractedSource> {
  const result = await extractSource('misleading.txt', bytes);
  expect(result.status, JSON.stringify(result)).toBe('extracted');
  if (result.status !== 'extracted') throw new Error('ingest.extract.invalid');
  return result.source;
}

function xls(date1904 = false): Buffer {
  const book = XLSX.utils.book_new();
  book.Workbook = {
    WBProps: { date1904 },
    Sheets: [
      { name: 'Visible', Hidden: 0 },
      { name: 'Hidden', Hidden: 1 },
      { name: 'Last', Hidden: 0 },
    ],
  };
  const sheet: XLSX.WorkSheet = {
    B1: { t: 's', v: 'Group' },
    B3: { t: 's', v: 'Identifier' },
    C3: { t: 's', v: 'Amount' },
    B4: { t: 's', v: '00412' },
    C4: { t: 'n', v: 0 },
    D4: { t: 's', v: '42' },
    E4: { t: 'n', v: date1904 ? 44620 : 46082, z: 'yyyy-mm-dd' },
    F4: { t: 'b', v: true },
    // SheetJS writes a BIFF formula from its token buffer, with the deliberately different cached value.
    G4: { t: 'n', v: 42, f: '1+1', bf: Buffer.from([7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03]) },
    H4: { t: 'n', v: 412, z: '00000' },
    B6: { t: 's', v: 'Last row' },
    '!ref': 'A1:I7',
    '!merges': [{ s: { r: 0, c: 1 }, e: { r: 1, c: 1 } }],
  };
  XLSX.utils.book_append_sheet(book, sheet, 'Visible');
  XLSX.utils.book_append_sheet(book, { C2: { t: 's', v: 'secret' }, '!ref': 'A1:C2' }, 'Hidden');
  XLSX.utils.book_append_sheet(book, { B3: { t: 'n', v: 5 }, '!ref': 'A1:B3' }, 'Last');
  return XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

type Compound = ReturnType<typeof XLSX.CFB.utils.cfb_new>;
function compound(): Compound {
  return XLSX.CFB.utils.cfb_new({ root: 'Root Entry' });
}
function stream(container: Compound, path: string, bytes: Buffer) {
  XLSX.CFB.utils.cfb_add(container, path, bytes);
}
function serialize(container: Compound): Buffer {
  return Buffer.from(XLSX.CFB.write(container, { type: 'buffer' }));
}

/** MAPI properties and storages are written by the bundled compound-file writer. */
function message(container: Compound, prefix = '', body = 'Text body', messageClass = 'IPM.Note') {
  stream(container, prefix + '__properties_version1.0', Buffer.alloc(prefix ? 24 : 32));
  for (const [tag, value] of [
    ['001A001F', messageClass],
    ['0037001F', prefix ? 'Attached subject' : 'Fixture subject'],
    ['0C1A001F', 'Sender'],
    ['5D01001F', 'sender@example.test'],
    ['1035001F', '<fixture@example.test>'],
    ['1000001F', body],
  ])
    stream(container, prefix + '__substg1.0_' + tag, Buffer.from(value + '\0', 'utf16le'));
  const time = Buffer.alloc(8);
  time.writeBigUInt64LE(BigInt(Date.parse('2026-10-11T16:00:00Z') + 11644473600000) * 10000n);
  stream(container, prefix + '__substg1.0_00390040', time);
}

function attachment(
  container: Compound,
  index: number,
  bytes: Buffer,
  name: string,
  contentId = '',
  prefix = '',
) {
  const path = prefix + `__attach_version1.0_#${index.toString(16).padStart(8, '0')}/`;
  stream(container, path + '__properties_version1.0', Buffer.alloc(8));
  stream(container, path + '__substg1.0_37010102', bytes);
  stream(container, path + '__substg1.0_3707001F', Buffer.from(name + '\0', 'utf16le'));
  if (contentId) stream(container, path + '__substg1.0_3712001F', Buffer.from(contentId + '\0', 'utf16le'));
}
function embedded(container: Compound, index: number, prefix = ''): string {
  const path = prefix + `__attach_version1.0_#${index.toString(16).padStart(8, '0')}/`;
  stream(container, path + '__properties_version1.0', Buffer.alloc(8));
  stream(container, path + '__substg1.0_3001001F', Buffer.from('Attached\0', 'utf16le'));
  const inner = path + '__substg1.0_3701000D/';
  message(container, inner, 'Attached body');
  return inner;
}

describe('legacy workbook extraction', () => {
  it('ignores formatted columns, 5,000 blank rows, and the stated dimension', async () => {
    const book = XLSX.utils.book_new();
    const values = Array.from({ length: 200 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) => row * 9 + column),
    );
    const sheet = XLSX.utils.aoa_to_sheet(values);
    sheet['!cols'] = Array.from({ length: 256 }, () => ({ width: 12 }));
    for (let row = 201; row <= 5200; row++) sheet[`A${row}`] = { t: 'z', z: '0' };
    sheet['!ref'] = 'A1:IV5200';
    XLSX.utils.book_append_sheet(book, sheet, 'Formatting');
    const original = XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer;
    const container = XLSX.CFB.read(original, { type: 'buffer' });
    const data = Buffer.from(XLSX.CFB.find(container, 'Workbook')!.content);
    expect(data.readUInt32LE(data.length - 4)).toBe(0x0000000a);
    // The writer omits row formatting records, so insert generated BIFF rows before the sheet's EOF.
    const rows = Array.from({ length: 5000 }, (_, index) => {
      const record = Buffer.alloc(20);
      record.writeUInt16LE(0x0208, 0);
      record.writeUInt16LE(16, 2);
      record.writeUInt16LE(index + 200, 4);
      record.writeUInt16LE(256, 8);
      record.writeUInt16LE(300, 10);
      record.writeUInt8(0x40, 16);
      return record;
    });
    XLSX.CFB.utils.cfb_add(
      container,
      'Workbook',
      Buffer.concat([data.subarray(0, data.length - 4), ...rows, data.subarray(data.length - 4)]),
    );
    const bytes = serialize(container);
    const formatted = XLSX.read(bytes, { type: 'buffer', cellStyles: true, sheetStubs: true }).Sheets
      .Formatting!;
    expect(formatted['!cols']).toHaveLength(256);
    expect(formatted['!rows']).toHaveLength(5200);
    const result = await source(bytes);
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual(values);
  });

  it('keeps every blank coordinate between values in B2 and D7', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      {
        B2: { t: 's', v: 'First' },
        D7: { t: 's', v: 'Last' },
        '!ref': 'A1:H20',
      },
      'Positions',
    );
    const result = await source(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer);
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

  it('clips a label merge to five valued columns and drops merges outside the grid', async () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['Table'], [1, 2, 3, 4, 5]]);
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 255 } },
      { s: { r: 8, c: 6 }, e: { r: 9, c: 7 } },
    ];
    sheet['!ref'] = 'A1:IV10';
    XLSX.utils.book_append_sheet(book, sheet, 'Merges');
    const result = await source(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer);
    expect(result.sheets![0]!.rows.map((row) => row.map((item) => item.v))).toEqual([
      ['Table', null, null, null, null],
      [1, 2, 3, 4, 5],
    ]);
    expect(result.sheets![0]!.merges).toEqual([{ top: 1, left: 1, bottom: 1, right: 5 }]);
  });

  it('retains hidden states, number formats, and merges without styles or blank stubs', async () => {
    const bytes = xls();
    const book = XLSX.read(bytes, {
      type: 'buffer',
      cellStyles: false,
      sheetStubs: false,
      cellNF: true,
    });
    expect(book.Workbook!.Sheets!.map((sheet) => sheet.Hidden)).toEqual([0, 1, 0]);
    expect(book.Sheets.Visible!.E4.z).toBe('yyyy-mm-dd');
    expect(book.Sheets.Visible!.H4.z).toBe('00000');
    expect(book.Sheets.Visible!['!merges']).toEqual([{ s: { r: 0, c: 1 }, e: { r: 1, c: 1 } }]);
    expect(book.Sheets.Visible!['!cols']).toBeUndefined();
    expect(book.Sheets.Visible!['!rows']).toBeUndefined();
  });

  it.each([false, true])(
    'preserves positions, types, merges, and sheet order with date1904=%s',
    async (date1904) => {
      const bytes = xls(date1904);
      const read = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
      expect(read.Sheets.Visible!.G4).toMatchObject({ f: '1+1', v: 42 });
      const result = await source(bytes);
      expect(result.kind).toBe('workbook');
      expect(result.sheets!.map((sheet) => [sheet.name, sheet.hidden])).toEqual([
        ['Visible', false],
        ['Hidden', true],
        ['Last', false],
      ]);
      const sheet = result.sheets![0]!;
      expect(sheet.rows).toHaveLength(6);
      expect(sheet.rows.every((row) => row.length === 8)).toBe(true);
      expect(sheet.rows[0]![0]).toEqual({ t: 'empty', v: null });
      expect(sheet.rows[0]![1]).toEqual({ t: 'text', v: 'Group' });
      expect(sheet.rows[1]![1]).toEqual({ t: 'empty', v: null });
      expect(sheet.merges).toEqual([{ top: 1, left: 2, bottom: 2, right: 2 }]);
      expect(sheet.rows[2]![1]).toEqual({ t: 'text', v: 'Identifier' });
      expect(sheet.rows[2]![2]).toEqual({ t: 'text', v: 'Amount' });
      expect(sheet.rows[3]!.slice(1, 8)).toEqual([
        { t: 'text', v: '00412' },
        { t: 'number', v: 0 },
        { t: 'text', v: '42' },
        { t: 'date', v: '2026-03-01' },
        { t: 'bool', v: true },
        { t: 'number', v: 42 },
        { t: 'text', v: '00412' },
      ]);
      expect(sheet.rows[4]!.every((item) => item.t === 'empty')).toBe(true);
      expect(sheet.rows[5]![1]).toEqual({ t: 'text', v: 'Last row' });
      expect(result.sheets![1]!.rows[1]![2]).toEqual({ t: 'text', v: 'secret' });
      expect(result.sheets![2]!.rows[2]![1]).toEqual({ t: 'number', v: 5 });
    },
  );

  it('applies the total cell cap before building grids', async () => {
    const book = XLSX.utils.book_new();
    for (const name of ['First', 'Second'])
      XLSX.utils.book_append_sheet(
        book,
        {
          A1: { t: 's', v: 'First' },
          IV1000: { t: 'n', v: 0 },
          '!ref': 'A1:IV1000',
        },
        name,
      );
    expect(await extractSource('', XLSX.write(book, { type: 'buffer', bookType: 'biff8' }))).toMatchObject({
      status: 'failed',
      code: 'size-limit',
    });
  });

  it('reports a password-protected BIFF workbook', async () => {
    const container = compound();
    // A generated BIFF8 global stream declares XOR protection before any worksheet records.
    stream(
      container,
      'Workbook',
      Buffer.from('0908100000060500bb0dcc0700000000060000002f0006000000341278560a000000', 'hex'),
    );
    expect(() => XLSX.read(serialize(container), { type: 'buffer' })).toThrow(/password-protected/);
    expect(await extractSource('', serialize(container))).toMatchObject({ status: 'needs-password' });
  });
});

describe('Outlook message extraction', () => {
  it('reads envelope, body, tables, attachment bytes, inline images, and embedded messages', async () => {
    const container = compound();
    message(container);
    stream(
      container,
      '__substg1.0_10130102',
      Buffer.from('<table><tr><td>00412</td><td>0</td></tr></table><img src="cid:picture">'),
    );
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer();
    attachment(container, 0, Buffer.from('Attachment bytes'), 'part.txt');
    attachment(container, 1, image, 'image.png', 'picture');
    const inner = embedded(container, 2);
    embedded(container, 0, inner);
    const result = await source(serialize(container));
    expect(result.kind).toBe('email');
    expect(result.email).toEqual({
      from: 'Sender <sender@example.test>',
      subject: 'Fixture subject',
      date: '2026-10-11T16:00:00.000Z',
      messageId: '<fixture@example.test>',
      bodyText: 'Text body',
      tables: [[['00412', '0']]],
    });
    expect(result.parts!.map((part) => [part.name, part.inline, part.contentId])).toEqual([
      ['part.txt', false, undefined],
      ['image.png', true, 'picture'],
      ['Attached.msg', undefined, undefined],
    ]);
    expect(Buffer.from(result.parts![0]!.bytes)).toEqual(Buffer.from('Attachment bytes'));
    expect(Buffer.from(result.parts![1]!.bytes)).toEqual(image);
    const nested = result.parts![2]!;
    expect(nested.emailDepth).toBe(1);
    expect(nested.source!.email!.bodyText).toBe('Attached body');
    expect(nested.source!.parts![0]!.source).toBeUndefined();
    expect(nested.source!.parts![0]!.emailDepth).toBe(2);
    expect(nested.source!.warnings).toContain('ingest.extract.nestedMessage');
    const require = createRequire(import.meta.url);
    const Reader = require('@kenjiuno/msgreader').default;
    const bytes = Buffer.from(nested.source!.parts![0]!.bytes);
    expect(
      new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)).getFileData().body,
    ).toBe('Attached body');
    expect(await extractSource('', bytes, { emailDepth: 2 })).toMatchObject({ status: 'unclaimed' });
  });

  it('reads an attached standalone message one level deep', async () => {
    const inner = compound();
    message(inner, '', 'Standalone body');
    const outer = compound();
    message(outer);
    attachment(outer, 0, serialize(inner), 'nested.msg');
    const result = await source(serialize(outer));
    expect(result.parts![0]!.source!.email!.bodyText).toBe('Standalone body');
    expect(Buffer.from(result.parts![0]!.bytes)).toEqual(serialize(inner));
  });

  it.each([12, 13])('caps attached messages with %i messages', async (count) => {
    const container = compound();
    message(container);
    for (let index = 0; index < count; index++) embedded(container, index);
    const result = await extractSource('', serialize(container));
    if (count === LIMITS.nestedMessages) {
      expect(result.status).toBe('extracted');
      if (result.status === 'extracted') expect(result.source.parts).toHaveLength(count);
    } else expect(result).toMatchObject({ status: 'failed', code: 'email-limit' });
  });

  it.each(['IPM.Note.SMIME', 'IPM.Note.rpmsg'])('reports protection for %s', async (messageClass) => {
    const container = compound();
    message(container, '', '', messageClass);
    expect(await extractSource('', serialize(container))).toMatchObject({ status: 'needs-password' });
  });
});

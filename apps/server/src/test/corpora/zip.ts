import { crc32, deflateRawSync } from 'node:zlib';

/** Small compressed fixtures, including a directory that understates the expanded size. */
export const zipBombs = [
  { name: 'declared expansion', size: 5 * 1024 * 1024, declared: 5 * 1024 * 1024 },
  { name: 'hidden expansion', size: 5 * 1024 * 1024, declared: 1 },
] as const;

export function zip(parts: Array<{ name: string; bytes: Buffer; declared?: number }>): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const packed = deflateRawSync(part.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(part.bytes), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(part.declared ?? part.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    local.copy(central, 16, 14, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

/** A valid workbook with one inline or shared string, or repeated bounded cells. */
export function worksheetWorkbook(text: string, declared = 1, shared = false, rows = 1): Buffer {
  const worksheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: rows }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="${shared ? 's' : 'inlineStr'}">${shared ? '<v>0</v>' : `<is><t>${text}</t></is>`}</c></row>`).join('')}</sheetData></worksheet>`;
  return zip([
    {
      name: 'xl/workbook.xml',
      bytes: Buffer.from(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      bytes: Buffer.from(
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', bytes: Buffer.from(worksheet), declared },
    ...(shared
      ? [{ name: 'xl/sharedStrings.xml', bytes: Buffer.from(`<sst><si><t>${text}</t></si></sst>`), declared }]
      : []),
  ]);
}

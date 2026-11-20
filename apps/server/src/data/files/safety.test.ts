import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { FileSafetySettings } from '@riosoma/contracts';
import { zip } from '../../test/corpora/zip.js';
import { builtInFileChecks, FILE_CHECK_LIMITS, requireSafeFile } from './safety.js';

const check = (bytes: Buffer, extra = {}) => builtInFileChecks({ bytes, ...extra });
const held = (reason: string) => ({ state: 'held', reason: `files.checks.${reason}` });

it('returns safe or a typed mismatch for a sniffed type, name, and stated type', async () => {
  const bytes = Buffer.from('A synthetic note');
  expect(await check(bytes, { name: 'note.txt', statedType: 'text/plain; charset=utf-8' })).toEqual({
    state: 'safe',
    type: 'text/plain',
  });
  expect(await check(bytes, { name: 'note.png' })).toMatchObject(held('typeMismatch'));
  expect(await check(bytes, { statedType: 'application/pdf' })).toMatchObject(held('typeMismatch'));
  expect(await check(bytes, { statedType: 'application/octet-stream' })).toMatchObject({ state: 'safe' });
});

it('accepts the labels browsers and other systems give ordinary files', async () => {
  const table = Buffer.from('Title,Units\nA,1\nB,2\n');
  // Windows labels a CSV as an Excel file when Excel is installed.
  for (const statedType of ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'])
    expect(await check(table, { name: 'sales.csv', statedType })).toEqual({
      state: 'safe',
      type: 'text/plain',
    });
  const notes = Buffer.from('# Setup\n\nBring the data in from the Sales sheet first.\n');
  expect(await check(notes, { name: 'notes.md', statedType: 'text/markdown' })).toMatchObject({
    state: 'safe',
  });
  expect(
    await check(Buffer.from('{"a":1}'), { name: 'data.json', statedType: 'application/json' }),
  ).toMatchObject({
    state: 'safe',
  });
  const picture = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(16)]);
  for (const statedType of ['image/jpeg', 'image/jpg', 'image/pjpeg'])
    expect(await check(picture, { name: 'photo.jpg', statedType })).toMatchObject({
      state: 'safe',
      type: 'image/jpeg',
    });
  expect(
    await check(Buffer.from('<?xml version="1.0"?><rows><row/></rows>'), { statedType: 'application/xml' }),
  ).toMatchObject({ state: 'safe' });
  // A label for a different kind of file is still a mismatch, in either direction.
  expect(await check(picture, { name: 'photo.txt' })).toMatchObject(held('typeMismatch'));
  expect(await check(picture, { statedType: 'text/csv' })).toMatchObject(held('typeMismatch'));
  expect(await check(table, { statedType: 'image/jpeg' })).toMatchObject(held('typeMismatch'));
  expect(await check(Buffer.alloc(64, 0x9c), { statedType: 'text/html' })).toMatchObject(
    held('typeMismatch'),
  );
});

it('notes the scripts in a web page without holding it, and leaves a plain page unmarked', async () => {
  const page = (body: string) =>
    Buffer.from(`<!DOCTYPE html>\n<html><head><title>Handbook</title></head><body>${body}</body></html>`);
  for (const body of [
    '<script src="analytics.js"></script>',
    '<p onclick="go()">Welcome</p>',
    '<a href="javascript:go()">Go</a>',
  ])
    expect(await check(page(body), { name: 'handbook.html', statedType: 'text/html' })).toEqual({
      state: 'noted',
      type: 'text/html',
      notes: ['files.checks.htmlActiveContent'],
    });
  expect(await check(page('<p>Welcome</p>'), { name: 'handbook.html' })).toEqual({
    state: 'safe',
    type: 'text/html',
  });
  // A page gains no cover from its name: a script file called a page is still held.
  expect(await check(Buffer.from('#!/bin/sh\necho test'), { name: 'handbook.html' })).toMatchObject(
    held('executable'),
  );
});

it.each(['4d5a', '7f454c46', 'feedfacf', 'cffaedfe', 'cafebabe', '0061736d'])(
  'holds executable magic %s regardless of its name',
  async (magic) => {
    expect(
      await check(Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(32)]), { name: 'note.txt' }),
    ).toMatchObject(held('executable'));
  },
);

it.each([
  '#!/bin/sh\necho test',
  '<?php echo 1;',
  '@echo off\necho test',
  'function run() { return 1; }',
  'def run():\n  return 1',
  '<script>alert(1)</script>',
])('holds script content without trusting its extension: %s', async (script) => {
  expect(await check(Buffer.from(script), { name: 'note.txt' })).toMatchObject(held('executable'));
});

it.each([
  '// A leading comment\nfunction run() { return 1; }',
  '/* A leading comment */\nfunction run() { return 1; }',
  '\uFEFF /* First */\n// Second\nfunction run() { return 1; }',
  '# A leading comment\ndef run():\n  return 1',
  '<!-- A leading comment -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>',
  '<?xml version="1.0"?><!-- A leading comment --><svg onload="run()"/>',
])('holds scripts and active SVG after legal leading comments: %s', async (script) => {
  expect(await check(Buffer.from(script))).toMatchObject(held('executable'));
  if (script.includes('<svg'))
    expect(await check(Buffer.from(script), { name: 'drawing.svg' })).toMatchObject(held('executable'));
});

it('allows an SVG with leading comments and no active content', async () => {
  expect(
    await check(Buffer.from('<!-- A drawing --><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), {
      name: 'drawing.svg',
    }),
  ).toMatchObject({ state: 'safe', type: 'image/svg+xml' });
});

it('holds detected SVG script elements with legal namespace prefixes', async () => {
  const prefix = String.fromCodePoint(0x3a9);
  const bytes = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:${prefix}="http://www.w3.org/2000/svg"><${prefix}:script>run()</${prefix}:script></svg>`,
  );
  expect(await check(bytes, { name: 'drawing.svg' })).toMatchObject(held('executable'));
});

it.each(['block', 'line'] as const)(
  'finds scripts after a %s comment longer than the sniff window',
  async (kind) => {
    const comment = kind === 'block' ? `/*${'A'.repeat(65536)}*/` : `//${'A'.repeat(65536)}`;
    expect(await check(Buffer.from(`${comment}\nfunction run() { return 1; }`))).toMatchObject(
      held('executable'),
    );
  },
);

it.each(['word', 'xl', 'ppt'])(
  'holds outside Office macros in %s and lets an admin allow them',
  async (part) => {
    const bytes = zip([{ name: `${part}/vbaProject.bin`, bytes: Buffer.from('synthetic macro contents') }]);
    expect(await check(bytes, { origin: 'outside' })).toMatchObject(held('macros'));
    for (const [origin, settings] of [
      ['organization', FileSafetySettings.parse({})],
      ['outside', FileSafetySettings.parse({ allowOutsideMacros: true })],
    ] as const) {
      expect(await builtInFileChecks({ bytes, origin }, settings)).toMatchObject({
        state: 'noted',
        notes: ['files.checks.macrosAllowed'],
      });
    }
  },
);

it.each(['content type', 'relationship', 'both'])(
  'finds a macro sheet at a worksheet path from its %s',
  async (marker) => {
    const bytes = zip([
      {
        name: '[Content_Types].xml',
        bytes: Buffer.from(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.ms-excel.${marker === 'relationship' ? 'worksheet' : 'macrosheet'}+xml"/></Types>`,
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        bytes: Buffer.from(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/${marker === 'content type' ? 'worksheet' : 'xlMacrosheet'}" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        bytes: Buffer.from(
          '<macrosheet xmlns="http://schemas.microsoft.com/office/excel/2006/main"><sheetData/></macrosheet>',
        ),
      },
    ]);
    expect(await check(bytes, { origin: 'outside', name: 'outside.xlsx' })).toMatchObject(held('macros'));
    expect(
      await builtInFileChecks(
        { bytes, origin: 'outside', name: 'outside.xlsx' },
        FileSafetySettings.parse({ allowOutsideMacros: true }),
      ),
    ).toMatchObject({ state: 'noted', notes: ['files.checks.macrosAllowed'] });
  },
);

it.each([
  ['application/vnd.ms-office.vbaProject', 'application.bin'],
  ['application/vnd.ms-excel.intlmacrosheet+xml', 'international.xml'],
])('finds renamed Office macro parts declared as %s', async (contentType, name) => {
  const bytes = zip([
    {
      name: '[Content_Types].xml',
      bytes: Buffer.from(
        `<Types><Default Extension="${name.split('.').at(-1)}" ContentType="${contentType}"/></Types>`,
      ),
    },
    { name: `xl/${name}`, bytes: Buffer.from('synthetic macro contents') },
  ]);
  expect(await check(bytes, { origin: 'outside' })).toMatchObject(held('macros'));
});

it.each(['namespace prefixes', 'numeric references'] as const)(
  'finds Office macro declarations with legal %s',
  async (form) => {
    const prefix = form === 'namespace prefixes' ? `${String.fromCodePoint(0x3a9)}:` : '';
    const namespace = (uri: string) => `xmlns${prefix ? `:${prefix.slice(0, -1)}` : ''}="${uri}"`;
    const attribute = (value: string) =>
      form === 'numeric references' ? value.replace(/a/gi, `&#${'0'.repeat(12)}97;`) : value;
    const bytes = zip([
      {
        name: '[Content_Types].xml',
        bytes: Buffer.from(
          `<${prefix}Types ${namespace('http://schemas.openxmlformats.org/package/2006/content-types')}><${prefix}Override PartName="/xl/worksheets/sheet1.xml" ContentType="${attribute('application/vnd.ms-excel.macrosheet+xml')}"/></${prefix}Types>`,
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        bytes: Buffer.from(
          `<${prefix}Relationships ${namespace('http://schemas.openxmlformats.org/package/2006/relationships')}><${prefix}Relationship Id="rId1" Type="${attribute('http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet')}" Target="worksheets/sheet1.xml"/></${prefix}Relationships>`,
        ),
      },
      {
        name: 'xl/workbook.xml',
        bytes: Buffer.from('<workbook><sheets><sheet name="Notes" sheetId="1"/></sheets></workbook>'),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        bytes: Buffer.from(
          '<macrosheet xmlns="http://schemas.microsoft.com/office/excel/2006/main"><sheetData/></macrosheet>',
        ),
      },
    ]);
    expect(await check(bytes, { origin: 'outside' })).toMatchObject(held('macros'));
  },
);

it('finds legacy Office macros and encrypted Office containers by content', async () => {
  const compound = (name: string) =>
    Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from(`${name}\0`, 'utf16le')]);
  expect(await check(compound('VBA'), { origin: 'outside' })).toMatchObject(held('macros'));
  expect(await check(compound('EncryptedPackage'))).toMatchObject(held('passwordProtected'));
  const word = Buffer.alloc(1024);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(word);
  Buffer.from('WordDocument\0', 'utf16le').copy(word, 128);
  word.writeUInt16LE(0xa5ec, 512);
  word.writeUInt16LE(0x100, 522);
  word.writeUInt16LE(0x00bf, 524);
  expect(await check(word)).toMatchObject(held('passwordProtected'));
  const excel = Buffer.alloc(1024);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(excel);
  Buffer.from('Workbook\0', 'utf16le').copy(excel, 128);
  excel.writeUInt16LE(0x002f, 512);
  excel.writeUInt16LE(6, 514);
  expect(await check(excel)).toMatchObject(held('passwordProtected'));
});

it('reports encrypted ZIP members, including a local encryption flag', async () => {
  for (const localOnly of [false, true]) {
    const bytes = zip([{ name: 'note.txt', bytes: Buffer.from('a note') }]);
    if (localOnly) bytes.writeUInt16LE(1, 6);
    else bytes.writeUInt16LE(1, bytes.indexOf(Buffer.from('504b0102', 'hex')) + 8);
    expect(await check(bytes)).toMatchObject(held('passwordProtected'));
  }
});

it('reports password-protected PDF documents', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  expect(await check(Buffer.from(await pdf.save()))).toMatchObject(held('passwordProtected'));
});

it('notes PDF active content in compressed objects without blocking it', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.catalog.set(
    PDFName.of('OpenAction'),
    pdf.context.register(pdf.context.obj({ S: 'JavaScript', JS: 'synthetic script' })),
  );
  expect(await check(Buffer.from(await pdf.save({ useObjectStreams: true })))).toMatchObject({
    state: 'noted',
    notes: ['files.checks.pdfActiveContent'],
  });
  const plain = await PDFDocument.create();
  plain.addPage();
  expect(await check(Buffer.from(await plain.save()))).toMatchObject({ state: 'safe' });
});

it('holds a small PDF whose object stream expands past the file check budget', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.context.register(
    pdf.context.flateStream(
      Buffer.concat([Buffer.from('100 0 <<>>'), Buffer.alloc(FILE_CHECK_LIMITS.expandedBytes + 1, 32)]),
      { Type: 'ObjStm', N: 1, First: 6 },
    ),
  );
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  expect(bytes.length).toBeLessThan(100 * 1024);
  expect(await check(bytes)).toMatchObject(held('inspectionLimit'));
});

it('holds cumulative decoded PDF object streams within individual stream limits', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  for (let index = 0; index < 6; index++) {
    pdf.context.register(
      pdf.context.flateStream(
        Buffer.concat([Buffer.from(`${100 + index} 0 <<>>`), Buffer.alloc(3 * 1024 * 1024, 32)]),
        { Type: 'ObjStm', N: 1, First: 6 },
      ),
    );
  }
  expect(await check(Buffer.from(await pdf.save({ useObjectStreams: false })))).toMatchObject(
    held('inspectionLimit'),
  );
});

it('holds excessive archive ratios even when declared sizes lie', async () => {
  for (const declared of [undefined, 1]) {
    expect(
      await check(zip([{ name: 'note.txt', bytes: Buffer.alloc(1024 * 1024, 65), declared }])),
    ).toMatchObject(held('archiveRatio'));
  }
  expect(await check(gzipSync(Buffer.alloc(1024 * 1024, 65)))).toMatchObject(held('archiveRatio'));
  const small = { name: 'first.txt', bytes: Buffer.from('a synthetic note'), declared: 1 };
  expect(await check(zip([small]))).toMatchObject(held('unreadable'));
  expect(
    await check(zip([small, { name: 'second.txt', bytes: Buffer.alloc(1024 * 1024, 65), declared: 1 }])),
  ).toMatchObject(held('archiveRatio'));
});

it('checks TAR and GZIP contents, including nested files and malformed TAR headers', async () => {
  const tar = (contents: Buffer) => {
    const header = Buffer.alloc(512);
    header.write('note.txt');
    header.write(contents.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header.write('ustar', 257);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0'),
      148,
    );
    header[154] = 0;
    return Buffer.concat([
      header,
      contents,
      Buffer.alloc((512 - (contents.length % 512)) % 512),
      Buffer.alloc(1024),
    ]);
  };
  expect(await check(tar(Buffer.from('a synthetic note')))).toMatchObject({ state: 'safe' });
  expect(await check(gzipSync(Buffer.from('a synthetic note')))).toMatchObject({ state: 'safe' });
  expect(await check(gzipSync(tar(Buffer.from('#!/bin/sh\necho test'))))).toMatchObject(held('executable'));
  const invalid = tar(Buffer.from('a synthetic note'));
  invalid[0] = 0;
  expect(await check(invalid)).toMatchObject(held('unreadable'));
});

function v7Tar(parts: Array<{ name: string; bytes: Buffer }>) {
  const blocks: Buffer[] = [];
  for (const part of parts) {
    const header = Buffer.alloc(512);
    header.write(part.name);
    header.write('0000644\0', 100);
    header.write(part.bytes.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0'),
      148,
    );
    header[154] = 0;
    blocks.push(header, part.bytes, Buffer.alloc((512 - (part.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

it('checks checksum-valid V7 TAR members directly and inside GZIP', async () => {
  const safe = v7Tar([{ name: 'note.txt', bytes: Buffer.from('a synthetic note') }]);
  expect(await check(safe, { name: 'outside.tar' })).toMatchObject({
    state: 'safe',
    type: 'application/x-tar',
  });
  const script = v7Tar([{ name: 'run.sh', bytes: Buffer.from('#!/bin/sh\necho test') }]);
  expect(await check(script)).toMatchObject(held('executable'));
  expect(await check(gzipSync(script), { name: 'outside.tgz' })).toMatchObject(held('executable'));
});

it('checks V7 TAR archives with historical signed checksums', async () => {
  const bytes = v7Tar([{ name: 'run.sh', bytes: Buffer.from('#!/bin/sh\necho test') }]);
  const header = bytes.subarray(0, 512);
  header[0] = 0xe9;
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + (byte > 127 ? byte - 256 : byte), 0)
      .toString(8)
      .padStart(6, '0'),
    148,
  );
  header[154] = 0;
  expect(await check(bytes)).toMatchObject(held('executable'));
  expect(await check(gzipSync(bytes))).toMatchObject(held('executable'));
});

it('applies member and nesting bounds to V7 TAR archives', async () => {
  expect(
    await check(
      v7Tar(
        Array.from({ length: FILE_CHECK_LIMITS.members + 1 }, (_, index) => ({
          name: `${index}.txt`,
          bytes: Buffer.alloc(0),
        })),
      ),
    ),
  ).toMatchObject(held('archiveMembers'));
  let bytes = v7Tar([{ name: 'note.txt', bytes: Buffer.from('a note') }]);
  for (let depth = 0; depth < FILE_CHECK_LIMITS.nestingDepth; depth++)
    bytes = v7Tar([{ name: 'nested.tar', bytes }]);
  expect(await check(bytes)).toMatchObject(held('archiveDepth'));
});

it('holds excessive member counts, including counts spread across nested archives', async () => {
  const members = (count: number) =>
    zip(Array.from({ length: count }, (_, index) => ({ name: `${index}.txt`, bytes: Buffer.from('note') })));
  expect(await check(members(FILE_CHECK_LIMITS.members + 1))).toMatchObject(held('archiveMembers'));
  expect(
    await check(
      zip([
        { name: 'one.zip', bytes: members(500) },
        { name: 'two.zip', bytes: members(500) },
      ]),
    ),
  ).toMatchObject(held('archiveMembers'));
});

it('holds excessive nesting based on content and checks executable members', async () => {
  let bytes = zip([{ name: 'note.txt', bytes: Buffer.from('note') }]);
  for (let depth = 1; depth < FILE_CHECK_LIMITS.nestingDepth; depth++)
    bytes = zip([{ name: 'hidden.bin', bytes }]);
  expect(await check(bytes)).toMatchObject({ state: 'safe' });
  expect(await check(zip([{ name: 'hidden.bin', bytes }]))).toMatchObject(held('archiveDepth'));
  expect(
    await check(zip([{ name: 'hidden.bin', bytes: Buffer.from('#!/bin/sh\necho test') }])),
  ).toMatchObject(held('executable'));
});

it('holds declared and cumulative expanded sizes beyond the bound', async () => {
  expect(
    await check(
      zip([{ name: 'note', bytes: Buffer.from('note'), declared: FILE_CHECK_LIMITS.expandedBytes + 1 }]),
    ),
  ).toMatchObject(held('archiveSize'));
  const part = randomBytes(FILE_CHECK_LIMITS.expandedBytes / 2 + 1);
  expect(
    await check(
      zip([
        { name: 'first', bytes: part },
        { name: 'second', bytes: part },
      ]),
    ),
  ).toMatchObject(held('archiveSize'));
});

it('holds malformed or unsupported containers instead of approving unchecked expansion', async () => {
  expect(await check(Buffer.from('504b0304', 'hex'))).toMatchObject(held('unreadable'));
  for (const magic of ['526172211a0700', '377abcaf271c'])
    expect(await check(Buffer.from(magic, 'hex'))).toMatchObject(held('archiveUnsupported'));
});

it('maps held results to caller errors and allows notes', () => {
  expect(() =>
    requireSafeFile({ state: 'held', type: 'text/plain', reason: 'files.checks.scannerUnavailable' }),
  ).toThrow('files.checks.scannerUnavailable');
  expect(() =>
    requireSafeFile(
      { state: 'held', type: 'text/plain', reason: 'files.checks.infected' },
      { infected: 'libraries.infected' },
    ),
  ).toThrow('libraries.infected');
  expect(() =>
    requireSafeFile({ state: 'noted', type: 'application/pdf', notes: ['files.checks.pdfActiveContent'] }),
  ).not.toThrow();
  expect(() =>
    requireSafeFile(
      { state: 'held', type: 'application/pdf', reason: 'files.checks.passwordProtected' },
      { invalid: 'import.document.invalid' },
    ),
  ).toThrow('files.checks.passwordProtected');
});

it('preserves a caller invalid-file error for document inspection limits', () => {
  expect(() =>
    requireSafeFile(
      { state: 'held', type: 'application/pdf', reason: 'files.checks.inspectionLimit' },
      { invalid: 'import.document.invalid', tooLarge: { key: 'import.document.tooLarge' } },
    ),
  ).toThrow('import.document.invalid');
});

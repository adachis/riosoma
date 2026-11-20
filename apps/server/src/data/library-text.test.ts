import { expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { chunkLibraryText, extractLibraryText, prepareLibraryText } from './library-text.js';

it('preserves heading paths and bounds passages without losing long paragraphs', () => {
  const text = 'A'.repeat(9000);
  const chunks = chunkLibraryText(`# Policy\n## Members\n${text}\n## Staff\nAsk a manager`);
  expect(chunks.slice(0, -1).every((chunk) => chunk.section === 'Policy / Members')).toBe(true);
  expect(chunks.every((chunk) => chunk.text.length <= 3000)).toBe(true);
  expect(
    chunks
      .slice(0, -1)
      .map((chunk) => chunk.text)
      .join(''),
  ).toBe(text);
  expect(chunks.at(-1)?.section).toBe('Policy / Staff');
  const unicode = '🍎'.repeat(3001);
  expect(
    chunkLibraryText(unicode)
      .map((chunk) => chunk.text.replaceAll('\n', ''))
      .join(''),
  ).toBe(unicode);
});
it('extracts HTML headings and entities without scripts or styles', async () => {
  const text = await extractLibraryText(
    'guide.html',
    Buffer.from(
      '<style>hidden</style><h1>Members &amp; guests</h1><p>Welcome &#x1F34E;</p><script>hidden()</script>',
    ),
  );
  expect(chunkLibraryText(text)).toEqual([{ section: 'Members & guests', text: 'Welcome 🍎', value: null }]);
});
it('reads Word paragraphs with heading styles', async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Policy', heading: HeadingLevel.HEADING_1 }),
            new Paragraph('Call customers members'),
          ],
        },
      ],
    }),
  );
  expect(chunkLibraryText(await extractLibraryText('policy.docx', bytes))).toEqual([
    { section: 'Policy', text: 'Call customers members', value: null },
  ]);
});
it('reads text-based PDFs without running actions', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText('Orchard harvest', { font });
  expect(await extractLibraryText('guide.pdf', Buffer.from(await document.save()))).toContain(
    'Orchard harvest',
  );
});
it('keeps consecutive PDF glyph operators in their words and respects line movements', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage();
  page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font.ref } }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(
      document.context.flateStream(
        'BT /F1 12 Tf 16 TL 1 0 0 1 20 700 Tm (R) Tj 8 0 Td (e) Tj 6 0 Td (try order) Tj ' +
          '0 -16 Td (Next) Tj ( paragraph) Tj T* (Third line) Tj ET',
      ),
    ),
  );
  expect(await extractLibraryText('report.pdf', Buffer.from(await document.save()))).toBe(
    'Retry order\nNext paragraph\nThird line',
  );
});
it.each([
  ['relative columns', '(Customer) Tj 250 0 Td (Amount) Tj', 'Customer Amount'],
  ['backward columns', '(Amount) Tj -250 0 Td (Customer) Tj', 'Amount Customer'],
  ['backward glyph runs', '(tomer) Tj -21.336 0 Td (Cus) Tj', 'tomerCus'],
  ['relative words', '(Customer) Tj 55 0 Td (Amount) Tj', 'Customer Amount'],
  ['leading and columns', '(Customer) Tj 250 0 TD (Amount) Tj', 'Customer Amount'],
  ['array word gaps', '[(Customer) -500 (Amount)] TJ', 'Customer Amount'],
  ['array kerning', '[(Cus) 15 (tomer)] TJ', 'Customer'],
  ['absolute columns', '(Customer) Tj 1 0 0 1 270 700 Tm (Amount) Tj', 'Customer Amount'],
  ['absolute glyph runs', '(Cus) Tj 1 0 0 1 41.336 700 Tm (tomer) Tj', 'Customer'],
  ['continued text before a gap', '(Cus) Tj (tomer) Tj 55 0 Td (Amount) Tj', 'Customer Amount'],
  ['existing whitespace', '(Customer ) Tj 250 0 Td (Amount) Tj', 'Customer Amount'],
  ['horizontal scaling', '50 Tz (Customer) Tj 28 0 Td (Amount) Tj', 'Customer Amount'],
  ['character spacing', '2 Tc (Cus) Tj 27.336 0 Td (tomer) Tj', 'Customer'],
  ['absolute line movements', '(Customer) Tj 1 0 0 1 20 680 Tm (Amount) Tj', 'Customer\nAmount'],
  [
    'rotated text',
    '0 1 -1 0 20 700 Tm (Cus) Tj 21.336 0 Td (tomer) Tj 80 0 Td (Amount) Tj',
    'Customer Amount',
  ],
])('preserves PDF word boundaries across %s', async (_kind, content, expected) => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage();
  page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font.ref } }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.flateStream(`BT /F1 12 Tf 1 0 0 1 20 700 Tm ${content} ET`)),
  );
  expect(await extractLibraryText('columns.pdf', Buffer.from(await document.save()))).toBe(expected);
});
it.each(['simple', 'composite'])('uses %s font widths to separate PDF words', async (kind) => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const mapping = document.context.register(
    document.context.flateStream(
      '4 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> <0004> <0044> endbfchar',
    ),
  );
  const font = document.context.register(
    document.context.obj(
      kind === 'simple'
        ? { Type: 'Font', Subtype: 'TrueType', FirstChar: 65, Widths: [250, 750, 500, 500] }
        : {
            Type: 'Font',
            Subtype: 'Type0',
            ToUnicode: mapping,
            DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', W: [1, [250, 750], 3, 4, 500] }],
          },
    ),
  );
  page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font } }));
  const glyph = (code: number) =>
    kind === 'simple' ? `(${String.fromCharCode(64 + code)})` : `<000${code}>`;
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(
      document.context.flateStream(
        `BT /F1 12 Tf 1 0 0 1 20 700 Tm ${glyph(1)} Tj 3 0 Td ${glyph(2)} Tj ` +
          `1 0 0 1 32 700 Tm ${glyph(3)} Tj 1 0 0 1 41 700 Tm ${glyph(4)} Tj ET`,
      ),
    ),
  );
  expect(await extractLibraryText('widths.pdf', Buffer.from(await document.save()))).toBe('ABC D');
});
it('retains the extraction budget for long Unicode PDF text', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const mapping = document.context.register(
    document.context.flateStream('1 beginbfchar <0001> <0041> endbfchar'),
  );
  const font = document.context.register(
    document.context.obj({ Type: 'Font', Subtype: 'Type0', ToUnicode: mapping }),
  );
  page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font } }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.flateStream(`BT /F1 12 Tf <${'0001'.repeat(130_000)}> Tj ET`)),
  );
  expect(await extractLibraryText('long.pdf', Buffer.from(await document.save()))).toBe('A'.repeat(130_000));
});
it('rejects unsupported files, invalid containers, and empty image-only PDFs', async () => {
  await expect(extractLibraryText('guide.exe', Buffer.from('text'))).rejects.toMatchObject({
    messageKey: 'libraries.unreadable',
  });
  await expect(extractLibraryText('guide.docx', Buffer.alloc(25))).rejects.toMatchObject({
    messageKey: 'libraries.unreadable',
  });
  const document = await PDFDocument.create();
  document.addPage();
  await expect(extractLibraryText('guide.pdf', Buffer.from(await document.save()))).rejects.toMatchObject({
    messageKey: 'libraries.unreadable',
  });
});

it('decodes embedded Unicode maps and rejects unbounded character ranges', async () => {
  async function source(mapping: string, encoded = '00010002') {
    const document = await PDFDocument.create();
    const page = document.addPage();
    const map = document.context.register(document.context.flateStream(mapping));
    const font = document.context.register(
      document.context.obj({ Type: 'Font', Subtype: 'Type0', ToUnicode: map }),
    );
    page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { F1: font } }));
    page.node.set(
      PDFName.of('Contents'),
      document.context.register(document.context.flateStream(`BT /F1 12 Tf <${encoded}> Tj ET`)),
    );
    return Buffer.from(await document.save());
  }
  expect(
    await extractLibraryText(
      'guide.pdf',
      await source('2 beginbfchar <0001> <0041> <0002> <D83CDF4E> endbfchar'),
    ),
  ).toBe('A🍎');
  expect(
    await extractLibraryText(
      'guide.pdf',
      await source('1 beginbfrange <0001> <000F> <0041> endbfrange', '000a000b'),
    ),
  ).toBe('JK');
  const huge = 'F'.repeat(1000);
  await expect(
    extractLibraryText('guide.pdf', await source(`1 beginbfrange <${huge}> <${huge}> <0041> endbfrange`)),
  ).rejects.toMatchObject({ messageKey: 'libraries.unreadable' });
});

it('keeps malformed markup extraction off the request thread', async () => {
  let ticked = false;
  const tick = new Promise<void>((resolve) =>
    setImmediate(() => {
      ticked = true;
      resolve();
    }),
  );
  const result = extractLibraryText('guide.html', Buffer.from('<!--'.repeat(20000))).catch(() => null);
  await result;
  expect(ticked).toBe(true);
  await tick;
});

it.each(['ObjStm', 'XRef'])('bounds decoded PDF %s streams before loading the document', async (type) => {
  const document = await PDFDocument.create();
  document.addPage().drawText('Orchard policy');
  document.context.register(
    document.context.flateStream(' '.repeat(5 * 1024 * 1024), {
      Type: type,
      N: 0,
      First: 0,
      Size: 0,
      W: [1, 2, 1],
      Index: [0, 0],
    }),
  );
  await expect(
    extractLibraryText('guide.pdf', Buffer.from(await document.save({ useObjectStreams: false }))),
  ).rejects.toMatchObject({ messageKey: 'libraries.limit' });
});

it('bounds total decoded PDF content even when individual streams fit', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  page.drawText('Orchard policy');
  for (let index = 0; index < 6; index++)
    page.node.addContentStream(
      document.context.register(document.context.flateStream(' '.repeat(3 * 1024 * 1024))),
    );
  await expect(extractLibraryText('guide.pdf', Buffer.from(await document.save()))).rejects.toMatchObject({
    messageKey: 'libraries.limit',
  });
});

it('bounds repeated PDF references without repeatedly decoding shared contents', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const stream = document.context.register(
    document.context.flateStream('%' + 'x'.repeat(1024 * 1024) + '\nBT (Orchard) Tj ET'),
  );
  for (let index = 0; index < 20; index++) page.node.addContentStream(stream);
  expect(
    (await extractLibraryText('guide.pdf', Buffer.from(await document.save()))).split('Orchard'),
  ).toHaveLength(21);
  for (let index = 0; index < 20; index++) page.node.addContentStream(stream);
  await expect(extractLibraryText('guide.pdf', Buffer.from(await document.save()))).rejects.toMatchObject({
    messageKey: 'libraries.limit',
  });
});

it('retains support for bounded ASCII hexadecimal PDF streams', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const stream = document.context.stream(Buffer.from('BT (Orchard) Tj ET').toString('hex') + '>', {
    Filter: 'ASCIIHexDecode',
  });
  page.node.addContentStream(document.context.register(stream));
  expect(await extractLibraryText('guide.pdf', Buffer.from(await document.save()))).toBe('Orchard');
});

it.each(['BT '.repeat(20000), '/'.repeat(80000), '('.repeat(80000)])(
  'bounds malformed PDF text operators',
  async (source) => {
    const document = await PDFDocument.create();
    document.addPage().node.addContentStream(document.context.register(document.context.flateStream(source)));
    await expect(extractLibraryText('guide.pdf', Buffer.from(await document.save()))).rejects.toMatchObject({
      messageKey: 'libraries.unreadable',
    });
  },
);

it.each([80000, 500000])('scans hostile headings with %i characters in linear time', (size) => {
  for (const separator of ['\u2028', '\u2029']) {
    for (const whitespace of [' ', '\t', '\u00a0']) {
      const started = performance.now();
      const chunks = chunkLibraryText('#' + whitespace.repeat(size - 8) + separator + '\nbody');
      expect(chunks.map((chunk) => chunk.text).join('')).toContain('body');
      expect(performance.now() - started).toBeLessThan(1000);
    }
  }
});

it('merges tiny sections and caps document chunks while keeping their headings and text', () => {
  const chunks = chunkLibraryText('# a\nb\n'.repeat(83333));
  expect(chunks.length).toBeLessThanOrEqual(500);
  expect(chunks.every((chunk) => chunk.text.length <= 3000)).toBe(true);
  expect(chunks.map((chunk) => chunk.text).join('')).toContain('a');
  expect(
    chunks
      .map((chunk) => chunk.text)
      .join('')
      .match(/b/g),
  ).toHaveLength(83333);
});

it('waits for a worker for a small burst of extractions', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => extractLibraryText('guide.txt', Buffer.from('Orchard'))),
  );
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
});

it('reports an extraction budget as a limit', async () => {
  await expect(extractLibraryText('guide.txt', Buffer.from('a'.repeat(1001)), 1000)).rejects.toMatchObject({
    messageKey: 'libraries.limit',
  });
});

it('bounds each person’s waiting uploads while admitting another person', async () => {
  const uploads = Array.from({ length: 4 }, () =>
    prepareLibraryText('guide.txt', Buffer.from('Orchard'), 1000, 'first'),
  );
  await expect(prepareLibraryText('guide.txt', Buffer.from('Orchard'), 1000, 'first')).rejects.toMatchObject({
    messageKey: 'libraries.limit',
  });
  expect((await prepareLibraryText('guide.txt', Buffer.from('Pear'), 1000, 'second')).text).toBe('Pear');
  expect(await Promise.all(uploads)).toHaveLength(4);
});

it('releases a canceled waiting upload before starting a worker', async () => {
  const active = prepareLibraryText('guide.txt', Buffer.from('Orchard'), 1000, 'first');
  const controller = new AbortController();
  const pending = prepareLibraryText('guide.txt', Buffer.from('Pear'), 1000, 'first', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect((await active).text).toBe('Orchard');
  expect((await prepareLibraryText('guide.txt', Buffer.from('Apple'), 1000, 'first')).text).toBe('Apple');
});

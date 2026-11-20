import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { extractAddon } from '../../drivers/archive.js';
import { zip, zipBombs, worksheetWorkbook } from '../../test/corpora/zip.js';
import { detectType, disposition } from '../files/detect.js';
import { extractLibraryText } from '../library-text.js';
import { unpack } from '../organization-archives/container.js';
import { readSpreadsheet } from './spreadsheet.js';
import { entryBytes, zipEntries, ZipTooLarge } from './zip.js';

describe('shared archive expansion corpus', () => {
  it.each(zipBombs)(
    'bounds $name in imports, libraries, uploads, and archives',
    async ({ size, declared }) => {
      const bytes = zip([{ name: 'word/document.xml', bytes: Buffer.alloc(size, 32), declared }]);
      const entry = zipEntries(bytes).get('word/document.xml')!;
      expect(() => entryBytes(bytes, entry, 1024)).toThrow(ZipTooLarge);
      await expect(extractLibraryText('bomb.docx', bytes)).rejects.toMatchObject({
        messageKey: 'libraries.limit',
      });
      // Upload sniffing never expands the archive, and serving it cannot execute Office markup.
      const type = detectType(bytes);
      expect(type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(disposition(type, 'bomb.docx')).toMatch(/^attachment;/);
      const directory = await mkdtemp(join(tmpdir(), 'rio-corpus-'));
      try {
        const source = join(directory, 'source.zip');
        const target = join(directory, 'addon.node');
        await writeFile(source, bytes);
        await expect(
          extractAddon(source, entry.name, '0'.repeat(64), Math.min(declared, 1024), target),
        ).rejects.toMatchObject({
          messageKey: 'sources.drivers.archiveInvalid',
        });
        await expect(unpack(Readable.from([bytes]), 999, directory)).rejects.toMatchObject({
          messageKey: 'organizationArchive.invalid',
        });
        expect(await readdir(directory)).toEqual(['source.zip']);
        expect(await readFile(source)).toEqual(bytes);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(zipBombs)('bounds workbook $name even when its directory lies', async ({ declared }) => {
    const bytes = zip([{ name: 'xl/workbook.xml', bytes: Buffer.alloc(17 * 1024 * 1024, 32), declared }]);
    const read = async () => {
      for await (const event of readSpreadsheet(bytes)) void event;
    };
    await expect(read()).rejects.toMatchObject({
      code: 'payload_too_large',
      messageKey: 'import.spreadsheet.tooLarge',
    });
  });

  it.each([
    { name: 'inline cell', bytes: () => worksheetWorkbook('x'.repeat(17 * 1024 * 1024)) },
    { name: 'shared cell', bytes: () => worksheetWorkbook('x'.repeat(1_000_001), 1, true) },
    {
      name: 'shared response expansion',
      bytes: () => worksheetWorkbook('x'.repeat(1_000_000), 1, true, 300),
    },
    { name: 'worksheet expansion', bytes: () => worksheetWorkbook('x'.repeat(100_000), 1, false, 2700) },
  ])('bounds actual $name before returning cells', async ({ bytes }) => {
    await expect(async () => {
      for await (const event of readSpreadsheet(bytes())) {
        if (event.kind === 'row')
          for (const cell of event.cells)
            if (typeof cell === 'string') expect(cell.length).toBeLessThanOrEqual(1_000_000);
      }
    }).rejects.toMatchObject({ code: 'payload_too_large', messageKey: 'import.spreadsheet.tooLarge' });
  });

  it('reads a valid worksheet control', async () => {
    const events = [];
    for await (const event of readSpreadsheet(worksheetWorkbook('Synthetic note'))) events.push(event);
    expect(events).toContainEqual({ kind: 'row', number: 1, cells: ['Synthetic note'] });
  });

  it('reads a small control archive and rejects truncated directories', () => {
    const bytes = zip([{ name: 'note.txt', bytes: Buffer.from('Synthetic note') }]);
    expect(entryBytes(bytes, zipEntries(bytes).get('note.txt')!, 1024).toString()).toBe('Synthetic note');
    for (const length of [0, 4, 29, bytes.length - 22])
      expect(() => zipEntries(bytes.subarray(0, length))).toThrow();
  });
});

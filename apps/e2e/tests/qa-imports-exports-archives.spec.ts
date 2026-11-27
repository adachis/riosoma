import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '../accessibility';
import { downloadNamedBlob } from '../downloads';
import { base } from '../base';
import { createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

test('a downloaded JSON snapshot preserves typed values and restores the original records', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Synthetic snapshot', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: '東京 😀 مرحبا', Amount: 12.5 }],
    },
  ]);
  const table = database.tables.Records!;
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: 'Snapshots', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Snapshots' });
  await dialog.getByRole('textbox', { name: 'Snapshot name' }).fill('Synthetic before import');
  await dialog.getByRole('button', { name: 'Take a snapshot' }).click();
  await expect(dialog.getByRole('button', { name: 'More for Synthetic before import' })).toBeVisible();
  await dialog.getByRole('button', { name: 'More for Synthetic before import' }).click();
  const download = await downloadNamedBlob(
    page,
    page.getByRole('menuitem', { name: 'Download', exact: true }),
    'Synthetic snapshot - Synthetic before import.riosoma.json',
  );
  const archive = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    format: string;
    version: number;
    records: string;
    tables: Array<{ records: Array<{ values: Record<string, unknown> }> }>;
  };
  expect(archive.format).toBe('riosoma.database');
  expect(archive.version).toBe(1);
  expect(archive.records).toBe('all');
  expect(archive.tables).toHaveLength(1);
  expect(archive.tables[0]!.records[0]!.values).toEqual({
    [table.fields.Name!]: '東京 😀 مرحبا',
    [table.fields.Amount!]: 12.5,
  });
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0]!, values: { [table.fields.Amount!]: 99 } }],
    },
  ]);
  await dialog.getByRole('button', { name: 'More for Synthetic before import' }).click();
  await page.getByRole('menuitem', { name: 'Restore as a new database', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore as a new database', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open the new database' }).click();
  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: '東京 😀 مرحبا', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '12.5', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '99', exact: true })).toHaveCount(0);
});

test('a background organization export survives reload and its archive refuses a nonempty destination', async ({
  page,
}, info) => {
  await signIn(page);
  const database = await createDatabase(page, 'Synthetic background export', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
    },
  ]);
  const table = database.tables.Records!;
  for (let start = 0; start < 2501; start += 1000) {
    await runCommands(page, database.id, [
      {
        kind: 'record.create',
        tableId: table.id,
        records: Array.from({ length: Math.min(1000, 2501 - start) }, (_, index) => ({
          id: newId('rec'),
          values: { [table.fields.Name!]: `Synthetic ${start + index} 東京 😀 مرحبا` },
        })),
      },
    ]);
  }
  await visit(page, `${base()}/settings/export-and-import`);
  const job = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/organization-archives/export') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  const response = await job;
  expect(response.ok()).toBe(true);
  const exported = (await response.json()) as { id: string };
  await page.reload();
  // A ready archive from an earlier export can appear while this job is still running.
  const link = page
    .getByRole('link', { name: 'Download archive', exact: true })
    .and(page.locator(`a[href="/api/organization-archives/${exported.id}/download"]`));
  await expect(link).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('organization.rio');
  // Earlier specs keep large record sets and attachments here, so the archive can exceed 50 MB.
  const archivePath = info.outputPath('synthetic.rio');
  await download.saveAs(archivePath);
  const bytes = readFileSync(archivePath);
  const magic = Buffer.from('RIOSOMA-ORG-1\n');
  expect(bytes.subarray(0, magic.length).equals(magic)).toBe(true);
  const entries = new Map<string, Buffer>();
  let offset = magic.length;
  while (true) {
    expect(offset + 44).toBeLessThanOrEqual(bytes.length);
    const header = bytes.subarray(offset, offset + 44);
    offset += 44;
    const nameLength = header.readUInt32BE(0);
    if (!nameLength) {
      expect(header.equals(Buffer.alloc(44))).toBe(true);
      break;
    }
    const length = Number(header.readBigUInt64BE(4));
    expect(offset + nameLength + length).toBeLessThanOrEqual(bytes.length);
    const name = bytes.subarray(offset, offset + nameLength).toString('utf8');
    offset += nameLength;
    const contents = bytes.subarray(offset, offset + length);
    offset += length;
    expect(createHash('sha256').update(contents).digest().equals(header.subarray(12))).toBe(true);
    expect(entries.has(name)).toBe(false);
    entries.set(name, contents);
  }
  expect(offset).toBe(bytes.length);
  const lines = (name: string) =>
    entries
      .get(name)!
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const records = lines(`databases/${database.id}.jsonl`).filter(
    (line) => line.kind === 'records' && line.table === table.id,
  );
  expect(records).toHaveLength(2501);
  expect(JSON.stringify(records[0])).toContain('Synthetic 0 東京 😀 مرحبا');
  expect(JSON.stringify(records.at(-1))).toContain('Synthetic 2500 東京 😀 مرحبا');
  const manifest = lines('manifest.jsonl')[0] as {
    counts: Record<string, number>;
    databases: Array<{ id: string; name: string; trashed: boolean }>;
  };
  expect(manifest.counts.records).toBeGreaterThanOrEqual(2501);
  expect(manifest.databases).toContainEqual({
    id: database.id,
    name: 'Synthetic background export',
    trashed: false,
  });
  const catalogs = ['organization.jsonl', ...manifest.databases.map((item) => `databases/${item.id}.jsonl`)]
    .flatMap(lines)
    .filter((line) => line.kind === 'catalog');
  const files = catalogs
    .filter((line) => line.catalog === 'files')
    .map((line) => line.row as { id: string; name: string; size: number });
  const allowed = new Set([
    'manifest.jsonl',
    'organization.jsonl',
    ...manifest.databases.map((item) => `databases/${item.id}.jsonl`),
    ...files.map((file) => `files/${file.id}`),
    ...catalogs
      .filter((line) => line.catalog === 'org_templates')
      .map((line) => `templates/${(line.row as { id: string }).id}.json`),
  ]);
  expect([...entries.keys()].filter((name) => !allowed.has(name))).toEqual([]);
  for (const file of files) expect(entries.get(`files/${file.id}`)).toHaveLength(Number(file.size));
  await info.attach('archive contents', {
    body: JSON.stringify({ bytes: bytes.length, files, entries: [...entries.keys()] }, null, 2),
    contentType: 'application/json',
  });
  await page.getByRole('button', { name: 'Organization archive', exact: true }).setInputFiles(archivePath);
  await expect(
    page.getByText('Import requires an empty organization with only the importing owner.', { exact: true }),
  ).toBeVisible();
});

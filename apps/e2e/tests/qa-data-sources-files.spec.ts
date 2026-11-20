import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../accessibility';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

let server: Server;
let origin = '';
const files = new Map<string, Buffer>();
const values = [
  [1, '海鳥🚢', 'مرفأ'],
  [2, 'Heron', 'Boston'],
];

test.beforeAll(async () => {
  files.set('/items.csv', Buffer.from('id,name,port\n1,海鳥🚢,مرفأ\n2,Heron,Boston\n'));
  files.set('/empty.csv', Buffer.alloc(0));
  for (const format of ['xlsx', 'json', 'parquet'])
    files.set(`/broken.${format}`, Buffer.from('This is an incomplete file'));
  files.set(
    '/items.json',
    Buffer.from(JSON.stringify(values.map(([id, name, port]) => ({ id, name, port })))),
  );
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const { Workbook } = require('exceljs') as {
    Workbook: new () => {
      addWorksheet(name: string): { addRow(values: unknown[]): void };
      xlsx: { writeBuffer(): Promise<Uint8Array> };
    };
  };
  const book = new Workbook();
  const sheet = book.addWorksheet('Vessels');
  sheet.addRow(['id', 'name', 'port']);
  for (const row of values) sheet.addRow(row);
  files.set('/items.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  const load = createRequire(new URL('../../../packages/connectors/package.json', import.meta.url));
  const { DuckDBInstance } = load('@duckdb/node-api') as {
    DuckDBInstance: {
      create(path: string): Promise<{
        connect(): Promise<{ run(text: string): Promise<void>; closeSync(): void }>;
        closeSync(): void;
      }>;
    };
  };
  const folder = mkdtempSync(
    join(fileURLToPath(new URL('../../../tools/', import.meta.url)), '.qa-data-sources-files-'),
  );
  const instance = await DuckDBInstance.create(':memory:');
  try {
    const db = await instance.connect();
    try {
      const path = join(folder, 'items.parquet');
      await db.run(
        `COPY (SELECT 1 AS id, '海鳥🚢' AS name, 'مرفأ' AS port UNION ALL SELECT 2, 'Heron', 'Boston') TO '${path.replaceAll("'", "''")}' (FORMAT parquet)`,
      );
      files.set('/items.parquet', readFileSync(path));
    } finally {
      db.closeSync();
    }
  } finally {
    instance.closeSync();
    rmSync(folder, { recursive: true, force: true });
  }
  server = createServer((request, response) => {
    if (request.url === '/denied.csv' || request.url === '/unavailable.csv') {
      response.writeHead(request.url === '/denied.csv' ? 403 : 503).end();
      return;
    }
    const body = files.get(request.url ?? '');
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

for (const format of ['csv', 'xlsx', 'json', 'parquet']) {
  test(`connects, previews, and syncs a ${format} file through the UI`, async ({ page }) => {
    test.setTimeout(100_000);
    await signIn(page);
    await page.goto(new URL('/settings/sources', page.url()).href);
    await page.getByRole('button', { name: 'Add a data source' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a data source' });
    await dialog.getByRole('option', { name: 'File at a web address', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Vessels ${format}`);
    await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill(`${origin}/items.${format}`);
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText('Connected.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    const database = await createDatabase(page, `File sweep ${format}`, [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Notes');
    await page.getByRole('button', { name: 'Add a table' }).click();
    await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
    const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
    await wizard.getByRole('button', { name: /Choose a data source/ }).click();
    await page.getByRole('option', { name: `Vessels ${format}`, exact: true }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('option', { name: new RegExp(`items\\.${format}`) }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(wizard.getByRole('table', { name: 'Preview' })).toContainText('海鳥🚢');
    await expect(wizard.getByRole('table', { name: 'Preview' })).toContainText('مرفأ');
    await expect(
      wizard.getByRole('group', { name: 'Key columns' }).getByRole('checkbox', { name: 'id', exact: true }),
    ).toBeChecked();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Create synced table' }).click();
    await expect(wizard).toBeHidden();
    const grid = page.getByRole('grid', { name: 'Grid' });
    await expect(grid.getByRole('gridcell', { name: '海鳥🚢', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(grid.getByRole('gridcell', { name: 'مرفأ', exact: true })).toBeVisible();
    await page.reload();
    await expect(grid.getByRole('gridcell', { name: 'Heron', exact: true })).toBeVisible();
    const sources = await asOwner<Array<{ id: string; name: string }>>(page, 'GET', '/api/sources');
    const saved = sources.find((source) => source.name === `Vessels ${format}`)!;
    const checked = await asOwner<{ ok: boolean }>(page, 'POST', `/api/sources/${saved.id}/test`);
    expect(checked.ok).toBe(true);
  });
}

test('explains missing, denied, empty, unavailable, and damaged files before saving', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(new URL('/settings/sources?source=new&kind=file-url', page.url()).href);
  const dialog = page.getByRole('dialog', { name: 'Add a data source' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('File checks');
  const damaged =
    'The file didn’t read in its format.  Check the format setting, and that the file isn’t damaged or cut short.';
  for (const [path, message] of [
    ['/missing.csv', 'Nothing is at that address.  Check the path and the file’s name.'],
    [
      '/denied.csv',
      'The server refused the request.  Check the request headers, like Authorization, and that they’re still valid.',
    ],
    ['/empty.csv', 'The file is empty.'],
    ['/unavailable.csv', 'The server answered with an error.  The details say which one.'],
    ...['xlsx', 'json', 'parquet'].map((format) => [`/broken.${format}`, damaged]),
  ]) {
    await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill(`${origin}${path}`);
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(dialog.getByText(message!, { exact: true })).toBeVisible();
  }
  await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill(`${origin}/items.csv`);
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(dialog.getByText('Connected.', { exact: true })).toBeVisible();
});

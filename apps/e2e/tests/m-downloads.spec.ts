import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '../accessibility';
import { downloadNamedBlob, expectSuggestedFilename } from '../downloads';
import { createDatabase, openTable, signIn } from '../helpers';

/** A view downloads from its menu as a CSV file or an Excel workbook, named for the table and view. */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

async function download(page: Page, item: 'Download CSV' | 'Download Excel', name: string) {
  await page.getByRole('button', { name: 'More for Grid' }).click();
  const file = await downloadNamedBlob(page, page.getByRole('menuitem', { name: item }), name);
  return readFileSync((await file.path())!);
}

test('the browser suggests the exact filename for a blob and an HTTP attachment', async ({ page }) => {
  const name = 'A - B.csv';
  const server = createServer((request, response) => {
    if (request.url === '/attachment') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      response.end('A,B\n');
    } else if (request.url === '/blob.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(
        "document.querySelector('#blob').href = URL.createObjectURL(new Blob(['A,B\\n'], { type: 'text/csv' }));",
      );
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><html lang="en"><title>Filename canary</title>
        <main><h1>Filename canary</h1><a id="blob" download="${name}">Blob</a>
        <a href="/attachment">Attachment</a></main><script src="/blob.js"></script></html>`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Filename canary needs a TCP address');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const blob = page.getByRole('link', { name: 'Blob' });
    await expect(blob).toHaveAttribute('download', name);
    for (const link of [blob, page.getByRole('link', { name: 'Attachment' })]) {
      const [file] = await Promise.all([page.waitForEvent('download'), link.click()]);
      expectSuggestedFilename(file, name);
      expect(readFileSync((await file.path())!, 'utf8')).toBe('A,B\n');
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a view downloads as CSV and as Excel from its menu', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Export Yard', [
    {
      name: 'Pallets',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Weight', type: 'number' },
        { name: 'Status', type: 'singleSelect', choices: ['Waiting', 'Shipped'] },
      ],
      records: [
        { Name: 'Pallet 1', Weight: 40, Status: 'Waiting' },
        { Name: 'Pallet 2', Weight: 55, Status: 'Shipped' },
      ],
    },
  ]);
  const grid = await openTable(page, database, 'Pallets');
  await expect(grid.getByRole('gridcell', { name: 'Pallet 2' })).toBeVisible();

  const csv = await download(page, 'Download CSV', 'Pallets - Grid.csv');
  // A byte-order mark leads, so spreadsheet apps read the file as UTF-8.
  const text = csv.toString('utf8');
  expect(text.startsWith('﻿')).toBe(true);
  const [header, first] = text.slice(1).split(/\r?\n/);
  expect(header).toBe('Name,Weight,Status');
  expect(first).toBe('Pallet 1,40,Waiting');

  const excel = await download(page, 'Download Excel', 'Pallets - Grid.xlsx');
  // A workbook is a zip archive.
  expect(excel.subarray(0, 2).toString('latin1')).toBe('PK');
});

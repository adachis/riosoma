import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '../accessibility';
import { createDatabase, openTable, signIn } from '../helpers';

/** A view downloads from its menu as a CSV file or an Excel workbook, named for the table and view. */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

async function download(page: Page, item: 'Download CSV' | 'Download Excel') {
  await page.getByRole('button', { name: 'More for Grid' }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: item }).click(),
  ]);
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

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

  const csv = await download(page, 'Download CSV');
  expect(csv.name).toBe('Pallets - Grid.csv');
  // A byte-order mark leads, so spreadsheet apps read the file as UTF-8.
  const text = csv.bytes.toString('utf8');
  expect(text.startsWith('﻿')).toBe(true);
  const [header, first] = text.slice(1).split(/\r?\n/);
  expect(header).toBe('Name,Weight,Status');
  expect(first).toBe('Pallet 1,40,Waiting');

  const excel = await download(page, 'Download Excel');
  expect(excel.name).toBe('Pallets - Grid.xlsx');
  // A workbook is a zip archive.
  expect(excel.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
});

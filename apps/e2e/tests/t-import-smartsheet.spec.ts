import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`picks Smartsheet and previews a grouped sheet at ${width} pixels`, async ({ page }) => {
    const token = randomUUID();
    const requests: string[] = [];
    const outside = createServer((request, response) => {
      const url = new URL(request.url!, 'https://api.smartsheet.com');
      requests.push(url.pathname);
      if (request.method !== 'GET' || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ errorCode: 1002, message: 'Invalid access token.' }));
        return;
      }
      let body: unknown;
      if (url.pathname === '/2.0/sheets')
        body = {
          pageNumber: 1,
          pageSize: 200,
          totalPages: 1,
          totalCount: 2,
          data: [
            { id: 6100000000000001, name: 'Launch plan' },
            { id: 6100000000000002, name: 'Archive' },
          ],
        };
      else if (url.pathname.endsWith('/path')) {
        const id = Number(url.pathname.split('/')[3]);
        body = {
          id: 6600000000000001,
          name: 'Riosoma tests',
          folders: [
            {
              id: 6600000000000002,
              name: 'Marketing',
              sheets: [{ id, name: id === 6100000000000001 ? 'Launch plan' : 'Archive' }],
            },
          ],
        };
      } else if (url.pathname.endsWith('/attachments')) body = { pageNumber: 1, totalPages: 0, data: [] };
      else if (url.pathname === '/2.0/sheets/6100000000000001')
        body = {
          id: 6100000000000001,
          name: 'Launch plan',
          totalRowCount: 1,
          version: 1,
          columns: [
            { id: 6300000000000001, index: 0, title: 'Task', type: 'TEXT_NUMBER', primary: true },
            { id: 6300000000000002, index: 1, title: 'Due', type: 'DATE' },
          ],
          rows: [
            {
              id: 6200000000000001,
              cells: [
                { columnId: 6300000000000001, value: 'Prepare launch' },
                { columnId: 6300000000000002, value: '2026-10-10' },
              ],
            },
          ],
        };
      else {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ errorCode: 1006, message: 'Not Found' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${(outside.address() as AddressInfo).port}/2.0`;
    try {
      await page.route('**/api/imports/smartsheet/**', async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.continue();
        const body = request.postDataJSON() as { address: string };
        expect(body.address).toBe('https://api.smartsheet.com/2.0');
        // Only the upstream address changes, so the real reader still validates and maps the response.
        await route.continue({ postData: JSON.stringify({ ...body, address: upstream }) });
      });
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      await page.getByRole('button', { name: 'Import from another tool' }).click();
      await page.getByRole('menuitem', { name: 'Smartsheet', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Import from Smartsheet' });
      await expect(dialog.getByRole('radio', { name: 'United States' })).toBeChecked();
      await expect(dialog.getByRole('radio', { name: 'Europe' })).toBeVisible();
      await expect(dialog.getByRole('radio', { name: 'Australia' })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Create a Smartsheet access token' })).toHaveAttribute(
        'href',
        'https://help.smartsheet.com/articles/2482389-generate-API-key',
      );
      await dialog.getByLabel('Access token', { exact: true }).fill(token);
      await dialog.getByRole('button', { name: 'Find sheets' }).click();
      const picker = dialog.getByRole('listbox', { name: 'Sheet' });
      await expect(picker.getByRole('option')).toHaveCount(2);
      await expect(picker).toContainText('Riosoma tests / Marketing');
      await picker.getByRole('option', { name: 'Archive', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: 'Database name' })).toHaveValue('Archive');
      await picker.getByRole('option', { name: 'Launch plan', exact: true }).click();
      await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
      const preview = dialog.getByRole('region', { name: 'Preview tables and fields' });
      await expect(preview).toContainText('Launch plan: 4 fields, 1 view');
      await expect(preview).toContainText('Due');
      await expect(preview).toContainText('Date');
      await expect(preview).toContainText('Parent row');
      await expect(preview).toContainText('Link to another record');
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      expect(requests).toContain('/2.0/sheets/6100000000000001');
      expect(requests.every((path) => !path.includes(token))).toBe(true);
      await page.goto(`${base()}/`);
    } finally {
      outside.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        outside.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

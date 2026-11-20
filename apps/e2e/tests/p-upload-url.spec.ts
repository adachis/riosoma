import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { assertAccessible, expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });
let host: Server;
let origin: string;
test.beforeAll(async () => {
  host = createServer((_request, reply) => reply.end('A synthetic attachment report'));
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  host?.closeAllConnections();
  await new Promise<void>((resolve) => (host ? host.close(() => resolve()) : resolve()));
});

test('adds a web-address attachment with the keyboard, reopens from a link, and fits a phone', async ({
  page,
}, info) => {
  await signIn(page);
  const database = await createDatabase(page, 'Web attachments', [
    {
      name: 'Reports',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Quarterly report' }],
    },
  ]);
  const table = database.tables.Reports!;
  const record = `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`;
  await visit(page, record);
  const menu = page.getByRole('button', { name: 'More ways to add' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'From a web address' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'From a web address' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Web address', exact: true })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('fileSource')).toBe(table.fields.Files);
  expect(new URL(page.url()).searchParams.get('fileRecord')).toBe(table.records[0]);
  const link = page.url();
  await page
    .getByRole('textbox', { name: 'Web address', exact: true })
    .fill('http://files.example.test/private');
  await page.getByRole('textbox', { name: 'Web address', exact: true }).press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('private network');
  await expect(page.getByRole('textbox', { name: 'Web address', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await visit(page, link);
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeLessThanOrEqual(844);
  // Firefox's in-page visit can return during entrance, when opacity lowers the text contrast.
  // Settle that screen before the original dialog scan runs every rule.
  await assertAccessible(page);
  expect((await new AxeBuilder({ page }).include('.rio-url-picker').analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('web-address-phone.png') });
  await page.getByRole('textbox', { name: 'Web address', exact: true }).fill(`${origin}/report.txt`);
  await page.getByLabel('File name (optional)').fill('Report.txt');
  await page.getByLabel('File name (optional)').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Report\.txt(?: |$)/ })).toBeVisible();
  await page.getByRole('button', { name: /^Report\.txt(?: |$)/ }).click();
  const download = page.getByRole('link', { name: /^Open in a new tab/ });
  await expect(download).toBeVisible();
  const bytes = await page.request.get(new URL((await download.getAttribute('href'))!, page.url()).href);
  expect(await bytes.text()).toBe('A synthetic attachment report');
});

for (const input of ['pointer', 'keyboard'] as const) {
  test(`opens the grid web-address picker with ${input} and preserves its destination in a link`, async ({
    page,
  }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Grid web attachments', [
      {
        name: 'Reports',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Files', type: 'attachment' },
        ],
        records: [{ Name: 'Grid report' }],
      },
    ]);
    const table = database.tables.Reports!;
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
    const cell = page
      .getByRole('row', { name: /Grid report/ })
      .getByRole('gridcell')
      .nth(1);
    await expect(cell).toBeVisible();
    await cell.dblclick();
    const menu = page.getByRole('button', { name: 'More ways to add' });
    if (input === 'pointer') {
      await menu.click();
      await page.getByRole('menuitem', { name: 'From a web address' }).click();
    } else {
      await menu.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'From a web address' }).press('Enter');
    }
    const dialog = page.getByRole('dialog', { name: 'From a web address' });
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Web address', exact: true })).toBeFocused();
    expect(new URL(page.url()).searchParams.get('fileSource')).toBe(table.fields.Files);
    expect(new URL(page.url()).searchParams.get('fileRecord')).toBe(table.records[0]);
    const link = page.url();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('fileSource')).toBe(false);
    await visit(page, link);
    await expect(dialog).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    await page.getByRole('textbox', { name: 'Web address', exact: true }).fill(`${origin}/grid.txt`);
    await page.getByLabel('File name (optional)').fill('Grid.txt');
    await page.getByRole('button', { name: 'Add file', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Grid\.txt(?: |$)/ })).toBeVisible();
  });
}

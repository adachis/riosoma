import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });
let host: Server, origin: string, image: Buffer;
let searchRequest = '';
test.beforeAll(async () => {
  host = createServer((request, reply) => {
    if (request.url?.startsWith('/search?')) {
      searchRequest = request.url;
      return reply.setHeader('content-type', 'application/json').end(
        JSON.stringify({
          results: [
            {
              title: 'Fixture page',
              url: 'https://photos.example.test/page',
              img_src: `${origin}/page.png`,
              license: 'CC BY 4.0',
            },
          ],
        }),
      );
    }
    reply.setHeader('content-type', 'image/png').end(image);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  host?.closeAllConnections();
  await new Promise<void>((resolve) => (host ? host.close(() => resolve()) : resolve()));
});

async function record(page: Page) {
  await signIn(page);
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#333333';
    context.fillRect(0, 0, 320, 240);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(35, 25);
    context.lineTo(280, 35);
    context.lineTo(260, 215);
    context.lineTo(45, 210);
    context.closePath();
    context.fill();
    context.fillStyle = '#111111';
    for (let y = 70; y < 180; y += 20) context.fillRect(75, y, 140, 3);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  image = Buffer.from(encoded, 'base64');
  const database = await createDatabase(page, 'Upload sources', [
    {
      name: 'Documents',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Pages' }],
    },
  ]);
  const table = database.tables.Documents!;
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
  return { database, table };
}

test('searches the organization’s image service, retains its license and source, and reopens on a phone', async ({
  page,
}) => {
  await record(page);
  await asOwner(page, 'PUT', '/api/ai/settings', { enabled: true });
  const original = await asOwner<Record<string, unknown>>(page, 'GET', '/api/knowledge/settings');
  try {
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings: { ...original, search: { enabled: true, engine: 'searxng', address: origin } },
    });
    await page.getByRole('button', { name: 'More ways to add' }).click();
    await page.getByRole('menuitem', { name: 'Image search', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Image search', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Search for images' })).toBeFocused();
    expect(new URL(page.url()).searchParams.get('filePicker')).toBe('images');
    const link = page.url();
    await page.keyboard.press('Escape');
    await visit(page, link);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('textbox', { name: 'Search for images' }).fill('document');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(dialog.getByText('License: CC BY 4.0', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'photos.example.test' })).toHaveAttribute(
      'href',
      'https://photos.example.test/page',
    );
    expect(new URL(searchRequest, origin).searchParams.get('categories')).toBe('images');
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    expect((await new AxeBuilder({ page }).include('.rio-image-picker').analyze()).violations).toEqual([]);
    const details = page.waitForResponse(
      (response) => response.url().includes('/api/files?ids=') && response.ok(),
    );
    await dialog.getByRole('button', { name: 'Fixture page', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const files = (await (await details).json()) as Array<{ source: { url: string; license: string } }>;
    expect(files[0]!.source).toMatchObject({ url: 'https://photos.example.test/page', license: 'CC BY 4.0' });
    await expect(page.getByRole('button', { name: /^page\.png(?: |$)/ })).toBeVisible();
  } finally {
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings: original,
    });
  }
});

test('explains disabled image search and gives an administrator the settings link', async ({ page }) => {
  await record(page);
  const original = await asOwner<Record<string, unknown>>(page, 'GET', '/api/knowledge/settings');
  try {
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings: { ...original, search: { enabled: false, engine: 'searxng', address: null } },
    });
    await page.getByRole('button', { name: 'More ways to add' }).click();
    await page.getByRole('menuitem', { name: 'Image search', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Image search', exact: true });
    await expect(dialog.getByRole('link', { name: 'Open AI and web search settings' })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
    await expect(dialog.getByText(/Image search needs web search enabled/)).toBeVisible();
  } finally {
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: randomUUID(),
      kind: 'knowledge.settings',
      settings: original,
    });
  }
});

test('drags and keyboards scan corners, arranges multiple pages, and saves one PDF', async ({
  page,
  browserName,
}) => {
  await record(page);
  await page.getByRole('button', { name: 'More ways to add' }).click();
  await page.getByRole('menuitem', { name: 'Scan documents', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan documents', exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get('filePicker')).toBe('scan');
  const link = page.url();
  await page.keyboard.press('Escape');
  await visit(page, link);
  if (browserName === 'chromium') {
    await expect(dialog.getByRole('button', { name: 'Capture page', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Capture page', exact: true }).click();
  } else {
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer: image });
  }
  const corner = dialog.getByRole('button', { name: 'Top left corner', exact: true });
  await expect(corner).toBeVisible();
  const before = await corner.getAttribute('style');
  const bounds = (await corner.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 20, { steps: 10 });
  await page.mouse.up();
  await expect(corner).not.toHaveAttribute('style', before!);
  const dragged = await corner.getAttribute('style');
  await corner.press('Shift+ArrowRight');
  await expect(corner).not.toHaveAttribute('style', dragged!);
  await dialog.getByLabel('Scan mode', { exact: true }).selectOption('bw');
  expect((await new AxeBuilder({ page }).include('.rio-scan-picker').analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Keep page', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (let index = 0; index < 2; index++) {
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer: image });
    await dialog.getByLabel('Scan mode', { exact: true }).selectOption('color');
    await dialog.getByRole('button', { name: 'Keep page', exact: true }).click();
  }
  const list = dialog.getByRole('list', { name: 'Scanned pages', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  const firstImage = await list.locator('img').first().getAttribute('src');
  await dialog.getByRole('button', { name: 'Move page 1 later', exact: true }).click();
  expect(await list.locator('img').nth(1).getAttribute('src')).toBe(firstImage);
  await dialog.getByRole('button', { name: 'Delete page 3', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const preview = page.getByRole('button', { name: /^Scan .*\.pdf(?: |$)/ });
  await expect(preview).toBeVisible();
  await preview.click();
  const open = page.getByRole('link', { name: /^Open in a new tab/ });
  const response = await page.request.get(new URL((await open.getAttribute('href'))!, page.url()).href);
  expect(response.headers()['content-type']).toContain('application/pdf');
  const pdf = await response.body();
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
});

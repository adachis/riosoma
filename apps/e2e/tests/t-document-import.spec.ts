import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

let provider: Server;
let providerUrl: string;
let calls = 0;
let previous: Record<string, unknown>;
let knowledge: Record<string, unknown>;

test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'fixture-vision' }] }));
      return;
    }
    let body = '';
    for await (const part of request) body += String(part);
    const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(parsed.messages)).toContain('data:image/png;base64,');
    calls++;
    const draft = {
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Quantity', type: 'number' },
      ],
      rows: [['Pencils', '12']],
      uncertain: [[0, 1, 0.4]],
    };
    response.setHeader('content-type', 'text/event-stream');
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(draft) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 60 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not start');
  providerUrl = `http://${address.address}:${address.port}/v1`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
  calls = 0;
  const view = await asOwner<{
    settings: Record<string, unknown>;
    providers: Array<{ providerId: string; local: boolean }>;
  }>(page, 'GET', '/api/ai/settings');
  const { gateways: _gateways, ...settings } = view.settings;
  previous = settings;
  knowledge = await asOwner(page, 'GET', '/api/knowledge/settings');
  const providerId = view.providers.find((item) => item.local)!.providerId;
  const model = { providerId, model: 'fixture-vision' };
  await asOwner(page, 'PUT', '/api/ai/settings', {
    ...previous,
    enabled: true,
    monthlyBudgetUsd: null,
    providers: [{ providerId, baseUrl: providerUrl }],
    models: { everyday: model, power: null },
  });
  await asOwner(page, 'POST', '/api/knowledge/commands', {
    kind: 'knowledge.settings',
    id: crypto.randomUUID(),
    settings: { ...knowledge, imports: { localModel: model, powerWatts: 40 } },
  });
});
test.afterEach(async ({ page }) => {
  await asOwner(page, 'POST', '/api/knowledge/commands', {
    kind: 'knowledge.settings',
    id: crypto.randomUUID(),
    settings: knowledge,
  });
  await asOwner(page, 'PUT', '/api/ai/settings', previous);
});

async function upload(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 120;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 320, 120);
    context.fillStyle = '#000000';
    context.font = '20px sans-serif';
    context.fillText('Item       Quantity', 10, 35);
    context.fillText('Pencils    12', 10, 80);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page
    .getByLabel('Photo or messy file', { exact: true })
    .setInputFiles({ name: 'Inventory.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await page.getByRole('button', { name: 'Read file', exact: true }).click();
  await expect(page.getByText('Check reading', { exact: true })).toBeVisible();
}

test('a photo becomes corrected rows and chosen types in a new table', async ({ page }) => {
  await page.goto(`${base()}/?new=photo`);
  await upload(page);
  const region = page.getByRole('region', { name: 'Readings to review' });
  const uncertain = region.locator('td').filter({ hasText: 'Check reading' });
  await expect(uncertain).toHaveCSS('border-top-width', '2px');
  await expect(uncertain).not.toHaveCSS(
    'background-color',
    await region
      .locator('td')
      .first()
      .evaluate((cell) => getComputedStyle(cell).backgroundColor),
  );
  await region.getByRole('textbox', { name: 'Quantity, row 1' }).fill('13');
  await expect(page.getByText('Check reading', { exact: true })).toHaveCount(0);
  await region.getByRole('button', { name: 'Type' }).nth(1).click();
  await page.getByRole('option', { name: 'Text', exact: true }).click();
  const use = page.getByRole('button', { name: 'Use these rows' });
  await use.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Import Inventory.csv');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/\/db[0-9A-Za-z]{14}/);
  const databaseId = new URL(page.url()).pathname.split('/')[1]!;
  const schema = await asOwner<{
    tables: Array<{ id: string }>;
    fields: Array<{ id: string; name: string; type: string }>;
  }>(page, 'GET', `/api/databases/${databaseId}/schema`);
  expect(schema.fields.find((field) => field.name === 'Quantity')?.type).toBe('text');
  const rows = await asOwner<{ records: Array<{ values: Record<string, unknown> }> }>(
    page,
    'POST',
    `/api/tables/${schema.tables[0]!.id}/import/records`,
    { fieldIds: schema.fields.map((field) => field.id) },
  );
  expect(Object.values(rows.records[0]!.values)).toEqual(expect.arrayContaining(['Pencils', '13']));
  expect(calls).toBe(1);
});

test('a phone preview appends to an existing table and supports undo', async ({ page }) => {
  const database = await createDatabase(page, 'Photo inventory', [
    {
      name: 'Stock',
      fields: [
        { name: 'Item', type: 'text' },
        { name: 'Quantity', type: 'number' },
      ],
    },
  ]);
  const table = database.tables.Stock!;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${base()}/${database.id}/${table.id}?import=${table.id}`);
  await page.getByText('Import from a photo or messy file', { exact: true }).click();
  await upload(page);
  expect((await page.getByRole('dialog').boundingBox())!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('textbox', { name: 'Quantity, row 1' }).fill('15');
  await page.getByRole('button', { name: 'Use these rows' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('status', { name: 'What the import did' })).toContainText('Added 1 record.');
  const read = () =>
    asOwner<{ records: Array<{ values: Record<string, unknown> }> }>(
      page,
      'POST',
      `/api/tables/${table.id}/import/records`,
      { fieldIds: Object.values(table.fields) },
    );
  expect((await read()).records[0]!.values[table.fields.Quantity!]).toBe(15);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status', { name: 'What the import did' })).toContainText(
    'The import was undone.',
  );
  expect((await read()).records).toEqual([]);
});

test('classification refusal and settings edits remain accessible from the keyboard', async ({ page }) => {
  await page.goto(`${base()}/?new=photo`);
  await upload(page);
  await page.getByRole('button', { name: 'Classification' }).click();
  await page.getByRole('option', { name: 'Restricted', exact: true }).click();
  await page.getByRole('button', { name: 'Read file', exact: true }).click();
  await expect(
    page.getByText(
      'Your organization’s data rules do not allow this file to be sent to the selected provider.',
    ),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.goto(`${base()}/settings/ai`);
  await page.getByRole('textbox', { name: 'Maximum PDF pages or workbook sheets' }).fill('3');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page
      .locator('.rio-settings__content')
      .getByRole('status')
      .filter({ hasText: /^Saved/ }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Maximum PDF pages or workbook sheets' })).toHaveValue('3');
  const footprint = page.getByRole('region', { name: 'AI footprint', exact: true });
  const byMonth = footprint.getByRole('region', { name: 'By month', exact: true });
  await byMonth.focus();
  await expect(byMonth).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(footprint.getByRole('button', { name: /Show a month/ })).toBeFocused();
  await footprint.getByRole('region', { name: 'By feature', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(footprint.getByRole('region', { name: 'By model', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(footprint.getByRole('link', { name: 'Download as CSV', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Help with document imports' }).click();
  await expect(page).toHaveURL(/help=importing/);
});

test('Home opens the file picker and keeps ordinary CSV imports available', async ({ page }) => {
  await page.goto(base());
  await page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }).click();
  await expect(page.getByText('Import from a photo or messy file', { exact: true })).toBeVisible();
  await page.getByLabel('Choose a CSV or Excel file', { exact: true }).setInputFiles({
    name: 'Inventory.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Item,Quantity\nPencils,12'),
  });
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Import Inventory.csv');
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  expect(calls).toBe(0);
});

import { randomBytes } from 'node:crypto';
import { expect, test } from '../accessibility';
import { asOwner, signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
const kinds = [
  ['dynamodb', 'DynamoDB'],
  ['couchdb', 'CouchDB'],
  ['couchbase', 'Couchbase'],
  ['firestore', 'Firestore'],
  ['cosmosdb', 'Cosmos DB'],
] as const;

for (const [kind, label] of kinds) {
  test(`an admin configures ${label} from its setup link on a phone`, async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/sources/test', async (route) => {
      expect(route.request().postDataJSON().connection.kind).toBe(kind);
      await route.fulfill({
        json: {
          ok: true,
          steps: ['resolve', 'connect', 'tls', 'authenticate', 'collections', 'document'].map((step) => ({
            step,
            status: 'ok',
            ms: 1,
          })),
        },
      });
    });
    await page.goto(`${base()}/settings/sources?source=new&kind=${kind}`);
    const dialog = page.getByRole('dialog', { name: 'Add a data source' });
    const name = `Document source ${randomBytes(4).toString('hex')}`;
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog
      .getByRole('textbox', { name: 'Service address', exact: true })
      .fill('http://127.0.0.1:18000');
    if (kind === 'dynamodb') {
      await dialog.getByRole('textbox', { name: 'Region', exact: true }).fill('us-east-1');
      await dialog.getByLabel('Access key ID', { exact: true }).fill(randomBytes(10).toString('hex'));
      await dialog.getByLabel('Secret access key', { exact: true }).fill(randomBytes(32).toString('hex'));
    }
    if (kind === 'couchdb' || kind === 'couchbase') {
      await dialog.getByRole('textbox', { name: 'User', exact: true }).fill('reader');
      await dialog.getByLabel('Password', { exact: true }).fill(randomBytes(16).toString('hex'));
    }
    if (kind === 'firestore') {
      await dialog.getByRole('textbox', { name: 'Project ID', exact: true }).fill('rio-test');
      await dialog.getByText('Use the local emulator', { exact: true }).click();
      await expect(dialog.getByRole('switch', { name: 'Use the local emulator' })).toBeChecked();
      await dialog.getByRole('textbox', { name: 'Collection groups', exact: true }).fill('items');
    }
    if (kind === 'cosmosdb') {
      await dialog.getByRole('textbox', { name: 'Database', exact: true }).fill('test');
      await dialog.getByText('Entra access token', { exact: true }).click();
      await expect(dialog.getByRole('radio', { name: 'Entra access token', exact: true })).toBeChecked();
      await dialog.getByLabel('Access token', { exact: true }).fill(randomBytes(32).toString('hex'));
    }
    const testConnection = dialog.getByRole('button', { name: 'Test connection', exact: true });
    await testConnection.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Connected.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Failed', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/sources') && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    const source = (await response.json()) as { id: string };
    try {
      await expect(dialog).toBeHidden();
      await page.goto(`${base()}/settings/sources?source=${source.id}`);
      const edit = page.getByRole('dialog', { name });
      await expect(edit.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
      await expect(edit.getByRole('textbox', { name: 'Service address', exact: true })).toHaveValue(
        'http://127.0.0.1:18000',
      );
      await page.keyboard.press('Escape');
      await expect(edit).toBeHidden();
    } finally {
      await asOwner(page, 'DELETE', `/api/sources/${source.id}`);
    }
  });
}

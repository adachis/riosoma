import { expect, test } from '../accessibility';
import { signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('Security settings rotate wrapping keys and link to the report on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`${base()}/settings/credential-vaults`);
  await expect(page.getByRole('heading', { name: 'Where credentials live', level: 1 })).toBeVisible();
  const storage = page.getByRole('combobox', { name: 'Credential storage' });
  await expect(storage).toHaveValue('database');
  await storage.focus();
  await expect(storage).toBeFocused();
  await page.getByRole('button', { name: 'Rotate wrapping keys', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rotate wrapping keys' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Rotate wrapping keys', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  const report = page.locator('.rio-credentials__report').first();
  await expect(report.getByRole('link', { name: 'Finished', exact: true })).toBeVisible({ timeout: 60000 });
  await report.getByRole('link', { name: 'Finished', exact: true }).click();
  await expect(page).toHaveURL(/#job-/);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
});

test('a source credential outage leaves healthy sources editable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.route('**/api/sources', async (route) => {
    const source = {
      id: 'src00000000000001',
      name: 'Healthy',
      description: '',
      kind: 'postgres',
      connection: {
        kind: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        database: 'data',
        user: 'reader',
        auth: { method: 'password' },
        tls: { mode: 'disable' },
      },
      secrets: ['password'],
      access: 'admins',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      lastTest: null,
      tables: 0,
    };
    await route.fulfill({
      json: [
        source,
        {
          ...source,
          id: 'src00000000000002',
          name: 'Affected',
          secrets: [],
          credentialError: 'credentials.unavailable',
        },
      ],
    });
  });
  await page.goto(`${base()}/settings/sources`);
  const affected = page.getByRole('row').filter({ hasText: 'Affected' });
  await expect(affected.getByRole('status')).toHaveText(
    'The credential vault is unavailable.  This connection is paused until access is restored.',
  );
  const edit = page.getByRole('button', { name: 'Edit Healthy' });
  await edit.focus();
  await edit.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toHaveValue('Healthy');
});

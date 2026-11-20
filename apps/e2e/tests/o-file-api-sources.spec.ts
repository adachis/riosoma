import { randomBytes } from 'node:crypto';
import { expect, test } from '../accessibility';
import { signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
for (const width of [390, 1280]) {
  test(`plain FTP explains the required transport on a ${width}-pixel screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.route('**/api/sources', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 422,
        json: {
          error: {
            code: 'validation_failed',
            messageKey: 'sources.file.ftp',
            userFault: true,
            fields: { kind: 'sources.file.ftp' },
          },
        },
      });
    });
    await page.goto(`${base()}/settings/sources?source=new&kind=ftp`);
    const dialog = page.getByRole('dialog', { name: 'Add a data source' });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Plain file transfer');
    await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('192.0.2.1');
    await dialog.getByRole('textbox', { name: 'User', exact: true }).fill('reader');
    await dialog.locator('input[type=password]').fill(randomBytes(18).toString('hex'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    const error = dialog.getByRole('alert');
    await expect(error).toContainText('Use FTPS or SFTP');
    await expect(error).toContainText('limited to localhost');
    await expect(error).toContainText('RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test(`an invalid file host explains the format on a ${width}-pixel screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.goto(`${base()}/settings/sources?source=new&kind=ftps`);
    const dialog = page.getByRole('dialog', { name: 'Add a data source' });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Invalid file host');
    await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('192.0.2.1:2222');
    await dialog.getByRole('textbox', { name: 'User', exact: true }).fill('reader');
    await dialog.locator('input[type=password]').fill(randomBytes(18).toString('hex'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('Enter a valid host name or IP address');
    await expect(dialog.getByRole('alert')).toContainText('Enter the port in its own field');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  for (const kind of ['sftp', 'ftp', 'ftps', 'webdav', 'graphql', 'odata']) {
    test(`${kind} setup supports keyboard navigation and a ${width}-pixel screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      await page.route('**/api/sources/test', (route) =>
        route.fulfill({
          json: {
            ok: false,
            steps: [
              { step: 'resolve', status: 'ok', ms: 1 },
              { step: 'connect', status: 'failed', ms: 1, messageKey: 'sources.test.connect' },
            ],
          },
        }),
      );
      await page.goto(`${base()}/settings/sources?source=new&kind=${kind}`);
      const dialog = page.getByRole('dialog', { name: 'Add a data source' });
      const name = `File API ${randomBytes(6).toString('hex')}`;
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      if (['sftp', 'ftp', 'ftps'].includes(kind)) {
        await dialog
          .getByRole('textbox', { name: 'Host', exact: true })
          .fill(kind === 'ftp' ? '127.0.0.1' : '192.0.2.1');
        await dialog.getByRole('textbox', { name: 'User', exact: true }).fill('reader');
        if (kind === 'sftp')
          await dialog.getByRole('textbox', { name: 'Server host key' }).fill('public-key');
      } else if (kind === 'webdav') {
        await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill('https://192.0.2.1/files/');
        await dialog.getByRole('textbox', { name: 'User', exact: true }).fill('reader');
      } else {
        await dialog.getByRole('textbox', { name: 'Base address' }).fill('https://192.0.2.1/service');
        if (kind === 'graphql') {
          await dialog.getByRole('textbox', { name: 'Query', exact: true }).fill('{ items { id } }');
          await dialog.getByRole('textbox', { name: 'Path to rows' }).fill('data.items');
          await page.route('**/api/sources/graphql-suggestions', (route) =>
            route.fulfill({ json: [{ name: 'Item.id', sourceType: 'Int' }] }),
          );
          await dialog.getByRole('button', { name: 'Suggest fields' }).click();
          await expect(dialog.getByText('Item.id')).toBeVisible();
          await dialog.getByRole('radio', { name: 'Cursor', exact: true }).focus();
          await page.keyboard.press('Space');
          await dialog.getByRole('textbox', { name: 'Path to pageInfo' }).fill('data.pageInfo');
        }
      }
      if (['sftp', 'ftp', 'ftps', 'webdav'].includes(kind))
        await dialog.locator('input[type=password]').fill(randomBytes(18).toString('hex'));
      await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(dialog.getByText('Failed', { exact: true })).toBeVisible();
      await dialog.getByRole('link', { name: 'Connection help' }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/help=file-api-sources/);
      await page.getByRole('button', { name: 'Close help', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
      await row.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
      await expect(page).toHaveURL(/source=src[A-Za-z0-9]{14}/);
      await page.reload();
      await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row).toBeHidden();
      await page
        .getByRole('alertdialog')
        .filter({ hasText: 'Source deleted' })
        .getByRole('button', { name: 'Undo', exact: true })
        .click();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    });
  }
}

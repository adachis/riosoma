import { randomBytes } from 'node:crypto';
import { expect, test, type Locator } from '../accessibility';
import { signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

async function chooseRadio(dialog: Locator, name: string): Promise<void> {
  const radio = dialog.getByRole('radio', { name, exact: true });
  await radio.focus();
  await radio.press('Space');
  await expect(radio).toBeChecked();
}

for (const width of [390, 1280]) {
  for (const kind of ['redshift', 'athena', 'duckdb-file'] as const) {
    test(`${kind} setup supports a ${width}-pixel screen, deep links, and the diagnostic ladder`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      await page.route('**/api/sources/test', async (route) => {
        const payload = route.request().postDataJSON() as { connection: { kind: string } };
        expect(payload.connection.kind).toBe(kind);
        await route.fulfill({
          json: {
            ok: false,
            steps: [
              { step: 'resolve', status: 'ok', ms: 1 },
              { step: 'connect', status: 'ok', ms: 1 },
              { step: 'tls', status: 'ok', ms: 1 },
              { step: 'authenticate', status: 'failed', ms: 1, messageKey: 'sources.test.authenticate' },
            ],
          },
        });
      });
      await page.goto(`${base()}/settings/sources?source=new&kind=${kind}`);
      const dialog = page.getByRole('dialog', { name: 'Add a data source' });
      const name = `Warehouse ${kind} ${randomBytes(6).toString('hex')}`;
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      if (kind === 'redshift') {
        await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('warehouse.invalid');
        await dialog.getByRole('textbox', { name: 'Database', exact: true }).fill('events');
        await dialog.getByRole('textbox', { name: 'Region', exact: true }).fill('us-east-1');
        await chooseRadio(dialog, 'Serverless workgroup');
        await dialog.getByRole('textbox', { name: 'Workgroup', exact: true }).fill('readers');
        await expect(dialog.getByRole('textbox', { name: 'Cluster identifier' })).toHaveCount(0);
      } else if (kind === 'athena') {
        await dialog.getByRole('textbox', { name: 'Region', exact: true }).fill('us-east-1');
        await dialog.getByRole('textbox', { name: 'Database', exact: true }).fill('events');
        await dialog.getByRole('textbox', { name: 'Workgroup', exact: true }).fill('readers');
        await dialog
          .getByRole('textbox', { name: 'Results location (S3)', exact: true })
          .fill('s3://results/queries/');
        await expect(dialog.getByRole('textbox', { name: 'Scan limit per query (bytes)' })).toHaveValue(
          '1,000,000,000',
        );
      } else {
        await chooseRadio(dialog, 'S3 bucket');
        await dialog.getByRole('textbox', { name: 'Bucket', exact: true }).fill('source-files');
        await dialog.getByRole('textbox', { name: 'Key or prefix', exact: true }).fill('events/');
        await dialog.getByRole('textbox', { name: 'Region', exact: true }).fill('us-east-1');
        await chooseRadio(dialog, 'Parquet folder');
      }
      await dialog.getByLabel('Access key ID', { exact: true }).fill(randomBytes(16).toString('hex'));
      await dialog.getByLabel('Secret access key', { exact: true }).fill(randomBytes(24).toString('hex'));
      await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(dialog.getByText('Failed', { exact: true })).toBeVisible();
      const helpLink = dialog.getByRole('link', { name: 'Connection help' });
      const helpUrl = new URL((await helpLink.getAttribute('href')) ?? '', page.url());
      expect(helpUrl.searchParams.get('source')).toBe('new');
      expect(helpUrl.searchParams.get('kind')).toBe(kind);
      expect(helpUrl.searchParams.get('help')).toBe('warehouse-sources');
      const documents: string[] = [];
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          documents.push(request.url());
      });
      await helpLink.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/help=warehouse-sources/);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Close help', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close help', exact: true }).click();
      await expect(page).not.toHaveURL(/help=/);
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
      await expect(dialog.getByText('Failed', { exact: true })).toBeVisible();
      expect(documents).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      const save = dialog.getByRole('button', { name: 'Save', exact: true });
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
      await expect(page).toHaveURL(/source=src[A-Za-z0-9]{14}/);
      await page.reload();
      await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row).toBeHidden();
    });
  }
}

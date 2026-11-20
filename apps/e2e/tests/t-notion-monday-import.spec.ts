import { expect, test, type Page } from '../accessibility';
import { signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
const token = ['browser', 'test', 'token'].join('-');

async function stubImport(page: Page, platform: 'notion' | 'monday') {
  await page.route(new RegExp(`/api/imports/${platform}(?:/|\\?|$)`), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/bases')) {
      await route.fulfill({
        json: {
          bases: Array.from({ length: 60 }, (_, index) => ({
            id: String(index),
            name: index === 0 ? 'Riosoma tests' : `Project ${index}`,
            group: index < 30 ? 'Operations' : 'Marketing',
          })),
        },
      });
    } else if (path.endsWith('/preview')) {
      expect(request.postDataJSON()).toMatchObject({ token, baseId: '0' });
      await route.fulfill({
        json: {
          tables: [
            {
              id: 'tasks',
              name: 'Tasks',
              fields: Array.from({ length: 12 }, (_, index) => ({ name: `Field ${index}`, type: 'text' })),
              views: 2,
            },
            {
              id: 'related',
              name: 'Related tasks',
              fields: Array.from({ length: 4 }, (_, index) => ({
                name: `Related field ${index}`,
                type: 'number',
              })),
              views: 1,
            },
          ],
          notes: [
            {
              status: 'changed',
              subject: 'field',
              table: 'Tasks',
              name: platform === 'notion' ? 'Page body' : 'Subitems',
              messageKey:
                platform === 'notion'
                  ? 'import.platform.report.pageBody'
                  : 'import.platform.report.subitemsTable',
              params: {},
            },
            ...(platform === 'notion'
              ? [
                  {
                    status: 'changed',
                    subject: 'field',
                    table: 'Tasks',
                    name: 'Office',
                    messageKey: 'import.platform.report.placeDetails',
                    params: {},
                  },
                ]
              : []),
          ],
        },
      });
    } else if (request.method() === 'GET') await route.fulfill({ json: { imports: [] } });
    else throw new Error('Unexpected import request');
  });
}

async function preview(page: Page, platform: 'notion' | 'monday') {
  await stubImport(page, platform);
  await signIn(page);
  await page.getByRole('button', { name: 'Import from another tool' }).click();
  const product = platform === 'notion' ? 'Notion' : 'monday.com';
  await page.getByRole('menuitem', { name: product, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Import from ${product}` });
  await expect(dialog.getByRole('link', { name: `Get a token in ${product}` })).toHaveAttribute(
    'href',
    platform === 'notion'
      ? 'https://www.notion.so/profile/integrations'
      : 'https://monday.com/developers/apps',
  );
  await dialog
    .getByLabel(platform === 'notion' ? 'Connection token' : 'API token', { exact: true })
    .fill(token);
  await dialog
    .getByRole('button', { name: platform === 'notion' ? 'Find databases' : 'Find boards' })
    .click();
  const picker = dialog.getByRole('listbox', { name: platform === 'notion' ? 'Database' : 'Board' });
  await expect(picker.getByText('Operations', { exact: true })).toBeVisible();
  await expect(picker.getByText('Marketing', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  const region = dialog.getByRole('region', { name: 'Preview tables and fields' });
  await expect(region).toBeVisible();
  await expect(region.getByText('Tasks: 12 fields, 2 views')).toBeVisible();
  await expect(region.getByText('Field 0', { exact: true })).toBeVisible();
  await expect(region.getByText('Text', { exact: true }).first()).toBeVisible();
  await expect(
    region.getByText(
      platform === 'notion'
        ? /Page body content is separate from table data/
        : /Subitems became a linked child table/,
    ),
  ).toBeVisible();
  if (platform === 'notion')
    await expect(
      region.getByText(/Keeps the place’s name, address, and provider IDs together/),
    ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  return dialog;
}

for (const platform of ['notion', 'monday'] as const) {
  test(`pick ${platform} and inspect its grouped schema preview`, async ({ page }) => {
    await preview(page, platform);
  });
}

test.describe('phone previews', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  for (const platform of ['notion', 'monday'] as const) {
    test(`${platform} preview fits and keeps the actions reachable`, async ({ page }) => {
      const dialog = await preview(page, platform);
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(375);
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
});

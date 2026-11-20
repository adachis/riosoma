import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '../accessibility';
import { signIn } from '../helpers';
import { startReplay, type Recording, type Replay } from '../../server/src/test/platform-replay';

test.use({ serviceWorkers: 'block' });
const TOKEN = randomBytes(24).toString('hex');
const replays = new Map<string, Replay>();
test.beforeAll(async () => {
  for (const platform of ['clickup', 'asana']) {
    replays.set(
      platform,
      await startReplay(
        join(import.meta.dirname, '../../server/src/data/imports/platforms', platform, 'test/recording.json'),
        (headers, path) =>
          path.startsWith('/files/') ||
          headers.authorization === (platform === 'asana' ? `Bearer ${TOKEN}` : TOKEN),
      ),
    );
  }
  const recording = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../server/src/data/imports/platforms/clickup/test/recording.json'),
      'utf8',
    ),
  ) as Recording;
  recording.answers.find((answer) => answer.path === '/api/v2/list/100/field')!.body = JSON.stringify({
    fields: Array.from({ length: 500 }, (_, at) => ({
      id: `capacity-${at}`,
      name: `Capacity ${at}`,
      type: 'short_text',
      type_config: {},
    })),
  });
  replays.set('capacity', await startReplay(recording, (headers) => headers.authorization === TOKEN));
});

test('preview explains field capacity before importing on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.getByRole('button', { name: 'Import from another tool' }).click();
  await page.getByRole('menuitem', { name: 'ClickUp', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from ClickUp' });
  await dialog.getByLabel('Address', { exact: true }).fill(replays.get('capacity')!.url);
  await dialog.getByLabel('API token', { exact: true }).fill(TOKEN);
  await dialog.getByRole('button', { name: 'Find lists', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = dialog.getByRole('region', { name: 'Preview tables and fields' });
  await expect(preview).toContainText('Source fields take priority');
  await expect(preview).toContainText('including inverse link fields');
  await expect(preview.locator('details').getByText('Capacity 0', { exact: true })).toBeVisible();
  await expect(preview.locator('details').getByText('Capacity 499', { exact: true })).toHaveCount(0);
  await expect(preview).toContainText('Left out, since a table here holds at most 500 fields.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
test.afterAll(async () => {
  for (const replay of replays.values()) await replay.close();
});

for (const width of [1280, 375]) {
  for (const platform of ['clickup', 'asana']) {
    const product = platform === 'clickup' ? 'ClickUp' : 'Asana';
    test(`${product} selection shows its schema preview on a ${width}-pixel screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const delayedHome = platform === 'asana' && width === 375;
      let finishHome = () => {};
      if (delayedHome) {
        const ready = new Promise<void>((resolve) => {
          finishHome = resolve;
        });
        await page.route('**/api/home', async (route) => {
          await ready;
          await route.continue();
        });
      }
      const importAction = page.getByRole('button', { name: 'Import from another tool' });
      try {
        await signIn(page);
        // A late folder listing used to move this action and close an opened menu.  Keep its
        // space while the listing loads, and prevent opening the menu until it arrives.
        if (delayedHome) {
          await expect(importAction).toBeVisible();
          await expect(importAction).toBeDisabled();
        }
      } finally {
        finishHome();
      }
      await expect(importAction).toBeEnabled();
      await importAction.click();
      await page.getByRole('menuitem', { name: product, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Import from ${product}` });
      await expect(dialog.getByRole('link', { name: 'Create a token' })).toHaveAttribute(
        'href',
        platform === 'clickup' ? 'https://app.clickup.com/settings/apps' : 'https://app.asana.com/0/my-apps',
      );
      await dialog.getByLabel('Address', { exact: true }).fill(replays.get(platform)!.url);
      await dialog
        .getByLabel(platform === 'clickup' ? 'API token' : 'Access token', { exact: true })
        .fill(TOKEN);
      await dialog
        .getByRole('button', { name: platform === 'clickup' ? 'Find lists' : 'Find projects' })
        .click();
      const group = platform === 'clickup' ? 'Riosoma tests / Product / Launch' : 'Riosoma tests / Product';
      await expect(dialog.getByRole('button', { name: new RegExp(group) })).toBeVisible();
      await expect(dialog.getByRole('option', { name: 'Tasks', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await dialog.getByRole('option', { name: 'Partners', exact: true }).click();
      await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
      const preview = dialog.getByRole('region', { name: 'Preview tables and fields' });
      await expect(preview).toBeVisible();
      await expect(preview.locator('summary')).toHaveText(['Tasks', 'Partners']);
      await expect(preview).toContainText('Attachments');
      await expect(preview).toContainText('Parent task');
      await expect(preview).toContainText('Subtasks become records');
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(dialog.getByRole('option', { name: 'Partners', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
  }
}

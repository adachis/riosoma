import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, signIn } from '../helpers';
import { enabledLocales } from '../../../tools/locales';

test.use({ serviceWorkers: 'block' });

test('search opens a setting, its deep link survives reload, and an invalid suffix is repaired', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${base()}/settings/appearance`);
  const search = page.getByRole('combobox', { name: 'Search settings' });
  await search.fill('blank means no cap');
  await expect(page.getByRole('option', { name: /Maximum upload size/ })).toBeVisible();
  await search.fill('maximum upload size');
  await expect(page.getByRole('group', { name: 'Security', exact: true })).toBeVisible();
  const option = page
    .getByRole('group', { name: 'Security', exact: true })
    .getByRole('option', { name: /Maximum upload size/ });
  await expect(option).toBeVisible();
  await search.press('End');
  await expect(search).toHaveAttribute('aria-activedescendant', (await option.getAttribute('id'))!);
  await search.press('Enter');
  await expect(page).toHaveURL(`${base()}/admin/security/files/max-upload-bytes`);
  const target = page.locator('[data-setting-page="files"][data-setting-id="max-upload-bytes"]');
  await expect(target).toHaveAttribute('data-setting-highlighted', 'true');
  await expect(page.getByRole('textbox', { name: 'Maximum upload size (bytes)' })).toBeFocused();
  await page.reload();
  await expect(target).toHaveAttribute('data-setting-highlighted', 'true');
  await search.fill('maximum upload size file uploads');
  await search.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Maximum upload size (bytes)' })).toBeFocused();
  await page.goto(`${base()}/admin/security/files/does-not-exist`);
  await expect(page).toHaveURL(`${base()}/admin/security/files`);
  await expect(
    page.getByText('That link pointed to something that no longer exists, so here’s the closest match.'),
  ).toBeVisible();
});

test('personal settings work on a phone with reduced motion and are searchable from the palette', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  const personalPage = enabledLocales().length > 1 ? 'language' : 'appearance';
  const setting = personalPage === 'language' ? 'language' : 'theme';
  await page.goto(`${base()}/settings/preferences/${personalPage}/${setting}`);
  const target = page.locator(`[data-setting-page="${personalPage}"][data-setting-id="${setting}"]`);
  await expect(target).toHaveAttribute('data-setting-highlighted', 'true');
  await expect(target).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(target).not.toHaveAttribute('data-setting-highlighted', 'true', { timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('searchbox').fill('maximum upload size');
  await palette
    .getByRole('option', { name: /Maximum upload size/ })
    .filter({ hasText: 'File uploads' })
    .click();
  await expect(page).toHaveURL(`${base()}/admin/security/files/max-upload-bytes`);
  await expect(page.getByRole('textbox', { name: 'Maximum upload size (bytes)' })).toBeFocused();
});

test('imported settings and model tiers have independent search destinations', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/settings/appearance`);
  const search = page.getByRole('combobox', { name: 'Search settings' });
  for (const [label, id] of [
    ['Quick answers', 'everyday'],
    ['Thorough work', 'power'],
    ['Electricity zone', 'electricity-zone'],
    ['Show a month', 'footprint-month'],
  ]) {
    await search.fill(label!);
    const target = page.locator(`[data-setting-page="ai"][data-setting-id="${id}"]`);
    // Observe the temporary highlight while the action's accessibility scan completes.
    await Promise.all([
      page.getByRole('option', { name: new RegExp(label!) }).click(),
      expect(target).toHaveAttribute('data-setting-highlighted', 'true'),
    ]);
    await expect(page).toHaveURL(`${base()}/admin/connections/ai/${id}`);
    await expect(target).toHaveCount(1);
    await expect(target).toBeInViewport();
    // The new document must restore the highlight; the old one cannot satisfy this assertion.
    await Promise.all([
      page
        .waitForEvent('domcontentloaded')
        .then(() => expect(target).toHaveAttribute('data-setting-highlighted', 'true')),
      page.reload(),
    ]);
  }
  await search.fill('any work or school account');
  await expect(page.getByRole('option', { name: /Tenant ID or domain/ })).toBeVisible();
  await search.fill('Connect outside MCP servers');
  await page.getByRole('option', { name: /Tools/ }).click();
  await expect(page).toHaveURL(`${base()}/admin/connections/ai/remote-tools`);
  await expect(page.getByRole('button', { name: 'Add server' })).toBeVisible();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page).toHaveURL(`${base()}/admin/connections/ai`);
  await expect(page.getByRole('switch', { name: 'Turn on AI', exact: true })).toBeVisible();
});

test('legal hold search keeps its target while the reader chooses a permitted database', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Retention review', [
    { name: 'Entries', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base()}/settings/appearance`);
  await page.getByRole('combobox', { name: 'Search settings' }).fill('Legal hold—stop all purging');
  await page.getByRole('option', { name: /Legal hold—stop all purging/ }).click();
  await expect(page).toHaveURL(`${base()}/admin/security/retention/legalHold`);
  const target = page.locator('[data-setting-page="retention"][data-setting-id="legalHold"]');
  const scope = page.getByRole('combobox', { name: 'Database for legal hold' });
  await expect(scope).toBeFocused();
  await expect(target).toHaveAttribute('data-setting-highlighted', 'true');
  await expect(target).toBeInViewport();
  await scope.selectOption(database.id);
  await expect(page).toHaveURL(`${base()}/admin/security/retention/legalHold?database=${database.id}`);
  const hold = page.getByRole('checkbox', { name: 'Legal hold—stop all purging for this database' });
  await expect(hold).toBeFocused();
  await expect(hold).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Apply to', exact: true }).selectOption('');
  await expect(scope).toBeFocused();
  await expect(page).toHaveURL(`${base()}/admin/security/retention/legalHold`);
  await scope.selectOption(database.id);
  await expect(hold).toBeFocused();
  await page.reload();
  await expect(hold).toBeFocused();
  await expect(hold).not.toBeChecked();
});

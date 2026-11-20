import { saveUploadPolicy } from '../settings-policy';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

// A cap a failed or timed-out test leaves behind would refuse the next spec's uploads with 413.
test.afterEach(async ({ page }) => {
  await saveUploadPolicy(page, null);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('an owner saves and clears the upload cap with a keyboard on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`${base()}/settings/files`);
  await expect(page.getByRole('heading', { name: 'File uploads', level: 1 })).toBeVisible();
  const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
  const save = page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true });
  await expect(input).toHaveValue('');
  await input.fill('0');
  await save.focus();
  await save.press('Enter');
  await expect(
    page
      .locator('[data-setting-id=max-upload-bytes]')
      .getByText('Enter a positive whole number of bytes, or leave this blank.'),
  ).toBeVisible();
  await input.fill('4294967296');
  await save.focus();
  await save.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Upload limit saved.' })).toBeVisible();
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 4294967296,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await page.reload();
  await expect(input).toHaveValue('4294967296');
  await input.fill('');
  await save.focus();
  await save.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Upload limit saved.' })).toBeVisible();
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: null,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .exclude('[data-live-announcer]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/file-upload-cap-phone.png', fullPage: true });
});

test('reopening cached settings submits the refreshed upload cap', async ({ page }) => {
  await signIn(page);
  await saveUploadPolicy(page, null);
  await page.goto(`${base()}/settings/files`);
  const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
  await expect(input).toHaveValue('');
  await page.getByRole('link', { name: 'Appearance', exact: true }).click();
  await saveUploadPolicy(page, 1024);
  const refresh = gate();
  await page.route('**/api/org/files', async (route) => {
    await refresh.promise;
    await route.continue();
  });
  await page.getByRole('link', { name: 'File uploads', exact: true }).click();
  await expect(input).toHaveValue('');
  refresh.resolve();
  await expect(input).toHaveValue('1024');
  await expect(
    page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await input.fill('2048');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Upload limit saved.' })).toBeVisible();
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 2048,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await saveUploadPolicy(page, null);
});

test('an edit made during a save stays unsaved until submitted', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/settings/files`);
  const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
  const save = page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true });
  await input.fill('1024');
  const stored = gate();
  const release = gate();
  let holdSave = true;
  // Expiring the last route can disable Chromium interception during the follow-up refresh.
  await page.route('**/api/org/admin-commands', async (route) => {
    if (!holdSave) {
      await route.continue();
      return;
    }
    holdSave = false;
    const response = await route.fetch();
    stored.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await save.press('Enter');
  await stored.promise;
  await input.fill('2048');
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/org/files'));
  release.resolve();
  await refreshed;
  await expect(save).not.toHaveAttribute('aria-disabled', 'true');
  await expect(input).toHaveValue('2048');
  await expect(page.getByRole('status').filter({ hasText: 'Upload limit saved.' })).toHaveCount(0);
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 1024,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await save.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Upload limit saved.' })).toBeVisible();
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 2048,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await saveUploadPolicy(page, null);
});

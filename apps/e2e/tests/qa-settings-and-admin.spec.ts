import { saveUploadPolicy } from '../settings-policy';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn } from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const bar = (page: Page) => page.getByRole('region', { name: 'Save changes', exact: true });

test('audit filters have one deep link and wait for explicit submission from the keyboard', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/admin/organization/audit/audit-filters`);
  const target = page.locator('[data-setting-page="audit"][data-setting-id="audit-filters"]');
  await expect(target).toHaveCount(1);
  await expect(target).toBeInViewport();
  const action = page.getByRole('textbox', { name: 'Action', exact: true });
  await action.fill('organization.roles');
  await action.press('Enter');
  await expect(page).toHaveURL(`${base()}/admin/organization/audit/audit-filters`);
  await expect(action).toBeFocused();
  await page.getByRole('button', { name: 'Filter events', exact: true }).click();
  await expect(page).toHaveURL(/action=organization.roles/);
  await page.reload();
  await expect(action).toHaveValue('organization.roles');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(action).toHaveValue('');
  await expect(page).toHaveURL(`${base()}/admin/organization/audit/audit-filters`);
});

test('discard removes the upload error and a failed save preserves a correctable draft', async ({ page }) => {
  await signIn(page);
  const prior = await asOwner<{ maxUploadBytes: number | null }>(page, 'GET', '/api/org/files');
  try {
    await saveUploadPolicy(page, 1024);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base()}/admin/security/files/max-upload-bytes`);
    const input = page.getByRole('textbox', { name: 'Maximum upload size (bytes)', exact: true });
    await input.fill('-1');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    await bar(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(input).toHaveValue('1024');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a positive whole number of bytes, or leave this blank.')).toHaveCount(
      0,
    );

    await page.route('**/api/org/admin-commands', (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'unavailable', messageKey: 'errors.unavailable', userFault: false } },
      }),
    );
    await input.fill('2048');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(input).toHaveValue('2048');
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 1024,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await page.unroute('**/api/org/admin-commands');
    await page.route('**/api/org/admin-commands', (route) => route.abort('internetdisconnected'));
    await input.fill('3072');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(input).toHaveValue('3072');
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 1024,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await page.unroute('**/api/org/admin-commands');
    await input.press('ControlOrMeta+s');
    await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 3072,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    await page.unroute('**/api/org/admin-commands');
    await saveUploadPolicy(page, prior.maxUploadBytes);
  }
});

test('returning to the original upload cap during a save keeps the newer edit', async ({ page }) => {
  await signIn(page);
  const prior = await asOwner<{ maxUploadBytes: number | null }>(page, 'GET', '/api/org/files');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await saveUploadPolicy(page, 1024);
    await page.goto(`${base()}/settings/files`);
    await page.route('**/api/org/admin-commands', async (route) => {
      await held;
      await route.continue();
    });
    const input = page.getByRole('textbox', { name: 'Maximum upload size (bytes)', exact: true });
    await input.fill('2048');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await input.fill('1024');
    release();
    await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(input).toHaveValue('1024');
    await expect(bar(page).getByRole('status')).toHaveText('Unsaved changes');
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 2048,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await page.unroute('**/api/org/admin-commands');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
    expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
      maxUploadBytes: 1024,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    release();
    await page.unroute('**/api/org/admin-commands');
    await saveUploadPolicy(page, prior.maxUploadBytes);
  }
});

test('invalid audit filters stay editable and identify the field on a phone', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/settings/audit`);
  const resource = page.getByRole('textbox', { name: 'Resource', exact: true });
  const value = '記録🌊مرحبا'.repeat(30);
  await resource.fill(value);
  await page.getByRole('button', { name: 'Filter events', exact: true }).click();
  await expect(resource).toHaveValue(value);
  await expect(resource).toHaveAttribute('aria-invalid', 'true');
  await expect(resource).toBeFocused();
  await expect(page).toHaveURL(`${base()}/settings/audit`);
  await resource.fill('記録🌊مرحبا');
  await page.getByRole('button', { name: 'Filter events', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('resource')).toBe('記録🌊مرحبا');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  const from = page.getByLabel('From, UTC', { exact: true });
  const to = page.getByLabel('To, UTC', { exact: true });
  await from.fill('2026-10-02T12:00');
  await to.fill('2026-10-01T12:00');
  await page.getByRole('button', { name: 'Filter events', exact: true }).click();
  await expect(to).toHaveAttribute('aria-invalid', 'true');
  await expect(to).toBeFocused();
  await expect(from).toHaveValue('2026-10-02T12:00');
  await expect(page).toHaveURL(`${base()}/settings/audit`);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(to).not.toHaveAttribute('aria-invalid', 'true');
});

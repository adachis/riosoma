import { saveUploadPolicy } from '../settings-policy';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn } from '../helpers';
import { collectSettings } from '../../web/build/settings-registry';
import { enabledLocales } from '../../../tools/locales';

test.use({ serviceWorkers: 'block' });

const bar = (page: Page) => page.getByRole('region', { name: 'Save changes', exact: true });
const personalPage = enabledLocales().length > 1 ? 'language' : 'appearance';
const personalLabel = personalPage === 'language' ? 'Language' : 'Appearance';
const personalSetting = personalPage === 'language' ? 'language' : 'theme';

test('AI consent stays in one draft, validates missing keys, and saves with the keyboard', async ({
  page,
}) => {
  await signIn(page);
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: false,
    providers: [],
    models: { everyday: null, power: null },
  });
  await page.goto(`${base()}/settings/ai`);
  const enabled = page.getByRole('switch', { name: 'Turn on AI', exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await enabled.press('Space');
  expect(
    (await asOwner<{ settings: { enabled: boolean } }>(page, 'GET', '/api/ai/settings')).settings.enabled,
  ).toBe(false);
  await bar(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(enabled).not.toBeChecked();
  const stored = await asOwner<{ providers: Array<{ name: string; hasKey: boolean; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const missing = stored.providers.find((provider) => !provider.hasKey && !provider.local)!;
  const provider = page.getByRole('region', { name: missing.name, exact: true });
  await provider.getByRole('switch').press('Space');
  await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(provider.getByLabel('API key', { exact: true })).toBeFocused();
  await expect(provider).toContainText(`Enter an API key for ${missing.name} before saving.`);
  await bar(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await enabled.press('Space');
  await enabled.press('ControlOrMeta+s');
  await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
  expect(
    (await asOwner<{ settings: { enabled: boolean } }>(page, 'GET', '/api/ai/settings')).settings.enabled,
  ).toBe(true);
  await page.reload();
  await expect(enabled).toBeChecked();
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Keyboard shortcuts' })
      .getByText('Save settings changes', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
});

test('organization settings revert, discard, and save from the fixed footer', async ({ page }) => {
  await signIn(page);
  await saveUploadPolicy(page, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/settings/files`);
  const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
  await expect(input).toHaveValue('');
  await input.fill('4096');
  await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await input.fill('');
  await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
  await input.fill('4096');
  await bar(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('4096');
  await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 4096,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const box = await bar(page).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await input.fill('8192');
  await saveUploadPolicy(page, 16384);
  await page.evaluate(() => window.dispatchEvent(new Event('organizationChanged')));
  await expect(bar(page).getByRole('status')).toHaveText(
    'These settings changed elsewhere.  Reload the stored values before saving.',
  );
  await expect(input).toHaveValue('8192');
  await bar(page).getByRole('button', { name: 'Reload stored values', exact: true }).click();
  await expect(input).toHaveValue('16384');
  await expect(bar(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await saveUploadPolicy(page, null);
  await page.goto(`${base()}/admin/security/files/max-upload-bytes`);
  await expect(bar(page)).toBeInViewport();
  await input.fill('32768');
  await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 32768,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await saveUploadPolicy(page, null);
  await page.goto(`${base()}/settings/preferences/${personalPage}/${personalSetting}`);
  await expect(
    page.locator(`[data-setting-page="${personalPage}"][data-setting-id="${personalSetting}"]`),
  ).toBeInViewport();
  await expect(bar(page)).toBeInViewport();
});

test('links, browser Back, and sign-out use the leave dialog and its three choices', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/settings/files`);
  const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
  await input.fill('8192');
  await page.getByRole('link', { name: personalLabel, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'You have unsaved changes on this page.' });
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('8192');
  await page.getByRole('link', { name: personalLabel, exact: true }).click();
  await dialog.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(personalPage));
  expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
    maxUploadBytes: 8192,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await page.getByRole('link', { name: 'File uploads', exact: true }).click();
  await input.fill('16384');
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(personalPage));
  await page.getByRole('link', { name: 'File uploads', exact: true }).click();
  await input.fill('32768');
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(input).toHaveValue('32768');
  await bar(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await saveUploadPolicy(page, null);
});

test('every registered settings page has only the footer save action', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  for (const section of new Set(collectSettings().map((setting) => setting.page))) {
    await page.goto(`${base()}/settings/${section}`);
    await expect(bar(page)).toBeVisible();
    await expect(page.locator('.rio-settings__content')).toBeVisible();
    await expect(page.locator('.rio-settings__content').getByRole('progressbar')).toHaveCount(0);
    await expect(
      page.locator('.rio-settings__content').getByRole('button', { name: /^Save(?:\s|$)/i }),
    ).toHaveCount(0);
  }
});

test('phone header controls remain reachable with monthly usage and a wide theme', async ({ page }) => {
  await signIn(page);
  const prior = await asOwner<{ preferences: Record<string, unknown> }>(page, 'GET', '/api/auth/session');
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'system-7' });
  await page.route('**/api/ai/footprint/mine', (route) =>
    route.fulfill({
      json: {
        used: true,
        month: '2026-10-01',
        calls: 123,
        pricedCalls: 123,
        estimatedCalls: 123,
        costUsd: 123.45,
        energyWh: { min: 10, max: 20 },
        gwpG: { min: 10, max: 20 },
        byFeature: [],
      },
    }),
  );
  try {
    await page.goto(`${base()}/settings/ai`);
    const desktopLauncher = page.getByRole('button', { name: 'AI: Ask Rio', exact: true });
    await expect(desktopLauncher).toBeVisible();
    const launcherBox = await desktopLauncher.boundingBox();
    const footerBox = await bar(page).boundingBox();
    const shellHeaderBox = (await page.locator('.rio-shell__header').boundingBox())!;
    const shellFooterBox = (await page.locator('.rio-shell__footer').boundingBox())!;
    // The AI button stays in the top bar, and the save bar keeps the footer to itself.
    expect(launcherBox!.y).toBeGreaterThanOrEqual(shellHeaderBox.y);
    expect(launcherBox!.y + launcherBox!.height).toBeLessThanOrEqual(
      shellHeaderBox.y + shellHeaderBox.height,
    );
    expect(footerBox!.y).toBeGreaterThanOrEqual(shellFooterBox.y);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(shellFooterBox.y + shellFooterBox.height);
    // AI spending shows only inside Rio's panel, never in the app's own top bar.
    await expect(page.locator('.rio-shell__header .rio-footprint-pill')).toHaveCount(0);
    await desktopLauncher.click();
    await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toBeVisible();
    await expect(
      page.locator('.rio-assistant__header').getByRole('button', { name: /^Your AI use this month:/ }),
    ).toBeVisible();
    await desktopLauncher.click();
    await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base()}/settings/ai`);
    await expect(page.locator('.rio-shell__header .rio-footprint-pill')).toHaveCount(0);
    const launcher = page.getByRole('button', { name: 'AI: Ask Rio', exact: true });
    await expect(launcher).toBeInViewport();
    const box = await launcher.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await launcher.click();
    await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toBeVisible();
    for (const control of await page.locator('.rio-assistant__header').getByRole('button').all()) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await expect(
      page.locator('.rio-assistant__header').getByRole('button', { name: /^Your AI use this month:/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await expect(bar(page)).toBeInViewport();
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', { theme: prior.preferences.theme ?? 'nature' });
  }
});

import type { IntegrationUpdate, IntegrationView } from '../../../packages/contracts/src/connections.js';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn, visit } from '../helpers';
import { saveUploadPolicy } from '../settings-policy';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const bar = (page: Page) => page.getByRole('region', { name: 'Save changes', exact: true });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function integrationPage(page: Page) {
  const views: IntegrationView[] = ['dropbox', 'box'].map((provider) => ({
    provider: provider as IntegrationView['provider'],
    clientId: 'initial-client',
    tenantId: '',
    apiKey: null,
    hasSecret: true,
    enabled: false,
    configured: true,
    fromEnvironment: false,
    redirectUri: new URL(`/callback/${provider}`, base()).href,
  }));
  const held = gate();
  const updates: IntegrationUpdate[] = [];
  await page.route('**/api/admin/integrations**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: views });
    const update = route.request().postDataJSON() as IntegrationUpdate;
    updates.push(update);
    if (updates.length === 1) await held.promise;
    const view = views.find((entry) => route.request().url().endsWith(`/${entry.provider}`))!;
    Object.assign(view, { clientId: update.clientId?.trim() ?? view.clientId });
    await route.fulfill({ json: view });
  });
  await page.goto(`${base()}/admin/connections/integrations/client-id`);
  const first = page.getByRole('region', { name: 'Dropbox', exact: true });
  const second = page.getByRole('region', { name: 'Box', exact: true });
  return { held, updates, first, second };
}

test('a queued provider keeps a reverted client ID until the next save on a phone', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { held, updates, first, second } = await integrationPage(page);
  try {
    const firstId = first.getByRole('textbox', { name: 'Client ID or app key', exact: true });
    const secondId = second.getByRole('textbox', { name: 'Client ID or app key', exact: true });
    await firstId.fill('first-change');
    await secondId.fill('second-change');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => updates.length).toBe(1);
    await secondId.fill('initial-client');
    held.release();
    await expect(bar(page).getByRole('status')).toHaveText('Unsaved changes');
    await expect(secondId).toHaveValue('initial-client');
    expect(updates[1]?.clientId).toBe('second-change');
    await secondId.press('ControlOrMeta+s');
    await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
    expect(updates[2]?.clientId).toBe('initial-client');
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  } finally {
    held.release();
  }
});

for (const newerSecret of [false, true]) {
  test(`a saved secret preserves a newer client ID and secret edit: ${newerSecret}`, async ({ page }) => {
    await signIn(page);
    const { held, updates, first } = await integrationPage(page);
    try {
      const clientId = first.getByRole('textbox', { name: 'Client ID or app key', exact: true });
      const secret = first.getByLabel('Client secret or app secret', { exact: true });
      const submitted = crypto.randomUUID();
      const newer = crypto.randomUUID();
      await secret.fill(submitted);
      await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => updates.length).toBe(1);
      await clientId.fill('new-client');
      if (newerSecret) await secret.fill(newer);
      held.release();
      await expect(bar(page).getByRole('status')).toHaveText('Unsaved changes');
      await expect(clientId).toHaveValue('new-client');
      await expect(secret).toHaveValue(newerSecret ? newer : '');
      await expect(bar(page).getByRole('button', { name: 'Reload stored values', exact: true })).toHaveCount(
        0,
      );
      await clientId.press('ControlOrMeta+s');
      await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
      expect(updates[1]?.clientSecret).toBe(newerSecret ? newer : undefined);
      await expect(secret).toHaveValue('');
    } finally {
      held.release();
    }
  });
}

test('concurrent upload saves reject the stale snapshot and keep its draft', async ({ page, browser }) => {
  await signIn(page);
  const prior = await asOwner<{ maxUploadBytes: number | null }>(page, 'GET', '/api/org/files');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const ownerSave = gate();
  const otherSave = gate();
  try {
    await saveUploadPolicy(page, 1024);
    const other = await context.newPage();
    await signIn(other);
    await page.goto(`${base()}/settings/files`);
    await visit(other, `${base()}/settings/files`);
    const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
    const otherInput = other.getByLabel('Maximum upload size (bytes)', { exact: true });
    await expect(input).toHaveValue('1024');
    await expect(otherInput).toHaveValue('1024');
    let captured = 0;
    await page.route('**/api/org/admin-commands', async (route) => {
      captured++;
      await ownerSave.promise;
      await route.continue();
    });
    await other.route('**/api/org/admin-commands', async (route) => {
      captured++;
      await otherSave.promise;
      await route.continue();
    });
    await input.fill('2048');
    await otherInput.fill('4096');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await bar(other).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => captured).toBe(2);
    ownerSave.release();
    await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
    const rejected = other.waitForResponse((response) => response.url().endsWith('/api/org/admin-commands'));
    otherSave.release();
    expect((await rejected).status()).toBe(409);
    await expect(otherInput).toHaveValue('4096');
    await expect(bar(other).getByRole('status')).toHaveText(
      'These settings changed elsewhere.  Reload the stored values before saving.',
    );
    const stored = await asOwner<{ maxUploadBytes: number }>(page, 'GET', '/api/org/files');
    expect(stored.maxUploadBytes).toBe(2048);
    await bar(other).getByRole('button', { name: 'Reload stored values', exact: true }).click();
    await expect(otherInput).toHaveValue('2048');
    await otherInput.fill('4096');
    await bar(other).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar(other).getByRole('status')).toHaveText('No unsaved changes');
  } finally {
    ownerSave.release();
    otherSave.release();
    await context.close();
    await page.unroute('**/api/org/admin-commands');
    await saveUploadPolicy(page, prior.maxUploadBytes);
  }
});

test('a normalized upload cap preserves a newer edit without a false conflict', async ({ page }) => {
  await signIn(page);
  const prior = await asOwner<{ maxUploadBytes: number | null }>(page, 'GET', '/api/org/files');
  const held = gate();
  try {
    await saveUploadPolicy(page, 1024);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base()}/settings/files`);
    let holdSave = true;
    // Expiring the last route can disable Chromium interception during the follow-up refresh.
    await page.route('**/api/org/admin-commands', async (route) => {
      if (!holdSave) {
        await route.continue();
        return;
      }
      holdSave = false;
      await held.promise;
      await route.continue();
    });
    const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
    await input.fill('02048');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar(page).getByRole('status')).toHaveText('Saving changes…');
    await input.fill('4096');
    held.release();
    await expect(bar(page).getByRole('status')).toHaveText('Unsaved changes');
    await expect(input).toHaveValue('4096');
    await expect(bar(page).getByRole('button', { name: 'Reload stored values', exact: true })).toHaveCount(0);
    const stored = await asOwner<{ maxUploadBytes: number }>(page, 'GET', '/api/org/files');
    expect(stored.maxUploadBytes).toBe(2048);
    await input.press('ControlOrMeta+s');
    await expect(bar(page).getByRole('status')).toHaveText('No unsaved changes');
    const updated = await asOwner<{ maxUploadBytes: number }>(page, 'GET', '/api/org/files');
    expect(updated.maxUploadBytes).toBe(4096);
  } finally {
    held.release();
    await page.unroute('**/api/org/admin-commands');
    await saveUploadPolicy(page, prior.maxUploadBytes);
  }
});

import { expect } from '../accessibility';
import { test } from '../sign-in-settings';
import { signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/**
 * Settings lists single sign-on providers and adds one.  There's no real provider to sign in with
 * here, so the test stops at the list, then deletes the provider so later pages sign in as before.
 */
test('Settings adds a single sign-on provider and lists it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Single sign-on' }).click();
  await expect(page.getByRole('heading', { name: 'Single sign-on', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add a provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a provider' });
  await dialog.getByText('Google', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Google' })).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Button label' })).toHaveValue('Google');
  await expect(
    dialog.getByRole('textbox', { name: 'Callback address to register with the provider' }),
  ).toHaveValue(/\/api\/auth\/sso\/callback$/);
  await dialog.getByRole('textbox', { name: 'Client ID' }).fill('riosoma-e2e.apps.example.test');
  await dialog.getByRole('textbox', { name: 'Client secret' }).fill('e2e-client-secret-not-real');
  await dialog.getByRole('textbox', { name: 'Email domains that may create accounts' }).fill('example.test');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const provider = page.getByRole('button', { name: 'Google', exact: true });
  await expect(provider).toBeVisible();
  const summary = page.getByText(/Google\s*On\s*0 people/);
  await expect(summary).toBeVisible();
  await provider.click();
  await expect(page.getByRole('textbox', { name: 'Client ID' })).toHaveValue('riosoma-e2e.apps.example.test');
  // A stored secret is never shown again, only replaced.
  await expect(page.getByRole('group', { name: 'Client secret' })).toContainText('Stored');

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete Google?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(provider).toHaveCount(0);
});

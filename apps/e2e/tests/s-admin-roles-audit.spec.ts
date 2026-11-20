import { expect, test } from '../accessibility';
import { test as it } from '../sign-in-settings';
import { asOwner, signIn } from '../helpers';
import { invite } from '../people';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('the owner assigns an Audit role and the member filters and exports the log', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Morgan Vale');
  try {
    await page.goto(`${base()}/settings/people`);
    const row = page.getByRole('listitem').filter({ hasText: person.email });
    await row.getByRole('button', { name: `Actions for ${person.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Admin roles', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`member=${person.id}`));
    const roles = page.getByRole('region', { name: 'Admin roles', exact: true });
    await roles.getByText('Audit', { exact: true }).click();
    await expect(roles.getByRole('checkbox', { name: 'Audit', exact: true })).toBeChecked();
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(roles.getByRole('status')).toContainText('Admin roles saved.');

    await person.page.goto(`${base()}/settings/audit`);
    await person.page.getByRole('textbox', { name: 'Action', exact: true }).fill('organization.roles');
    await person.page.getByRole('textbox', { name: 'Resource', exact: true }).fill(person.id);
    await person.page.getByRole('button', { name: 'Filter events' }).click();
    await expect(person.page).toHaveURL(/action=organization.roles/);
    const event = person.page.getByRole('link', { name: 'organization.roles', exact: true });
    await expect(event).toHaveCount(1);
    await event.click();
    await expect(person.page.getByRole('heading', { name: 'Event details' })).toBeVisible();
    await expect(person.page).toHaveURL(/event=/);
    await person.page.reload();
    await expect(person.page.getByRole('textbox', { name: 'Resource', exact: true })).toHaveValue(person.id);
    await expect(person.page.getByRole('heading', { name: 'Event details' })).toBeVisible();
    await person.page.getByRole('button', { name: 'Check integrity' }).click();
    await expect(person.page.getByRole('status').filter({ hasText: 'No breaks found.' })).toBeVisible();
    const download = person.page.waitForEvent('download');
    await person.page.getByRole('button', { name: 'Export JSON' }).click();
    expect((await download).suggestedFilename()).toBe('audit.json');
    await person.page.setViewportSize({ width: 390, height: 844 });
    expect(await person.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  } finally {
    await person.context.close();
  }
});

test('a preset shows its changes before it is applied', async ({ page }) => {
  await signIn(page);
  await page.goto(`${base()}/settings/security?preset=balanced`);
  await expect(page.getByRole('heading', { name: 'Organization presets' })).toBeVisible();
  await expect(page.getByText('Shortest password allowed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply preset', exact: true })).toBeVisible();
});

it('Open turns off a required second step and the owner can undo it', async ({ page }) => {
  await signIn(page);
  await asOwner(page, 'PUT', '/api/admin/mfa/policy', { policy: 'everyone' });
  await page.goto(`${base()}/settings/security?preset=open`);
  await page.getByRole('button', { name: 'Apply preset', exact: true }).click();
  expect(await asOwner(page, 'GET', '/api/admin/mfa/policy')).toEqual({ policy: 'everyone' });
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Organization presets' }).getByRole('status')).toContainText(
    'Preset applied.',
  );
  expect(await asOwner(page, 'GET', '/api/admin/mfa/policy')).toEqual({ policy: 'off' });
  await page.getByRole('button', { name: 'Undo change', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo change', exact: true })).toHaveCount(0);
  expect(await asOwner(page, 'GET', '/api/admin/mfa/policy')).toEqual({ policy: 'everyone' });
});

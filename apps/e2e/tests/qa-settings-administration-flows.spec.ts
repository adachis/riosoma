import { randomUUID } from 'node:crypto';
import type { OrgUnit, UnitPolicyView } from '../../../packages/contracts/src/org-units.js';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn, visit } from '../helpers';
import { waitForMail } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('personal appearance changes discard, save with the keyboard, and survive reload on a phone', async ({
  page,
}) => {
  await signIn(page);
  const prior = await asOwner<{ preferences: { recordLayout?: string } }>(page, 'GET', '/api/auth/session');
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, `${base()}/settings/preferences/appearance/record-layout`);
    const layout = page.getByRole('button', { name: /Record layout/ });
    const bar = page.getByRole('region', { name: 'Save changes', exact: true });
    await layout.press('Enter');
    await page.getByRole('option', { name: 'Side panel', exact: true }).press('Enter');
    await expect(layout).toContainText('Side panel');
    expect((await asOwner<typeof prior>(page, 'GET', '/api/auth/session')).preferences.recordLayout).toBe(
      'card',
    );
    await bar.getByRole('button', { name: 'Discard', exact: true }).press('Enter');
    await expect(layout).toContainText('Card');
    await layout.press('Enter');
    await page.getByRole('option', { name: 'Side panel', exact: true }).press('Enter');
    await layout.press('ControlOrMeta+s');
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    expect((await asOwner<typeof prior>(page, 'GET', '/api/auth/session')).preferences.recordLayout).toBe(
      'panel',
    );
    await page.reload();
    await expect(layout).toContainText('Side panel');
    await expect(
      page.locator('[data-setting-page="appearance"][data-setting-id="record-layout"]'),
    ).toBeInViewport();
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', {
      recordLayout: prior.preferences.recordLayout ?? 'card',
    });
  }
});

test('people invitations validate, send mail, deduplicate addresses, and revoke on a phone', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/settings/people`);
  const input = page.getByRole('textbox', { name: 'Email addresses', exact: true });
  await input.fill('invalid-address');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled();
  const email = `settings-${randomUUID()}@example.test`;
  await input.fill(`${email}, ${email.toUpperCase()}`);
  await page.getByRole('button', { name: /Invite as/ }).click();
  await page.getByRole('option', { name: 'Guest', exact: true }).click();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const pending = page.getByRole('region', { name: 'Waiting to join', exact: true });
  const row = pending.getByRole('listitem').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  const mail = await waitForMail((message) => message.to.includes(email), 'the settings invitation');
  expect(mail.text).toContain('/join#token=');
  const invitations = await asOwner<Array<{ email: string; kind: string }>>(
    page,
    'GET',
    '/api/org/invitations',
  );
  expect(invitations.filter((invitation) => invitation.email === email)).toEqual([
    expect.objectContaining({ email, kind: 'guest' }),
  ]);
  await row.getByRole('button', { name: `Revoke the invitation to ${email}?`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: `Revoke the invitation to ${email}?`, exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(
    (await asOwner<Array<{ email: string }>>(page, 'GET', '/api/org/invitations')).some(
      (invitation) => invitation.email === email,
    ),
  ).toBe(false);
});

test('unit dialogs are named, Unicode names survive reload, and inherited theme policy stays visible', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/settings/org-units`);
  const add = page.getByRole('button', { name: 'Make a unit', exact: true });
  await expect(add).toHaveAttribute('data-icon-only', 'true');
  await expect(add).toHaveAttribute('data-tooltip', 'Make a unit');
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Make a unit', exact: true });
  await expect(dialog).toBeVisible();
  const name = `PlanningReferenceMaterialAndImplementationRequirements 記録🌊مرحبا ${randomUUID()}`;
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const units = await asOwner<OrgUnit[]>(page, 'GET', '/api/org/units');
  const unit = units.find((entry) => entry.name === name)!;
  expect(unit).toBeTruthy();
  const organizationPolicy = await asOwner<UnitPolicyView>(page, 'GET', '/api/admin/unit-policy');
  try {
    await expect(page).toHaveURL(new RegExp(`unit=${unit.id}`));
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = (await page.locator('.rio-units').boundingBox())!;
        return bounds.x >= 0 && bounds.x + bounds.width <= 390;
      })
      .toBe(true);
    for (const control of [
      page.getByRole('button', { name, exact: true }),
      page.getByRole('heading', { name, exact: true, level: 2 }),
    ]) {
      await expect
        .poll(() => control.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }
    const policy = page.getByRole('region', { name: 'Policy', exact: true });
    const stored = await asOwner<UnitPolicyView>(page, 'GET', `/api/org/units/${unit.id}/policy`);
    await expect(policy.getByRole('group', { name: 'Themes people can choose', exact: true })).toBeVisible();
    await expect(policy.getByRole('button', { name: /Default theme/ })).toBeVisible();
    await expect(policy.getByText('Set by the organization', { exact: true }).first()).toBeVisible();
    expect(stored.origins.allowedThemes.id).toBeNull();
    expect(stored.origins.defaultTheme.id).toBeNull();
    const organization = page.getByRole('region', { name: 'Organization policy', exact: true });
    await organization.getByRole('checkbox', { name: 'Bauhaus', exact: true }).press('Space');
    await organization.getByRole('button', { name: /Default theme/ }).click();
    await page.getByRole('option', { name: 'Bauhaus', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Bauhaus', exact: true })).toHaveCount(0);
    await organization.getByRole('button', { name: /Default theme/ }).click();
    await page.getByRole('option', { name: 'Bauhaus', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Bauhaus', exact: true })).toHaveCount(0);
    await organization.getByRole('button', { name: /Default theme/ }).click();
    await page.getByRole('option', { name: 'Bauhaus', exact: true }).press('Enter');
    await expect(page.getByRole('option', { name: 'Bauhaus', exact: true })).toHaveCount(0);
    const bar = page.getByRole('region', { name: 'Save changes', exact: true });
    await bar.getByRole('button', { name: 'Discard', exact: true }).click();
    expect((await asOwner<UnitPolicyView>(page, 'GET', '/api/admin/unit-policy')).own).toEqual(
      organizationPolicy.own,
    );
    await organization.getByRole('checkbox', { name: 'Bauhaus', exact: true }).press('Space');
    await organization.getByRole('button', { name: /Default theme/ }).click();
    await page.getByRole('option', { name: 'Bauhaus', exact: true }).click();
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    const inherited = await asOwner<UnitPolicyView>(page, 'GET', `/api/org/units/${unit.id}/policy`);
    expect(inherited.values.allowedThemes).toEqual(['bauhaus']);
    expect(inherited.values.defaultTheme).toBe('bauhaus');
    expect(inherited.origins.defaultTheme.id).toBeNull();
    await page.getByRole('button', { name: `Rename or move ${name}`, exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Rename or move', exact: true });
    await expect(edit.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.screenshot({ path: info.outputPath('unit-settings-phone.png') });
    await info.attach('unit-name-geometry', {
      contentType: 'application/json',
      body: JSON.stringify(
        await page.locator('.rio-units').evaluate((element) => ({
          section: element.getBoundingClientRect().toJSON(),
          name: element.querySelector('.rio-units__grow')?.getBoundingClientRect().toJSON(),
          heading: element.querySelector('.rio-units__selected > h2')?.getBoundingClientRect().toJSON(),
        })),
      ),
    });
    await expect
      .poll(async () => {
        const bounds = (await page.locator('.rio-units').boundingBox())!;
        return bounds.x >= 0 && bounds.x + bounds.width <= 390;
      })
      .toBe(true);
    await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Delete this unit?', exact: true });
    await remove.getByRole('button', { name: 'Delete unit', exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  } finally {
    await asOwner(page, 'PUT', '/api/admin/unit-policy', {
      values: organizationPolicy.own,
      overridable: organizationPolicy.overridable,
    });
    if ((await asOwner<OrgUnit[]>(page, 'GET', '/api/org/units')).some((entry) => entry.id === unit.id))
      await asOwner(page, 'DELETE', `/api/org/units/${unit.id}`);
  }
});

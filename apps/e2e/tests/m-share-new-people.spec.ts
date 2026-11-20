import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, signIn, visit } from '../helpers';
import { mailTo, waitForMail } from '../people';

test.use({ serviceWorkers: 'block' });

interface PolicyView {
  own: Record<string, unknown>;
  overridable: string[];
}
let original: PolicyView;
test.beforeEach(async ({ page }) => {
  await signIn(page);
  original = await asOwner<PolicyView>(page, 'GET', '/api/admin/unit-policy');
  await setPolicy(page, {
    newPeopleSharing: true,
    newPeopleAdministratorsOnly: false,
    newPeopleRole: 'guest',
    externalSharing: true,
    guestInvitations: true,
    allowedEmailDomains: null,
  });
});
test.afterEach(async ({ page }) => {
  if (original)
    await asOwner(page, 'PUT', '/api/admin/unit-policy', {
      values: original.own,
      overridable: original.overridable,
    });
});

async function setPolicy(page: Page, changes: Record<string, unknown>) {
  const view = await asOwner<PolicyView>(page, 'GET', '/api/admin/unit-policy');
  await asOwner(page, 'PUT', '/api/admin/unit-policy', {
    values: { ...view.own, ...changes },
    overridable: view.overridable,
  });
}
async function openSharing(page: Page) {
  const name = `Shared projects ${randomBytes(4).toString('hex')}`;
  const database = {
    ...(await createDatabase(page, name, [{ name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] }])),
    name,
  };
  await visit(page, `${base()}/${database.id}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${database.name}` });
  await expect(dialog.getByRole('combobox', { name: 'Add people' })).toBeEnabled();
  return { database, dialog };
}
const address = () => `new.${randomBytes(6).toString('hex')}@example.test`;

for (const outcome of ['allowed', 'members', 'domains', 'malformed'] as const) {
  test(`sharing explains the ${outcome} outcome at phone width`, async ({ page }) => {
    if (outcome === 'members')
      await setPolicy(page, {
        newPeopleSharing: false,
        newPeopleAdministratorsOnly: true,
        allowedEmailDomains: ['allowed.test'],
      });
    if (outcome === 'domains')
      await setPolicy(page, { allowedEmailDomains: ['allowed.test', 'sub.allowed.test'] });
    await page.setViewportSize({ width: 390, height: 844 });
    const { dialog } = await openSharing(page);
    await dialog
      .getByRole('combobox', { name: 'Add people' })
      .fill(outcome === 'malformed' ? 'person@@example.test' : address());
    if (outcome === 'allowed') {
      await expect(page).toHaveURL(/share=open/);
      await page.reload();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Add people' }).fill(address());
      await expect(dialog).toContainText('Not a member yet, will be invited');
      await dialog.getByRole('combobox', { name: 'Add people' }).press('Escape');
      await expect(dialog.getByRole('button', { name: 'Invite and share' })).toBeVisible();
    } else {
      await expect(dialog).toContainText(
        outcome === 'members'
          ? 'Sharing is limited to members.'
          : outcome === 'domains'
            ? 'allowed.test, sub.allowed.test'
            : 'Enter a valid email address.',
      );
      await expect(dialog.getByRole('button', { name: 'Invite and share' })).toHaveCount(0);
    }
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('an emailed sharing invitation fixes the address, grants the selected access, and opens the item', async ({
  page,
  browser,
}) => {
  const { database, dialog } = await openSharing(page);
  const email = address();
  const input = dialog.getByRole('combobox', { name: 'Add people' });
  await input.fill(email);
  await input.press('Escape');
  await dialog.getByRole('button', { name: 'Access for the invited person' }).click();
  await page.getByRole('option', { name: labelName('Reader'), exact: true }).click();
  await dialog.getByRole('button', { name: 'Invite and share' }).click();
  const row = dialog.getByRole('listitem').filter({ hasText: email });
  await expect(row).toContainText('Invited');
  await expect(row.getByRole('button', { name: `Reader ${email}`, exact: true })).toContainText('Reader');
  const first = await waitForMail((mail) => mail.to.includes(email), 'the sharing invitation');
  expect(first.text).toContain(`shared ${database.name}`);
  await row.getByRole('button', { name: 'Resend invitation' }).click();
  await expect.poll(() => mailTo(email).length).toBe(2);
  const newest = mailTo(email).at(-1)!;
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    let invited = await context.newPage();
    const oldLink = first.text.match(/https?:\/\/\S+\/join#token=[\w-]+/)![0];
    await visit(invited, oldLink);
    await expect(invited.getByRole('alert')).toContainText('expired, was revoked, or was already used');
    await invited.close();
    invited = await context.newPage();
    const link = newest.text.match(/https?:\/\/\S+\/join#token=[\w-]+/)![0];
    await visit(invited, link);
    await expect(invited.getByRole('textbox', { name: 'Invited email address' })).toHaveValue(email);
    await expect(invited.getByRole('textbox', { name: 'Invited email address' })).toHaveAttribute('readonly');
    await invited.getByRole('textbox', { name: 'Your name' }).fill('Casey Shared');
    await invited.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(invited).toHaveURL(new RegExp(`/${database.id}`));
    await expect(invited.getByRole('heading', { name: database.name, exact: true })).toBeVisible();
    const schema = await invited.request.get(`${base()}/api/databases/${database.id}/schema`);
    expect(schema.ok(), await schema.text()).toBe(true);
    const info = await (await invited.request.get(`${base()}/api/auth/session`)).json();
    const grants = await asOwner<Array<{ principal: { id?: string }; role: string }>>(
      page,
      'GET',
      `/api/databases/${database.id}/grants`,
    );
    expect(grants.find((grant) => grant.principal.id === info.user.id)?.role).toBe('reader');
  } finally {
    await context.close();
  }

  const revokedEmail = address();
  await input.fill(revokedEmail);
  await input.press('Escape');
  await dialog.getByRole('button', { name: 'Invite and share' }).click();
  const revoked = dialog.getByRole('listitem').filter({ hasText: revokedEmail });
  await revoked.getByRole('button', { name: 'Revoke invitation' }).click();
  await expect(revoked).toHaveCount(0);
  expect(
    (await asOwner<Array<{ email: string }>>(page, 'GET', '/api/org/invitations')).some(
      (invite) => invite.email === revokedEmail,
    ),
  ).toBe(false);
});

test('sharing settings save, discard, search, and deep-link without organizational units', async ({
  page,
}) => {
  await visit(page, `${base()}/admin/security/sign-in-policy/allowedEmailDomains`);
  const domains = page.getByRole('textbox', { name: 'Allowed email domains', exact: true });
  await expect(domains).toBeVisible();
  const bar = page.getByRole('region', { name: 'Save changes', exact: true });
  await domains.fill('EXAMPLE.TEST, sub.example.test');
  await domains.press('Enter');
  await expect(bar.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await bar.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(domains).toHaveValue('');
  await domains.fill('example.test, sub.example.test');
  await bar.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
  const view = await asOwner<PolicyView>(page, 'GET', '/api/admin/unit-policy');
  expect(view.own.allowedEmailDomains).toEqual(['example.test', 'sub.example.test']);
  await page.reload();
  await expect(domains).toHaveValue('example.test, sub.example.test');
  const search = page.getByRole('combobox', { name: 'Search settings' });
  await search.fill('Allowed email domains');
  await expect(page.getByRole('option', { name: /Allowed email domains/ })).toBeVisible();
});

test('the email-disabled response offers a copyable invitation link', async ({ page }) => {
  const email = address();
  const link = `${base()}/join#token=${randomBytes(32).toString('base64url')}`;
  let invited = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, 'copiedInvitation', text);
        },
      },
    });
  });
  await page.route('**/api/databases/*/invitations', (route) =>
    route.fulfill({
      json: {
        allowed: true,
        administratorsOnly: false,
        domains: [],
        kind: 'guest',
        mailAvailable: false,
        pending: invited
          ? [
              {
                id: 'pending',
                email,
                role: 'editor',
                expiresAt: new Date(Date.now() + 604_800_000).toISOString(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route('**/api/home/commands', async (route) => {
    const body = route.request().postDataJSON() as { id: string; action: { kind: string } };
    if (body.action.kind !== 'share.invite') {
      await route.fallback();
      return;
    }
    invited = true;
    await route.fulfill({ json: { id: body.id, status: 'applied', invitationLink: link } });
  });
  const { dialog } = await openSharing(page);
  const input = dialog.getByRole('combobox', { name: 'Add people' });
  await input.fill(email);
  await input.press('Escape');
  await dialog.getByRole('button', { name: 'Invite and share' }).click();
  await expect(dialog).toContainText('Email is not set up.');
  await expect(dialog.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(link);
  await dialog.getByRole('button', { name: 'Copy invitation link' }).click();
  await expect(dialog).toContainText('Invitation link copied');
  expect(await page.evaluate(() => Reflect.get(window, 'copiedInvitation'))).toBe(link);
});

test('the folder sharing dialog invites a new address with a long name at phone width', async ({ page }) => {
  const folderId = `folder-${newId('cmd')}`;
  const name = `Shared workspace ${'long name '.repeat(9)}`;
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, name, parentId: null },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, base());
  await page.getByRole('button', { name: `More for ${name.trim()}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Share'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${name.trim()}` });
  await expect(page).toHaveURL(new RegExp(`share=${folderId}`));
  await page.reload();
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox', { name: 'Add people' });
  await input.fill(address());
  await input.press('Escape');
  await dialog.getByRole('button', { name: 'Invite and share' }).click();
  await expect(dialog).toContainText('Invited');
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

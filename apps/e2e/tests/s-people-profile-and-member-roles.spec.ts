import { randomBytes } from 'node:crypto';
import { expect, test, documentIdentity } from '../accessibility';
import { asOwner, createDatabase, runCommands, OWNER, signIn, visit } from '../helpers';
import { invite, waitForMail } from '../people';
import { base } from '../base';
import { rows } from '../sql';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function action(page: Page, name: string, label: string) {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return page.getByRole('dialog', { name: `${label}: ${name}`, exact: true });
}

test('a profile picture and name reach another browser, and email waits for confirmation', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const person = await invite(page, browser, 'Morgan Profile');
  const grouped = await page.context().newPage();
  try {
    const database = await createDatabase(person.page, 'Live profile groups', [
      {
        name: 'Records',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Person', type: 'user' },
          { name: 'Created by', type: 'createdBy' },
          { name: 'Last modified by', type: 'lastModifiedBy' },
        ],
        records: [{ Name: 'Profile record', Person: [person.id] }],
      },
    ]);
    const table = database.tables.Records!;
    const identity = await asOwner<{ org: { id: string } }>(person.page, 'GET', '/api/auth/session');
    await asOwner(person.page, 'PUT', `/api/databases/${database.id}/grants`, {
      principal: { kind: 'org', id: identity.org.id },
      role: 'reader',
    });
    await runCommands(person.page, database.id, [
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: {
          groups: ['Person', 'Created by', 'Last modified by'].map((name) => ({
            fieldId: table.fields[name]!,
            direction: 'asc',
          })),
        },
      },
    ]);
    await visit(grouped, `${base()}/${database.id}/${table.id}/${table.viewId}`);
    await expect(grouped.getByRole('treegrid', { name: 'Grid' })).toBeVisible();
    const groupAvatars = grouped.locator('.rio-grid-group-value .rio-person-avatar');
    await expect(groupAvatars).toHaveCount(3);
    const groupedDocument = await documentIdentity(grouped);
    await visit(page, `${base()}/settings/people`);
    const beforeDocument = await documentIdentity(page);
    const row = page.getByRole('listitem').filter({ hasText: person.email });
    await expect(row.getByRole('button', { name: `Actions for ${person.name}` })).toBeVisible();
    await visit(person.page, `${base()}/settings/profile`);
    const name = 'Morgan Updated';
    await person.page.getByRole('textbox', { name: 'Display name', exact: true }).fill(name);
    const data = await person.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 100;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#237561';
      context.fillRect(0, 0, 160, 100);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await person.page
      .locator('input[type=file]')
      .setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    const crop = person.page.getByRole('dialog', { name: 'Crop your picture' });
    await expect(crop).toBeVisible();
    await crop.getByRole('slider', { name: 'Zoom' }).focus();
    await person.page.keyboard.press('ArrowRight');
    await crop.getByRole('button', { name: 'Use picture' }).click();
    await person.page
      .getByRole('region', { name: 'Save changes' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(row.getByRole('button', { name: `Actions for ${name}` })).toBeVisible();
    await expect(row.locator('.rio-person-avatar img')).toBeVisible();
    await expect(groupAvatars.locator('img')).toHaveCount(3);
    const firstPicture = await groupAvatars.locator('img').first().getAttribute('src');
    const replacement = await person.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 100;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#624284';
      context.fillRect(0, 0, 100, 100);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await person.page.locator('input[type=file]').setInputFiles({
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: Buffer.from(replacement, 'base64'),
    });
    await crop.getByRole('button', { name: 'Use picture' }).click();
    await person.page
      .getByRole('region', { name: 'Save changes' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect
      .poll(() =>
        groupAvatars
          .locator('img')
          .evaluateAll(
            (images, previous) =>
              images.map((image) => image.getAttribute('src')).filter((src) => src && src !== previous)
                .length,
            firstPicture,
          ),
      )
      .toBe(3);
    expect(await documentIdentity(page)).toBe(beforeDocument);
    expect(await documentIdentity(grouped)).toBe(groupedDocument);
    await person.page.getByRole('button', { name: 'Remove profile picture' }).click();
    await person.page
      .getByRole('region', { name: 'Save changes' })
      .getByRole('button', { name: 'Discard', exact: true })
      .click();
    await expect(person.page.locator('.rio-profile__picture img')).toBeVisible();
    await person.page.getByRole('button', { name: 'Remove profile picture' }).click();
    await person.page
      .getByRole('region', { name: 'Save changes' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(row.locator('.rio-person-avatar img')).toHaveCount(0);
    await expect(groupAvatars.locator('img')).toHaveCount(0);
    await expect(groupAvatars.first()).toHaveText('MU');

    await person.page.getByRole('button', { name: 'Change email address', exact: true }).click();
    const email = `profile.${randomBytes(8).toString('hex')}@example.test`;
    const dialog = person.page.getByRole('dialog', { name: 'Change email address' });
    await dialog.getByRole('textbox', { name: 'New email address' }).fill(email);
    await dialog.getByRole('button', { name: 'Send confirmation link' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Check your new address for the confirmation link.');
    expect(
      (await asOwner<{ user: { email: string } }>(person.page, 'GET', '/api/auth/session')).user.email,
    ).toBe(person.email);
    const mail = await waitForMail((mail) => mail.to.includes(email), 'the email confirmation');
    const link = new RegExp(`${base()}/settings/profile\\?emailToken=[\\w-]+`).exec(mail.text)?.[0];
    expect(link).toBeTruthy();
    await visit(person.page, link!);
    await person.page
      .getByRole('dialog', { name: 'Confirm your new email address' })
      .getByRole('button', { name: 'Confirm your new email address' })
      .click();
    await expect(person.page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(email);
    await waitForMail(
      (mail) => mail.to.includes(person.email) && mail.subject === 'Your Riosoma email address changed',
      'the notice to the old address',
    );
    await person.page.setViewportSize({ width: 390, height: 844 });
    expect(await person.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await grouped.close();
    await person.context.close();
  }
});

test('roles, lifecycle, counts, and owner guards work with the affected tab open at phone width', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const person = await invite(page, browser, 'Alexandria People With A Long Display Name');
  try {
    await visit(page, `${base()}/settings/people`);
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.getByRole('listitem').filter({ hasText: person.email });
    for (const role of ['Guest', 'Member']) {
      const dialog = await action(page, person.name, 'Change role');
      await dialog.getByRole('button', { name: / Role$/ }).click();
      await page.getByRole('option', { name: role, exact: true }).click();
      await dialog.getByRole('button', { name: 'Change role', exact: true }).click();
      await expect(row.getByText(role, { exact: true })).toBeVisible();
      await expect
        .poll(
          async () =>
            (await asOwner<{ membership: { kind: string } }>(person.page, 'GET', '/api/auth/session'))
              .membership.kind,
        )
        .toBe(role.toLowerCase());
    }
    const accessNotice = () =>
      page.getByRole('alertdialog', { name: `Updated access for ${person.name}`, exact: true }).first();
    const undo = () => accessNotice().getByRole('button', { name: 'Undo', exact: true }).click();
    await undo();
    await expect(row.getByText('Guest', { exact: true })).toBeVisible();
    const restoreRole = await action(page, person.name, 'Change role');
    await restoreRole.getByRole('button', { name: / Role$/ }).click();
    await page.getByRole('option', { name: 'Member', exact: true }).click();
    await restoreRole.getByRole('button', { name: 'Change role', exact: true }).click();
    await expect(row.getByText('Member', { exact: true })).toBeVisible();
    const ownerGuard = await action(page, OWNER.name, 'Deactivate');
    await expect(ownerGuard.getByRole('status')).toHaveText(
      'The last active owner cannot be demoted, deactivated, or removed.  Make another active person an owner first.',
    );
    await expect(ownerGuard.getByRole('button', { name: 'Deactivate', exact: true })).toBeDisabled();
    await ownerGuard.getByRole('button', { name: 'Cancel' }).click();
    const demotion = await action(page, OWNER.name, 'Change role');
    await demotion.getByRole('button', { name: / Role$/ }).click();
    await page.getByRole('option', { name: 'Member', exact: true }).click();
    await expect(demotion.getByRole('status')).toHaveText(
      'The last active owner cannot be demoted, deactivated, or removed.  Make another active person an owner first.',
    );
    await demotion.getByRole('button', { name: 'Cancel' }).click();
    await (
      await action(page, person.name, 'Make owner')
    )
      .getByRole('button', { name: 'Make owner', exact: true })
      .click();
    await expect(row.getByText('Owner', { exact: true })).toBeVisible();
    const demote = await action(page, person.name, 'Change role');
    await demote.getByRole('button', { name: / Role$/ }).click();
    await page.getByRole('option', { name: 'Member', exact: true }).click();
    await demote.getByRole('button', { name: 'Change role', exact: true }).click();
    await expect(row.getByText('Member', { exact: true })).toBeVisible();

    const deactivate = await action(page, person.name, 'Deactivate');
    await expect(deactivate).toContainText('Their automations keep running');
    await deactivate.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await expect(person.page.getByRole('heading', { name: 'Your account is deactivated' })).toBeVisible();
    await expect(row.getByText('Deactivated', { exact: true })).toBeVisible();
    await undo();
    await expect(row.getByText('Deactivated', { exact: true })).toHaveCount(0);
    expect((await person.page.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
    await (
      await action(page, person.name, 'Deactivate')
    )
      .getByRole('button', { name: 'Deactivate', exact: true })
      .click();
    await expect(row.getByText('Deactivated', { exact: true })).toBeVisible();
    await accessNotice().getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByRole('button', { name: / Filter by status$/ }).click();
    await page.getByRole('option', { name: 'Deactivated', exact: true }).click();
    await expect(page).toHaveURL(/status=deactivated/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await (
      await action(page, person.name, 'Reactivate')
    )
      .getByRole('button', { name: 'Reactivate', exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect((await person.page.request.get(`${base()}/api/auth/session`)).status()).toBe(401);
    await visit(person.page, `${base()}/sign-in`);
    await person.page.getByRole('textbox', { name: 'Email address', exact: true }).fill(person.email);
    await person.page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await person.page.getByRole('button', { name: 'Send link', exact: true }).click();
    const mail = await waitForMail(
      (mail) => mail.to.includes(person.email) && mail.subject === 'Sign in to Riosoma',
      'a new sign-in link',
    );
    const link = new RegExp(`${base()}/sign-in/link#token=[\\w-]+`).exec(mail.text)?.[0];
    expect(link).toBeTruthy();
    await visit(person.page, link!);
    await expect(person.page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  } finally {
    await asOwner(page, 'PATCH', `/api/org/members/${person.id}/status`, { deactivated: false });
    await asOwner(page, 'PATCH', `/api/org/members/${person.id}/role`, { role: 'member' });
    await person.context.close();
  }
});

test('ownership transfer requires proof, changes both roles together, and offers no undo', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const person = await invite(page, browser, 'Casey Ownership');
  try {
    await visit(page, `${base()}/settings/people`);
    const dialog = await action(page, person.name, 'Transfer ownership');
    await expect(dialog).toContainText('This cannot be undone.');
    await expect(dialog.getByRole('button', { name: 'Transfer ownership', exact: true })).toBeDisabled();
    await dialog.getByLabel('Current password', { exact: true }).fill(randomBytes(12).toString('base64url'));
    await dialog.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Confirm with your current password');
    await dialog.getByLabel('Current password', { exact: true }).fill(OWNER.password);
    await dialog.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await asOwner<{ membership: { kind: string } }>(person.page, 'GET', '/api/auth/session')).membership
        .kind,
    ).toBe('owner');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await visit(person.page, `${base()}/settings/people`);
    const ownerEmail = person.page
      .locator('.rio-people__identity > .rio-text')
      .and(person.page.getByText(OWNER.email, { exact: true }));
    const formerOwner = person.page.getByRole('listitem').filter({ has: ownerEmail });
    await expect(formerOwner).toHaveCount(1);
    await expect(
      formerOwner.locator('.rio-people__identity > .rio-text').filter({ hasText: /^Member$/ }),
    ).toBeVisible();
  } finally {
    const recipient = await asOwner<{ membership: { kind: string } }>(
      person.page,
      'GET',
      '/api/auth/session',
    );
    if (recipient.membership.kind === 'owner') {
      const original = (await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session')).user.id;
      await asOwner(person.page, 'PATCH', `/api/org/members/${original}/role`, { role: 'owner' });
    }
    await asOwner(page, 'PATCH', `/api/org/members/${person.id}/role`, { role: 'member' });
    await person.context.close();
  }
});

test('directory fields, lifecycle, owner reach, and administration roles explain their guards', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const manager = await invite(page, browser, 'Robin Scoped Administrator');
  const managed = await invite(page, browser, 'Taylor Directory');
  const inactive = await invite(page, browser, 'Jordan Inactive');
  const session = await asOwner<{ org: { id: string }; user: { id: string } }>(
    page,
    'GET',
    '/api/auth/session',
  );
  const [namespace] = await rows<{ table_schema: string }>(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = 'scim_users'",
  );
  const unit = await asOwner<{ id: string }>(page, 'POST', '/api/org/units', {
    name: `People ${randomBytes(6).toString('hex')}`,
    parentId: null,
  });
  try {
    for (const person of [manager, managed, inactive])
      await asOwner(page, 'PUT', `/api/org/members/${person.id}/unit`, { unitId: unit.id });
    await asOwner(page, 'PUT', `/api/org/units/${unit.id}/admins/${manager.id}`, { roles: ['people'] });
    // A directory has linked this existing person, as provisioning does after domain verification.
    await rows(
      `INSERT INTO "${namespace!.table_schema}".scim_users (org_id, user_id, document) VALUES ($1, $2, $3::jsonb)`,
      [session.org.id, managed.id, JSON.stringify({ userName: managed.email, active: true })],
    );
    await visit(managed.page, `${base()}/settings/profile`);
    await expect(managed.page.getByRole('textbox', { name: 'Display name', exact: true })).toBeDisabled();
    await expect(managed.page.getByRole('button', { name: 'Upload a profile picture' })).toBeDisabled();
    await expect(
      managed.page.getByText('Your organization manages this field.', { exact: true }),
    ).toHaveCount(3);
    await visit(page, `${base()}/settings/people`);
    for (const label of ['Change role', 'Deactivate', 'Make owner', 'Transfer ownership']) {
      const dialog = await action(page, managed.name, label);
      await expect(dialog.getByRole('status')).toHaveText(
        'Your directory manages this person’s role and lifecycle.  Make the change there.',
      );
      await expect(dialog.getByRole('button', { name: label, exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    }
    await visit(page, `${base()}/settings/people?person=${session.user.id}&action=transfer`);
    const selfTransfer = page.getByRole('dialog');
    await expect(selfTransfer.getByRole('status')).toHaveText(
      'Choose another active person to receive ownership.',
    );
    await expect(
      selfTransfer.getByRole('button', { name: 'Transfer ownership', exact: true }),
    ).toBeDisabled();
    await selfTransfer.getByRole('button', { name: 'Cancel' }).click();
    await (
      await action(page, inactive.name, 'Deactivate')
    )
      .getByRole('button', { name: 'Deactivate', exact: true })
      .click();
    const inactiveOwner = await action(page, inactive.name, 'Make owner');
    await expect(inactiveOwner.getByRole('status')).toHaveText(
      'Reactivate this person before making them an owner.',
    );
    await expect(inactiveOwner.getByRole('button', { name: 'Make owner', exact: true })).toBeDisabled();
    await inactiveOwner.getByRole('button', { name: 'Cancel' }).click();
    await visit(manager.page, `${base()}/settings/people`);
    await expect(manager.page.getByRole('button', { name: `Actions for ${OWNER.name}` })).toHaveCount(0);
    const role = await action(manager.page, manager.name, 'Change role');
    await role.getByRole('button', { name: / Role$/ }).click();
    await manager.page.getByRole('option', { name: 'Owner', exact: true }).click();
    await expect(role.getByRole('status')).toHaveText(
      'Only an owner can change an owner or make someone an owner.',
    );
    await expect(role.getByRole('button', { name: 'Change role', exact: true })).toBeDisabled();
    await role.getByRole('button', { name: / Role$/ }).click();
    await manager.page.getByRole('option', { name: 'Guest', exact: true }).click();
    await expect(role.getByRole('status')).toHaveText(
      'Remove this person’s administration roles before making them a Guest.',
    );
    await role.getByRole('button', { name: 'Cancel' }).click();
    await manager.page.setViewportSize({ width: 390, height: 844 });
    expect(await manager.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await visit(manager.page, `${base()}/settings/people?person=${session.user.id}&action=role`);
    await expect(manager.page.getByRole('heading', { name: 'People', exact: true, level: 1 })).toBeVisible();
    await expect(manager.page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await rows(`DELETE FROM "${namespace!.table_schema}".scim_users WHERE org_id = $1 AND user_id = $2`, [
      session.org.id,
      managed.id,
    ]);
    await asOwner(page, 'PATCH', `/api/org/members/${inactive.id}/status`, { deactivated: false });
    await asOwner(page, 'DELETE', `/api/org/units/${unit.id}`);
    await Promise.all([manager.context.close(), managed.context.close(), inactive.context.close()]);
  }
});

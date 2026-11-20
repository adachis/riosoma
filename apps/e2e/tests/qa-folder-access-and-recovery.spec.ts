import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, signIn, visit } from '../helpers';
import { invite } from '../people';
import { rows } from '../sql';
import type { HomeListing } from '../../../packages/contracts/src/index';

test.use({ serviceWorkers: 'block' });

for (const throughGroup of [false, true]) {
  test(`folder sharing with ${throughGroup ? 'a group' : 'a person'} inherits every role and revokes nested access`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const person = await invite(page, browser, throughGroup ? 'Group Folder Reviewer' : 'Folder Reviewer');
    try {
      const name = throughGroup ? 'Group workspace' : 'Personal workspace';
      await page.getByRole('button', { name: 'New folder', exact: true }).click();
      const creating = page.getByRole('dialog', { name: 'New folder', exact: true });
      await creating.getByRole('textbox', { name: 'Folder name' }).fill(name);
      await creating.getByRole('textbox', { name: 'Folder name' }).press('Enter');
      await expect(creating).toBeHidden();
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page).toHaveURL(/\/home\/folders\/[^/?#]+/);
      const folderUrl = page.url();
      const folderId = new URL(folderUrl).pathname.split('/').at(-1)!;
      const database = await createDatabase(page, `${name} notes`, [
        { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Inherited entry' }] },
      ]);
      await asOwner(page, 'POST', '/api/home/commands', {
        id: newId('cmd'),
        action: { kind: 'database.move', databaseId: database.id, parentId: folderId, confirmedLosses: [] },
      });
      const principal = throughGroup ? 'Folder reviewers' : `${person.name} (${person.email})`;
      if (throughGroup) {
        // Provisioned groups exist before a person chooses one in the sharing dialog.
        const [schema] = await rows<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE table_name = 'groups'",
        );
        const session = await asOwner<{ org: { id: string } }>(page, 'GET', '/api/auth/session');
        const groupId = `grp${newId('cmd').slice(3)}`;
        await rows(`INSERT INTO "${schema!.table_schema}".groups (id, org_id, name) VALUES ($1, $2, $3)`, [
          groupId,
          session.org.id,
          principal,
        ]);
        await rows(
          `INSERT INTO "${schema!.table_schema}".group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
          [session.org.id, groupId, person.id],
        );
      }
      await person.page.setViewportSize({ width: 390, height: 844 });
      await visit(person.page, `${base()}/home/shared`);
      await page.getByRole('link', { name: 'My files', exact: true }).first().click();
      await page.getByRole('button', { name: `More for ${name}`, exact: true }).click();
      await page.getByRole('menuitem', { name: labelName('Share'), exact: true }).click();
      const sharing = page.getByRole('dialog', { name: `Share ${name}`, exact: true });
      if (throughGroup) {
        await sharing.getByRole('button', { name: /Add a group/ }).click();
        await page.getByRole('option', { name: labelName(principal), exact: true }).click();
      } else {
        await sharing.getByRole('combobox', { name: 'Add people' }).fill(person.email);
        await page.getByRole('option', { name: new RegExp(person.name) }).click();
      }
      await expect(person.page.getByRole('button', { name, exact: true })).toBeVisible();
      const control = sharing.getByRole('button', {
        name: new RegExp(
          `^(?:Reader|Commenter|Editor|Creator|Owner) ${throughGroup ? principal : person.name}`,
        ),
      });
      for (const [role, label] of [
        ['reader', 'Reader'],
        ['commenter', 'Commenter'],
        ['editor', 'Editor'],
        ['creator', 'Creator'],
        ['owner', 'Owner'],
      ] as const) {
        await control.click();
        await page.getByRole('option', { name: labelName(label), exact: true }).click();
        await expect(control).toContainText(label);
        await visit(person.page, folderUrl);
        await expect(person.page.getByRole('heading', { name, exact: true })).toBeVisible();
        const canEdit = role === 'editor' || role === 'creator' || role === 'owner';
        const create = person.page.getByRole('button', { name: 'New database', exact: true });
        const createFolder = person.page.getByRole('button', { name: 'New folder', exact: true });
        if (canEdit) {
          await expect(create).toBeVisible();
          await expect(createFolder).toBeVisible();
        } else {
          await expect(create).toBeHidden();
          await expect(createFolder).toBeHidden();
        }
        await person.page.getByRole('link', { name: new RegExp(`${name} notes`) }).click();
        const grid = person.page.getByRole('grid', { name: 'Grid', exact: true });
        await expect(grid).toBeVisible();
        const schema = await asOwner<{ database: { role: string } }>(
          person.page,
          'GET',
          `/api/databases/${database.id}/schema`,
        );
        expect(schema.database.role).toBe(role);
        const add = grid.getByRole('button', { name: 'Add record', exact: true });
        if (canEdit) {
          await expect(add).toBeVisible();
          await add.click();
        } else await expect(add).toBeHidden();
      }
      await visit(person.page, folderUrl);
      await sharing
        .getByRole('button', { name: `Remove ${throughGroup ? principal : person.name}`, exact: true })
        .click();
      await expect(
        person.page.getByText('This folder is no longer available.', { exact: true }),
      ).toBeVisible();
      expect((await person.page.request.get(`${base()}/api/databases/${database.id}/schema`)).status()).toBe(
        404,
      );
      await person.page.reload();
      await expect(
        person.page.getByText('This folder is no longer available.', { exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    } finally {
      await person.context.close();
    }
  });
}

test('a folder rename preserves its input through a lost connection and a server error', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session');
  const suffix = newId('cmd');
  const original = `Recovery drafts ${suffix}`;
  const name = `復旧 📂 مسودات ${suffix}`;
  const backdrop = Array.from({ length: 300 }, (_, index) => ({
    id: `folder-${newId('cmd')}`,
    name: `Recovery backdrop ${String(index).padStart(3, '0')}`,
    parentId: null,
    ownerId: session.user.id,
    path: [],
    role: 'owner' as const,
    shared: false,
    trashed: false,
  }));
  await page.route(`${base()}/api/home`, async (route) => {
    const response = await route.fetch();
    const listing = (await response.json()) as HomeListing;
    await route.fulfill({
      response,
      json: {
        ...listing,
        // Other specs share the owner.  Keep this real folder in the controlled 300-folder
        // fixture without letting earlier folders push its first row outside the viewport.
        folders: [
          ...listing.folders.filter((folder) => folder.name === original || folder.name === name),
          ...backdrop,
        ].sort((a, b) => a.name.localeCompare(b.name)),
      },
    });
  });
  const backdropIds = new Set(backdrop.map(({ id }) => id));
  // The fixture's folders also need matching destination previews.
  await page.route(`${base()}/api/home/drop-preview`, (route) => {
    const { action } = route.request().postDataJSON() as { action: { parentId?: string | null } };
    return backdropIds.has(action.parentId ?? '')
      ? route.fulfill({ json: { available: true } })
      : route.continue();
  });
  // Start with a populated Home, so creating the folder does not also initialize virtualization.
  await visit(page, base());
  await expect(page.getByRole('list', { name: 'My files', exact: true })).toHaveAttribute(
    'data-home-virtual',
    'true',
  );
  // Repetitions share the owner's folders, so each rename needs its own names.
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const creating = page.getByRole('dialog', { name: 'New folder', exact: true });
  await creating.getByRole('textbox', { name: 'Folder name' }).fill(original);
  await creating.getByRole('textbox', { name: 'Folder name' }).press('Enter');
  await expect(creating).toBeHidden();
  await page.getByRole('button', { name: `More for ${original}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Rename'), exact: true }).click();
  const renaming = page.getByRole('group', { name: original, exact: true });
  const input = renaming.getByRole('textbox', { name: 'Folder name' });
  await input.fill(name);
  let fail = true;
  await page.route('**/api/home/commands', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'unavailable', messageKey: 'errors.tryAgain' } },
      });
    } else await route.continue();
  });
  try {
    await page.context().setOffline(true);
    await input.press('Enter');
    await expect(input).toHaveAttribute('readonly');
    await expect(input).toHaveValue(name);
    const failed = page.waitForResponse(
      (response) => response.url().endsWith('/api/home/commands') && response.status() === 503,
    );
    await page.context().setOffline(false);
    await failed;
    await expect(page.locator('.rio-banner[role="alert"]')).toBeVisible();
    await expect(input).toHaveValue(name);
    const listing = page.getByRole('list', { name: 'My files', exact: true });
    // The retained editor can change row height.  Reach the end before focusing its neighbor.
    await listing.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await listing.getByRole('button', { name: 'Recovery backdrop 299', exact: true }).focus();
    await listing.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(listing.getByRole('button', { name: 'Recovery backdrop 000', exact: true })).toBeVisible();
    await expect(input).toHaveValue(name);
    await input.scrollIntoViewIfNeeded();
    await input.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Folder name' })).toBeHidden();
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('many home items keep the final folder reachable by keyboard on desktop and phone', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const folders = Array.from({ length: 120 }, (_, index) => ({
    kind: 'folder.create' as const,
    folderId: `folder-${newId('cmd')}`,
    parentId: null,
    name: `Sweep folder ${String(index).padStart(3, '0')}`,
  }));
  const leftovers = Array.from({ length: 150 }, (_, index) => ({
    kind: 'folder.create' as const,
    folderId: `folder-${newId('cmd')}`,
    parentId: null,
    name: `Z workspace ${String(index).padStart(3, '0')}`,
  }));
  const created = [...folders, ...leftovers];
  for (let start = 0; start < created.length; start += 100) {
    const actions = created.slice(start, start + 100);
    await asOwner(page, 'POST', '/api/home/commands', {
      id: newId('cmd'),
      action: actions[0],
      actions,
    });
  }
  const last = folders.at(-1)!;
  try {
    const ids = new Set(folders.map(({ folderId }) => folderId));
    // End selects the last visible folder, so this listing contains only this test's folders.
    const listing = await asOwner<HomeListing>(page, 'GET', '/api/home');
    await page.route(`${base()}/api/home`, (route) =>
      route.fulfill({
        json: { ...listing, folders: listing.folders.filter(({ id }) => ids.has(id)) },
      }),
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await visit(page, base());
      const listing = page.getByRole('list', { name: 'My files', exact: true });
      await listing.focus();
      await listing.press('End');
      const folder = page.getByRole('button', { name: last.name, exact: true });
      await expect(folder).toBeAttached();
      await folder.scrollIntoViewIfNeeded();
      await expect(folder).toBeInViewport();
      await folder.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: last.name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    for (let start = 0; start < created.length; start += 100) {
      const actions = created
        .slice(start, start + 100)
        .map(({ folderId }) => ({ kind: 'folder.trash', folderId }));
      await asOwner(page, 'POST', '/api/home/commands', { id: newId('cmd'), action: actions[0], actions });
    }
  }
});

import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';
import { rows } from '../sql';

test.use({ serviceWorkers: 'block' });

test('guest home offers only actions the guest can complete', async ({ page, browser }) => {
  await signIn(page);
  const guest = await invite(page, browser, 'Casey Guest', 'guest');
  try {
    await expect(guest.page.getByRole('heading', { name: 'No databases yet' })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'New database', exact: true })).toBeHidden();
    await expect(guest.page.getByRole('button', { name: 'New folder', exact: true })).toBeHidden();
    await guest.page.keyboard.press('ControlOrMeta+k');
    const palette = guest.page.getByRole('dialog', { name: 'Search and commands' });
    await palette.getByRole('searchbox').fill('New database');
    await expect(palette.getByRole('option', { name: labelName('New database'), exact: true })).toBeHidden();
    await guest.page.keyboard.press('Escape');
    const database = await createDatabase(page, 'Guest editing', [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await share(page, database.id, guest, 'creator');
    await visit(guest.page, `${base()}/home/shared`);
    await expect(guest.page.getByRole('link', { name: /Guest editing/ })).toBeVisible();
    await expect(
      guest.page.getByRole('button', { name: 'More for Guest editing', exact: true }),
    ).toBeHidden();
  } finally {
    await guest.context.close();
  }
});

test('a template created inside a shared folder stays there and inherits access live', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Taylor Templates');
  try {
    const folderId = `folder-${newId('cmd')}`;
    await asOwner(page, 'POST', '/api/home/commands', {
      id: newId('cmd'),
      action: { kind: 'folder.create', folderId, parentId: null, name: 'Template workspace' },
    });
    await asOwner(page, 'POST', '/api/home/commands', {
      id: newId('cmd'),
      action: { kind: 'folder.share', folderId, principal: { kind: 'user', id: person.id }, role: 'reader' },
    });
    await visit(person.page, `${base()}/home/folders/${folderId}`);
    await visit(page, `${base()}/home/folders/${folderId}`);
    await page.getByRole('button', { name: 'New database', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New database', exact: true });
    await dialog.getByRole('searchbox', { name: 'Filter items' }).fill('Reading list');
    await dialog.getByRole('option', { name: labelName('Reading list'), exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('読書 📚 مكتبة');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/db[0-9A-Za-z]{14}/);
    const databaseId = new URL(page.url()).pathname.split('/')[1]!;
    const home = await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
      page,
      'GET',
      '/api/home',
    );
    expect(home.databases.find((database) => database.id === databaseId)?.parentId).toBe(folderId);
    await expect(person.page.getByRole('link', { name: /読書 📚 مكتبة/ })).toBeVisible();
    await visit(page, `${base()}/home/folders/${folderId}`);
    await expect(page.getByRole('link', { name: /読書 📚 مكتبة/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('link', { name: /読書 📚 مكتبة/ })).toBeVisible();
  } finally {
    await person.context.close();
  }
});

test('long Unicode folder names fit desktop and touch navigation at phone width', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const name = `資料📚${'長'.repeat(90)}مكتبة`;
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Folder name' }).press('Enter');
  await expect(dialog).toBeHidden();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const phone = await context.newPage();
    await visit(phone, base());
    await phone.getByRole('button', { name, exact: true }).tap();
    await expect(phone).toHaveURL(/\/home\/folders\//);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.reload();
    await expect(phone.getByRole('heading', { name, exact: true })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a slow move review keeps its destination fixed until the review completes', async ({ page }) => {
  await signIn(page);
  const data = await createDatabase(page, 'Move review', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await page.reload();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/home/move-preview', async (route) => {
    started();
    await held;
    await route.fulfill({ json: [] });
  });
  try {
    await page.getByRole('button', { name: 'More for Move review', exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Move to…'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move Move review', exact: true });
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await entered;
    await expect(dialog.getByRole('button', { name: /Destination/ })).toBeDisabled();
    release();
    await expect(dialog).toBeHidden();
    expect((await asOwner<{ databases: Array<{ id: string }> }>(page, 'GET', '/api/home')).databases).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: data.id })]),
    );
  } finally {
    release();
  }
});

test('database names support keyboard undo and redo, and a completed copy appears on home immediately', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Lifecycle notes', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'First entry' }] },
  ]);
  await visit(page, `${base()}/${database.id}/${database.tables.Tasks!.id}/${database.tables.Tasks!.viewId}`);
  const name = '資料 📔 مكتبة';
  await page.getByRole('button', { name: 'Lifecycle notes', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Database name', exact: true });
  await input.fill('   ');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.fill(name);
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/databases/${database.id}/commands`),
  );
  await input.press('Enter');
  expect((await saved).ok()).toBe(true);
  const title = page.getByRole('heading', { level: 1 }).getByRole('button');
  await expect(title).toContainText(name);
  await page
    .getByRole('grid', { name: 'Grid', exact: true })
    .getByRole('gridcell', { name: 'First entry', exact: true })
    .click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toContainText('Lifecycle notes');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(title).toContainText(name);
  await page.reload();
  await expect(title).toContainText(name);
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await page.getByRole('button', { name: `More for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Duplicate database'), exact: true }).click();
  const copy = page.getByRole('dialog', { name: `Duplicate ${name}`, exact: true });
  await copy.getByRole('textbox', { name: 'New database name' }).fill('Copied notes');
  await copy.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(copy.getByRole('button', { name: 'Open the new database', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await copy.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('link', { name: /Copied notes/ })).toBeVisible();
  await page.getByRole('button', { name: 'More for Copied notes', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Delete database'), exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete Copied notes?' })
    .getByRole('button', { name: 'Delete database', exact: true })
    .click();
  await expect(page.getByRole('link', { name: /Copied notes/ })).toBeHidden();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('link', { name: /Copied notes/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: /Copied notes/ })).toBeVisible();
});

for (const throughGroup of [false, true]) {
  test(`sharing with ${throughGroup ? 'a group' : 'a person'} applies every role and removing it revokes access`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const person = await invite(page, browser, throughGroup ? 'Group Reviewer' : 'Direct Reviewer');
    try {
      const database = await createDatabase(page, throughGroup ? 'Group roles' : 'Direct roles', [
        { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Role check' }] },
      ]);
      const name = throughGroup ? 'Sharing reviewers' : `${person.name} (${person.email})`;
      if (throughGroup) {
        // Group provisioning is independent of sharing; seed the provisioned membership.
        const [schema] = await rows<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE table_name = 'groups'",
        );
        const session = await asOwner<{ org: { id: string } }>(page, 'GET', '/api/auth/session');
        const groupId = `grp${newId('cmd').slice(3)}`;
        await rows(`INSERT INTO "${schema!.table_schema}".groups (id, org_id, name) VALUES ($1, $2, $3)`, [
          groupId,
          session.org.id,
          name,
        ]);
        await rows(
          `INSERT INTO "${schema!.table_schema}".group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
          [session.org.id, groupId, person.id],
        );
      }
      const denied = await person.page.request.get(`${base()}/api/databases/${database.id}/schema`);
      expect(denied.status()).toBe(404);
      await visit(person.page, `${base()}/home/shared`);
      await visit(
        page,
        `${base()}/${database.id}/${database.tables.Tasks!.id}/${database.tables.Tasks!.viewId}`,
      );
      await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      const sharing = page.getByRole('dialog', {
        name: `Share ${throughGroup ? 'Group roles' : 'Direct roles'}`,
      });
      if (throughGroup) {
        await sharing.getByRole('button', { name: /Add a group/ }).click();
        await page.getByRole('option', { name: labelName(name), exact: true }).click();
      } else {
        await sharing.getByRole('combobox', { name: 'Add people' }).fill(person.email);
        await page.getByRole('option', { name: new RegExp(person.name) }).click();
      }
      await expect(person.page.getByRole('link', { name: /(?:Group|Direct) roles/ })).toBeVisible();
      if (!throughGroup) {
        await person.page.getByRole('button', { name: /^Notifications/ }).click();
        const notifications = person.page.getByRole('dialog', { name: 'Notifications', exact: true });
        await expect(notifications.getByRole('link', { name: /shared Direct roles with you/ })).toBeVisible();
        await person.page.keyboard.press('Escape');
      }
      const roleControl = sharing.getByRole('button', {
        name: new RegExp(`^(?:Reader|Commenter|Editor|Creator|Owner) ${throughGroup ? name : person.name}`),
      });
      for (const [role, label] of [
        ['reader', 'Reader'],
        ['commenter', 'Commenter'],
        ['editor', 'Editor'],
        ['creator', 'Creator'],
        ['owner', 'Owner'],
      ] as const) {
        await roleControl.click();
        await page.getByRole('option', { name: labelName(label), exact: true }).click();
        await expect(roleControl).toContainText(label);
        await visit(person.page, `${base()}/${database.id}`);
        await expect(person.page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
        const schema = await asOwner<{ database: { role: string } }>(
          person.page,
          'GET',
          `/api/databases/${database.id}/schema`,
        );
        expect(schema.database.role).toBe(role);
        const rename = person.page.getByRole('button', {
          name: `${throughGroup ? 'Group' : 'Direct'} roles`,
          exact: true,
        });
        if (role === 'owner') await expect(rename).toBeVisible();
        else await expect(rename).toBeHidden();
        await person.page.getByRole('button', { name: 'Share', exact: true }).click();
        const readSharing = person.page.getByRole('dialog', { name: /^Share / });
        if (role === 'owner')
          await expect(readSharing.getByRole('combobox', { name: 'Add people' })).toBeVisible();
        else await expect(readSharing.getByRole('combobox', { name: 'Add people' })).toBeHidden();
        await person.page.keyboard.press('Escape');
      }
      await visit(person.page, `${base()}/home/shared`);
      await sharing
        .getByRole('button', { name: `Remove ${throughGroup ? name : person.name}`, exact: true })
        .click();
      await expect(person.page.getByRole('link', { name: /(?:Group|Direct) roles/ })).toBeHidden();
      const revoked = await person.page.request.get(`${base()}/api/databases/${database.id}/schema`);
      expect(revoked.status()).toBe(404);
      await person.page.reload();
      await expect(person.page.getByRole('link', { name: /(?:Group|Direct) roles/ })).toBeHidden();
      await page.keyboard.press('Escape');
    } finally {
      await person.context.close();
    }
  });
}

test('two owners sharing opposite linked databases both save and receive access live', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const first = await invite(page, browser, 'First Linked Owner');
  const second = await invite(page, browser, 'Second Linked Owner');
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const source = await createDatabase(page, 'Concurrent projects', [
      {
        name: 'Projects',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Linked source entry' }],
      },
    ]);
    const target = await createDatabase(page, 'Concurrent contacts', [
      {
        name: 'Contacts',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Linked target entry' }],
      },
    ]);
    const relation = newId('fld');
    await runCommands(page, source.id, [
      {
        kind: 'field.create',
        tableId: source.tables.Projects!.id,
        field: {
          id: relation,
          name: 'Contact',
          type: 'link',
          options: { linkedTableId: target.tables.Contacts!.id, oneWay: true },
        },
      },
      {
        kind: 'record.update',
        tableId: source.tables.Projects!.id,
        records: [
          {
            id: source.tables.Projects!.records[0],
            values: { [relation]: [target.tables.Contacts!.records[0]] },
          },
        ],
      },
    ]);
    await share(page, source.id, first, 'owner');
    await share(page, target.id, second, 'owner');
    await visit(first.page, `${base()}/${source.id}`);
    await visit(second.page, `${base()}/${target.id}`);
    await first.page.getByRole('button', { name: 'Share', exact: true }).click();
    await second.page.getByRole('button', { name: 'Share', exact: true }).click();
    await first.page.getByRole('combobox', { name: 'Add people' }).fill(second.email);
    await second.page.getByRole('combobox', { name: 'Add people' }).fill(first.email);
    let arrivals = 0;
    for (const person of [first, second])
      await person.page.route('**/api/databases/*/grants', async (route) => {
        if (route.request().method() === 'PUT') {
          arrivals += 1;
          if (arrivals === 2) release();
          await held;
        }
        await route.continue();
      });
    const firstSaved = first.page.waitForResponse(
      (response) => response.url().endsWith('/grants') && response.request().method() === 'PUT',
    );
    const secondSaved = second.page.waitForResponse(
      (response) => response.url().endsWith('/grants') && response.request().method() === 'PUT',
    );
    await Promise.all([
      first.page.getByRole('option', { name: new RegExp(second.name) }).click(),
      second.page.getByRole('option', { name: new RegExp(first.name) }).click(),
    ]);
    for (const response of await Promise.all([firstSaved, secondSaved])) expect(response.ok()).toBe(true);
    await first.page.keyboard.press('Escape');
    await second.page.keyboard.press('Escape');
    await expect(first.page.getByRole('gridcell', { name: /Linked target entry/ })).toBeVisible();
    for (const [person, databaseId] of [
      [first, target.id],
      [second, source.id],
    ] as const) {
      const schema = await asOwner<{ database: { role: string } }>(
        person.page,
        'GET',
        `/api/databases/${databaseId}/schema`,
      );
      expect(schema.database.role).toBe('editor');
      await visit(person.page, `${base()}/home/shared`);
      await expect(person.page.getByRole('link', { name: /Concurrent projects/ })).toBeVisible();
      await expect(person.page.getByRole('link', { name: /Concurrent contacts/ })).toBeVisible();
    }
  } finally {
    release();
    await first.context.close();
    await second.context.close();
  }
});

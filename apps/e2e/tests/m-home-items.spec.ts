import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, runCommands, signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

test('shortcuts open current targets and tags filter home with keyboard and phone controls', async ({
  page,
}) => {
  await signIn(page);
  const data = await createDatabase(page, 'Shortcut planning', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = data.tables.Tasks!;
  await page.goto(`${base()}/${data.id}/${table.id}/${table.viewId}`);
  await page.getByRole('button', { name: 'More for Grid', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add shortcut to home', exact: true }).click();
  await expect(page.getByText('Shortcut added to home', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page
    .getByRole('list', { name: 'Shortcuts', exact: true })
    .getByRole('link', { name: 'Grid', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${table.viewId}$`));
  await runCommands(page, data.id, [{ kind: 'view.update', viewId: table.viewId, name: 'Launch schedule' }]);
  await page.goto(base());
  await expect(
    page.getByRole('list', { name: 'Shortcuts', exact: true }).getByRole('link', { name: 'Launch schedule' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Tags and colors', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tags and colors', exact: true });
  await dialog.getByRole('textbox', { name: 'Tag name', exact: true }).fill('Launch checklist');
  await dialog.getByRole('button', { name: 'Create tag', exact: true }).click();
  const checkbox = dialog.getByRole('checkbox', { name: 'Launch checklist Private', exact: true });
  await expect(checkbox).toBeVisible();
  await dialog.getByRole('button', { name: /Item to tag/ }).click();
  await page.getByRole('option', { name: 'Shortcut planning', exact: true }).click();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Color name', exact: true }).fill('Brand indigo');
  await dialog.getByRole('textbox', { name: 'Color value', exact: true }).fill('#334488');
  await dialog.getByRole('button', { name: 'Save color', exact: true }).click();
  await expect(
    dialog.locator('li').filter({ hasText: 'Brand indigo' }).getByText('Brand indigo', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Color name', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: 'Launch checklist Private', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/tags\//);
  const tagUrl = page.url();
  await expect(page.getByRole('link', { name: /Shortcut planning/ })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(tagUrl);
  await expect(page.getByRole('heading', { name: 'Launch checklist', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: /Shortcut planning/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Tags and colors', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Tag name', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('dialog', { name: 'Search and commands' })
    .getByRole('searchbox')
    .fill('Launch checklist');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(tagUrl);

  await runCommands(page, data.id, [{ kind: 'database.trash' }]);
  await page.goto(`${base()}/home/trash`);
  await expect(
    page
      .getByRole('list', { name: 'Shortcuts', exact: true })
      .getByText('Unavailable shortcut', { exact: true }),
  ).toBeVisible();
});

test('dragging a view onto home creates an alias and moving it keeps the target intact', async ({ page }) => {
  await signIn(page);
  const data = await createDatabase(page, 'Drag planning', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = data.tables.Tasks!;
  await page.goto(`${base()}/${data.id}/${table.id}/${table.viewId}`);
  await page
    .getByRole('link', { name: 'Grid', exact: true })
    .dragTo(page.getByRole('link', { name: 'Home', exact: true }));
  await expect(page.getByText('Shortcut added to home', { exact: true })).toBeVisible();
  const folderId = `folder-${newId('cmd')}`;
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, name: 'Shortcut folder', parentId: null },
  });
  await page.goto(base());
  const list = page.getByRole('list', { name: 'Shortcuts', exact: true });
  await list.getByRole('button', { name: 'More for Grid', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move shortcut', exact: true });
  await dialog.getByRole('button', { name: /Destination/ }).click();
  await page.getByRole('option', { name: 'Shortcut folder', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByRole('button', { name: 'Shortcut folder', exact: true }).click();
  await list.getByRole('link', { name: 'Grid', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${table.viewId}$`));
});

for (const phone of [false, true]) {
  test(`home plans wait for keyboard approval and support undo on ${phone ? 'phone' : 'desktop'}`, async ({
    page,
  }) => {
    await signIn(page);
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const tagId = `tag-${newId('cmd')}`;
    const commandId = newId('cmd');
    await asOwner(page, 'POST', '/api/home/commands', {
      id: newId('cmd'),
      action: {
        kind: 'tag.create',
        tagId,
        name: 'Approval checklist',
        color: '#007aff',
        visibility: 'private',
      },
    });
    const conversation = {
      id: crypto.randomUUID(),
      title: 'Home approval',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const planId = crypto.randomUUID();
    let applied = false;
    await page.route(`${base()}/api/rio/status`, (route) =>
      route.fulfill({
        json: { enabled: true, tiers: ['everyday'], autonomy: 'ask', paused: false, routines: false },
      }),
    );
    await page.route(`${base()}/api/rio/conversations`, (route) => route.fulfill({ json: [conversation] }));
    await page.route(
      (url) =>
        url.pathname === `/api/rio/conversations/${conversation.id}` ||
        url.pathname === '/api/rio/active-conversation',
      (route) =>
        route.fulfill({
          json: {
            conversation,
            messages: [
              {
                id: crypto.randomUUID(),
                role: 'rio',
                createdAt: conversation.createdAt,
                blocks: [
                  {
                    kind: 'plan',
                    planId,
                    databaseId: null,
                    summary: 'Remove the checklist tag',
                    steps: ['Move Approval checklist to Trash'],
                    needsApproval: true,
                    status: 'pending',
                  },
                ],
              },
            ],
          },
        }),
    );
    await page.route(`${base()}/api/rio/plans/${planId}/apply`, async (route) => {
      await asOwner(page, 'POST', '/api/home/commands', {
        id: commandId,
        action: { kind: 'tag.trash', tagId },
      });
      applied = true;
      await route.fulfill({
        json: {
          kind: 'receipt',
          planId,
          databaseId: null,
          groupId: commandId,
          summary: 'Removed the checklist tag',
        },
      });
    });
    await page.reload();
    await page.locator('.rio-assistant__trigger button').click();
    await page.getByRole('button', { name: 'Past conversations' }).click();
    await page.getByRole('menuitem', { name: 'Home approval' }).click();
    const apply = page.getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeVisible();
    expect(applied).toBe(false);
    const tags = async () =>
      (await asOwner<{ tags: Array<{ id: string }> }>(page, 'GET', '/api/home')).tags.map((tag) => tag.id);
    expect(await tags()).toContain(tagId);
    await apply.focus();
    await page.keyboard.press('Enter');
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    expect(applied).toBe(true);
    expect(await tags()).not.toContain(tagId);
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Undone', { exact: true })).toBeVisible();
    expect(await tags()).toContain(tagId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

import { expect, test, type Page } from '../accessibility';
import { asOwner, createDatabase, newId, signIn } from '../helpers';
import { invite, share, type Role } from '../people';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('database moves are offered only to an owner across every shared role', async ({ page, browser }) => {
  await signIn(page);
  const person = await invite(page, browser, 'Jordan Reed');
  try {
    const data = await createDatabase(page, 'Ownership check', [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    for (const role of ['reader', 'commenter', 'editor', 'creator', 'owner'] satisfies Role[]) {
      await share(page, data.id, person, role);
      await person.page.goto(`${base()}/home/shared`);
      const card = person.page.getByRole('link', { name: /Ownership check/ });
      await expect(card).toBeVisible();
      const handle = card.locator('..').getByRole('button', { name: 'Move Ownership check', exact: true });
      if (role === 'owner') await expect(handle).toBeEnabled();
      else await expect(handle).toBeDisabled();
      const menu = person.page.getByRole('button', { name: 'More for Ownership check' });
      if (role === 'creator' || role === 'owner') {
        await menu.click();
        const move = person.page.getByRole('menuitem', { name: 'Move to…', exact: true });
        if (role === 'owner') {
          await move.click();
          await expect(person.page.getByRole('dialog', { name: 'Move Ownership check' })).toBeVisible();
        } else await expect(move).toBeHidden();
        await person.page.keyboard.press('Escape');
      } else await expect(menu).toBeHidden();
    }
  } finally {
    await person.context.close();
  }
});

async function makeFolder(page: Page, name: string) {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Folder name' }).press('Enter');
  await expect(dialog).toBeHidden();
  const previous = page.url();
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page).not.toHaveURL(previous);
  await expect(page).toHaveURL(/\/home\/folders\/[^/]+$/);
}

test('sharing hides private ancestor names on a phone and supports keyboard dismissal', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Riley Quinn');
  try {
    await page.goto(base());
    await makeFolder(page, 'Private planning');
    await makeFolder(page, 'Unannounced projects');
    const folderId = page.url().split('/').at(-1)!;
    const data = await createDatabase(page, 'Shared tasks', [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await asOwner(page, 'POST', '/api/home/commands', {
      id: newId('cmd'),
      action: { kind: 'database.move', databaseId: data.id, parentId: folderId, confirmedLosses: [] },
    });
    await share(page, data.id, person, 'reader');
    await person.page.setViewportSize({ width: 390, height: 844 });
    await person.page.goto(`${base()}/home/shared`);
    await person.page.getByRole('link', { name: /Shared tasks/ }).click();
    await expect(person.page).toHaveURL(new RegExp(data.id));
    // The database address redirects on to its first table and view.  Read the address only once
    // that redirect lands, so the reload below is compared with the address the app settles on.
    const tasks = data.tables.Tasks!;
    await expect(person.page).toHaveURL(`${base()}/${data.id}/${tasks.id}/${tasks.viewId}`);
    const databaseUrl = person.page.url();
    await person.page.reload();
    await expect(person.page).toHaveURL(databaseUrl);
    await person.page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = person.page.getByRole('dialog', { name: 'Share Shared tasks' });
    await expect(dialog.getByText("From a folder you can't see", { exact: true })).toHaveCount(2);
    await expect(dialog.getByText(/Private planning|Unannounced projects/)).toHaveCount(0);
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
    await person.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await person.context.close();
  }
});

test('nested folders share live with another person and support keyboard moves and phone navigation', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Morgan Vale');
  try {
    await person.page.goto(`${base()}/home/shared`);
    await expect(person.page.getByRole('heading', { name: 'Shared with me', exact: true })).toBeVisible();
    await page.goto(base());
    await makeFolder(page, 'Launch materials');
    const parentUrl = page.url();
    await makeFolder(page, 'Drafts');
    const childUrl = page.url();
    await page.getByRole('link', { name: 'My files', exact: true }).last().click();
    await page.getByRole('button', { name: 'More for Launch materials' }).click();
    await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
    const sharing = page.getByRole('dialog');
    await sharing.getByRole('combobox', { name: 'Add people' }).fill(person.email);
    await page.getByRole('option', { name: new RegExp(person.name) }).click();
    await expect(person.page.getByRole('button', { name: 'Launch materials', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await person.page.getByRole('button', { name: 'Launch materials', exact: true }).click();
    await expect(person.page).toHaveURL(parentUrl);
    await person.page.getByRole('button', { name: 'Drafts', exact: true }).click();
    await expect(person.page).toHaveURL(childUrl);
    await page.keyboard.press('Escape');
    await page.goto(parentUrl);
    await page.getByRole('button', { name: 'More for Drafts' }).click();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
    const moving = page.getByRole('dialog', { name: 'Move Drafts' });
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(moving.getByText(person.name, { exact: true })).toBeVisible();
    await moving.getByRole('button', { name: 'Confirm move' }).click();
    await expect(moving).toBeHidden();
    await expect(person.page.getByText('This folder is no longer available.')).toBeVisible({
      timeout: 10_000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base());
    await page.getByRole('button', { name: 'Drafts', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Folder path' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible();
    await page.goto(base());
    await page.getByRole('button', { name: 'More for Drafts' }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Move folder to Trash?' })
      .getByRole('button', { name: 'Move to Trash', exact: true })
      .click();
    await page.getByRole('link', { name: 'Trash', exact: true }).click();
    await page.getByRole('button', { name: 'More for Drafts' }).click();
    await page.getByRole('menuitem', { name: 'Restore folder', exact: true }).click();
    await expect(page.getByRole('button', { name: 'More for Drafts' })).toBeHidden();
    await page.getByRole('link', { name: 'My files', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Drafts', exact: true })).toBeVisible();
  } finally {
    await person.context.close();
  }
});

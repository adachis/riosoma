import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, newId, signIn, visit } from '../helpers';
import { invite } from '../people';

test.use({ serviceWorkers: 'block' });

for (const kind of ['template', 'blank'] as const) {
  for (const atRoot of [false, true]) {
    test(`a delayed ${kind} stays in its starting ${atRoot ? 'root' : 'private folder'} after Back reaches a shared folder`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(90_000);
      await signIn(page);
      await page.setViewportSize({ width: 390, height: 844 });
      const person = await invite(page, browser, 'Creation Reviewer');
      const suffix = newId('cmd');
      const sharedFolder = `shared-${suffix}`;
      const privateFolder = `private-${suffix}`;
      const privateName = `Private drafts ${suffix}`;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let databaseId = '';
      try {
        const actions = [
          { kind: 'folder.create', folderId: sharedFolder, parentId: null, name: `Shared ${suffix}` },
          { kind: 'folder.create', folderId: privateFolder, parentId: null, name: privateName },
        ];
        await asOwner(page, 'POST', '/api/home/commands', { id: newId('cmd'), action: actions[0], actions });
        await asOwner(page, 'POST', '/api/home/commands', {
          id: newId('cmd'),
          action: {
            kind: 'folder.share',
            folderId: sharedFolder,
            principal: { kind: 'user', id: person.id },
            role: 'reader',
          },
        });
        await visit(page, `${base()}/home/folders/${sharedFolder}`);
        await page.getByRole('link', { name: 'My files', exact: true }).first().click();
        await expect(page).toHaveURL(`${base()}/`);
        if (!atRoot) {
          await page.getByRole('button', { name: privateName, exact: true }).click();
          await expect(page).toHaveURL(`${base()}/home/folders/${privateFolder}`);
        }
        await page.route(
          kind === 'template' ? '**/api/databases/from-template' : '**/api/databases',
          async (route) => {
            if (route.request().method() !== 'POST') {
              await route.continue();
              return;
            }
            databaseId = (route.request().postDataJSON() as { id: string }).id;
            started();
            await held;
            await route.continue();
          },
        );
        await page.getByRole('button', { name: 'New database', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'New database', exact: true });
        if (kind === 'template') {
          await dialog.getByRole('searchbox', { name: 'Filter items' }).fill('Reading list');
          await dialog.getByRole('option', { name: labelName('Reading list'), exact: true }).click();
        }
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Private ${kind} 📚`);
        await dialog.getByRole('button', { name: 'Create', exact: true }).click();
        await entered;
        await page.goBack();
        if (!atRoot) {
          await expect(page).toHaveURL(`${base()}/`);
          await page.goBack();
        }
        await expect(page).toHaveURL(`${base()}/home/folders/${sharedFolder}`);
        release();
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(new RegExp(`/${databaseId}(?:/|$)`));
        const home = await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
          page,
          'GET',
          '/api/home',
        );
        expect(home.databases.find((database) => database.id === databaseId)?.parentId).toBe(
          atRoot ? null : privateFolder,
        );
        expect((await person.page.request.get(`${base()}/api/databases/${databaseId}/schema`)).status()).toBe(
          404,
        );
        await page.reload();
        await expect(
          page.getByRole('grid', { name: kind === 'template' ? 'All records' : 'Grid', exact: true }),
        ).toBeVisible();
      } finally {
        release();
        await person.context.close();
      }
    });
  }
}

test('a filing retry keeps the created template name read-only and files the existing database once', async ({
  page,
}) => {
  await signIn(page);
  const folderId = `folder-${newId('cmd')}`;
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, parentId: null, name: 'Retry drafts' },
  });
  await visit(page, `${base()}/home/folders/${folderId}`);
  let creations = 0;
  let filings = 0;
  let databaseId = '';
  await page.route('**/api/databases/from-template', async (route) => {
    creations += 1;
    databaseId = (route.request().postDataJSON() as { id: string }).id;
    await route.continue();
  });
  await page.route('**/api/home/commands', async (route) => {
    const body = route.request().postDataJSON() as { action: { kind: string; databaseId?: string } };
    if (body.action.kind === 'database.move' && body.action.databaseId === databaseId) {
      filings += 1;
      if (filings === 1) {
        await route.fulfill({
          status: 503,
          json: { error: { code: 'unavailable', messageKey: 'errors.tryAgain' } },
        });
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'New database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New database', exact: true });
  await dialog.getByRole('searchbox', { name: 'Filter items' }).fill('Reading list');
  await dialog.getByRole('option', { name: labelName('Reading list'), exact: true }).click();
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(name).toHaveAttribute('readonly', '');
  await name.press('End');
  await name.press('x');
  await expect(name).toHaveValue('Reading list');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(creations).toBe(1);
  expect(filings).toBe(2);
  const home = await asOwner<{ databases: Array<{ id: string; name: string; parentId: string | null }> }>(
    page,
    'GET',
    '/api/home',
  );
  expect(home.databases.filter((database) => database.id === databaseId)).toEqual([
    expect.objectContaining({ name: 'Reading list', parentId: folderId }),
  ]);
});

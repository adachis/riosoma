import { expect, test, type Page } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, pasteText, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

async function edit(page: Page, row: number, text: string) {
  await page.locator(`[role="gridcell"][data-rio-row="${row}"][data-rio-col="0"]`).dblclick();
  const input = page.locator('.rio-grid__input');
  await input.fill(text);
  const saved = page.waitForResponse((response) => response.url().endsWith('/commands') && response.ok());
  await input.press('Enter');
  await saved;
}

async function reverse(page: Page, redo = false) {
  const response = page.waitForResponse((answer) => answer.url().endsWith(redo ? '/redo' : '/undo'));
  await page.locator('.rio-grid__input').focus();
  await page.locator('.rio-grid__input').press(redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
  expect((await response).ok()).toBe(true);
}

async function expectUndoable(page: Page) {
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Undo history', exact: true });
  await expect(
    panel.getByRole('listbox', { name: 'Changes to undo, newest first' }).getByRole('option'),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`a late undo preserves edits made after leaving and reopening the grid at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Late history recovery', [
      {
        name: 'Records',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Original' }, { Name: 'Second original' }],
      },
    ]);
    const grid = await openTable(page, database, 'Records');
    await edit(page, 0, 'Earlier edit');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route(`**/api/databases/${database.id}/undo`, async (route) => {
      if (++requests <= 2) await blocked;
      await route.continue();
    });
    const started = page.waitForRequest((request) => request.url().endsWith('/undo'));
    await page.locator('.rio-grid__input').focus();
    await page.locator('.rio-grid__input').press('ControlOrMeta+z');
    await started;
    await page.getByRole('link', { name: 'Riosoma', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await page.locator(`a[href="/${database.id}"]`).click();
    await expect(grid).toBeVisible();
    await edit(page, 1, 'Newer edit 東京 🦋');
    release();
    await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
    await page.reload();
    await expect(grid.getByRole('gridcell', { name: 'Newer edit 東京 🦋', exact: true })).toBeVisible();
    await expectUndoable(page);
    await reverse(page);
    await expect(grid.getByRole('gridcell', { name: 'Second original', exact: true })).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  });

  for (const direction of ['undo', 'redo'] as const)
    test(`reload recovers a completed ${direction} whose response was lost at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const database = await createDatabase(page, 'Lost history response', [
        {
          name: 'Records',
          fields: [{ name: 'Name', type: 'text' }],
          records: [{ Name: 'Original' }],
        },
      ]);
      const grid = await openTable(page, database, 'Records');
      await edit(page, 0, 'Saved edit');
      if (direction === 'redo') {
        await reverse(page);
        await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
      }
      const requests: unknown[] = [];
      let completed!: () => void;
      const lost = new Promise<void>((resolve) => {
        completed = resolve;
      });
      await page.route(`**/api/databases/${database.id}/${direction}`, async (route) => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) {
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort('failed');
          completed();
        } else await route.continue();
      });
      await page.locator('.rio-grid__input').focus();
      await page
        .locator('.rio-grid__input')
        .press(direction === 'redo' ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
      await lost;
      await page.reload();
      await expect(
        grid.getByRole('gridcell', { name: direction === 'undo' ? 'Original' : 'Saved edit', exact: true }),
      ).toBeVisible();
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]).toEqual(requests[0]);
      await reverse(page, direction === 'undo');
      await expect(
        grid.getByRole('gridcell', { name: direction === 'undo' ? 'Saved edit' : 'Original', exact: true }),
      ).toBeVisible();
    });
}

test('a rejected paste remainder after reload still lets the saved option changes undo', async ({ page }) => {
  await signIn(page);
  const fields = Array.from({ length: 100 }, (_, index) => ({
    name: `Status ${index + 1}`,
    type: 'singleSelect',
    choices: [],
  }));
  const database = await createDatabase(page, 'Partial paste recovery', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  await runCommands(
    page,
    database.id,
    fields.map(({ name, type }) => ({
      kind: 'field.create',
      tableId: database.tables.Records!.id,
      field: { id: newId('fld'), name, type, options: { choices: [] } },
    })),
  );
  const grid = await openTable(page, database, 'Records');
  let reloaded = false;
  let interrupted!: () => void;
  const interruption = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    const body = route.request().postDataJSON() as { commands: Array<{ id: string }> };
    if (body.commands.length !== 1) return route.continue();
    if (!reloaded) {
      await route.abort('failed');
      interrupted();
    } else
      await route.fulfill({
        json: {
          results: body.commands.map(({ id }) => ({
            id,
            status: 'rejected',
            error: { code: 'forbidden', messageKey: 'errors.forbidden', userFault: true },
          })),
        },
      });
  });
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).click();
  await pasteText(page.locator('.rio-grid__input'), ['Changed', ...fields.map(() => 'Ready')].join('\t'));
  const preview = page.getByRole('dialog', { name: 'Paste 101 cells?' });
  await preview.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await preview.getByRole('button', { name: 'Cancel', exact: true }).press('Shift+Tab');
  await expect(preview.locator('.rio-dialog__body')).toBeFocused();
  await preview.getByRole('button', { name: 'Paste', exact: true }).click();
  await interruption;
  reloaded = true;
  await page.reload();
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  const schema = () =>
    asOwner<{ fields: Array<{ options: { choices?: unknown[] } }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
  expect((await schema()).fields.filter((field) => field.options.choices?.length === 1)).toHaveLength(100);
  await expectUndoable(page);
  await reverse(page);
  expect((await schema()).fields.filter((field) => field.options.choices?.length === 1)).toHaveLength(0);
});

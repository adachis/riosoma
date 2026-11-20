import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, newId, openTable, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

for (const width of [390, 1280]) {
  test(`a fully refused undo stays available at width ${width}`, async ({ page, browser }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Skipped history', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Notes', type: 'text' },
        ],
        records: [{ Name: 'Review', Notes: 'Before' }],
      },
    ]);
    const table = database.tables.Tasks!;
    await asOwner(page, 'PUT', `/api/tables/${table.id}/record-rules`, {
      rules: [
        {
          id: newId('rul'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'after', fieldId: table.fields.Notes, operator: 'is', value: 'After' }],
          },
        },
      ],
    });
    const person = await invite(page, browser, 'Casey Morgan');
    try {
      await person.page.setViewportSize({ width, height: 900 });
      await share(page, database.id, person, 'creator');
      const grid = await openTable(person.page, database, 'Tasks');
      await grid
        .getByRole('button', { name: /^Expand row/ })
        .first()
        .click();
      const card = person.page.getByRole('dialog', { name: 'Review', exact: true });
      const notes = card.getByRole('textbox', { name: 'Notes', exact: true });
      const saved = person.page.waitForResponse((response) =>
        response.url().endsWith(`/api/databases/${database.id}/commands`),
      );
      await notes.fill('After');
      await notes.press('Enter');
      expect((await saved).ok()).toBe(true);
      await person.page.keyboard.press('Escape');
      await share(page, database.id, person, 'editor');
      await person.page.getByRole('button', { name: 'Undo history', exact: true }).click();
      const history = person.page.getByRole('dialog', { name: 'Undo history' });
      const undo = history.getByRole('listbox', { name: 'Changes to undo, newest first' });
      const reverse = async (direction: 'undo' | 'redo') => {
        const response = person.page.waitForResponse((response) =>
          response.url().endsWith(`/api/databases/${database.id}/${direction}`),
        );
        await history
          .getByRole('listbox', {
            name: direction === 'undo' ? 'Changes to undo, newest first' : 'Changes to redo, next first',
          })
          .getByRole('option')
          .first()
          .click();
        return (await response).json();
      };
      expect(await reverse('undo')).toMatchObject({ status: 'nothing', skipped: 1 });
      await expect(
        person.page.getByText('1 change was skipped because the data or your permissions changed.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(undo.getByRole('option')).toHaveCount(1);
      await expect(history.getByRole('listbox', { name: 'Changes to redo, next first' })).toHaveCount(0);
      await share(page, database.id, person, 'creator');
      expect(await reverse('undo')).toMatchObject({ status: 'applied', skipped: 0 });
      const read = () =>
        asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${table.id}/records/${table.records[0]}`,
        );
      expect((await read()).values[table.fields.Notes!]).toBe('Before');
      expect(await reverse('redo')).toMatchObject({ status: 'applied', skipped: 0 });
      expect((await read()).values[table.fields.Notes!]).toBe('After');
    } finally {
      await person.context.close();
    }
  });
}

for (const width of [390, 1280]) {
  for (const direction of ['undo', 'redo'] as const) {
    test(`${direction} history refuses a demoted reader at width ${width}`, async ({ page, browser }) => {
      await signIn(page);
      const database = await createDatabase(page, 'Write history', [
        {
          name: 'Tasks',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Notes', type: 'text' },
          ],
          records: [{ Name: 'Review', Notes: 'Before' }],
        },
      ]);
      const person = await invite(page, browser, `Rowan ${direction}`);
      try {
        await person.page.setViewportSize({ width, height: 900 });
        await share(page, database.id, person, 'editor');
        const grid = await openTable(person.page, database, 'Tasks');
        await grid
          .getByRole('button', { name: /^Expand row/ })
          .first()
          .click();
        const card = person.page.getByRole('dialog', { name: 'Review', exact: true });
        const saved = person.page.waitForResponse((response) =>
          response.url().endsWith(`/api/databases/${database.id}/commands`),
        );
        const notes = card.getByRole('textbox', { name: 'Notes', exact: true });
        await notes.fill('After');
        await notes.press('Enter');
        expect((await saved).ok()).toBe(true);
        await person.page.keyboard.press('Escape');
        await expect(card).toBeHidden();
        if (direction === 'redo') {
          // Undo belongs to the grid, whose focus returns after the card closes.
          await expect(person.page.locator('.rio-grid__input')).toBeFocused();
          const undone = person.page.waitForResponse((response) =>
            response.url().endsWith(`/api/databases/${database.id}/undo`),
          );
          await person.page.keyboard.press('ControlOrMeta+z');
          expect(await (await undone).json()).toMatchObject({ status: 'applied' });
        }
        await share(page, database.id, person, 'reader');
        await expect(grid).toHaveAttribute('aria-readonly', 'true');
        await person.page.getByRole('button', { name: 'Undo history', exact: true }).click();
        const history = person.page.getByRole('dialog', { name: 'Undo history' });
        const list = history.getByRole('listbox', {
          name: direction === 'undo' ? 'Changes to undo, newest first' : 'Changes to redo, next first',
        });
        const refused = person.page.waitForResponse((response) =>
          response.url().endsWith(`/api/databases/${database.id}/${direction}`),
        );
        await list.getByRole('option').first().click();
        expect(await (await refused).json()).toMatchObject({
          status: 'rejected',
          error: { messageKey: 'data.access.denied' },
        });
        await expect(
          person.page.getByText('You don’t have access to do that in this database.', { exact: true }),
        ).toBeVisible();
        await expect(list.getByRole('option')).toHaveCount(1);
        await person.page.keyboard.press('Escape');
        await grid
          .getByRole('button', { name: /^Expand row/ })
          .first()
          .click();
        await expect(card.getByRole('group', { name: 'Notes', exact: true })).toContainText(
          direction === 'undo' ? 'After' : 'Before',
        );
      } finally {
        await person.context.close();
      }
    });
  }
}

for (const width of [390, 1280]) {
  for (const direction of ['undo', 'redo'] as const) {
    test(`${direction} skips a hidden record move at width ${width}`, async ({ page, browser }) => {
      await signIn(page);
      const database = await createDatabase(page, 'Move access', [
        {
          name: 'Tasks',
          fields: [{ name: 'Name', type: 'text' }],
          records: [{ Name: 'Visible' }, { Name: 'Hidden' }],
        },
      ]);
      const table = database.tables.Tasks!;
      const viewId = await createView(page, database, 'Tasks', { name: 'Move history', type: 'list' });
      await asOwner(page, 'PUT', `/api/tables/${table.id}/record-rules`, {
        rules: [
          {
            id: newId('rul'),
            roles: ['editor'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: table.fields.Name, operator: 'is', value: 'Visible' }],
            },
          },
        ],
      });
      const person = await invite(page, browser, `Move ${direction}`);
      try {
        await share(page, database.id, person, 'creator');
        await person.page.setViewportSize({ width, height: 900 });
        const address = `${base()}/${database.id}/${table.id}/${viewId}`;
        await visit(person.page, address);
        const tree = person.page.getByRole('tree', { name: 'Move history' });
        await expect(tree.getByRole('treeitem')).toHaveText(['Visible', 'Hidden']);
        await tree.getByRole('treeitem', { name: 'Hidden', exact: true }).focus();
        const moved = person.page.waitForResponse((response) =>
          response.url().endsWith(`/api/databases/${database.id}/commands`),
        );
        await person.page.keyboard.press('Alt+ArrowUp');
        expect(await (await moved).json()).toMatchObject({ results: [{ status: 'applied' }] });
        await expect(tree.getByRole('treeitem')).toHaveText(['Hidden', 'Visible']);
        if (direction === 'redo') {
          await person.page.getByRole('button', { name: 'Undo history', exact: true }).click();
          const history = person.page.getByRole('dialog', { name: 'Undo history' });
          const undone = person.page.waitForResponse((response) =>
            response.url().endsWith(`/api/databases/${database.id}/undo`),
          );
          await history
            .getByRole('listbox', { name: 'Changes to undo, newest first' })
            .getByRole('option')
            .first()
            .click();
          expect(await (await undone).json()).toMatchObject({ status: 'applied', skipped: 0 });
          await history.getByRole('button', { name: 'Close', exact: true }).click();
          await expect(history).toBeHidden();
          await expect(tree.getByRole('treeitem')).toHaveText(['Visible', 'Hidden']);
        }
        await share(page, database.id, person, 'editor');
        await expect(tree.getByRole('treeitem')).toHaveText(['Visible']);
        await person.page.getByRole('button', { name: 'Undo history', exact: true }).click();
        const history = person.page.getByRole('dialog', { name: 'Undo history' });
        const reversed = person.page.waitForResponse((response) =>
          response.url().endsWith(`/api/databases/${database.id}/${direction}`),
        );
        await history
          .getByRole('listbox', {
            name: direction === 'undo' ? 'Changes to undo, newest first' : 'Changes to redo, next first',
          })
          .getByRole('option')
          .first()
          .click();
        expect(await (await reversed).json()).toMatchObject({ status: 'nothing', skipped: 1 });
        await history.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(history).toBeHidden();
        await expect(tree.getByRole('treeitem')).toHaveText(['Visible']);
        await visit(page, address);
        await expect(page.getByRole('tree', { name: 'Move history' }).getByRole('treeitem')).toHaveText(
          direction === 'undo' ? ['Hidden', 'Visible'] : ['Visible', 'Hidden'],
        );
      } finally {
        await person.context.close();
      }
    });
  }
}

test('a locked field refuses conversion from its edit dialog', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Schema locks', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'text' },
      ],
      records: [{ Name: 'Review', Notes: 'Keep this' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await asOwner(page, 'PUT', `/api/fields/${table.fields.Notes}/permissions`, {
    restricted: null,
    locked: { roles: [], users: [] },
  });
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('columnheader', { name: 'Notes', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  await dialog.getByRole('button', { name: /Type/ }).click();
  await page.getByRole('option', { name: 'Long text', exact: true }).click();
  await expect(dialog.getByText('Every value converts.', { exact: true })).toBeVisible();
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/databases/${database.id}/commands`),
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await (await saved).json()).toMatchObject({
    results: [
      { status: 'rejected', error: { messageKey: 'data.access.fieldLockedConversion' } },
      { status: 'applied' },
    ],
  });
  await expect(page.getByText('Unlock this field before changing its type.', { exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Keep this', exact: true })).toBeVisible();
});

test('a creator cannot clear a locked choice from the field dialog', async ({ page, browser }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Choice locks', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
      ],
      records: [{ Name: 'Review', Status: 'Ready' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await asOwner(page, 'PUT', `/api/fields/${table.fields.Status}/permissions`, {
    restricted: null,
    locked: { roles: ['creator'], users: [] },
  });
  const person = await invite(page, browser, 'Morgan Reed');
  try {
    await share(page, database.id, person, 'creator');
    const grid = await openTable(person.page, database, 'Tasks');
    await grid.getByRole('columnheader', { name: 'Status', exact: true }).click({ button: 'right' });
    await person.page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
    const dialog = person.page.getByRole('dialog', { name: 'Edit field' });
    await dialog.getByRole('button', { name: 'Remove Ready', exact: true }).click();
    const saved = person.page.waitForResponse((response) =>
      response.url().endsWith(`/api/databases/${database.id}/commands`),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await (await saved).json()).toMatchObject({
      results: [{ status: 'rejected', error: { messageKey: 'data.access.fieldLockedChoices' } }],
    });
    await expect(
      person.page.getByText('Only a database owner can remove choices from a locked field.', { exact: true }),
    ).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: 'Ready', exact: true })).toBeVisible();
  } finally {
    await person.context.close();
  }
});

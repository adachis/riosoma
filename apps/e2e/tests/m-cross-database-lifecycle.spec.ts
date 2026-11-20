import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', actionTimeout: 15_000 });

test('opens deleted linked databases from the trash address', async ({ page }) => {
  await signIn(page);
  await visit(page, `${base()}/?trash=1`);
  await expect(page.getByRole('dialog', { name: 'Deleted databases', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Deleted databases', exact: true })).toBeHidden();
});

test('copies both one-way endpoints and restores a destination snapshot without redirecting the original link', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const target = await createDatabase(page, 'Snapshot directory', [
    { name: 'Contacts', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Morgan 🌊' }] },
  ]);
  const source = await createDatabase(page, 'Snapshot planning', [
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
  ]);
  const projects = source.tables.Projects!,
    contacts = target.tables.Contacts!;
  const linkId = newId('fld');
  await runCommands(page, source.id, [
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: linkId,
        name: 'Contact',
        type: 'link',
        options: { linkedTableId: contacts.id, oneWay: true },
      },
    },
    {
      kind: 'record.update',
      tableId: projects.id,
      records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
    },
  ]);
  for (const [side, tableName, databaseName] of [
    [source, 'Projects', 'Snapshot planning'],
    [target, 'Contacts', 'Snapshot directory'],
  ] as const) {
    await openTable(page, side, tableName);
    await page.getByRole('button', { name: 'Database settings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate database', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Duplicate ${databaseName}`, exact: true });
    const copiedName = `${databaseName} copy`;
    await dialog.getByRole('textbox', { name: 'New database name', exact: true }).fill(copiedName);
    await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(dialog).toContainText(`Made ${copiedName} with 1 table and 1 records.`, { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Open the new database', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toContainText(
      side === source ? 'Harbor' : 'Morgan 🌊',
    );
    if (side === source) {
      const copiedId = page.url().split('/')[3]!;
      const schema = await asOwner<{
        fields: Array<{ id: string; type: string; options: { oneWay?: boolean; linkedTableId?: string } }>;
        views: Array<{ id: string }>;
      }>(page, 'GET', `/api/databases/${copiedId}/schema`);
      const field = schema.fields.find((field) => field.type === 'link')!;
      expect(field.options).toMatchObject({ oneWay: true, linkedTableId: contacts.id });
      const copiedRows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${schema.views[0]!.id}/rows`,
      );
      expect(copiedRows.rows[0]!.values[field.id]).toEqual(contacts.records);
    }
  }
  await openTable(page, source, 'Projects');
  await page.getByRole('button', { name: 'Database settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Snapshots', exact: true }).click();
  let snapshots = page.getByRole('dialog', { name: 'Snapshots', exact: true });
  await snapshots.getByRole('textbox', { name: 'Snapshot name', exact: true }).fill('External references');
  const refused = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/databases/${source.id}/snapshots`) &&
      response.request().method() === 'POST',
  );
  await snapshots.getByRole('button', { name: 'Take a snapshot', exact: true }).click();
  expect((await refused).status()).toBe(403);
  await expect(snapshots).toContainText(
    'You can’t see every table and field in this database, so you can’t take a copy of it.  Ask its owner.',
  );
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await openTable(page, target, 'Contacts');
  await page.getByRole('button', { name: 'Database settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Snapshots', exact: true }).click();
  snapshots = page.getByRole('dialog', { name: 'Snapshots', exact: true });
  await snapshots
    .getByRole('textbox', { name: 'Snapshot name', exact: true })
    .fill('Destination before change');
  await snapshots.getByRole('button', { name: 'Take a snapshot', exact: true }).click();
  await expect(
    snapshots.getByRole('button', { name: 'More for Destination before change', exact: true }),
  ).toBeVisible();
  await runCommands(page, target.id, [
    {
      kind: 'record.update',
      tableId: contacts.id,
      records: [{ id: contacts.records[0], values: { [contacts.fields.Name!]: 'Updated contact' } }],
    },
  ]);
  await snapshots.getByRole('button', { name: 'More for Destination before change', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restore as a new database', exact: true }).click();
  await snapshots.getByRole('textbox', { name: 'New database name', exact: true }).fill('Restored directory');
  await snapshots.getByRole('button', { name: 'Restore as a new database', exact: true }).click();
  await expect(snapshots).toContainText('Made Restored directory with 1 table and 1 records.', {
    timeout: 30_000,
  });
  await snapshots.getByRole('button', { name: 'Open the new database', exact: true }).click();
  await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toContainText('Morgan 🌊');
  const original = await asOwner<{ values: Record<string, unknown> }>(
    page,
    'GET',
    `/api/tables/${projects.id}/records/${projects.records[0]}`,
  );
  expect(original.values[linkId]).toEqual(contacts.records);
  const grid = await openTable(page, source, 'Projects');
  await grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
    .getByRole('button', { name: /^Expand row/ })
    .click();
  await page
    .getByRole('dialog', { name: 'Harbor', exact: true })
    .getByRole('button', { name: 'Updated contact', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(target.id));
});

async function rename(page: Page, databaseName: string, tableName: string, nextTableName: string) {
  await page.getByRole('heading', { level: 1 }).getByRole('button').click();
  const name = page.getByRole('textbox', { name: 'Database name', exact: true });
  await name.fill(databaseName);
  await name.press('Enter');
  await expect(page.getByRole('button', { name: databaseName, exact: true })).toHaveText(databaseName);
  await page.getByRole('button', { name: `More for ${tableName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const table = page.getByRole('textbox', { name: 'Rename', exact: true });
  await table.fill(nextTableName);
  await table.press('Enter');
  await expect(page.getByRole('link', { name: nextTableName, exact: true })).toBeVisible();
}

for (const oneWay of [true, false]) {
  test(`keeps a ${oneWay ? 'one-way' : 'paired'} link live through both endpoint lifecycles`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const person = await invite(page, browser, oneWay ? 'Quinn Lifecycle' : 'Casey Lifecycle');
    try {
      const target = await createDatabase(page, 'Lifecycle directory', [
        { name: 'Contacts', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: '東京 🌊 مرحبا' }] },
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      const source = await createDatabase(page, 'Lifecycle planning', [
        { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      const projects = source.tables.Projects!,
        contacts = target.tables.Contacts!;
      const linkId = newId('fld');
      await runCommands(page, source.id, [
        {
          kind: 'field.create',
          tableId: projects.id,
          field: {
            id: linkId,
            name: 'Contact',
            type: 'link',
            options: { linkedTableId: contacts.id, oneWay },
          },
        },
        {
          kind: 'field.create',
          tableId: projects.id,
          field: {
            id: newId('fld'),
            name: 'Contact name',
            type: 'lookup',
            options: { linkFieldId: linkId, targetFieldId: contacts.fields.Name },
          },
        },
        {
          kind: 'record.update',
          tableId: projects.id,
          records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
        },
      ]);
      await share(page, source.id, person, 'owner');
      await share(page, target.id, person, 'owner');
      await person.page.setViewportSize({ width: 390, height: 844 });
      const grid = await openTable(person.page, source, 'Projects');
      await grid
        .getByRole('row')
        .filter({ has: person.page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
        .getByRole('button', { name: /^Expand row/ })
        .click();
      const sourceAddress = person.page.url();
      const card = person.page.getByRole('dialog', { name: 'Harbor', exact: true });
      const linked = card.getByRole('button', { name: '東京 🌊 مرحبا', exact: true });
      await expect(linked).toBeVisible();
      await expect(card.getByRole('group', { name: 'Contact name', exact: true })).toContainText(
        '東京 🌊 مرحبا',
      );

      for (const [side, tableName, nextTableName, databaseName] of [
        [target, 'Contacts', 'People 東京', 'Directory 🌊'],
        [source, 'Projects', 'Plans مرحبا', 'Planning 東京'],
      ] as const) {
        await openTable(page, side, tableName);
        await rename(page, databaseName, tableName, nextTableName);
        await page.getByRole('link', { name: nextTableName, exact: true }).press('Alt+ArrowDown');
        await expect(
          page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('link').first(),
        ).toHaveText('Notes');
        await expect(linked).toBeVisible();

        await page.getByRole('button', { name: 'Share', exact: true }).click();
        let sharing = page.getByRole('dialog', { name: `Share ${databaseName}`, exact: true });
        await sharing.getByRole('button', { name: `Remove ${person.name}`, exact: true }).click();
        await expect(sharing.getByRole('button', { name: `Remove ${person.name}`, exact: true })).toHaveCount(
          0,
        );
        if (side === target) await expect(linked).toHaveCount(0);
        else {
          const unavailable = await person.page.request.get(`${base()}/api/databases/${side.id}/schema`);
          expect(unavailable.status()).toBe(404);
          await expect(person.page.getByRole('grid', { name: 'Grid', exact: true })).toHaveCount(0);
          await expect(person.page).toHaveURL(`${base()}/`);
        }
        await page.keyboard.press('Escape');
        await share(page, side.id, person, 'owner');
        await visit(person.page, sourceAddress);
        await expect(linked).toBeVisible();

        // The organization administrator can recover a database after transferring its direct grant.
        await openTable(person.page, side, tableName);
        await person.page.getByRole('button', { name: 'Share', exact: true }).click();
        sharing = person.page.getByRole('dialog', { name: `Share ${databaseName}`, exact: true });
        await sharing.getByRole('button', { name: 'Remove Ada Lovelace', exact: true }).click();
        await expect(sharing.getByRole('button', { name: 'Remove Ada Lovelace', exact: true })).toHaveCount(
          0,
        );
        await person.page.keyboard.press('Escape');
        await asOwner(person.page, 'PUT', `/api/databases/${side.id}/grants`, {
          principal: {
            kind: 'user',
            id: (await asOwner<{ user: { id: string } }>(page, 'GET', '/api/auth/session')).user.id,
          },
          role: 'owner',
        });
        await visit(person.page, sourceAddress);
        await expect(linked).toBeVisible();

        await visit(page, base());
        await page.getByRole('button', { name: 'New folder', exact: true }).click();
        const folderName = `Files for ${nextTableName} ${oneWay ? 'one-way' : 'paired'}`;
        const folder = page.getByRole('dialog', { name: 'New folder', exact: true });
        await folder.getByRole('textbox', { name: 'Folder name' }).fill(folderName);
        await folder.getByRole('textbox', { name: 'Folder name' }).press('Enter');
        await expect(folder).toBeHidden();
        await page.getByRole('button', { name: `More for ${databaseName}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
        const moving = page.getByRole('dialog', { name: `Move ${databaseName}`, exact: true });
        await moving.getByRole('button', { name: /Destination$/ }).click();
        await page.getByRole('option', { name: folderName, exact: true }).click();
        await moving.getByRole('button', { name: 'Move', exact: true }).click();
        await expect(moving).toBeHidden();
        await expect(linked).toBeVisible();
        await person.page.reload();
        await expect(linked).toBeVisible();

        await openTable(page, side, 'Notes');
        await page.getByRole('button', { name: `More for ${nextTableName}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Delete table', exact: true }).click();
        await page
          .getByRole('dialog', { name: `Delete ${nextTableName}?`, exact: true })
          .getByRole('button', { name: 'Delete table', exact: true })
          .click();
        await expect(page.getByRole('link', { name: nextTableName, exact: true })).toHaveCount(0);
        if (side === target) await expect(linked).toHaveCount(0);
        else await expect(card).toHaveCount(0);
        await page.getByRole('button', { name: 'Trash', exact: true }).click();
        const trash = page.getByRole('dialog', { name: 'Trash', exact: true });
        await trash.getByRole('button', { name: `Restore ${nextTableName}`, exact: true }).click();
        await expect(
          trash.getByRole('button', { name: `Restore ${nextTableName}`, exact: true }),
        ).toHaveCount(0);
        await page.keyboard.press('Escape');
        if (side === source) await visit(person.page, sourceAddress);
        await expect(linked).toBeVisible();

        await visit(page, base());
        await page.getByRole('button', { name: folderName, exact: true }).click();
        await page.getByRole('button', { name: `More for ${databaseName}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Delete database', exact: true }).click();
        await page
          .getByRole('dialog', { name: `Delete ${databaseName}?`, exact: true })
          .getByRole('button', { name: 'Delete database', exact: true })
          .click();
        if (side === target) await expect(linked).toHaveCount(0);
        else await expect(card).toHaveCount(0);
        await visit(page, `${base()}/?trash=1`);
        const deleted = page.getByRole('dialog', { name: 'Deleted databases', exact: true });
        await deleted.getByRole('button', { name: `Restore ${databaseName}`, exact: true }).click();
        await expect(
          deleted.getByRole('button', { name: `Restore ${databaseName}`, exact: true }),
        ).toHaveCount(0);
        await page.keyboard.press('Escape');
        if (side === source) await visit(person.page, sourceAddress);
        await expect(linked).toBeVisible();
        const record = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${projects.id}/records/${projects.records[0]}`,
        );
        expect(record.values[linkId]).toEqual(contacts.records);
      }
    } finally {
      await person.context.close();
    }
  });
}

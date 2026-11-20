import { openNewField } from '../grid-fields';
import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

test.afterEach(async ({ page: _page }, info) => {
  expect(info.attachments.some((attachment) => attachment.name === 'accessibility')).toBe(true);
});

for (const oneWay of [false, true]) {
  test(`creates a ${oneWay ? 'one-way' : 'paired'} cross-database link, picks a record, and follows its address`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const person = await invite(page, browser, oneWay ? 'Taylor Brooks' : 'Jordan Brooks');
    try {
      const target = await createDatabase(page, oneWay ? 'One-way directory' : 'Paired directory', [
        { name: 'Contacts', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Morgan Rivera' }] },
      ]);
      const source = await createDatabase(page, oneWay ? 'One-way planning' : 'Paired planning', [
        { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor project' }] },
      ]);
      await share(page, source.id, person, 'owner');
      await share(page, target.id, person, oneWay ? 'editor' : 'creator');
      const grid = await openTable(person.page, source, 'Projects');
      if (oneWay) await person.page.setViewportSize({ width: 390, height: 844 });
      await openNewField(person.page);
      const dialog = person.page.getByRole('dialog', { name: 'New field' });
      await dialog.getByRole('button', { name: /Type$/ }).click();
      await person.page.getByRole('option', { name: 'Link to another record', exact: true }).click();
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Contact');
      await dialog.getByRole('button', { name: /Link to$/ }).click();
      await person.page.getByRole('searchbox').fill('Contacts');
      await expect(person.page.getByRole('listbox')).toContainText(
        oneWay ? 'One-way directory' : 'Paired directory',
      );
      await person.page.getByRole('option', { name: 'Contacts', exact: true }).click();
      if (oneWay) await expect(dialog.getByText(/This link will appear only in this table/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Create field' }).click();
      await expect(dialog).toBeHidden();
      await grid
        .getByRole('row')
        .filter({ has: person.page.getByRole('gridcell', { name: 'Harbor project', exact: true }) })
        .getByRole('button', { name: /^Expand row/ })
        .click();
      const card = person.page.getByRole('dialog', { name: 'Harbor project', exact: true });
      await card.getByRole('button', { name: 'Link a record', exact: true }).click();
      await expect(
        card.getByText(oneWay ? 'Records from One-way directory' : 'Records from Paired directory'),
      ).toBeVisible();
      await card.getByRole('searchbox', { name: 'Find a record' }).fill('Morgan');
      await card.getByRole('option', { name: 'Morgan Rivera', exact: true }).click();
      await card.getByRole('button', { name: 'Morgan Rivera', exact: true }).click();
      await expect(person.page.getByRole('dialog', { name: 'Morgan Rivera', exact: true })).toBeVisible();
      expect(person.page.url()).toContain(target.id);
      expect(person.page.url()).toContain(target.tables.Contacts!.records[0]!);
      const address = person.page.url();
      await person.page.reload();
      await expect(person.page).toHaveURL(address);
      await expect(person.page.getByRole('dialog', { name: 'Morgan Rivera', exact: true })).toBeVisible();
      const schema = (await asOwner(page, 'GET', `/api/databases/${target.id}/schema`)) as {
        fields: Array<{ name: string; type: string }>;
      };
      expect(schema.fields.some((field) => field.name === 'Projects' && field.type === 'link')).toBe(!oneWay);
    } finally {
      await person.context.close();
    }
  });
}

for (const readable of [true, false]) {
  test(`copies an external link with destination read access set to ${readable}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const person = await invite(page, browser, readable ? 'Casey Rivera' : 'Alex Rivera');
    try {
      const target = await createDatabase(page, 'Copy directory', [
        { name: 'Contacts', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Morgan Rivera' }] },
      ]);
      const source = await createDatabase(page, 'Copy planning', [
        { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor project' }] },
      ]);
      const fieldId = newId('fld');
      await runCommands(page, source.id, [
        {
          kind: 'field.create',
          tableId: source.tables.Projects!.id,
          field: {
            id: fieldId,
            name: 'Contact',
            type: 'link',
            options: { linkedTableId: target.tables.Contacts!.id },
          },
        },
        {
          kind: 'record.update',
          tableId: source.tables.Projects!.id,
          records: [
            {
              id: source.tables.Projects!.records[0]!,
              values: { [fieldId]: [target.tables.Contacts!.records[0]!] },
            },
          ],
        },
      ]);
      await share(page, source.id, person, 'owner');
      if (readable) await share(page, target.id, person, 'reader');
      await openTable(person.page, source, 'Projects');
      if (!readable) await person.page.setViewportSize({ width: 390, height: 844 });
      await person.page.getByRole('button', { name: 'Database settings' }).click();
      await person.page.getByRole('menuitem', { name: 'Duplicate database' }).click();
      const dialog = person.page.getByRole('dialog', { name: 'Duplicate Copy planning' });
      await dialog.getByRole('textbox', { name: 'New database name' }).fill('Copied planning');
      await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect(dialog.getByText('Made Copied planning with 1 table and 1 records.')).toBeVisible({
        timeout: 30_000,
      });
      const warning = dialog.getByText(
        'Projects → Contact was copied with empty values because you cannot read its destination table.',
      );
      if (readable) await expect(warning).toHaveCount(0);
      else await expect(warning).toBeVisible();
      await dialog.getByRole('button', { name: 'Open the new database' }).click();
      await expect(person.page.getByRole('heading', { name: 'Copied planning', exact: true })).toContainText(
        'Copied planning',
      );
      const grid = person.page.getByRole('grid', { name: 'Grid', exact: true });
      if (readable)
        await expect(grid.getByRole('columnheader', { name: 'Contact', exact: true })).toBeVisible();
      else await expect(grid.getByRole('columnheader', { name: 'Contact', exact: true })).toHaveCount(0);
      await grid
        .getByRole('row')
        .filter({ has: person.page.getByRole('gridcell', { name: 'Harbor project', exact: true }) })
        .getByRole('button', { name: /^Expand row/ })
        .click();
      const record = person.page.getByRole('dialog', { name: 'Harbor project', exact: true });
      if (readable) {
        await record.getByRole('button', { name: 'Morgan Rivera', exact: true }).click();
        await expect(person.page.getByRole('dialog', { name: 'Morgan Rivera', exact: true })).toBeVisible();
        expect(person.page.url()).toContain(target.id);
      } else await expect(record.getByRole('button', { name: 'Morgan Rivera', exact: true })).toHaveCount(0);
    } finally {
      await person.context.close();
    }
  });
}

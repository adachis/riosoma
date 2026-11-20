import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, newId, runCommands, signIn, visit } from '../helpers';

for (const phone of [false, true])
  test(`link choices, preview, paging, and creation on ${phone ? 'phone' : 'desktop'}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    const database = await createDatabase(page, 'Link choices', [
      {
        name: 'Requests',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Region', type: 'text' },
        ],
      },
      {
        name: 'Contacts',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Region', type: 'text', options: { defaultValue: { kind: 'value', value: 'West' } } },
          {
            name: 'Status',
            type: 'singleSelect',
            choices: ['Active', 'Paused'],
            options: { defaultValue: { kind: 'firstChoice' } },
          },
          { name: 'Details', type: 'text' },
        ],
        records: [
          { Name: 'Alpine', Region: 'West', Status: 'Active', Details: 'alpine@example.test' },
          { Name: 'Eastern', Region: 'East', Status: 'Paused', Details: 'eastern@example.test' },
          ...Array.from({ length: 115 }, (_, index) => ({
            Name: `Contact ${index}`,
            Region: 'West',
            Status: 'Active',
            Details: `Detail ${index}`,
          })),
        ],
      },
    ]);
    const requests = database.tables.Requests!;
    const contacts = database.tables.Contacts!;
    const linkId = newId('fld');
    await runCommands(page, database.id, [
      {
        kind: 'field.create',
        tableId: requests.id,
        field: {
          id: linkId,
          name: 'Contact',
          type: 'link',
          options: {
            linkedTableId: contacts.id,
            displayFieldIds: [contacts.fields.Region, contacts.fields.Status, contacts.fields.Details],
            filter: {
              conjunction: 'and',
              conditions: [
                {
                  id: 'region',
                  fieldId: contacts.fields.Region,
                  operator: 'is',
                  currentFieldId: requests.fields.Region,
                },
              ],
            },
          },
        },
      },
    ]);
    const viewId = await createView(page, database, 'Requests', {
      name: 'Request form',
      type: 'form',
      config: {
        form: {
          questions: [
            { fieldId: requests.fields.Name },
            { fieldId: requests.fields.Region },
            { fieldId: linkId },
          ],
        },
      },
    });
    await visit(page, `${base()}/${database.id}/${requests.id}/${viewId}`);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('New request');
    await page.getByRole('textbox', { name: 'Region', exact: true }).fill('West');
    await page.getByRole('button', { name: 'Link a record', exact: true }).click();
    const picker = page.locator('.rio-link-picker');
    const search = picker.getByRole('searchbox', { name: 'Find a record' });
    await expect(picker.getByRole('button', { name: 'Load more records' })).toBeVisible();
    await expect.poll(() => picker.getByRole('option').count()).toBeLessThan(100);
    await picker.getByRole('button', { name: 'Load more records' }).click();
    await expect(picker.getByRole('button', { name: 'Load more records' })).toHaveCount(0);
    await search.fill('alpine@example');
    const option = picker.getByRole('option', { name: 'Alpine' });
    await expect(option).toBeVisible();
    await expect(option.locator('.rio-choice-pill')).toContainText('Active');
    await search.press('ArrowDown');
    await expect(option).toBeFocused();
    const preview = picker.getByRole('complementary', { name: 'Record preview' });
    await expect(preview).toContainText('alpine@example.test');
    await option.press('Tab');
    await expect(preview).toBeFocused();
    await preview.press('Shift+Tab');
    await expect(option).toBeFocused();
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((body) => body.clientWidth),
    );
    await option.press('Enter');
    await expect(picker.getByRole('button', { name: 'Remove Alpine' })).toBeVisible();
    await search.fill('Eastern');
    await expect(picker.getByText('No matching records', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Region', exact: true }).fill('East');
    await page.getByRole('textbox', { name: 'Region', exact: true }).press('Tab');
    await expect(picker.getByRole('option', { name: 'Eastern' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Region', exact: true }).fill('West');
    await search.fill('New contact');
    await picker.getByRole('button', { name: 'Add new record “New contact”' }).click();
    await expect(picker.getByRole('button', { name: 'Remove New contact' })).toBeVisible();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Your answer was recorded.' })).toBeVisible();
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${requests.viewId}/rows`,
    );
    expect(rows.rows[0]!.values[linkId]).toHaveLength(2);
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((body) => body.clientWidth),
    );
  });

for (const phone of [false, true])
  test(`focuses and scrolls the grid preview before advancing on ${phone ? 'phone' : 'desktop'}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    const details = Array.from({ length: 20 }, (_, index) => `Detail ${index}`);
    const database = await createDatabase(page, 'Keyboard links', [
      { name: 'Requests', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Request' }] },
      {
        name: 'Contacts',
        fields: [{ name: 'Name', type: 'text' }, ...details.map((name) => ({ name, type: 'text' }))],
        records: [{ Name: 'Alpine', ...Object.fromEntries(details.map((name) => [name, name])) }],
      },
    ]);
    const requests = database.tables.Requests!;
    const contacts = database.tables.Contacts!;
    await runCommands(page, database.id, [
      {
        kind: 'field.create',
        tableId: requests.id,
        field: { id: newId('fld'), name: 'Contact', type: 'link', options: { linkedTableId: contacts.id } },
      },
      {
        kind: 'field.create',
        tableId: requests.id,
        field: { id: newId('fld'), name: 'Next field', type: 'text' },
      },
    ]);
    await visit(page, `${base()}/${database.id}/${requests.id}/${requests.viewId}`);
    const grid = page.locator('.rio-grid__scroller');
    await grid.locator('[data-rio-row="0"][data-rio-col="0"]').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const picker = page.locator('.rio-link-picker');
    const option = picker.getByRole('option', { name: 'Alpine' });
    await expect(option).toBeVisible();
    const initialBox = await option.boundingBox();
    await option.hover();
    expect(await option.boundingBox()).toEqual(initialBox);
    await picker.getByRole('searchbox', { name: 'Find a record' }).press('ArrowDown');
    await expect(option).toBeFocused();
    await option.press('Tab');
    const preview = picker.getByRole('complementary', { name: 'Record preview' });
    await expect(preview).toBeFocused();
    await preview.press('ArrowDown');
    await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await preview.press('Shift+Tab');
    await expect(option).toBeFocused();
    await option.press('Tab');
    await expect(preview).toBeFocused();
    await preview.press('Tab');
    await expect(picker).toHaveCount(0);
    await expect(grid.locator('[data-rio-row="0"][data-rio-col="2"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('compatible field conversions keep their default after saving the dialog', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Converted defaults', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number', options: { defaultValue: { kind: 'value', value: 7 } } },
      ],
    },
  ]);
  const table = database.tables.Tasks!;
  await openTable(page, database, 'Tasks');
  await page.goto(`${page.url()}?fieldRules=${table.fields.Amount}`);
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  await dialog.getByRole('button', { name: /Type/ }).click();
  await page.getByRole('option', { name: 'Currency', exact: true }).click();
  await expect(
    dialog.getByRole('group', { name: 'Default value' }).getByRole('textbox', { name: 'Value', exact: true }),
  ).toHaveValue('$7.00');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const schema = await asOwner<{ fields: Array<{ id: string; options: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  expect(schema.fields.find((field) => field.id === table.fields.Amount)!.options.defaultValue).toEqual({
    kind: 'value',
    value: 7,
  });
});

for (const phone of [false, true]) {
  test(`required form questions use defaults at ${phone ? 'phone' : 'desktop'} width`, async ({
    page,
    browser,
  }) => {
    if (phone) await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const database = await createDatabase(page, 'Form defaults', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text', options: { defaultValue: { kind: 'value', value: 'Open' } } },
          { name: 'Count', type: 'number', options: { defaultValue: { kind: 'value', value: 2 } } },
        ],
      },
    ]);
    const table = database.tables.Tasks!;
    const viewId = newId('viw');
    await runCommands(page, database.id, [
      {
        kind: 'view.create',
        view: {
          id: viewId,
          tableId: table.id,
          name: 'Form',
          type: 'form',
          config: {
            form: {
              questions: Object.values(table.fields).map((fieldId) => ({ fieldId, required: true })),
            },
          },
        },
      },
    ]);
    await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await submit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Thanks!' })).toContainText(
      'Thanks!  Your answer was recorded.',
    );
    const shared = await asOwner<{ formId: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
    const interfaceId = `itf${newId('rec').slice(3)}`;
    const pageId = 'formPage01';
    const blockId = 'formButton01';
    await runCommands(page, database.id, [
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Forms',
          pages: [
            {
              id: pageId,
              name: 'Forms',
              blocks: [
                {
                  id: blockId,
                  kind: 'button',
                  label: 'Apply',
                  place: { x: 0, y: 0, w: 6, h: 4 },
                  action: { kind: 'form', tableId: table.id, viewId },
                },
              ],
            },
          ],
        },
      },
    ]);
    const siteSlug = `form-${newId('rec').slice(3).toLowerCase()}`;
    await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug: siteSlug,
      title: 'Forms',
      pages: [{ pageId, slug: 'apply', title: 'Apply' }],
    });
    const visitor = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: phone ? 375 : 1280, height: 812 },
    });
    try {
      const form = await visitor.newPage();
      await visit(form, `${base()}/f/${shared.formId}`);
      await form.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(form.getByRole('status')).toContainText('Thanks!  Your answer was recorded.');
      await visit(form, `${base()}/sites/${siteSlug}/forms/${pageId}/${blockId}`);
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).not.toHaveAttribute('required');
      await expect(form.locator('input[name="ticket"]')).toBeAttached();
      const issuedAt = await form.locator('input[name="ticket"]').inputValue();
      const readyAt = Number(issuedAt.split('.')[0]) + 2100;
      await expect.poll(() => Date.now()).toBeGreaterThanOrEqual(readyAt);
      const submitted = form.waitForResponse(
        (response) => response.url() === form.url() && response.request().method() === 'POST',
      );
      await form.getByRole('button', { name: 'Submit', exact: true }).click();
      expect((await submitted).status()).toBe(200);
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveCount(0);
    } finally {
      await visitor.close();
    }
    const grid = await openTable(page, database, 'Tasks');
    await expect(grid.getByRole('gridcell', { name: 'Open', exact: true })).toHaveCount(3);
    await expect(grid.getByRole('gridcell', { name: '2', exact: true })).toHaveCount(3);
  });
}

test('a field’s default fills in a new row and leaves the rows already there alone', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Field defaults', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
        { name: 'Priority', type: 'singleSelect', choices: ['Low', 'High'] },
      ],
      records: [{ Name: 'Existing' }],
    },
  ]);
  const table = database.tables.Tasks!;

  await openTable(page, database, 'Tasks');
  await page.goto(`${page.url()}?fieldRules=${table.fields.Status}`);
  let settings = page.getByRole('dialog', { name: 'Edit field' });
  let defaults = settings.getByRole('group', { name: 'Default value' });
  await defaults.getByRole('textbox', { name: 'Value', exact: true }).fill('Open');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();

  await openTable(page, database, 'Tasks');
  await page.goto(`${page.url()}?fieldRules=${table.fields.Priority}`);
  settings = page.getByRole('dialog', { name: 'Edit field' });
  defaults = settings.getByRole('group', { name: 'Default value' });
  await defaults.getByRole('button', { name: /Default option/ }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();

  const grid = await openTable(page, database, 'Tasks');
  await expect(grid.getByRole('gridcell', { name: 'Open', exact: true })).toHaveCount(0);
  await grid.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: 'Open', exact: true })).toHaveCount(1);
  await expect(grid.getByRole('gridcell', { name: 'High', exact: true })).toHaveCount(1);

  // The server gave the record the same defaults, and the row already there kept its empty cells.
  const reloaded = await openTable(page, database, 'Tasks');
  await expect(reloaded.getByRole('gridcell', { name: 'Existing', exact: true })).toBeVisible();
  await expect(reloaded.getByRole('gridcell', { name: 'Open', exact: true })).toHaveCount(1);
  await expect(reloaded.getByRole('gridcell', { name: 'High', exact: true })).toHaveCount(1);
});

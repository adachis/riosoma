import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, signIn, visit } from '../helpers';

for (const phone of [false, true]) {
  test.describe(phone ? 'response edits on a phone' : 'response edits on desktop', () => {
    test.use({
      serviceWorkers: 'block',
      ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
    });

    test('submits a response, opens its edit link, and updates the same record', async ({
      page,
      browser,
    }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const database = await createDatabase(page, 'Response edits', [
        {
          name: 'Requests',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'More details', type: 'checkbox' },
            { name: 'Details', type: 'text' },
            { name: 'Approved', type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
            { name: 'Private note', type: 'text' },
          ],
        },
      ]);
      const table = database.tables.Requests!;
      const viewId = await createView(page, database, 'Requests', {
        name: 'Request form',
        type: 'form',
        config: {
          form: {
            allowEdits: true,
            questions: [
              { fieldId: table.fields.Name, required: true },
              { fieldId: table.fields['More details'] },
              {
                fieldId: table.fields.Details,
                showIf: { fieldId: table.fields['More details'], equals: true },
              },
              {
                fieldId: table.fields.Approved,
                required: true,
                showIf: { fieldId: table.fields['More details'], equals: true },
              },
            ],
          },
        },
      });
      const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
      const visitor = await browser.newContext(
        phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
      );
      try {
        const form = await visitor.newPage();
        await visit(form, `${base()}${shared.path}`);
        await form.getByRole('textbox', { name: 'Name' }).fill('Original answer');
        await expect(form.getByRole('textbox', { name: 'Details' })).toHaveCount(0);
        await form.getByRole('button', { name: 'Submit', exact: true }).click();
        const edit = form.getByRole('link', { name: 'Edit your response', exact: true });
        await expect(edit).toBeVisible();
        const link = await edit.getAttribute('href');
        await edit.click();
        await expect(form.getByRole('button', { name: 'Save response', exact: true })).toBeVisible();
        await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Original answer');
        await expect(form.getByRole('textbox', { name: 'Private note' })).toHaveCount(0);
        await expect(form.getByRole('textbox', { name: 'Details' })).toHaveCount(0);
        await expect(form.getByRole('checkbox', { name: 'Approved' })).toHaveCount(0);
        await form.getByRole('textbox', { name: 'Name' }).fill('Updated answer');
        await form.getByRole('checkbox', { name: 'More details' }).focus();
        await form.keyboard.press('Space');
        await expect(form.getByRole('checkbox', { name: 'Approved' })).not.toBeChecked();
        await form.getByRole('button', { name: 'Save response' }).click();
        await expect(form.getByText('Your response was updated.', { exact: true })).toBeVisible();
        const rows = await asOwner<{
          total: number;
          rows: Array<{ id: string; values: Record<string, unknown> }>;
        }>(page, 'GET', `/api/views/${table.viewId}/rows`);
        expect(rows.total).toBe(1);
        expect(rows.rows[0]!.values[table.fields.Name!]).toBe('Updated answer');
        expect(rows.rows[0]!.values[table.fields.Approved!]).toBe(false);
        const reopened = await visitor.newPage();
        await visit(reopened, `${base()}${link}`);
        await expect(reopened.getByRole('button', { name: 'Save response', exact: true })).toBeVisible();
        await expect(reopened.getByRole('textbox', { name: 'Name' })).toHaveValue('Updated answer');
        await expect(reopened.locator('body')).toHaveJSProperty(
          'scrollWidth',
          await reopened.locator('body').evaluate((body) => body.clientWidth),
        );
      } finally {
        await visitor.close();
      }
    });
  });
}

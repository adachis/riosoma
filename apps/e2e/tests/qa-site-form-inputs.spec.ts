import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, newId, runCommands, signIn, visit } from '../helpers';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function publishForm(page: Page, requiredLines = false) {
  await signIn(page);
  const description = newId('fld');
  const amount = newId('fld');
  const descriptionLabel = 'Description of the requested work 東京 👋 مرحبا with a long name';
  const database = await createDatabase(page, 'Site intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Budget', type: 'multiCurrency' },
        {
          name: 'Lines',
          type: 'lineItems',
          options: {
            columns: [
              { id: description, name: descriptionLabel, type: 'text' },
              { id: amount, name: 'Amount', type: 'currency' },
            ],
          },
        },
        { name: 'Include details', type: 'checkbox' },
        { name: 'Details', type: 'text' },
        { name: 'Follow-up', type: 'text' },
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Intake form',
    type: 'form',
    config: {
      form: {
        questions: [
          { fieldId: table.fields.Name },
          { fieldId: table.fields.Budget },
          { fieldId: table.fields.Lines, required: requiredLines },
          { fieldId: table.fields['Include details'] },
          {
            fieldId: table.fields.Details,
            required: true,
            showIf: { fieldId: table.fields['Include details'], equals: true },
          },
          {
            fieldId: table.fields['Follow-up'],
            required: true,
            showIf: { fieldId: table.fields.Details, equals: 'Ready' },
          },
        ],
      },
    },
  });
  const interfaceId = `itf${newId('rec').slice(3)}`;
  await runCommands(page, database.id, [
    {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Intake',
        pages: [
          {
            id: 'intakePage',
            name: 'Apply',
            blocks: [
              {
                id: 'intakeButton',
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
  const slug = `intake-${newId('rec').slice(3).toLowerCase()}`;
  await asOwner(page, 'PUT', `/api/interfaces/${interfaceId}/site`, {
    slug,
    title: 'Intake',
    pages: [{ pageId: 'intakePage', slug: 'apply', title: 'Apply' }],
  });
  return {
    databaseId: database.id,
    table,
    description,
    descriptionLabel,
    amount,
    path: `${base()}/sites/${slug}/forms/intakePage/intakeButton`,
  };
}

async function submit(page: Page) {
  const ticket = await page.locator('input[name="ticket"]').inputValue();
  await expect.poll(() => Date.now()).toBeGreaterThanOrEqual(Number(ticket.split('.')[0]) + 2100);
  const response = page.waitForResponse(
    (item) => item.request().method() === 'POST' && item.url() === page.url(),
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).press('Enter');
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Thanks!  Your answer was recorded.', { exact: true })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`published forms accept currency and repeated line answers at width ${width}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const { databaseId, table, description, descriptionLabel, amount, path } = await publishForm(page);
    const visitor = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 844 } });
    try {
      const form = await visitor.newPage();
      await visit(form, path);
      await form.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('12.50');
      await form.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('EUR');
      await form
        .getByRole('textbox', { name: `${descriptionLabel}, line 1`, exact: true })
        .fill('東京 👋 مرحبا');
      await form.getByRole('spinbutton', { name: 'Amount, line 1', exact: true }).fill('7.25');
      await form.getByRole('button', { name: 'Add line', exact: true }).press('Enter');
      await form.getByRole('textbox', { name: `${descriptionLabel}, line 2`, exact: true }).fill('Parts');
      await form.getByRole('spinbutton', { name: 'Amount, line 2', exact: true }).fill('5.25');
      expect(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        (
          await new AxeBuilder({ page: form })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await submit(form);
      const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${table.viewId}/rows`,
      );
      expect(rows.rows[0]!.values[table.fields.Budget!]).toEqual({ amount: 12.5, code: 'EUR' });
      const lines = rows.rows[0]!.values[table.fields.Lines!] as string[];
      expect(lines).toHaveLength(2);
      const schema = await asOwner<{ fields: Array<{ id: string; options: { linkedTableId?: string } }> }>(
        page,
        'GET',
        `/api/databases/${databaseId}/schema`,
      );
      const linkedTableId = schema.fields.find((field) => field.id === table.fields.Lines)!.options
        .linkedTableId!;
      const children = await Promise.all(
        lines.map((id) =>
          asOwner<{ values: Record<string, unknown> }>(
            page,
            'GET',
            `/api/tables/${linkedTableId}/records/${id}`,
          ),
        ),
      );
      expect(children.map((row) => row.values[description])).toEqual(['東京 👋 مرحبا', 'Parts']);
      expect(children.map((row) => row.values[amount])).toEqual([7.25, 5.25]);
    } finally {
      await visitor.close();
    }
  });
}

test('published forms toggle required questions and omit stale hidden answers by keyboard', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const { table, path } = await publishForm(page);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, path);
    const enabled = form.getByRole('checkbox', { name: 'Include details', exact: true });
    const detail = form.getByRole('textbox', { name: 'Details', exact: true });
    const followup = form.getByRole('textbox', { name: 'Follow-up', exact: true });
    await expect(detail).toBeHidden();
    await enabled.focus();
    await enabled.press('Space');
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute('required');
    await enabled.press('Tab');
    await expect(detail).toBeFocused();
    await detail.fill('Ready');
    await expect(followup).toBeVisible();
    await followup.fill('Stale answer');
    await enabled.press('Space');
    await expect(detail).toBeHidden();
    await expect(followup).toBeHidden();
    await expect(form.locator(`input[name="${table.fields.Details}"]`)).toBeDisabled();
    await submit(form);
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(rows.rows[0]!.values[table.fields.Details!]).toBeNull();
    expect(rows.rows[0]!.values[table.fields['Follow-up']!]).toBeNull();
    await visit(form, path);
    await enabled.press('Space');
    await detail.fill('Ready');
    await followup.fill('Visible answer');
    await submit(form);
    const after = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(after.rows.some((row) => row.values[table.fields['Follow-up']!] === 'Visible answer')).toBe(true);
  } finally {
    await visitor.close();
  }
});

test('published forms require a populated line and focus its first control', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { table, descriptionLabel, path } = await publishForm(page, true);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, path);
    const ticket = await form.locator('input[name="ticket"]').inputValue();
    await expect.poll(() => Date.now()).toBeGreaterThanOrEqual(Number(ticket.split('.')[0]) + 2100);
    const first = form.getByRole('textbox', { name: `${descriptionLabel}, line 1`, exact: true });
    await form.getByRole('button', { name: 'Submit', exact: true }).press('Enter');
    await expect(first).toBeFocused();
    expect(await first.evaluate((input: HTMLInputElement) => input.validationMessage)).toBe(
      'Answer this question.',
    );
    const before = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
    expect(before.total).toBe(0);
    await form.getByRole('spinbutton', { name: 'Amount, line 1', exact: true }).fill('0');
    expect(await first.evaluate((input: HTMLInputElement) => input.validationMessage)).toBe('');
    await submit(form);
    const after = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
    expect(after.total).toBe(1);
  } finally {
    await visitor.close();
  }
});

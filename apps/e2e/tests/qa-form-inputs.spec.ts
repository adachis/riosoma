import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('public time validation preserves drafts alongside signatures and location answers on a phone', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Detailed intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText' },
        { name: 'Email', type: 'email' },
        { name: 'Website', type: 'url' },
        { name: 'Phone', type: 'phone' },
        { name: 'Code', type: 'barcode' },
        { name: 'Time', type: 'time', options: { timeFormat: '24h' } },
        { name: 'Budget', type: 'multiCurrency' },
        { name: 'Details', type: 'json' },
        { name: 'Location', type: 'location' },
        { name: 'Signature', type: 'signature' },
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Detailed form',
    type: 'form',
    config: {
      form: {
        allowEdits: true,
        theme: { id: 'nature', scheme: 'spectrum' },
        questions: Object.values(table.fields).map((fieldId) => ({ fieldId })),
      },
    },
  });
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, `${base()}${shared.path}`);
    await expect(form.locator('html')).toHaveAttribute('data-theme', 'nature');
    await expect(form.locator('html')).toHaveAttribute('data-scheme', 'spectrum');
    for (const [name, value] of [
      ['Name', '東京 👋 مرحبا'],
      ['Notes', 'A long response.  '.repeat(150)],
      ['Email', 'visitor@example.test'],
      ['Website', 'https://example.test'],
      ['Phone', '+15551234567'],
      ['Code', '000123'],
      ['Time', '14:30'],
      ['Details', '{"name":"東京 👋"}'],
    ]) {
      const input = form.getByRole('textbox', { name, exact: true });
      await input.fill(value!);
      await input.press('Tab');
    }
    await form.getByRole('textbox', { name: 'Amount', exact: true }).fill('12.5');
    await form.keyboard.press('Tab');
    await form.getByRole('textbox', { name: 'Place', exact: true }).fill('Harbor');
    await form.getByRole('textbox', { name: 'Latitude, longitude', exact: true }).fill('40.7128, -74.006');
    await form.keyboard.press('Tab');
    await form.getByRole('textbox', { name: 'Your name', exact: true }).fill('Visitor');
    await form.getByRole('button', { name: 'Sign', exact: true }).press('Enter');
    const time = form.getByRole('textbox', { name: 'Time', exact: true });
    await time.fill('invalid');
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(time).toHaveAttribute('aria-invalid', 'true');
    await expect(time).toBeFocused();
    await expect(time).toHaveValue('invalid');
    const before = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
    expect(before.total).toBe(0);
    await time.fill('15:45');
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    const edit = form.getByRole('link', { name: 'Edit your response', exact: true });
    await expect(edit).toBeVisible();
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    const values = rows.rows[0]!.values;
    expect(values[table.fields.Time!]).toBe('15:45:00');
    expect(values[table.fields.Code!]).toBe('000123');
    expect(values[table.fields.Budget!]).toEqual({ amount: 12.5, code: 'USD' });
    expect(values[table.fields.Location!]).toMatchObject({ lat: 40.7128, lng: -74.006, label: 'Harbor' });
    expect(values[table.fields.Signature!]).toMatchObject({ name: 'Visitor' });
    await edit.click();
    await expect(form.getByRole('button', { name: 'Save response', exact: true })).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Time', exact: true })).toHaveValue('15:45:00');
    expect(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await visitor.close();
  }
});

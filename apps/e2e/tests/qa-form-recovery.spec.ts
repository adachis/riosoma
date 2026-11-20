import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('a phone form preserves answers after connection and server failures and records a retry once', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Recoverable intake', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Request form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name, required: true }] } },
  });
  const shared = await asOwner<{ formId: string; path: string }>(
    page,
    'PUT',
    `/api/views/${viewId}/public-form`,
  );
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, `${base()}${shared.path}`);
    const submit = form.getByRole('button', { name: 'Submit', exact: true });
    await submit.focus();
    await submit.press('Enter');
    await expect(form.getByText('Answer this question.', { exact: true })).toBeVisible();
    const name = form.getByRole('textbox', { name: 'Name', exact: true });
    const answer = '東京 👋 مرحبا';
    await name.focus();
    await form.keyboard.insertText(answer);
    await visitor.setOffline(true);
    await submit.focus();
    await submit.press('Enter');
    const alert = form.getByRole('alert').filter({ hasText: /\S/ });
    await expect(alert).toBeVisible();
    await expect(name).toHaveValue(answer);
    await expect(submit).toBeEnabled();
    await visitor.setOffline(false);
    const endpoint = `**/api/public/forms/${shared.formId}/submissions`;
    let refused = 0;
    await form.route(endpoint, async (route) => {
      refused++;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal', messageKey: 'errors.internal', userFault: false },
        }),
      });
    });
    await submit.focus();
    await submit.press('Enter');
    await expect.poll(() => refused).toBe(1);
    await expect(alert).toBeVisible();
    await expect(name).toHaveValue(answer);
    await expect(submit).toBeEnabled();
    const before = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
    expect(before.total).toBe(0);
    await form.unroute(endpoint);
    await submit.focus();
    await submit.press('Enter');
    const confirmation = form.getByRole('status').filter({ hasText: 'Your answer was recorded.' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toBeFocused();
    const after = await asOwner<{ total: number; rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(after.total).toBe(1);
    expect(after.rows[0]!.values[table.fields.Name!]).toBe(answer);
    await form.getByRole('button', { name: 'Submit another response', exact: true }).press('Enter');
    await expect(name).toHaveValue('');
    await expect(name).toBeFocused();
  } finally {
    await visitor.close();
  }
});

test('keyboard form design keeps order, help, and required questions through live updates, undo, redo, and reload', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Live form design', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Details', type: 'longText' },
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Request form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name }, { fieldId: table.fields.Details }] } },
  });
  const path = `${base()}/${database.id}/${table.id}/${viewId}`;
  const observer = await browser.newContext({
    serviceWorkers: 'block',
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 },
  });
  try {
    const other = await observer.newPage();
    await visit(page, path);
    await visit(other, path);
    const labels = (target: typeof page) =>
      target.locator('.rio-form-view__question-heading > span:first-child');
    await expect(labels(other)).toHaveText(['Name', 'Details']);
    await page.getByRole('button', { name: 'Edit form', exact: true }).press('Enter');
    const details = page.getByRole('group', { name: 'Details', exact: true });
    const help = 'Use a short description.  Unicode is welcome.';
    await details.getByRole('textbox', { name: 'Help text', exact: true }).fill(help);
    await details.getByRole('checkbox', { name: 'Required', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(
      other.getByRole('group', { name: 'Details', exact: true }).getByText(help, { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByRole('group', { name: 'Details', exact: true }).getByText('Required', { exact: true }),
    ).toBeVisible();
    await details.getByRole('button', { name: 'Reorder Details', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(labels(page)).toHaveText(['Details', 'Name']);
    await expect(labels(other)).toHaveText(['Details', 'Name']);
    await page.getByRole('button', { name: 'Undo history', exact: true }).press('Enter');
    const history = page.getByRole('dialog', { name: 'Undo history', exact: true });
    await history
      .getByRole('listbox', { name: 'Changes to undo, newest first' })
      .getByRole('option')
      .first()
      .press('Enter');
    await expect(labels(page)).toHaveText(['Name', 'Details']);
    await expect(labels(other)).toHaveText(['Name', 'Details']);
    await history
      .getByRole('listbox', { name: 'Changes to redo, next first' })
      .getByRole('option')
      .first()
      .press('Enter');
    await expect(labels(other)).toHaveText(['Details', 'Name']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Done editing', exact: true }).press('Enter');
    await page.reload();
    await expect(labels(page)).toHaveText(['Details', 'Name']);
    await expect(
      page.getByRole('group', { name: 'Details', exact: true }).getByText(help, { exact: true }),
    ).toBeVisible();
    await other.getByRole('button', { name: 'Submit', exact: true }).press('Enter');
    await expect(other.getByText('Answer this question.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await observer.close();
  }
});

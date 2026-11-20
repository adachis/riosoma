import { expect, test } from '../accessibility';
import { randomBytes } from 'node:crypto';
import { base } from '../base';
import { asOwner, createDatabase, createView, everythingReceived, newId, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`line-item validation preserves drafts and blocks submissions at ${width}px`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const amount = newId('fld');
    const database = await createDatabase(page, 'Request intake', [
      {
        name: 'Requests',
        fields: [
          { name: 'Name', type: 'text' },
          {
            name: 'Items',
            type: 'lineItems',
            options: { columns: [{ id: amount, name: 'Amount', type: 'number' }] },
          },
          {
            name: 'Private note',
            type: 'text',
            options: { defaultValue: { kind: 'value', value: 'Internal' } },
          },
        ],
      },
    ]);
    const table = database.tables.Requests!;
    const viewId = await createView(page, database, 'Requests', {
      name: 'Request form',
      type: 'form',
      config: {
        form: {
          questions: [
            { fieldId: table.fields.Name, required: true, help: 'Enter your name.' },
            { fieldId: table.fields.Items },
          ],
        },
      },
    });
    const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
    const schema = await asOwner<{ fields: Array<{ id: string; options: { linkedTableId?: string } }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
    const childTableId = schema.fields.find((field) => field.id === table.fields.Items)!.options
      .linkedTableId!;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 844 } });
    try {
      for (const publicForm of [false, true]) {
        const form = publicForm ? await context.newPage() : page;
        await form.setViewportSize({ width, height: 844 });
        await visit(
          form,
          publicForm ? `${base()}${shared.path}` : `${base()}/${database.id}/${table.id}/${viewId}`,
        );
        const name = form.getByRole('textbox', { name: 'Name', exact: true });
        await name.focus();
        await form.keyboard.insertText('東京 👋 مرحبا');
        await form.getByRole('button', { name: 'Add line', exact: true }).focus();
        await form.keyboard.press('Enter');
        const input = form.getByRole('textbox', { name: 'Amount, line 1', exact: true });
        await input.fill('12');
        await input.press('Tab');
        await input.fill('invalid');
        const submit = form.getByRole('button', { name: 'Submit', exact: true });
        await submit.focus();
        await submit.press('Enter');
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('invalid');
        const before = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
        expect(before.total).toBe(publicForm ? 1 : 0);
        await input.fill('24');
        await submit.focus();
        await submit.press('Enter');
        await expect(form.getByRole('status').filter({ hasText: 'Your answer was recorded.' })).toBeVisible();
        const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
          page,
          'GET',
          `/api/views/${table.viewId}/rows`,
        );
        const lineIds = rows.rows.at(-1)!.values[table.fields.Items!] as string[];
        expect(lineIds).toEqual([expect.any(String)]);
        const line = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${childTableId}/records/${lineIds[0]}`,
        );
        expect(line.values[amount]).toBe(24);
        expect(rows.rows.at(-1)!.values[table.fields['Private note']!]).toBe('Internal');
        expect(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (publicForm) await form.close();
      }
    } finally {
      await context.close();
    }
  });
}

test('a form revoked while open closes after submission and on reload', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Closed intake', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Request form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name }] } },
  });
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, `${base()}${shared.path}`);
    await form.getByRole('textbox', { name: 'Name' }).fill('Unsubmitted answer');
    await asOwner(page, 'DELETE', `/api/views/${viewId}/public-form`);
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByRole('heading', { name: 'This form isn’t available.' })).toBeVisible();
    await expect(form.getByRole('heading', { name: 'This form isn’t available.' })).toBeFocused();
    await expect(form.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
    await form.reload();
    await expect(form.getByRole('heading', { name: 'This form isn’t available.' })).toBeVisible();
    const rows = await asOwner<{ total: number }>(page, 'GET', `/api/views/${table.viewId}/rows`);
    expect(rows.total).toBe(0);
  } finally {
    await visitor.close();
  }
});

test('public numeric inputs keep their nonnegative field settings', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Numeric intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Count', type: 'number', options: { allowNegative: false } },
        { name: 'Price', type: 'currency', options: { allowNegative: false } },
        { name: 'Percent', type: 'percent', options: { allowNegative: false } },
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Request form',
    type: 'form',
    config: { form: { questions: Object.values(table.fields).map((fieldId) => ({ fieldId })) } },
  });
  const shared = await asOwner<{ formId: string; path: string }>(
    page,
    'PUT',
    `/api/views/${viewId}/public-form`,
  );
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const form = await visitor.newPage();
    const response = await visitor.request.get(`${base()}/api/public/forms/${shared.formId}`);
    const definition = await response.json();
    expect(
      definition.questions
        .slice(1)
        .map((question: { options: { allowNegative?: boolean } }) => question.options.allowNegative),
    ).toEqual([false, false, false]);
    await visit(form, `${base()}${shared.path}`);
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Numeric response');
    for (const name of ['Count', 'Price', 'Percent']) {
      await form.getByRole('textbox', { name, exact: true }).fill('10');
      await form.keyboard.press('Tab');
    }
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('Your answer was recorded.');
  } finally {
    await visitor.close();
  }
});

test('public passwords, private data boundaries, and organization revocation apply to every read', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Public access', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Private note', type: 'text' },
      ],
      records: [{ Name: 'Public record', 'Private note': 'Unpublished detail' }],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Public requests',
    type: 'grid',
    config: { hiddenFieldIds: [table.fields['Private note']] },
  });
  const view = await asOwner<{ linkId: string; path: string }>(
    page,
    'PUT',
    `/api/views/${viewId}/shared-view`,
  );
  const formViewId = await createView(page, database, 'Requests', {
    name: 'Public form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name }] } },
  });
  const form = await asOwner<{ formId: string; path: string }>(
    page,
    'PUT',
    `/api/views/${formViewId}/public-form`,
  );
  const password = randomBytes(18).toString('base64url');
  await asOwner(page, 'PATCH', `/api/views/${viewId}/shared-view`, { password });
  const policy = await asOwner<{ own: Record<string, unknown>; overridable: string[] }>(
    page,
    'GET',
    '/api/admin/unit-policy',
  );
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const reader = await visitor.newPage();
    const received = everythingReceived(reader);
    await visit(reader, `${base()}${view.path}`);
    await expect(reader.getByRole('heading', { name: 'This view has a password' })).toBeVisible();
    const locked = await visitor.request.get(`${base()}/api/public/views/${view.linkId}/rows`);
    expect(locked.status()).toBe(403);
    await reader.getByLabel('Password', { exact: true }).fill(password);
    await reader.getByRole('button', { name: 'Open view', exact: true }).press('Enter');
    await expect(reader.getByRole('gridcell', { name: 'Public record', exact: true })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Add record' })).toHaveCount(0);
    await expect(reader.getByText('Private note', { exact: true })).toHaveCount(0);
    await reader.getByRole('button', { name: 'Expand row 1', exact: true }).press('Enter');
    const record = reader.getByRole('dialog', { name: 'Public record', exact: true });
    await expect(record).toBeVisible();
    await expect(record.getByRole('tab', { name: /History|Comments/ })).toHaveCount(0);
    await reader.keyboard.press('Escape');
    const publicRows = await visitor.request.get(`${base()}/api/public/views/${view.linkId}/rows`);
    expect(publicRows.status()).toBe(200);
    const rows = await publicRows.json();
    expect(JSON.stringify(rows)).not.toContain('Unpublished detail');
    const recordId = rows.rows[0].id;
    for (const path of [
      `/api/databases/${database.id}/schema`,
      `/api/views/${table.viewId}/rows`,
      `/api/tables/${table.id}/records/${recordId}`,
      `/api/tables/${table.id}/records/${recordId}/history`,
      `/api/tables/${table.id}/records/${recordId}/comments`,
      '/api/org/members',
    ]) {
      await asOwner(page, 'GET', path);
      const denied = await visitor.request.get(`${base()}${path}`);
      expect(denied.status()).toBe(401);
    }
    expect((await received()).join('\n')).not.toContain('Unpublished detail');
    await asOwner(page, 'PUT', '/api/admin/unit-policy', {
      values: { ...policy.own, publicLinks: false },
      overridable: policy.overridable,
    });
    for (const path of [
      `/api/public/views/${view.linkId}`,
      `/api/public/views/${view.linkId}/rows`,
      `/api/public/forms/${form.formId}`,
    ]) {
      const closed = await visitor.request.get(`${base()}${path}`);
      expect([404, 410]).toContain(closed.status());
    }
    await reader.getByRole('searchbox', { name: 'Search', exact: true }).fill('Public');
    await expect(reader.getByRole('heading', { name: 'This view isn’t available.' })).toBeVisible();
    await visit(reader, `${base()}${form.path}`);
    await expect(reader.getByRole('heading', { name: 'This form isn’t available.' })).toBeVisible();
  } finally {
    await asOwner(page, 'PUT', '/api/admin/unit-policy', {
      values: policy.own,
      overridable: policy.overridable,
    });
    await visitor.close();
  }
});

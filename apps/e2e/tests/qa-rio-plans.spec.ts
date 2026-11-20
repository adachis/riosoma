import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

let provider: Server;
let address: string;
let proposal: Record<string, unknown>;

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
        return;
      }
      const prompt = JSON.parse(body) as { messages: Array<{ role: string }> };
      const asked = prompt.messages.findLastIndex((message) => message.role === 'user');
      const answered = prompt.messages.slice(asked + 1).some((message) => message.role === 'tool');
      const delta = answered
        ? { content: 'Review the proposed changes.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: { name: 'propose_changes', arguments: JSON.stringify(proposal) },
              },
            ],
          };
      response.setHeader('content-type', 'text/event-stream');
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: answered ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  address = `http://${new URL(base()).hostname}:${(provider.address() as AddressInfo).port}/v1`;
});

test.afterAll(async () => {
  provider?.closeAllConnections();
  if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
});

async function configure(page: Page) {
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((item) => item.local)!.providerId;
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: address }],
    models: { everyday: { providerId, model: 'fixture' }, power: null },
    autonomy: 'ask',
    monthlyBudgetUsd: null,
  });
}

test('builds a table, formula, view, draft automation, and many records as one approved action', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const db = await createDatabase(page, 'Build planning', [
    {
      name: 'Existing',
      fields: [{ name: 'Name', type: 'text' }],
      records: [],
    },
  ]);
  await configure(page);
  const tableId = newId('tbl');
  const nameId = newId('fld');
  const formulaId = newId('fld');
  const gridId = newId('viw');
  const reviewId = newId('viw');
  const automationId = newId('aut');
  const recordIds = Array.from({ length: 25 }, () => newId('rec'));
  proposal = {
    databaseId: db.id,
    summary: 'Build project tracking',
    steps: ['Add Projects, a formula, a review view, a draft automation, and 25 records'],
    commands: [
      {
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Projects 项目 🌱',
          fields: [{ id: nameId, name: 'Name', type: 'text' }],
          view: { id: gridId, name: 'Grid' },
          records: [],
        },
      },
      {
        kind: 'field.create',
        tableId,
        field: { id: formulaId, name: 'Total', type: 'formula', options: { expression: '1 + 1' } },
      },
      { kind: 'view.create', view: { id: reviewId, tableId, name: 'Review', type: 'grid' } },
      {
        kind: 'automation.create',
        automation: {
          id: automationId,
          name: 'New projects',
          config: { trigger: { kind: 'recordCreated', tableId }, steps: [] },
        },
      },
      {
        kind: 'record.create',
        tableId,
        records: recordIds.map((id, index) => ({ id, values: { [nameId]: `项目 🌱 مرحبا ${index + 1}` } })),
      },
    ],
  };
  const existing = db.tables.Existing!;
  await visit(page, `${base()}/${db.id}/${existing.id}/${existing.viewId}`);
  const panel = await ask(page);
  const details = panel.getByRole('region', { name: 'Changes to review', exact: true });
  await details.focus();
  await expect(details).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const previewLink = panel.getByRole('link', { name: 'Preview', exact: true });
  const planId = new URL((await previewLink.getAttribute('href'))!, base()).searchParams.get('rioPreview')!;
  await previewLink.click();
  const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
  await expect(dialog.getByRole('gridcell', { name: '项目 🌱 مرحبا 1', exact: true })).toBeVisible();
  await expect(dialog.getByRole('gridcell', { name: '2', exact: true }).first()).toBeVisible();
  const snapshot = await asOwner<{ views: Record<string, { rows: unknown[] }> }>(
    page,
    'GET',
    `/api/rio/plans/${planId}/preview?timeZone=UTC`,
  );
  expect(snapshot.views[gridId]!.rows).toHaveLength(25);
  await dialog.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.getByRole('columnheader', { name: 'Total', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'New projects', exact: true }).click();
  await expect(
    dialog.getByText('This automation stays a draft until you publish it.', { exact: true }),
  ).toBeVisible();
  const schema = () =>
    asOwner<{
      tables: Array<{ id: string }>;
      fields: Array<{ id: string }>;
      views: Array<{ id: string }>;
      automations: Array<{ id: string; enabled: boolean; publishedAt: string | null }>;
    }>(page, 'GET', `/api/databases/${db.id}/schema`);
  expect((await schema()).tables.some((table) => table.id === tableId)).toBe(false);
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    panel.locator('.rio-assistant__block').filter({ hasText: 'Build project tracking' }),
  ).toContainText('Dismissed');
  expect((await schema()).tables.some((table) => table.id === tableId)).toBe(false);
  const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
  const declined = await page.request.post(`${base()}/api/rio/plans/${planId}/apply`, {
    headers: { 'x-csrf-token': session.csrfToken },
  });
  expect(declined.status()).toBe(409);
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  await ask(page);
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Build project tracking' });
  await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  const saved = await schema();
  expect(saved.tables.some((table) => table.id === tableId)).toBe(true);
  expect(saved.fields.some((field) => field.id === formulaId)).toBe(true);
  expect(saved.views.some((view) => view.id === reviewId)).toBe(true);
  expect(saved.automations.find((automation) => automation.id === automationId)).toMatchObject({
    enabled: false,
    publishedAt: null,
  });
  await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(receipt.getByRole('status')).toHaveText('Undone');
  const restored = await schema();
  expect(restored.tables.some((table) => table.id === tableId)).toBe(false);
  expect(restored.fields.some((field) => field.id === formulaId)).toBe(false);
  expect(restored.views.some((view) => view.id === reviewId)).toBe(false);
  expect(restored.automations.some((automation) => automation.id === automationId)).toBe(false);
});

test('isolates previews from another person and rechecks permissions before applying a batch', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const db = await createDatabase(page, 'Shared planning', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'text' },
      ],
      records: [{ Name: 'Before', Notes: 'Original' }],
    },
  ]);
  const table = db.tables.Items!;
  await configure(page);
  const guest = await invite(page, browser, 'Plan reviewer', 'guest');
  try {
    const inaccessible = await guest.page.request.get(`${base()}/api/databases/${db.id}/schema`);
    expect([403, 404]).toContain(inaccessible.status());
    await share(page, db.id, guest, 'editor');
    await visit(guest.page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    await expect(guest.page.getByRole('gridcell', { name: 'Before', exact: true })).toBeVisible();
    proposal = {
      databaseId: db.id,
      summary: 'Change shared item',
      steps: ['Change Name and Notes together'],
      commands: [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[0], values: { [table.fields.Name!]: 'After' } }],
        },
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[0], values: { [table.fields.Notes!]: 'Planned' } }],
        },
      ],
    };
    const panel = await ask(guest.page);
    const previewLink = panel.getByRole('link', { name: 'Preview', exact: true });
    const planId = new URL((await previewLink.getAttribute('href'))!, base()).searchParams.get('rioPreview')!;
    await previewLink.click();
    const dialog = guest.page.getByRole('dialog', { name: 'Preview', exact: true });
    await expect(dialog.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    const untouched = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
    expect(untouched.values).toMatchObject({
      [table.fields.Name!]: 'Before',
      [table.fields.Notes!]: 'Original',
    });
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    await expect(page.getByRole('gridcell', { name: 'Before', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Planned', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Undone' })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Before', exact: true })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await ask(guest.page);
    await panel.getByRole('link', { name: 'Preview', exact: true }).click();
    await expect(dialog.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    await share(page, db.id, guest, 'reader');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    const after = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
    expect(after.values).toMatchObject({ [table.fields.Name!]: 'Before', [table.fields.Notes!]: 'Original' });
    const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
    const otherPerson = await page.request.get(`${base()}/api/rio/plans/${planId}/preview?timeZone=UTC`, {
      headers: { 'x-csrf-token': session.csrfToken },
    });
    expect(otherPerson.status()).toBe(404);
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  } finally {
    await guest.context.close();
  }
});

async function ask(page: Page) {
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const panel = page.locator('.rio-assistant__panel');
  await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click();
  const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
  await input.fill('Make the requested changes');
  await input.press('Enter');
  await expect(panel.getByRole('link', { name: 'Preview', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  return panel;
}

test('holds bulk updates, deletes, and external steps for approval and respects the budget pause', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const names = Array.from({ length: 25 }, (_, index) => `Item ${index + 1}`);
  const db = await createDatabase(page, 'Approval limits', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
      records: names.map((Name) => ({ Name })),
    },
  ]);
  const table = db.tables.Items!;
  await configure(page);
  await asOwner(page, 'PUT', '/api/ai/settings', { autonomy: 'instant' });
  proposal = {
    databaseId: db.id,
    summary: 'Update every item',
    steps: ['Change 25 names'],
    commands: [
      {
        kind: 'record.update',
        tableId: table.id,
        records: table.records.map((id, index) => ({
          id,
          values: { [table.fields.Name!]: `Updated ${index + 1}` },
        })),
      },
    ],
  };
  await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
  const panel = await ask(page);
  await expect(panel.getByText('No energy or carbon estimate for this model', { exact: true })).toBeVisible();
  const readNames = async () =>
    Promise.all(
      table.records.map(async (id) => {
        const record = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${table.id}/records/${id}`,
        );
        return record.values[table.fields.Name!];
      }),
    );
  expect(await readNames()).toEqual(names);
  await panel.getByRole('link', { name: 'Preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
  await expect(dialog.getByRole('gridcell', { name: 'Updated 1', exact: true })).toBeVisible();
  expect(await readNames()).toEqual(names);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readNames()).toEqual(names.map((_, index) => `Updated ${index + 1}`));
  const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Update every item' });
  await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(receipt.getByRole('status')).toHaveText('Undone');
  expect(await readNames()).toEqual(names);
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  proposal = {
    databaseId: db.id,
    summary: 'Remove the first item',
    steps: ['Remove one record'],
    commands: [{ kind: 'record.trash', tableId: table.id, recordIds: [table.records[0]] }],
  };
  await ask(page);
  expect(await readNames()).toEqual(names);
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    panel.locator('.rio-assistant__block').filter({ hasText: 'Remove the first item' }),
  ).toContainText('Dismissed');
  expect(await readNames()).toEqual(names);
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  const automationId = newId('aut');
  proposal = {
    databaseId: db.id,
    summary: 'Prepare a notification',
    steps: ['Draft an email automation'],
    commands: [
      {
        kind: 'automation.create',
        automation: {
          id: automationId,
          name: 'Notifications',
          config: {
            trigger: { kind: 'recordCreated', tableId: table.id },
            steps: [
              {
                kind: 'sendEmail',
                name: 'Notify',
                to: ['review@example.test'],
                subject: 'Review',
                body: 'Review the new item',
              },
            ],
          },
        },
      },
    ],
  };
  await ask(page);
  const details = panel.getByRole('region', { name: 'Changes to review', exact: true });
  await expect(details).toContainText('review@example.test');
  const schema = await asOwner<{ automations: Array<{ id: string }> }>(
    page,
    'GET',
    `/api/databases/${db.id}/schema`,
  );
  expect(schema.automations.some((automation) => automation.id === automationId)).toBe(false);
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    panel.locator('.rio-assistant__block').filter({ hasText: 'Prepare a notification' }),
  ).toContainText('Dismissed');
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  await asOwner(page, 'PUT', '/api/ai/settings', { monthlyBudgetUsd: 0 });
  try {
    await page.reload();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await expect(panel.getByText(/Rio is resting until next month/)).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Ask Rio anything about your data' })).toBeDisabled();
  } finally {
    await asOwner(page, 'PUT', '/api/ai/settings', { monthlyBudgetUsd: null, autonomy: 'ask' });
  }
});

for (const width of [1280, 390]) {
  test(`previews field edits and restores their prior state in one undo at ${width} pixels`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    const db = await createDatabase(page, 'Field planning', [
      {
        name: 'Items',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Amount', type: 'number' },
          { name: 'Old', type: 'text' },
        ],
        records: [{ Name: '项目 🌱 مرحبا', Amount: 7, Old: 'Keep for undo' }],
      },
    ]);
    const table = db.tables.Items!;
    await configure(page);
    const renamed = '项目 🌱 مرحبا ' + 'Long field name '.repeat(5);
    proposal = {
      databaseId: db.id,
      summary: 'Review field changes',
      steps: ['Rename Name, convert Amount to a formula, and remove Old'],
      commands: [
        { kind: 'field.update', fieldId: table.fields.Name, name: renamed },
        {
          kind: 'field.convert',
          fieldId: table.fields.Amount,
          to: { type: 'formula', options: { expression: '1 + 1' } },
        },
        { kind: 'field.trash', fieldId: table.fields.Old },
      ],
    };
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    const panel = await ask(page);
    const read = () => asOwner(page, 'GET', `/api/databases/${db.id}/schema`);
    const before = await read();
    await panel.getByRole('link', { name: 'Preview', exact: true }).click();
    if (width === 390) await expect(panel).toBeHidden();
    const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
    const grid = dialog.getByRole('grid', { name: 'Grid', exact: true });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('columnheader', { name: renamed.trim(), exact: true })).toBeVisible();
    await expect(grid.getByRole('columnheader', { name: 'Old', exact: true })).toHaveCount(0);
    await grid.locator('.rio-grid__scroller').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await expect(grid.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
    expect(await read()).toEqual(before);
    await page.reload();
    await expect(grid).toBeVisible();
    if (width === 390) await expect(panel).toBeHidden();
    await grid.locator('.rio-grid__scroller').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await expect(grid.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
    const apply = dialog.getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeEnabled();
    await apply.focus();
    await expect(apply).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    const live = page.getByRole('grid', { name: 'Grid', exact: true });
    await live.locator('.rio-grid__scroller').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await expect(live.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Review field changes' });
    await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await page.reload();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await live.locator('.rio-grid__scroller').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await expect(live.getByRole('columnheader', { name: 'Old', exact: true })).toBeVisible();
    await expect(live.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
    await expect(live.getByRole('gridcell', { name: 'Keep for undo', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`recovers a saved approval after losing its response at ${width} pixels`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    const db = await createDatabase(page, 'Saved approval recovery', [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Before' }],
      },
    ]);
    const table = db.tables.Items!;
    await configure(page);
    proposal = {
      databaseId: db.id,
      summary: 'Save the item',
      steps: ['Rename Before to After'],
      commands: [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[0], values: { [table.fields.Name!]: 'After' } }],
        },
      ],
    };
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    const panel = await ask(page);
    await panel.getByRole('link', { name: 'Preview', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
    await expect(dialog.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    let attempts = 0;
    await page.route('**/api/rio/plans/*/apply', async (route) => {
      attempts++;
      if (attempts !== 1) return route.continue();
      const saved = await route.fetch();
      expect(saved.status()).toBe(200);
      await route.abort('connectionfailed');
    });
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(attempts).toBe(2);
    await expect(panel).toBeVisible();
    const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Save the item' });
    await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    const saved = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
    expect(saved.values[table.fields.Name!]).toBe('After');
    await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await expect(receipt.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    const restored = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
    expect(restored.values[table.fields.Name!]).toBe('Before');
  });

  test(`keeps a preview retryable after interrupted approval at ${width} pixels`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    const db = await createDatabase(page, 'Approval recovery', [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Before' }],
      },
    ]);
    const table = db.tables.Items!;
    await configure(page);
    proposal = {
      databaseId: db.id,
      summary: 'Change the item',
      steps: ['Rename Before to After'],
      commands: [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[0], values: { [table.fields.Name!]: 'After' } }],
        },
      ],
    };
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    const panel = await ask(page);
    await panel.getByRole('link', { name: 'Preview', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
    await expect(dialog.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    let attempts = 0;
    await page.route('**/api/rio/plans/*/apply', async (route) => {
      attempts++;
      if (attempts === 1) return route.abort('connectionfailed');
      if (attempts === 2)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'unavailable', messageKey: 'errors.unavailable', userFault: false } },
        });
      return route.continue();
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
      const saved = await asOwner<{ values: Record<string, unknown> }>(
        page,
        'GET',
        `/api/tables/${table.id}/records/${table.records[0]}`,
      );
      expect(saved.values[table.fields.Name!]).toBe('Before');
    }
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(attempts).toBe(3);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await expect(page.getByRole('gridcell', { name: 'After', exact: true })).toBeVisible();
    const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Change the item' });
    await runCommands(page, db.id, [
      {
        kind: 'record.create',
        tableId: table.id,
        records: [{ id: newId('rec'), values: { [table.fields.Name!]: 'Later edit' } }],
      },
    ]);
    await page.getByRole('button', { name: '1 new record', exact: true }).click();
    await expect(page.getByRole('gridcell', { name: 'Later edit', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(receipt.getByRole('status')).toHaveText('Undone');
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await expect(page.getByRole('gridcell', { name: 'Before', exact: true })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Later edit', exact: true })).toBeVisible();
  });
}

test('previews record placement in the order approval saves', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const db = await createDatabase(page, 'Record placement', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'First' }, { Name: 'Second' }],
    },
  ]);
  const table = db.tables.Items!;
  await configure(page);
  proposal = {
    databaseId: db.id,
    summary: 'Move the second item',
    steps: ['Place Second before First'],
    commands: [
      {
        kind: 'record.move',
        tableId: table.id,
        viewId: table.viewId,
        recordIds: [table.records[1]],
        place: { before: table.records[0] },
      },
    ],
  };
  await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
  const panel = await ask(page);
  await panel.getByRole('link', { name: 'Preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
  const names = (root: ReturnType<Page['locator']>) =>
    root.getByRole('gridcell').filter({ hasText: /^(First|Second)$/ });
  await expect(names(dialog)).toHaveText(['Second', 'First']);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  await page.getByRole('button', { name: 'View changed', exact: true }).click();
  await expect(names(page.getByRole('grid', { name: 'Grid', exact: true }))).toHaveText(['Second', 'First']);
});

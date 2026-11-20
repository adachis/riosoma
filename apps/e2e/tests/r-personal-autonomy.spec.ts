import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';

let provider: Server;
let providerUrl: string;
let proposal: Record<string, unknown>;
let proposed = false;

test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    request.resume();
    await new Promise<void>((resolve) => request.on('end', resolve));
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const delta = proposed
      ? { content: 'Review the small change.' }
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
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: proposed ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    );
    proposed = true;
  });
  await new Promise<void>((resolve) => provider.listen(0, resolve));
  providerUrl = `http://${new URL(base()).hostname}:${(provider.address() as AddressInfo).port}/v1`;
});

test.afterAll(async () => {
  provider?.closeAllConnections();
  if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test('previews a small change at the personal limit and explains a lowered organization cap', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((entry) => entry.local)!.providerId;
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: providerUrl }],
    models: { everyday: { providerId, model: 'fixture' }, power: null },
    autonomy: 'instant',
    monthlyBudgetUsd: null,
  });
  const database = await createDatabase(page, 'Personal approval', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  const table = database.tables.Items!;
  const recordId = table.records[0]!;
  const fieldId = table.fields.Name!;
  proposal = {
    databaseId: database.id,
    summary: 'Rename one item',
    steps: ['Change the name of one item'],
    commands: [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: recordId, values: { [fieldId]: 'Changed' } }],
      },
    ],
  };
  proposed = false;
  const save = () =>
    page.getByRole('region', { name: 'Save changes' }).getByRole('button', { name: 'Save', exact: true });
  const saveChoice = async () => {
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/me/preferences') && response.request().method() === 'PATCH',
    );
    await save().click();
    expect((await saved).ok()).toBe(true);
    await expect(save()).toBeDisabled();
  };
  await visit(page, `${base()}/settings/ai/rio/autonomy`);
  await page.getByText('Always preview first', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Always preview first', exact: true })).toBeChecked();
  await saveChoice();
  expect(
    await asOwner<{ preferences: { rioAutonomy: string } }>(page, 'GET', '/api/auth/session'),
  ).toMatchObject({ preferences: { rioAutonomy: 'ask' } });

  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
  await page.locator('.rio-assistant__trigger button').click();
  const composer = page.locator('.rio-assistant__composer textarea');
  await composer.fill('Rename one item');
  await composer.press('Enter');
  await expect(page.getByRole('link', { name: 'Preview', exact: true })).toBeVisible();
  const record = async () =>
    asOwner<{ values: Record<string, unknown> }>(page, 'GET', `/api/tables/${table.id}/records/${recordId}`);
  expect((await record()).values[fieldId]).toBe('Original');
  await page.getByRole('link', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Preview', exact: true });
  await expect(preview).toBeVisible();
  expect((await record()).values[fieldId]).toBe('Original');
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await page.locator('.rio-assistant__trigger button').click();

  await visit(page, `${base()}/settings/ai/rio/autonomy`);
  await page.getByText('Make changes right away', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Make changes right away', exact: true })).toBeChecked();
  await saveChoice();
  await asOwner(page, 'PUT', '/api/ai/settings', { autonomy: 'ask' });
  await visit(page, `${base()}/settings/ai/rio/autonomy`);
  await expect(page.getByRole('radio', { name: 'Make changes right away', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Make changes right away', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: 'Preview big changes, do small ones right away', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Rio currently uses “Always preview first”/)).toBeVisible();
  expect(await asOwner(page, 'GET', '/api/rio/status')).toMatchObject({
    autonomy: 'ask',
    autonomyCap: 'ask',
  });
});

for (const { cap, label } of [
  { cap: 'previewBig', label: 'Preview big changes, do small ones right away' },
  { cap: 'ask', label: 'Always preview first' },
] as const) {
  test(`selects an allowed choice by keyboard after the cap falls to ${cap}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await asOwner(page, 'PUT', '/api/ai/settings', { autonomy: 'instant' });
    await asOwner(page, 'PATCH', '/api/me/preferences', { rioAutonomy: 'instant' });
    await visit(page, `${base()}/settings/ai/rio/autonomy`);
    const saved = page.getByRole('radio', { name: 'Make changes right away', exact: true });
    await expect(saved).toBeChecked();
    await expect(saved).toBeEnabled();

    await asOwner(page, 'PUT', '/api/ai/settings', { autonomy: cap });
    await visit(page, `${base()}/settings/ai/rio/autonomy`);
    await expect(saved).toBeDisabled();
    await expect(saved).toBeChecked();
    const save = page
      .getByRole('region', { name: 'Save changes' })
      .getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    const group = page.getByRole('radiogroup', { name: 'What Rio may do without asking', exact: true });
    await group.locator('..').focus();
    await page.keyboard.press('Tab');
    const first = page.getByRole('radio', { name: 'Always preview first', exact: true });
    const allowed = page.getByRole('radio', { name: label, exact: true });
    await expect(first).toBeFocused();
    await expect(saved).toBeChecked();
    expect(await asOwner(page, 'GET', '/api/auth/session')).toMatchObject({
      preferences: { rioAutonomy: 'instant' },
    });
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await expect(saved).not.toBeChecked();
    if (cap === 'previewBig') {
      await page.keyboard.press('ArrowDown');
      await expect(allowed).toBeChecked();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('radio', { name: 'Always preview first', exact: true })).toBeChecked();
      await page.keyboard.press('ArrowUp');
      await expect(allowed).toBeChecked();
    }
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(allowed).toBeFocused();
    const persisted = page.waitForResponse(
      (response) => response.url().endsWith('/api/me/preferences') && response.request().method() === 'PATCH',
    );
    await save.click();
    expect((await persisted).ok()).toBe(true);
    await expect(save).toBeDisabled();
    expect(await asOwner(page, 'GET', '/api/auth/session')).toMatchObject({
      preferences: { rioAutonomy: cap },
    });
  });
}

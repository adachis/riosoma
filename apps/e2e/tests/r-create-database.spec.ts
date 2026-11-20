import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSummary } from '../../../packages/contracts/src/data/schema.js';
import type { RioPlanPreview } from '../../../packages/contracts/src/rio.js';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, signIn } from '../helpers';
import { databaseBlueprint } from '../../server/src/ai/create-database-fixture';

let receiver: Server;
let address: string;
let proposed = false;

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      const delta = proposed
        ? { content: 'Review your project tracker.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: {
                  name: 'create_database',
                  arguments: JSON.stringify(databaseBlueprint()),
                },
              },
            ],
          };
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: proposed ? 'stop' : 'tool_calls' }],
        })}\n\n`,
      );
      proposed = true;
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  address = `http://${new URL(base()).hostname}:${(receiver.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('creates from home through preview and approval, opens the database, and undoes it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((provider) => provider.local)!.providerId;
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: `${address}/v1` }],
    models: { everyday: { providerId, model: 'fixture' }, power: null },
    autonomy: 'instant',
    monthlyBudgetUsd: null,
  });
  proposed = false;
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Ask Rio anything about your data' });
  await composer.fill('make me a project tracker');
  await composer.press('Enter');
  const preview = page.getByRole('link', { name: 'Preview', exact: true });
  await expect(preview).toBeVisible();
  const beforePreview = await asOwner<DatabaseSummary[]>(page, 'GET', '/api/databases');
  const previewed = page.waitForResponse((response) =>
    /\/api\/rio\/plans\/[^/]+\/preview$/.test(new URL(response.url()).pathname),
  );
  await preview.click();
  const previewResponse = await previewed;
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const snapshot = (await previewResponse.json()) as RioPlanPreview;
  const databaseId = snapshot.schema.database.id;
  const proposedDatabase = async () =>
    (await asOwner<DatabaseSummary[]>(page, 'GET', '/api/databases')).filter(
      (database) => database.id === databaseId,
    );
  expect(beforePreview.filter((database) => database.id === databaseId)).toEqual([]);
  const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Project tracker' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tasks · By status' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tasks · Deadlines' })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Keep sample records' })).toBeChecked();
  await expect(dialog.getByRole('grid', { name: 'All projects' })).toBeVisible();
  await expect(dialog.getByRole('gridcell', { name: 'Community launch', exact: true })).toBeVisible();
  const samples = dialog.getByRole('checkbox', { name: 'Keep sample records' });
  await samples.focus();
  await samples.press('Space');
  await expect(samples).not.toBeChecked();
  await expect(dialog.getByRole('grid', { name: 'All projects' })).toBeVisible();
  await expect(dialog.getByRole('gridcell', { name: 'Community launch', exact: true })).toHaveCount(0);
  await samples.focus();
  await samples.press('Space');
  await expect(dialog.getByRole('gridcell', { name: 'Community launch', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Tasks · By status' }).click();
  await expect(dialog.getByText('Invite members', { exact: true })).toBeVisible();
  expect(await proposedDatabase()).toEqual([]);
  const applied = page.waitForResponse((response) =>
    /\/api\/rio\/plans\/[^/]+\/apply$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  const response = await applied;
  expect(response.ok(), await response.text()).toBe(true);
  const receipt = (await response.json()) as { databaseId: string };
  expect(receipt.databaseId).toBe(databaseId);
  expect(await proposedDatabase()).toEqual([
    expect.objectContaining({
      id: databaseId,
      name: 'Project tracker',
      icon: 'list-check',
      color: 'blue',
      role: 'owner',
    }),
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/${receipt.databaseId}(?:/|$)`));
  await expect(page.getByRole('link', { name: 'Open database', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'All projects' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'Community launch', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Open database', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page).toHaveURL(base() + '/');
  await expect(page.getByText('Undone', { exact: true })).toBeVisible();
  expect(await proposedDatabase()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, runCommands, signIn } from '../helpers';

let receiver: Server;
let port: number;
let tableId: string;
let onboardingPage: string | undefined;
const longValue = 'A long overdue item with a name that must stay readable in a narrow panel '.repeat(8);

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
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
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const userIndex = parsed.messages.findLastIndex((message) => message.role === 'user');
      const onboarding = parsed.messages[userIndex]?.content?.includes("I'm new here");
      const read = parsed.messages.slice(userIndex + 1).some((message) => message.role === 'tool');
      if (onboarding) {
        const context = /"page":"(\w+)"/.exec(parsed.messages[0]?.content ?? '');
        onboardingPage = context?.[1];
      }
      const delta = !read
        ? {
            ...(onboarding ? {} : { content: 'Here are the overdue items in Items.' }),
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: {
                  name: 'query_records',
                  arguments: JSON.stringify({
                    tableId,
                    ...(onboarding
                      ? {}
                      : {
                          show: true,
                          fields: ['Name', 'Status', 'Notes'],
                          where: [{ field: 'Due', operator: 'lt', value: '2026-01-01' }],
                        }),
                  }),
                },
              },
            ],
          }
        : {
            content: onboarding
              ? 'Welcome! 🌱 Try these first:\n\n- Choose your preferences in settings.\n- Set your notifications.\n- Find your way with search. [Show me search](/?showMe=palette)'
              : '| Name | Status | Notes |\n| --- | --- | --- |\n| Overdue item | Waiting | A long comparison value that should remain on one line inside the scroll region. |',
          };
      response.setHeader('content-type', 'text/event-stream');
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: read ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  port = (receiver.address() as AddressInfo).port;
});
test.afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test('welcomes from settings without records and fits requested records to the panel', async ({ page }) => {
  await signIn(page);
  const db = await createDatabase(page, 'Reply workspace', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
        { name: 'Notes', type: 'text' },
        { name: 'Due', type: 'date' },
        { name: 'Region', type: 'text' },
      ],
      records: [{ Name: longValue, Status: 'Waiting', Notes: longValue, Due: '2000-01-01', Region: 'West' }],
    },
  ]);
  tableId = db.tables.Items!.id;
  await runCommands(page, db.id, [
    {
      kind: 'view.update',
      viewId: db.tables.Items!.viewId,
      config: { hiddenFieldIds: [db.tables.Items!.fields.Notes!] },
    },
  ]);
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((entry) => entry.local)!.providerId;
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: `http://${new URL(base()).hostname}:${port}/v1` }],
    models: { everyday: { providerId, model: 'fixture' }, power: null },
    monthlyBudgetUsd: null,
  });
  await page.goto(`${base()}/settings/ai`);
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Rio', exact: true });
  const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
  await input.fill("I'm new here. What should I know?");
  await input.press('Enter');
  await expect(panel.getByText(/Welcome!/)).toBeVisible();
  expect(onboardingPage).toBe('settings');
  await expect(panel.getByRole('table')).toHaveCount(0);
  await expect(panel.locator('.rio-assistant__records')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show me search' }).click();
  await expect(page.locator('[data-demo-layer]')).toBeVisible();
  await page.locator('[data-demo-layer]').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('[data-demo-layer]')).toHaveCount(0);
  await input.fill('show me the overdue items');
  await input.press('Enter');
  const records = panel.locator('.rio-assistant__records');
  await expect(records.locator('p')).toHaveText('1 of 1 records in Items · Reply workspace');
  const cards = records.locator('.rio-assistant__record-cards');
  await expect(cards).toBeVisible();
  await expect(cards.getByRole('heading', { name: longValue.trim() })).toBeVisible();
  await expect(cards.getByRole('link', { name: `Open record: ${longValue.trim()}` })).toHaveAttribute(
    'href',
    new RegExp(`/${db.id}/${tableId}/`),
  );
  await expect(cards.locator('dt')).toHaveCount(2);
  await expect(cards.getByText('Notes', { exact: true })).toBeVisible();
  await expect(records.getByRole('table')).toBeHidden();
  await panel.evaluate((element) => {
    (element as HTMLElement).style.width = '360px';
  });
  await expect(cards).toBeVisible();
  const title = cards.locator('h3 span');
  await expect(title).toHaveAttribute('title', longValue);
  await expect(title).toHaveAttribute('aria-label', longValue);
  expect(
    await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.whiteSpace === 'nowrap' &&
        style.textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth
      );
    }),
  ).toBe(true);
  const comparison = panel.getByRole('region', { name: 'Comparison: Name, Status, Notes' });
  await expect(comparison).toBeVisible();
  expect(await comparison.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await comparison.focus();
  await expect(comparison).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.evaluate((element) => {
    (element as HTMLElement).style.width = '800px';
  });
  await expect(cards).toBeHidden();
  const table = records.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveCount(3);
  expect(
    await table
      .getByRole('cell')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width >= 160),
  ).toBe(true);
  const scroll = records.getByRole('region');
  await scroll.focus();
  await expect(scroll).toBeFocused();
});

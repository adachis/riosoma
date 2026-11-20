import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { REGISTRY } from '../../../packages/ai/src/registry';
import type { RioConversationDetail, AiSettingsView } from '../../../packages/contracts/src/rio';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';

let receiver: Server;
let port: number;
let recordLink = '';
let summaries = 0;
let lastPrompt = '';
let recordTable = '';

// Delayed record responses must reach the browser route instead of a service worker.
test.use({ serviceWorkers: 'block' });

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      lastPrompt = body;
      const compacting = body.includes('Summarize this conversation for its continuation.');
      if (compacting) summaries += 1;
      const prompt = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const showRecords =
        prompt.messages.at(-1)?.role === 'user' &&
        prompt.messages.at(-1)?.content === 'Show records for scrolling';
      const content = compacting
        ? 'Decisions: keep the task. Open question: the next step. Relevant record ID is preserved.'
        : `Continue with [Open task](${recordLink}).`;
      response.setHeader('content-type', 'text/event-stream');
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: showRecords
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: randomUUID(),
                        type: 'function',
                        function: {
                          name: 'query_records',
                          arguments: JSON.stringify({ tableId: recordTable, show: true, limit: 40 }),
                        },
                      },
                    ],
                  }
                : { content },
              finish_reason: showRecords ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        })}\n\n`,
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

test('keeps record navigation reachable beside Rio at 900 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await signIn(page);
  const { preferences } = await asOwner<{ preferences: { recordLayout?: 'card' | 'panel' } }>(
    page,
    'GET',
    '/api/auth/session',
  );
  const database = await createDatabase(page, 'Tablet record navigation', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Tablet task' }],
    },
  ]);
  const table = database.tables.Tasks!;
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`);
    const record = page.getByRole('region', { name: 'Tablet task', exact: true });
    const close = record.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toBeVisible();
    await close.click({ trial: true });
    await page.locator('.rio-assistant__trigger button').click();
    await expect(page.locator('.rio-assistant__panel')).toBeVisible();
    const controls = record.locator('.rio-record-card__navigation').locator('button, a');
    await expect(controls).toHaveCount(6);
    await expect
      .poll(() =>
        controls.evaluateAll((elements) => {
          const workspace = elements[0]!.closest('.rio-record-workspace')!.getBoundingClientRect();
          const panel = elements[0]!.closest('.rio-record-surface')!.getBoundingClientRect();
          return elements.every((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= Math.max(workspace.left, panel.left) &&
              box.right <= Math.min(workspace.right, panel.right) &&
              box.top >= panel.top &&
              box.bottom <= panel.bottom
            );
          });
        }),
      )
      .toBe(true);
    await record.getByRole('button', { name: 'More for this record' }).click();
    await expect(page.getByRole('menuitem', { name: 'Download as Word' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(record).toBeVisible();
    await close.focus();
    await close.press('Enter');
    await expect(record).toHaveCount(0);
    await expect(page.locator('.rio-assistant__panel')).toBeVisible();
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: preferences.recordLayout ?? 'card' });
  }
});

test('keeps the active conversation through record links, reloads, new tabs, sign-ins, and compaction', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1024, height: 720 });
  await signIn(page);
  const { preferences } = await asOwner<{ preferences: { recordLayout?: 'card' | 'panel' } }>(
    page,
    'GET',
    '/api/auth/session',
  );
  const db = await createDatabase(page, 'Conversation projects', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Follow up' }],
    },
  ]);
  const table = db.tables.Tasks!;
  recordTable = table.id;
  recordLink = `/${db.id}/${table.id}/${table.viewId}/${table.records[0]}`;
  const model = REGISTRY.filter((entry) => entry.tiers.includes('everyday')).sort(
    (a, b) => a.contextTokens - b.contextTokens,
  )[0]!;
  const { gateways: _gateways, ...original } = (
    await asOwner<AiSettingsView>(page, 'GET', '/api/ai/settings')
  ).settings;
  // A key is saved for an address, so the stand-in's address and its key go in one save.
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId: model.providerId, baseUrl: `http://${new URL(base()).hostname}:${port}/v1` }],
    keys: { [model.providerId]: randomUUID() },
    models: { everyday: { providerId: model.providerId, model: model.model }, power: null },
    monthlyBudgetUsd: null,
  });
  try {
    // Record links must leave both the conversation and the side panel's controls reachable.
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
    // Exercise the searchable history used once conversations outgrow the menu.
    for (let index = 0; index < 11; index++) await asOwner(page, 'POST', '/api/rio/conversations');
    await page.reload();
    await page.locator('.rio-assistant__trigger button').click();
    const panel = page.locator('.rio-assistant__panel');
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await input.fill('Find the follow-up task');
    await input.press('Enter');
    const link = panel.getByRole('link', { name: 'Open task' }).first();
    await expect(link).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const active = await panel.getAttribute('data-conversation-id');
    await page.locator('.rio-assistant__trigger button').click();
    await expect(panel).toHaveCount(0);
    await page.locator('.rio-assistant__trigger button').click();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${table.records[0]}$`));
    const recordPanel = page.getByRole('region', { name: 'Follow up', exact: true });
    await expect(recordPanel).toBeVisible();
    const recordBox = (await recordPanel.boundingBox())!;
    const conversationBox = (await panel.boundingBox())!;
    expect(recordBox.x + recordBox.width).toBeLessThanOrEqual(conversationBox.x + 0.5);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await expect(panel.getByRole('log').getByText('Find the follow-up task', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    const tab = await page.context().newPage();
    await visit(tab, `${base()}/`);
    await tab.locator('.rio-assistant__trigger button').click();
    await expect(tab.locator('.rio-assistant__panel')).toHaveAttribute('data-conversation-id', active!);
    await tab.close();
    await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click();
    await expect(panel).not.toHaveAttribute('data-conversation-id', active!);
    await panel.getByRole('button', { name: 'Past conversations' }).click();
    await page
      .getByRole('menuitem', { name: /Find the follow-up task/ })
      .or(page.getByRole('option', { name: /Find the follow-up task/ }))
      .click();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await panel.getByRole('button', { name: 'Close Rio' }).click();
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await signIn(page);
    await page.locator('.rio-assistant__trigger button').click();
    await expect(panel).not.toHaveAttribute('data-conversation-id', active!);
    await panel.getByRole('button', { name: 'Past conversations' }).click();
    await page
      .getByRole('menuitem', { name: /Find the follow-up task/ })
      .or(page.getByRole('option', { name: /Find the follow-up task/ }))
      .click();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
      csrfToken: string;
    };
    const turns = Math.ceil((model.contextTokens * 0.75 * 4) / 7800) + 2;
    for (let i = 0; i < turns; i++) {
      const response = await page.request.post(`${base()}/api/rio/conversations/${active}/messages`, {
        headers: { 'x-csrf-token': session.csrfToken },
        data: {
          text: `${i} ${'a'.repeat(7800)}`,
          context: { databaseId: db.id, tableId: table.id },
          locale: 'en-US',
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText('This conversation is getting long. Rio will start forgetting the earliest messages.'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Home', exact: true }).first().click();
    await expect(page).toHaveURL(`${base()}/`);
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await panel.getByRole('button', { name: 'Compact', exact: true }).click();
    await expect(panel.getByText('Conversation compacted. Earlier messages are still here.')).toBeVisible();
    expect(summaries).toBeGreaterThan(0);
    await expect(panel.locator('[data-summarized]')).not.toHaveCount(0);
    await expect(
      panel.getByText('This conversation is getting long. Rio will start forgetting the earliest messages.'),
    ).toHaveCount(0);
    const detail = await asOwner<RioConversationDetail>(page, 'GET', '/api/rio/active-conversation');
    expect(detail.messages.at(-1)?.usage).toHaveProperty('footprint');
    await visit(page, `${base()}/${db.id}/${table.id}/${table.viewId}`);
    await input.fill('Continue the recent work');
    await input.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    expect(lastPrompt).toContain('Decisions: keep the task');
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: preferences.recordLayout ?? 'card' });
    await asOwner(page, 'PUT', '/api/ai/settings', original);
    await asOwner(page, 'DELETE', `/api/ai/keys/${model.providerId}`);
  }
});

for (const phone of [false, true]) {
  test(`restores delayed record blocks after reload and reopening (phone: ${phone})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: phone ? 375 : 1280, height: 812 });
    await signIn(page);
    const db = await createDatabase(page, 'Saved record scrolling', [
      {
        name: 'Tasks',
        fields: [{ name: 'Name', type: 'text' }],
        records: Array.from({ length: 40 }, (_, index) => ({ Name: `Task ${index}` })),
      },
    ]);
    const table = db.tables.Tasks!;
    recordTable = table.id;
    recordLink = `/${db.id}/${table.id}/${table.viewId}/${table.records[0]}`;
    const model = REGISTRY.filter((entry) => entry.tiers.includes('everyday')).sort(
      (a, b) => a.contextTokens - b.contextTokens,
    )[0]!;
    const { gateways: _gateways, ...original } = (
      await asOwner<AiSettingsView>(page, 'GET', '/api/ai/settings')
    ).settings;
    // A key is saved for an address, so the stand-in's address and its key go in one save.
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId: model.providerId, baseUrl: `http://${new URL(base()).hostname}:${port}/v1` }],
      keys: { [model.providerId]: randomUUID() },
      models: { everyday: { providerId: model.providerId, model: model.model }, power: null },
      monthlyBudgetUsd: null,
    });
    let releaseRecords!: () => void;
    try {
      await page.locator('.rio-assistant__trigger button').click();
      const panel = page.locator('.rio-assistant__panel');
      const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
      await expect(panel).toHaveAttribute('data-conversation-id');
      const active = await panel.getAttribute('data-conversation-id');
      await input.fill('Show records for scrolling');
      await input.press('Enter');
      await expect(panel.locator('.rio-assistant__records tbody tr')).toHaveCount(40);
      await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const log = panel.getByRole('log');
      await log.evaluate((element) => {
        element.scrollTop = 500;
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            for (const key of Object.keys(sessionStorage)) {
              if (key.startsWith('rio.panel.')) return JSON.parse(sessionStorage.getItem(key)!).scrollTop;
            }
          }),
        )
        .toBe(500);
      const recordsReady = new Promise<void>((resolve) => {
        releaseRecords = resolve;
      });
      await page.route('**/api/tables/*/records/*', async (route) => {
        await recordsReady;
        await route.continue();
      });
      await page.reload();
      await expect(panel).toHaveAttribute('data-conversation-id', active!);
      await expect(log.getByRole('progressbar')).toBeVisible();
      expect(
        await page.evaluate(() => {
          const key = Object.keys(sessionStorage).find((entry) => entry.startsWith('rio.panel.'))!;
          return JSON.parse(sessionStorage.getItem(key)!).scrollTop;
        }),
      ).toBe(500);
      releaseRecords();
      await expect(panel.locator('.rio-assistant__records tbody tr')).toHaveCount(40);
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(500);
      await page.unroute('**/api/tables/*/records/*');

      await panel.getByRole('button', { name: 'Close Rio' }).click();
      await page.locator('.rio-assistant__trigger button').click();
      await expect(panel).toHaveAttribute('data-conversation-id', active!);
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(500);
      await panel.getByRole('link', { name: 'Open record: Task 1', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${table.records[1]}$`));
      if (phone) {
        await expect(panel).toHaveCount(0);
        await expect(page.locator('.rio-assistant__trigger button')).toHaveAttribute('aria-expanded', 'true');
        const record = page.getByRole('dialog', { name: 'Task 1', exact: true });
        await expect(record).toBeVisible();
        await record.getByRole('button', { name: 'Close', exact: true }).click();
      }
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('data-conversation-id', active!);
    } finally {
      releaseRecords?.();
      await asOwner(page, 'PUT', '/api/ai/settings', original);
      await asOwner(page, 'DELETE', `/api/ai/keys/${model.providerId}`);
    }
  });
}

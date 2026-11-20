import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { AiSettingsView } from '../../../packages/contracts/src/rio';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120_000);

let receiver: Server;
let port: number;
const rejected = new Set<string>();
const linkText = 'Continue with';
const question = '次の質問 🌱 مرحبا';

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
        return;
      }
      const prompt = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const text = prompt.messages.findLast((message) => message.role === 'user')?.content ?? '';
      if (text.startsWith('Reject once ') && !rejected.has(text)) {
        rejected.add(text);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'The request was rejected.' } }));
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      if (text === 'A slow reply') {
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'A partial reply' } }] })}\n\n`,
        );
        return;
      }
      if (text === 'Offer a question' && prompt.messages.at(-1)?.role === 'user') {
        response.end(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: randomUUID(),
                      type: 'function',
                      function: {
                        name: 'ask_question',
                        arguments: JSON.stringify({
                          prompt: 'Which records?',
                          options: ['All records', 'Selected records'],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.end(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: `${linkText} [Open autonomy](/settings/ai/rio/autonomy).` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  port = (receiver.address() as AddressInfo).port;
});

test.afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

async function configure(page: Page) {
  await signIn(page);
  const previous = await asOwner<AiSettingsView>(page, 'GET', '/api/ai/settings');
  const providerId = previous.providers.find((provider) => provider.local)!.providerId;
  await asOwner(page, 'PUT', '/api/ai/settings', {
    enabled: true,
    providers: [{ providerId, baseUrl: `http://${new URL(base()).hostname}:${port}/v1` }],
    models: { everyday: { providerId, model: 'fixture' }, power: { providerId, model: 'fixture' } },
    monthlyBudgetUsd: null,
  });
  return async () => {
    const { gateways: _gateways, ...settings } = previous.settings;
    await asOwner(page, 'PUT', '/api/ai/settings', settings);
  };
}

for (const width of [1280, 390]) {
  test(`keeps reply links, drafts, and tier choices through navigation and reload at ${width} pixels`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const restore = await configure(page);
    try {
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      const panel = page.locator('.rio-assistant__panel');
      const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
      await expect(input).toBeEnabled();
      await input.fill(question);
      await input.press('Enter');
      const link = panel.getByRole('link', { name: 'Open autonomy', exact: true });
      await expect(link).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const active = await panel.getAttribute('data-conversation-id');
      await panel.getByRole('button', { name: 'Thorough', exact: true }).click();
      await input.fill(`${question}\nA draft to keep`);
      await link.click();
      await expect(page).toHaveURL(/\/settings\/ai\/rio\/autonomy$/);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('data-conversation-id', active!);
      await expect(input).toHaveValue(`${question}\nA draft to keep`);
      await page.reload();
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('data-conversation-id', active!);
      await expect(input).toHaveValue(`${question}\nA draft to keep`);
      await expect(panel.getByRole('button', { name: 'Thorough', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(panel.getByRole('log')).toHaveAttribute('aria-live', 'polite');
      await expect(panel.getByRole('log').getByText(question, { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`rio-chat-${width}.png`) });
      await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
      await expect(
        page.getByRole('radiogroup', { name: 'What Rio may do without asking', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      await expect(input).toHaveValue(`${question}\nA draft to keep`);
      await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click();
      await expect(input).toHaveValue('');
      await expect(panel).not.toHaveAttribute('data-conversation-id', active!);
      await input.focus();
      await input.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'AI: Ask Rio', exact: true })).toBeFocused();
    } finally {
      await restore();
    }
  });
}

test('keeps rejected and disconnected questions available for editing and resending', async ({ page }) => {
  const restore = await configure(page);
  try {
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await expect(input).toBeEnabled();
    const text = `Reject once ${randomUUID()} ${question}`;
    await input.fill(text);
    await input.press('Enter');
    await expect(panel.getByRole('alert').first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(input).toHaveValue(text);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(panel.getByRole('link', { name: 'Open autonomy', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await page.route('**/api/rio/conversations/*/messages', (route) => route.abort('failed'));
    await input.fill('A question during a lost connection');
    await input.press('Enter');
    await expect(input).toHaveValue('A question during a lost connection');
    await expect(panel.getByRole('alert').last()).toBeVisible();
    await page.unroute('**/api/rio/conversations/*/messages');
    await input.fill('An edited question after reconnecting');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(panel.getByRole('link', { name: 'Open autonomy', exact: true })).toHaveCount(2);
  } finally {
    await restore();
  }
});

test('keeps long pasted messages intact and makes the limit actionable on a short phone screen', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 420 });
  const restore = await configure(page);
  try {
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await expect(input).toBeEnabled();
    const text = `${'a'.repeat(7995)}🌱مرحبا`;
    await input.focus();
    await page.keyboard.insertText(text);
    await expect(input).toHaveValue(text);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(panel.getByText('Keep your message to 8,000 characters or fewer.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('rio-chat-message-limit.png') });
    await input.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await input.fill('a'.repeat(8000));
    await input.press('Enter');
    await expect(panel.getByRole('link', { name: 'Open autonomy', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await restore();
  }
});

test('stops a partial reply, keeps the next draft, and sends question choices', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-05T12:00:00') });
  const restore = await configure(page);
  try {
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await expect(input).toBeEnabled();
    await input.fill('A slow reply');
    await input.press('Enter');
    await expect(panel.getByText('A partial reply', { exact: true })).toBeVisible();
    await input.fill('The next draft');
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(input).toHaveValue('The next draft');
    await expect(panel.getByText('A partial reply', { exact: true })).toBeVisible();
    const pet = panel.locator('.rio-avatar');
    await expect(pet).toHaveAttribute('data-mood', 'idle');
    expect(await pet.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    // Conversation naps wait two minutes on weekdays, so advance the browser clock.
    await page.clock.fastForward(120_000);
    await expect(pet).toHaveAttribute('data-mood', 'napping');
    expect(await pet.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    await input.fill('Offer a question');
    await input.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Selected records', exact: true }).click();
    await expect(
      panel.locator('[data-role="person"]').getByText('Selected records', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Open autonomy', exact: true })).toHaveCount(2);
    await expect(panel.getByRole('table')).toHaveCount(0);
    await expect(panel.locator('.rio-assistant__records')).toHaveCount(0);
  } finally {
    await restore();
  }
});

test('keeps Rio open on a full-page record with the card preference on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const restore = await configure(page);
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    const database = await createDatabase(page, 'Full-page conversation context', [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Keep the conversation' }],
      },
    ]);
    const table = database.tables.Items!;
    const href = `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`;
    await visit(page, href);
    await expect(page.locator('.rio-record-surface--page')).toBeVisible();
    const launcher = page.getByRole('button', { name: 'AI: Ask Rio', exact: true });
    await launcher.click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('dialog', { name: 'Rio', exact: true });
    await expect(panel).toBeVisible();
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await expect(input).toBeEnabled();
    await input.fill(question);
    await input.press('Enter');
    await expect(panel.getByRole('link', { name: 'Open autonomy', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const active = await page.locator('.rio-assistant__panel').getAttribute('data-conversation-id');
    await input.fill('A draft on the full page');
    await page.reload();
    await expect(page).toHaveURL(href);
    await expect(panel).toBeVisible();
    await expect(page.locator('.rio-assistant__panel')).toHaveAttribute('data-conversation-id', active!);
    await expect(input).toHaveValue('A draft on the full page');
    await expect(panel.getByRole('log').getByText(question, { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.rio-record-surface--page')).toBeVisible();
    await launcher.click();
    await expect(panel).toBeVisible();
    await expect(input).toHaveValue('A draft on the full page');
  } finally {
    await restore();
  }
});

test('keeps Rio usable while a linked database loads and fails on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const restore = await configure(page);
  let releaseSchema!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseSchema = resolve;
  });
  let schemaRequested = false;
  try {
    const database = await createDatabase(page, 'Unavailable conversation context', [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Keep the conversation' }],
      },
    ]);
    const table = database.tables.Items!;
    await page.route(`**/api/databases/${database.id}/schema`, async (route) => {
      schemaRequested = true;
      await waiting;
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal', messageKey: 'errors.internal', userFault: false } },
      });
    });
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`, {
      waitForAppLoaded: false,
    });
    await expect.poll(() => schemaRequested).toBe(true);
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await expect(input).toBeEnabled();
    await input.fill('Help me continue');
    const failedSchema = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/databases/${database.id}/schema`) && response.status() === 500,
    );
    releaseSchema();
    await failedSchema;
    await expect(page.locator('.rio-database-unavailable')).toHaveCount(1);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('Help me continue');
    await input.press('Enter');
    const link = panel.getByRole('link', { name: 'Open autonomy', exact: true });
    await expect(link).toBeVisible();
    const active = await panel.getAttribute('data-conversation-id');
    await link.click();
    await expect(page).toHaveURL(/\/settings\/ai\/rio\/autonomy$/);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-conversation-id', active!);
    await expect(panel.getByRole('log').getByText('Help me continue', { exact: true })).toBeVisible();
  } finally {
    releaseSchema();
    await restore();
  }
});

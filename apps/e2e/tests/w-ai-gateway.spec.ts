import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, signIn, visit } from '../helpers';
import { randomUUID } from 'node:crypto';

test.setTimeout(120_000);
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

let upstream: Server;
let port: number;
const gatewayKey = randomUUID();
const gatewayRoute = randomUUID();
let restrictModel = false;
test.beforeAll(async () => {
  upstream = createServer((request, response) => {
    if (request.headers.apikey !== gatewayKey || request.headers['x-route'] !== gatewayRoute) {
      response.writeHead(401);
      response.end('{}');
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'chat-route' }] }));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (restrictModel) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'cannot use own model - must be: allowed-route' } }));
        return;
      }
      const parsed = JSON.parse(body) as { stream: boolean };
      if (!parsed.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'Y' } }] }));
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'The gateway delivered this answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as AddressInfo).port;
});
test.afterAll(async () => {
  upstream?.closeAllConnections();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test('configures a gateway in settings and receives a Rio answer', async ({ page }) => {
  await signIn(page);
  const previous = await asOwner<{
    settings: Record<string, unknown>;
  }>(page, 'GET', '/api/ai/settings');
  let providerId: string | undefined;
  try {
    await visit(page, `${base()}/settings/ai`);
    await page.getByRole('button', { name: 'Add gateway', exact: true }).click();
    const form = page.getByRole('region', { name: 'AI gateway', exact: true });
    await form.getByLabel('Display name', { exact: true }).fill('Browser gateway');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await form.getByRole('button', { name: /Send the key/ }).click();
    await page.getByRole('option', { name: labelName('Custom header'), exact: true }).click();
    await form.getByLabel('API key', { exact: true }).fill(gatewayKey);
    await form.getByRole('button', { name: 'Add extra header', exact: true }).click();
    await form.getByLabel('Extra header name', { exact: true }).fill('X-Route');
    await form.getByLabel('Extra header value', { exact: true }).fill(gatewayRoute);
    await form.getByRole('button', { name: 'Discover models', exact: true }).click();
    await expect(form.getByLabel('Model name', { exact: true })).toHaveValue('chat-route');
    await form.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('Connected.  Round trip:');
    const pending = await asOwner<{ settings: { gateways?: unknown[] } }>(page, 'GET', '/api/ai/settings');
    expect(pending.settings.gateways ?? []).toEqual(previous.settings.gateways ?? []);
    const save = page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true });
    await save.click();
    const saved = page.getByRole('region', { name: 'Browser gateway', exact: true });
    await expect(saved.getByText('Stored', { exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Add gateway', exact: true })).toBeVisible();
    const view = await asOwner<{ settings: { gateways: Array<{ providerId: string; name: string }> } }>(
      page,
      'GET',
      '/api/ai/settings',
    );
    providerId = view.settings.gateways.find((gateway) => gateway.name === 'Browser gateway')!.providerId;
    await saved.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Connected.  Round trip:');
    const enabled = page.getByRole('switch', { name: 'Turn on AI', exact: true });
    if (!(await enabled.isChecked())) {
      await enabled.focus();
      await page.keyboard.press('Space');
    }
    await page.getByRole('button', { name: /Quick answers/ }).click();
    await page.getByRole('option', { name: labelName('Browser gateway · chat-route'), exact: true }).click();
    await save.click();
    await saved.getByLabel('Model name', { exact: true }).fill('replacement-route');
    await save.click();
    const changed = await asOwner<{ settings: { models: { everyday: unknown } } }>(
      page,
      'GET',
      '/api/ai/settings',
    );
    expect(changed.settings.models.everyday).toBeNull();
    await page.getByRole('button', { name: /Quick answers/ }).click();
    await expect(
      page.getByRole('option', { name: labelName('Browser gateway · chat-route'), exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('option', { name: labelName('Browser gateway · replacement-route'), exact: true })
      .click();
    await save.click();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Rio', exact: true });
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await input.fill('Say hello');
    await input.press('Enter');
    await expect(panel.getByText('The gateway delivered this answer.', { exact: true })).toBeVisible();
  } finally {
    if (providerId) await asOwner(page, 'DELETE', `/api/ai/gateways/${providerId}`);
    const { gateways: _gateways, ...settings } = previous.settings;
    await asOwner(page, 'PUT', '/api/ai/settings', settings);
  }
});

test('opens a gateway setting from its deep link before a gateway is configured', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/admin/connections/ai/gateway-baseUrl`);
  const form = page.getByRole('region', { name: 'AI gateway', exact: true });
  const address = form.getByLabel('Base URL', { exact: true });
  await expect(address).toBeVisible();
  await expect(address).toBeFocused();
  await expect(page).toHaveURL(/\/admin\/connections\/ai\/gateway-baseUrl$/);
});

test('links a failed compaction to its gateway settings on a phone', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const previous = await asOwner<{ settings: Record<string, unknown> }>(page, 'GET', '/api/ai/settings');
  const providerId = 'gateway-browser-compaction';
  try {
    await asOwner(page, 'PUT', `/api/ai/gateways/${providerId}`, {
      gateway: {
        providerId,
        name: 'Compaction gateway',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        auth: { mode: 'header', header: 'apikey' },
        headerNames: ['X-Route'],
        models: [{ model: 'chat-route', contextTokens: 32000, mapping: null }],
      },
      key: gatewayKey,
      headers: { 'X-Route': gatewayRoute },
    });
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: true,
      models: { everyday: { providerId, model: 'chat-route' }, power: null },
      monthlyBudgetUsd: null,
    });
    const conversation = await asOwner<{ id: string }>(page, 'POST', '/api/rio/conversations', {});
    const session = await asOwner<{ csrfToken: string }>(page, 'GET', '/api/auth/session');
    // A real transcript reaches the compaction notice without reducing the model's request budget.
    for (let turn = 0; turn < 13; turn++) {
      const reply = await page.request.post(`${base()}/api/rio/conversations/${conversation.id}/messages`, {
        headers: { 'x-csrf-token': session.csrfToken },
        data: { text: `${turn} ${'r'.repeat(7900)}`, locale: 'en-US' },
      });
      expect(reply.ok()).toBe(true);
      expect(await reply.text()).toContain('The gateway delivered this answer.');
    }
    await asOwner(page, 'PUT', '/api/rio/active-conversation', { conversationId: conversation.id });
    await visit(page, base());
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Rio', exact: true });
    await expect(panel.getByText('The gateway delivered this answer.', { exact: true }).last()).toBeVisible();
    restrictModel = true;
    const compact = panel.getByRole('button', { name: 'Compact', exact: true });
    await compact.focus();
    await page.keyboard.press('Enter');
    const alert = panel.getByRole('alert');
    await expect(alert).toContainText('The gateway route only allows model allowed-route.');
    const settings = alert.getByRole('link', { name: 'Open gateway settings', exact: true });
    await expect(settings).toHaveAttribute('href', `/settings/ai#${providerId}`);
    await settings.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/settings/ai#${providerId}$`));
    await expect(panel).toBeVisible();
    await expect(panel.getByText('The gateway delivered this answer.', { exact: true }).last()).toBeVisible();
    await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Compaction gateway', exact: true })).toBeVisible();
  } finally {
    restrictModel = false;
    await asOwner(page, 'DELETE', `/api/ai/gateways/${providerId}`);
    const { gateways: _gateways, ...settings } = previous.settings;
    await asOwner(page, 'PUT', '/api/ai/settings', settings);
  }
});

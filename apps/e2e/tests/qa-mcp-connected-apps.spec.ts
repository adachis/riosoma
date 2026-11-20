import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { RemoteServer } from '../../../packages/contracts/src/index';
import { expect, test } from '../accessibility';
import { standIn } from '../../server/src/mcp-client/stand-in.test-support';
import { asOwner, flip, signIn, visit } from '../helpers';
import { STAND_IN_HOSTS } from '../stack';
import { base, standIn as listener } from '../base';
import { recordLayoutAudit } from '../tight-space-audit';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60000);

async function addServer(page: Page, address: string, name: string, auth?: string, secret?: string) {
  await visit(page, `${base()}/settings/ai?tab=tools&server=new`);
  await page.getByRole('textbox', { name: 'Server name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Server address', exact: true }).fill(address);
  if (auth) {
    await page.getByRole('button', { name: 'Authentication' }).click();
    await page.getByRole('option', { name: auth, exact: true }).click();
  }
  if (secret) {
    await page.getByRole('textbox', { name: 'Header name' }).fill('x-api-key');
    await page.getByLabel('API key or client secret', { exact: true }).fill(secret);
  }
  await flip(page.getByRole('switch', { name: 'Allow private network addresses' }));
  await flip(page.getByRole('switch', { name: 'Everyone', exact: true }));
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page).toHaveURL(/server=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get('server')!;
}

async function server(page: Page, id: string) {
  return (await asOwner<RemoteServer[]>(page, 'GET', '/api/admin/remote-tools')).find(
    (row) => row.id === id,
  )!;
}

async function removeServer(page: Page, id: string | undefined) {
  if (!id) return;
  const current = await server(page, id);
  await asOwner(page, 'POST', '/api/admin/remote-tools/commands', {
    kind: 'remote.remove',
    id: randomUUID(),
    serverId: id,
    revision: current.revision,
  });
}

test('keeps a large catalog with long names and descriptions within phone width', async ({ page }, info) => {
  const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
  const longName = `tool_${'x'.repeat(195)}`;
  outside.state.extraTools = Array.from({ length: 98 }, (_, index) => ({
    name: index === 0 ? longName : `tool_${index}`,
    description: `${'detail'.repeat(150)} 共有 🧭 مسودة`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  }));
  let cleanupId: string | undefined;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const serverName = `共有 🧭 ${'n'.repeat(70)}`;
    const id = await addServer(page, outside.address, serverName);
    cleanupId = id;
    await expect(page.getByRole('link', { name: serverName, exact: true }).locator('span')).toHaveAttribute(
      'title',
      serverName,
    );
    await page.getByRole('button', { name: /^Refresh tools for/ }).hover();
    const tooltip = page.getByRole('tooltip', { name: `Refresh tools for ${serverName}`, exact: true });
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await recordLayoutAudit(page, info, 'connected-tools-long-name-phone');
    await page.getByRole('button', { name: /^Refresh tools for/ }).click();
    await expect(page.getByRole('switch', { name: longName, exact: true })).toBeVisible();
    expect((await server(page, id)).tools).toHaveLength(100);
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    const toggle = page.getByRole('switch', { name: longName, exact: true });
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toBeChecked();
    const save = page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true });
    await save.focus();
    await save.press('Enter');
    await expect.poll(async () => (await server(page, id)).config.enabledTools).toEqual([longName]);
    await page.reload();
    await expect(toggle).toBeChecked();
    await toggle.focus();
    await toggle.press('Space');
    await save.click();
    await expect.poll(async () => (await server(page, id)).config.enabledTools).toEqual([]);
  } finally {
    await removeServer(page, cleanupId);
    await outside.close();
  }
});

for (const width of [1280, 390])
  test(`keeps drafts during live connection changes at ${width} pixels`, async ({ page, browser }) => {
    const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
    const other = await browser.newContext({ serviceWorkers: 'block' });
    let cleanupId: string | undefined;
    try {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      const id = await addServer(page, outside.address, '共有 🧭 مسودة');
      cleanupId = id;
      await page.getByRole('button', { name: 'Refresh tools for 共有 🧭 مسودة' }).click();
      await expect(page.getByRole('switch', { name: 'inspect', exact: true })).toBeVisible();
      const name = page.getByRole('textbox', { name: 'Server name', exact: true });
      await name.fill('未保存 🧭 مسودة');
      await name.focus();
      const colleague = await other.newPage();
      await signIn(colleague);
      await visit(colleague, `${base()}/settings/ai?tab=tools&server=${id}`);
      await colleague.getByRole('textbox', { name: 'Server name', exact: true }).fill('Saved by colleague');
      await colleague
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(page.getByRole('link', { name: 'Saved by colleague', exact: true })).toBeVisible({
        timeout: 20000,
      });
      await expect(name).toHaveValue('未保存 🧭 مسودة');
      await expect(name).toBeFocused();
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(
        page
          .locator('.rio-settings__content')
          .getByRole('alert')
          .filter({ hasText: 'Someone else changed this at the same time.' })
          .first(),
      ).toBeVisible();
      expect((await server(page, id)).config.name).toBe('Saved by colleague');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Discard and continue' }).click();
      await page.getByRole('link', { name: 'Saved by colleague', exact: true }).click();
      await expect(name).toHaveValue('Saved by colleague');
      await name.fill('Final name');
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(page.getByRole('link', { name: 'Final name', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Undo last change' }).click();
      await expect(name).toHaveValue('Saved by colleague');
      await page.reload();
      await expect(name).toHaveValue('Saved by colleague');
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
    } finally {
      await removeServer(page, cleanupId);
      await other.close();
      await outside.close();
    }
  });

for (const width of [1280, 390])
  test(`cancels pending removal after another administrator saves at ${width} pixels`, async ({
    page,
    browser,
  }) => {
    const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
    const other = await browser.newContext({ serviceWorkers: 'block' });
    let cleanupId: string | undefined;
    try {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      const id = await addServer(page, outside.address, 'Removal connection');
      cleanupId = id;
      // Discovery changes the revision and can cancel removal while Firefox is confirming it.
      // Finish discovery before the draft so this case tests the colleague's live save alone.
      await page.getByRole('button', { name: 'Refresh tools for Removal connection', exact: true }).click();
      await expect(page.getByRole('switch', { name: 'inspect', exact: true })).toBeVisible();
      const name = page.getByRole('textbox', { name: 'Server name', exact: true });
      await name.fill('未保存 🧭 مسودة');
      await page.getByRole('button', { name: 'Remove server', exact: true }).click();
      const confirmation = page.getByRole('group', { name: 'Remove this connection?' });
      await expect(confirmation).toBeVisible();
      const colleague = await other.newPage();
      await signIn(colleague);
      await visit(colleague, `${base()}/settings/ai?tab=tools&server=${id}`);
      await colleague.getByRole('textbox', { name: 'Server name', exact: true }).fill('Saved by colleague');
      await colleague
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(page.getByRole('link', { name: 'Saved by colleague', exact: true })).toBeVisible({
        timeout: 20000,
      });
      await expect(confirmation).toHaveCount(0);
      await expect(name).toHaveValue('未保存 🧭 مسودة');
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(
        page
          .locator('.rio-settings__content')
          .getByRole('alert')
          .filter({ hasText: 'Someone else changed this at the same time.' })
          .first(),
      ).toBeVisible();
      expect((await server(page, id)).config.name).toBe('Saved by colleague');
      await page.getByRole('button', { name: 'Remove server', exact: true }).click();
      const confirm = confirmation.getByRole('button', { name: 'Confirm removal', exact: true });
      await confirm.focus();
      await confirm.press('Enter');
      await expect(page.getByRole('link', { name: 'Saved by colleague', exact: true })).toHaveCount(0);
      cleanupId = undefined;
      expect(await server(page, id)).toBeUndefined();
    } finally {
      await removeServer(page, cleanupId);
      await other.close();
      await outside.close();
    }
  });

for (const status of [401, 403] as const)
  test(`explains rejected API keys after an SSE fallback returns ${status}`, async ({ page }) => {
    const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
    outside.state.header = { name: 'x-api-key', value: randomUUID() };
    outside.state.headerStatus = status;
    let cleanupId: string | undefined;
    try {
      await signIn(page);
      const id = await addServer(
        page,
        `${outside.origin}/legacy`,
        'Legacy key connection',
        'API key header',
        randomUUID(),
      );
      cleanupId = id;
      await page.getByRole('button', { name: 'Refresh tools for Legacy key connection' }).click();
      await expect(page.locator('.rio-settings__content').getByRole('alert')).toHaveText(
        'The connected server rejected the API key.  Check its value and header name in Tools settings.',
      );
      expect((await server(page, id)).errorKey).toBe('remote.credentialRejected');
      await page.getByLabel('API key or client secret', { exact: true }).fill(outside.state.header.value);
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect.poll(async () => (await server(page, id)).revision).toBe(2);
      await page.getByRole('button', { name: 'Refresh tools for Legacy key connection' }).click();
      await expect(page.getByRole('switch', { name: 'inspect', exact: true })).toBeVisible();
      expect((await server(page, id)).errorKey).toBeNull();
    } finally {
      await removeServer(page, cleanupId);
      await outside.close();
    }
  });

test('explains rejected API keys and recovers after the credential is corrected', async ({ page }) => {
  const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
  outside.state.header = { name: 'x-api-key', value: randomUUID() };
  let cleanupId: string | undefined;
  try {
    await signIn(page);
    const id = await addServer(page, outside.address, 'Key connection', 'API key header', randomUUID());
    cleanupId = id;
    await page.getByRole('button', { name: 'Refresh tools for Key connection' }).click();
    await expect(page.locator('.rio-settings__content').getByRole('alert')).toContainText(
      'The connected server rejected the API key.',
    );
    await page.getByLabel('API key or client secret', { exact: true }).fill(outside.state.header.value);
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect.poll(async () => (await server(page, id)).revision).toBe(2);
    await page.getByRole('button', { name: 'Refresh tools for Key connection' }).click();
    await expect(page.getByRole('switch', { name: 'inspect', exact: true })).toBeVisible();
    await flip(page.getByRole('switch', { name: 'inspect', exact: true }));
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect.poll(async () => (await server(page, id)).config.enabledTools).toEqual(['inspect']);
    await page.reload();
    await expect(page.getByLabel('API key or client secret', { exact: true })).toHaveValue('');
    outside.state.failing = true;
    await page.getByRole('button', { name: 'Refresh tools for Key connection' }).click();
    await expect(page.locator('.rio-settings__content').getByRole('alert')).toHaveText(
      'The connected server is unavailable.  Try again shortly.',
    );
    expect((await server(page, id)).config.enabledTools).toEqual(['inspect']);
  } finally {
    await removeServer(page, cleanupId);
    await outside.close();
  }
});

test('returns OAuth denial to settings and explains revoked authorization in Rio', async ({
  page,
  context,
  request,
}) => {
  const outside = await standIn({ ...listener(), hostname: STAND_IN_HOSTS[0]! });
  outside.state.oauth = true;
  outside.state.denyAuthorization = true;
  let cleanupId: string | undefined;
  // Browser authorization visits reach the same local listener as the server's guarded requests.
  await context.route(`${outside.origin}/authorize**`, async (route) => {
    const local = new URL(route.request().url());
    local.hostname = '127.0.0.1';
    const response = await request.get(local.href, { ignoreHTTPSErrors: true, maxRedirects: 0 });
    expect(response.status()).toBe(302);
    // WebKit cannot fulfill an intercepted request with a redirect response.
    await route.fulfill({
      contentType: 'text/html',
      body: `<script>window.location.replace(${JSON.stringify(response.headers().location)})</script>`,
    });
  });
  try {
    await signIn(page);
    const id = await addServer(page, outside.address, 'OAuth connection', 'OAuth 2.1');
    cleanupId = id;
    await page.getByRole('button', { name: 'Authorize connection', exact: true }).click();
    await expect(page).toHaveURL(/connectionError=denied/);
    await expect(page.locator('.rio-settings__content').getByRole('alert')).toHaveText(
      'Authorization was denied.  Authorize the connection when you are ready.',
    );
    expect(outside.state.exchanges).toBe(0);
    outside.state.denyAuthorization = false;
    await page.getByRole('button', { name: 'Authorize connection', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`server=${id}$`));
    await flip(page.getByRole('switch', { name: 'inspect', exact: true }));
    await flip(page.getByRole('switch', { name: 'write', exact: true }));
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect.poll(async () => (await server(page, id)).config.enabledTools).toEqual(['inspect', 'write']);
    await asOwner(page, 'PUT', '/api/ai/settings', { enabled: true });
    const conversation = await asOwner<{ id: string }>(page, 'POST', '/api/rio/conversations');
    outside.state.expired = true;
    const read = await asOwner<{ block: { approvalId: string } }>(
      page,
      'POST',
      `/api/rio/conversations/${conversation.id}/remote-tools`,
      {
        serverId: id,
        tool: 'inspect',
        arguments: { value: '読み取り 🧭' },
      },
    );
    expect(outside.state.refreshes).toBe(1);
    expect(outside.state.calls).toHaveLength(1);
    await visit(page, `${base()}/#remote-approval=${read.block.approvalId}`);
    await expect(page.locator('.rio-remote-approval').getByRole('status')).toHaveText('Finished');
    outside.state.expired = true;
    outside.state.rejectRefresh = true;
    const failed = await asOwner<{ block: { approvalId: string } }>(
      page,
      'POST',
      `/api/rio/conversations/${conversation.id}/remote-tools`,
      {
        serverId: id,
        tool: 'inspect',
        arguments: { value: 'revoked' },
      },
    );
    await page.evaluate((approvalId) => {
      window.location.hash = `remote-approval=${approvalId}`;
    }, failed.block.approvalId);
    await expect(page.locator('.rio-remote-approval').getByRole('alert')).toHaveText(
      'This connection’s authorization expired or was revoked.  Ask an AI admin to authorize it again in Tools settings.',
    );
    expect(outside.state.calls).toHaveLength(1);
    expect(outside.state.registrations).toBe(1);
  } finally {
    await removeServer(page, cleanupId);
    await context.unroute(`${outside.origin}/authorize**`);
    await outside.close();
  }
});

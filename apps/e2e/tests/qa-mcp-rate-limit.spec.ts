import type { McpAppActivity, McpRateSettings, OAuthSettings } from '../../../packages/contracts/src/index';
import { expect, test } from '../accessibility';
import { oauthClient } from '../../server/src/mcp/client.test-support';
import { asOwner, signIn, visit } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

test('saves MCP limits, refuses an SDK client, and shows connected app counters', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const previous = await asOwner<McpRateSettings>(page, 'GET', '/api/admin/mcp/settings');
  const oauth = await asOwner<OAuthSettings>(page, 'GET', '/api/admin/oauth/settings');
  const callback = `${base()}/rate-client/callback`;
  await context.route(`${callback}**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Client callback</title></head><body><main><h1>Client callback</h1></main></body></html>',
    }),
  );
  const sdk = oauthClient(`${base()}/mcp`, callback);
  let clientId: string | undefined;
  try {
    await asOwner(page, 'PUT', '/api/admin/oauth/settings', { dynamicRegistration: true });
    await expect(sdk.connect()).rejects.toThrow();
    const authorization = sdk.authorizationUrl()!;
    clientId = authorization.searchParams.get('client_id')!;
    await visit(page, authorization.href);
    await page.getByRole('button', { name: 'Approve access', exact: true }).click();
    await expect(page).toHaveURL(/\/rate-client\/callback\?/);
    await sdk.finish(new URL(page.url()).searchParams.get('code')!);
    await sdk.client.listTools();
    const before = (await asOwner<McpAppActivity[]>(page, 'GET', '/api/admin/mcp/activity')).find(
      (row) => row.clientId === clientId,
    )!;
    await visit(page, `${base()}/settings/mcp`);
    await expect(page.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible();
    const card = page.getByRole('region', { name: 'Local MCP client' });
    await expect(card).toBeVisible();
    const global = page.locator('[data-setting-id="rate-limit"]');
    await global.getByRole('textbox', { name: 'Calls per minute' }).fill(String(before.callsLastMinute + 1));
    await card.getByText('Limit calls', { exact: true }).click();
    await card.getByRole('textbox', { name: 'Calls per minute' }).fill('1');
    const bar = page.getByRole('region', { name: 'Save changes', exact: true });
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    await expect
      .poll(() => asOwner<McpRateSettings>(page, 'GET', '/api/admin/mcp/settings'))
      .toEqual({
        callsPerMinute: before.callsLastMinute + 1,
        appOverrides: { ...previous.appOverrides, [clientId]: 1 },
      });
    await expect(sdk.client.listTools()).rejects.toMatchObject({
      code: 429,
      message: expect.stringContaining('1 calls per minute'),
    });
    await expect(
      card.getByText(
        `${before.callsLastMinute + 1} calls in the last minute. 1 limit hits in the last 24 hours.`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 15_000 });
    await card.getByText('Use organization limit', { exact: true }).click();
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    await sdk.client.listTools();
    await expect(sdk.client.listTools()).rejects.toMatchObject({ code: 429 });
    await expect(
      card.getByText(
        `${before.callsLastMinute + 3} calls in the last minute. 2 limit hits in the last 24 hours.`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 15_000 });
    await global.getByText('No limit', { exact: true }).click();
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    expect((await sdk.client.listTools()).tools.length).toBeGreaterThan(0);
    await page.reload();
    await expect(global.getByRole('radio', { name: 'No limit', exact: true })).toBeChecked();
    await expect(card.getByRole('radio', { name: 'Use organization limit' })).toBeChecked();
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    const stylesheet = await page.locator('link[href*="/themes/"][rel="stylesheet"]').getAttribute('href');
    expect(stylesheet).toBeTruthy();
    const themeAddress = new URL(stylesheet!, base());
    expect((await page.request.get(themeAddress.href)).ok()).toBe(true);
    const manifest = await page.request.get(new URL('./theme.json', themeAddress).href);
    expect(manifest.ok()).toBe(true);
    const theme = (await manifest.json()) as {
      assets: Array<{ path: string }>;
      remoteFonts: Array<{ path: string }>;
    };
    for (const asset of [...theme.assets, ...theme.remoteFonts])
      expect((await page.request.get(new URL(asset.path, themeAddress).href)).ok()).toBe(true);
  } finally {
    await sdk.client.close();
    await asOwner(page, 'PUT', '/api/admin/mcp/settings', previous);
    await asOwner(page, 'PUT', '/api/admin/oauth/settings', {
      dynamicRegistration: oauth.dynamicRegistration,
    });
    if (clientId) await asOwner(page, 'DELETE', `/api/admin/oauth/apps/${clientId}`);
    await context.unroute(`${callback}**`);
  }
});

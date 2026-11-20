import type { ConnectionsView, SourceMeta } from '../../../packages/contracts/src/index';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

const account = {
  id: 'cnx0123456789abcd',
  name: 'Example organization account with a long name for narrow screens',
  email: null,
  connectedAt: '2026-01-01T00:00:00.000Z',
  needsReconnect: false,
};

function savedSource(): SourceMeta {
  return {
    id: 'src0123456789abcd',
    name: 'Repository source',
    description: '',
    kind: 'app',
    connection: {
      kind: 'app',
      app: 'github',
      settings: { connectionId: 'cnx0987654321abcd', connectedBy: 'Other person' },
    },
    secrets: [],
    access: 'creators',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'Other person',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastTest: null,
    tables: 0,
  };
}

for (const width of [1280, 390]) {
  test(`tests another person's saved account and selects a replacement explicitly at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const source = savedSource();
    let tested = false;
    let update: unknown;
    await page.route('**/api/connections', (route) =>
      route.fulfill({
        json: {
          providers: [{ provider: 'github', available: true, account }],
        },
      }),
    );
    await page.route('**/api/sources', (route) => route.fulfill({ json: [source] }));
    await page.route(`**/api/sources/${source.id}/test`, async (route) => {
      tested = true;
      await route.fulfill({ json: { ok: true, steps: [] } });
    });
    await page.route(`**/api/sources/${source.id}`, async (route) => {
      update = route.request().postDataJSON();
      await route.fulfill({ json: source });
    });
    await page.goto(`${base()}/settings/sources?source=${source.id}`);
    const dialog = page.getByRole('dialog', { name: source.name, exact: true });
    const check = dialog.getByRole('button', { name: 'Test connection', exact: true });
    await expect(check).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await check.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => tested).toBe(true);
    await expect(dialog.getByText('Connected.', { exact: true })).toBeVisible();
    const select = dialog.getByRole('button', { name: /Connected account/ });
    await select.focus();
    await page.keyboard.press('Space');
    await page.getByRole('option', { name: account.name, exact: true }).click();
    await expect(dialog.getByText(/Sources using a different account stop syncing/)).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => update)
      .toMatchObject({
        connection: { kind: 'app', app: 'github', settings: { connectionId: account.id } },
      });
    expect(update).not.toHaveProperty('secrets');
  });

  test(`connects an account and explains unavailable provider setup at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const view: ConnectionsView = { providers: [{ provider: 'github', available: true, account: null }] };
    let draft: unknown;
    await page.route('**/api/connections', (route) => route.fulfill({ json: view }));
    await page.route('**/api/sources', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sources/test', async (route) => {
      draft = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, steps: [] } });
    });
    await context.route('**/api/oauth/start/github?*', async (route) => {
      view.providers[0]!.account = account;
      await route.fulfill({
        contentType: 'text/html',
        body: `<script>localStorage.setItem('rio-connections', JSON.stringify({id:crypto.randomUUID(),provider:'github',ok:true}));window.close()</script>`,
      });
    });
    await page.goto(`${base()}/settings/sources?source=new`);
    let dialog = page.getByRole('dialog', { name: 'Add a data source', exact: true });
    await dialog.getByRole('option', { name: 'GitHub', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Repository data');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /Connected account/ })).toContainText(account.name);
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect
      .poll(() => draft)
      .toMatchObject({
        connection: { kind: 'app', app: 'github', settings: { connectionId: account.id } },
        secrets: {},
      });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    view.providers[0]!.available = false;
    await page.reload();
    dialog = page.getByRole('dialog', { name: 'Add a data source', exact: true });
    await dialog.getByRole('option', { name: 'GitHub', exact: true }).click();
    await expect(dialog.getByText(/Unavailable.*Settings, Integrations/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
  });

  test(`keeps a newly selected app ready after a delayed account refresh at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    let startRefresh!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      startRefresh = resolve;
    });
    let delay = false;
    let saved: unknown;
    await page.route('**/api/connections', async (route) => {
      if (delay) {
        startRefresh();
        await refresh;
      }
      await route.fulfill({ json: { providers: [{ provider: 'github', available: true, account }] } });
    });
    await page.route('**/api/sources', async (route) => {
      if (route.request().method() === 'POST') {
        saved = route.request().postDataJSON();
        await route.fulfill({ json: savedSource() });
      } else await route.fulfill({ json: [] });
    });
    await context.route('**/api/oauth/start/github?*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<script>localStorage.setItem('rio-connections', JSON.stringify({id:crypto.randomUUID(),provider:'github',ok:true}));window.close()</script>`,
      }),
    );
    await page.goto(`${base()}/settings/sources?source=new`);
    const dialog = page.getByRole('dialog', { name: 'Add a data source', exact: true });
    await dialog.getByRole('option', { name: 'GitHub', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /Connected account/ })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Customer data');
    delay = true;
    try {
      await dialog.getByRole('button', { name: 'Connect another account', exact: true }).click();
      await refreshing;
      await dialog.getByRole('option', { name: 'HubSpot', exact: true }).click();
      await dialog.getByLabel('Key', { exact: true }).fill(['stand', 'in', 'key'].join('-'));
      const save = dialog.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toBeEnabled();
      finishRefresh();
      await page.waitForLoadState('networkidle');
      await expect(save).toBeEnabled();
      await save.click();
      await expect
        .poll(() => saved)
        .toMatchObject({ connection: { kind: 'app', app: 'hubspot', settings: {} } });
    } finally {
      finishRefresh();
    }
  });
}

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import AxeBuilder from '@axe-core/playwright';
import { base } from '../base';
import { asOwner, createDatabase, newId, offlineMap, signIn, visit } from '../helpers';

let receiver: Server;
let address: string;
let proposed: Record<string, unknown>;
let sent = false;
let providerRequests: Array<{
  method?: string;
  path?: string;
  response: 'catalog' | 'plan' | 'text';
}> = [];
test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      providerRequests.push({
        method: request.method,
        path: request.url,
        response: request.method === 'GET' ? 'catalog' : sent ? 'text' : 'plan',
      });
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      const delta = sent
        ? { content: 'Review the proposed dashboard' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: { name: 'propose_changes', arguments: JSON.stringify(proposed) },
              },
            ],
          };
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: sent ? 'stop' : 'tool_calls' }] })}\n\n`,
      );
      sent = true;
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

test.beforeEach(() => {
  providerRequests = [];
});
test.afterEach(async ({ page: _page }, info) => {
  // Background calls can share the fixture.  Keep their sequence with the browser result.
  await info.attach('provider-requests', {
    body: JSON.stringify(providerRequests),
    contentType: 'application/json',
  });
});

test('creates every non-grid view type through a confirmed plan and undoes them together', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await offlineMap(page);
  const database = await createDatabase(page, 'Planned views', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Starts', type: 'date' },
      ],
      records: [{ Name: '東京 🚢 مرحبا', Starts: new Date().toISOString().slice(0, 10) }],
    },
  ]);
  const table = database.tables.Items!;
  const views = [
    'gallery',
    'kanban',
    'calendar',
    'form',
    'timeline',
    'gantt',
    'list',
    'map',
    'pivot',
    'chart',
    'orgChart',
  ].map((type) => ({ id: newId('viw'), tableId: table.id, name: type, type }));
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
    autonomy: 'ask',
    monthlyBudgetUsd: null,
  });
  proposed = {
    databaseId: database.id,
    summary: 'Create views',
    steps: views.map((view) => `Create ${view.name}`),
    commands: views.map((view) => ({ kind: 'view.create', view })),
  };
  sent = false;
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
  await page.locator('.rio-assistant__trigger button').click();
  const composer = page.locator('.rio-assistant__composer textarea');
  await composer.fill('Create views');
  await composer.press('Enter');
  await page.getByRole('link', { name: 'Preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
  const read = () =>
    asOwner<{ views: Array<{ id: string; type: string }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
  expect((await read()).views.map((view) => view.id)).toEqual([table.viewId]);
  const applied = page.waitForResponse((response) => response.url().endsWith('/apply'));
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  const response = await applied;
  expect(response.ok(), await response.text()).toBe(true);
  const { groupId } = (await response.json()) as { groupId: string };
  await expect(dialog).toHaveCount(0);
  expect((await read()).views).toEqual(
    expect.arrayContaining(views.map(({ id, type }) => expect.objectContaining({ id, type }))),
  );
  for (const view of views) {
    await visit(page, `${base()}/${database.id}/${table.id}/${view.id}`);
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: view.name, exact: true }),
    ).toBeVisible();
  }
  const undone = await asOwner<{ status: string }>(page, 'POST', `/api/databases/${database.id}/undo`, {
    clientId: newId('cli'),
    commandId: newId('cmd'),
    groupId,
  });
  expect(undone.status).toBe('applied');
  expect((await read()).views.map((view) => view.id)).toEqual([table.viewId]);
  const redone = await asOwner<{ status: string }>(page, 'POST', `/api/databases/${database.id}/redo`, {
    clientId: newId('cli'),
    commandId: newId('cmd'),
    groupId,
  });
  expect(redone.status).toBe('applied');
  expect((await read()).views).toEqual(
    expect.arrayContaining(views.map(({ id, type }) => expect.objectContaining({ id, type }))),
  );
  await visit(page, `${base()}/${database.id}/${table.id}/${views[0]!.id}`);
  await expect(page.getByRole('grid', { name: 'gallery', exact: true })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`previews a dashboard locally and applies one undoable action at ${width} pixels`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    const database = await createDatabase(page, 'Planning', [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'First' }, { Name: 'Second' }],
      },
    ]);
    const dashboardId = `dsh${newId('cmd').slice(3)}`;
    const dashboard = {
      id: dashboardId,
      name: 'Project overview',
      databaseId: database.id,
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {
        tiles: [
          {
            id: 'item-count',
            kind: 'number',
            title: 'Item count',
            source: { tableId: database.tables.Items!.id, viewId: null, filter: null },
            value: { fn: 'count', fieldId: null },
            place: { x: 0, y: 0, w: 4, h: 2 },
          },
          {
            id: 'review-note',
            kind: 'text',
            title: 'Review',
            text: 'Ready for review',
            place: { x: 4, y: 0, w: 8, h: 2 },
          },
        ],
      },
    };
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
      autonomy: 'ask',
      monthlyBudgetUsd: null,
    });
    proposed = {
      databaseId: database.id,
      summary: 'Create a project overview',
      steps: ['Add a dashboard with a count and a note'],
      commands: [{ kind: 'dashboard.create', dashboard }],
    };
    sent = false;
    const tablePath = `${base()}/${database.id}/${database.tables.Items!.id}/${database.tables.Items!.viewId}`;
    await page.goto(tablePath);
    await expect(page.getByRole('grid', { name: 'Grid' })).toBeVisible();
    await page.locator('.rio-assistant__trigger button').click();
    await page
      .getByRole('textbox', { name: 'Ask Rio anything about your data' })
      .fill('Build a project overview');
    await page.getByRole('textbox', { name: 'Ask Rio anything about your data' }).press('Enter');
    const preview = page.getByRole('link', { name: 'Preview', exact: true });
    await expect(preview).toBeVisible();
    const planId = new URL((await preview.getAttribute('href'))!, base()).searchParams.get('rioPreview')!;
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/'))
        requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await preview.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Preview', exact: true });
    await expect(dialog.getByRole('heading', { name: dashboard.name })).toBeVisible();
    await expect(dialog.getByText('Ready for review', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`rioPreview=${planId}`));
    const saved = async () =>
      (
        await asOwner<{ dashboards: Array<{ id: string }> }>(
          page,
          'GET',
          `/api/databases/${database.id}/schema`,
        )
      ).dashboards.map((item) => item.id);
    expect(await saved()).not.toContain(dashboardId);
    expect(requests).toContain(`GET /api/rio/plans/${planId}/preview`);
    const writes: string[] = [];
    page.on('request', (request) => {
      // The underlying grid reads its summary with POST when the dialog closes.
      const summaryRead = /\/views\/[^/]+\/aggregate$/.test(new URL(request.url()).pathname);
      if (request.method() !== 'GET' && request.url().includes('/api/') && !summaryRead)
        writes.push(request.url());
    });
    requests.length = 0;
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    const accessibility = await new AxeBuilder({ page }).include('.rio-plan-preview').analyze();
    expect(accessibility.violations).toEqual([]);
    // The live grid remains mounted behind the preview and refreshes its own summary.
    const backgroundSummary = `POST /api/databases/${database.id}/views/${database.tables.Items!.viewId}/aggregate`;
    expect(requests.filter((request) => request !== backgroundSummary)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(await saved()).not.toContain(dashboardId);
    await page.goto(`${tablePath}?rioPreview=${planId}&rioPreviewTarget=${dashboardId}`);
    await expect(dialog.getByText('Ready for review', { exact: true })).toBeVisible();
    await page.reload();
    await expect(dialog.getByText('Ready for review', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).focus();
    const applied = page.waitForResponse((response) =>
      response.url().endsWith(`/api/rio/plans/${planId}/apply`),
    );
    await page.keyboard.press('Enter');
    const response = await applied;
    expect(response.ok(), await response.text()).toBe(true);
    const { groupId } = (await response.json()) as { groupId: string };
    await expect(dialog).toHaveCount(0);
    expect(await saved()).toContain(dashboardId);
    if (width >= 700) {
      // On a wide screen the receipt links to the created dashboard, and opening it navigates there
      // with the panel still open, so the person does not have to hunt for it in the sidebar.
      const panel = page.locator('.rio-assistant__panel');
      const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Create a project overview' });
      const openDashboard = receipt.getByRole('link', { name: 'Open dashboard', exact: true });
      await expect(openDashboard).toBeVisible();
      await openDashboard.click();
      await expect(page).toHaveURL(new RegExp(`/${database.id}/dashboards/${dashboardId}`));
      await expect(panel).toBeVisible();
    } else {
      // On a phone Rio covers the page, so it is closed when it is open, and the dashboard opens by
      // its address instead.
      const rio = page.getByRole('dialog', { name: 'Rio', exact: true });
      if (await rio.isVisible()) await rio.getByRole('button', { name: 'Close Rio', exact: true }).click();
      await page.goto(`${base()}/${database.id}/dashboards/${dashboardId}`);
    }
    await expect(page.getByRole('heading', { name: dashboard.name })).toBeVisible();
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
    const undone = await asOwner<{ status: string }>(page, 'POST', `/api/databases/${database.id}/undo`, {
      clientId: newId('cli'),
      commandId: newId('cmd'),
      groupId,
    });
    expect(undone.status).toBe('applied');
    expect(await saved()).not.toContain(dashboardId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

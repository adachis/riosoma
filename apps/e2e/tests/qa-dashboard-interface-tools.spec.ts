import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, flip, newId, runCommands, signIn, visit } from '../helpers';
import { oauthClient } from '../../server/src/mcp/client.test-support';

test.use({ serviceWorkers: 'block', actionTimeout: 15_000 });

test('MCP and Rio read dashboard tiles and interface pages without executable content', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Shared reporting tools', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: '東京 🌊 مرحبا' }],
    },
  ]);
  const table = database.tables.Tasks!;
  const dashboardId = `dsh${newId('rec').slice(3)}`;
  const interfaceId = `itf${newId('rec').slice(3)}`;
  const number = {
    id: 'number01',
    kind: 'number',
    title: 'Task count',
    place: { x: 0, y: 0, w: 3, h: 2 },
    source: { tableId: table.id, viewId: null, filter: null },
    value: { fn: 'count', fieldId: null },
  };
  await runCommands(page, database.id, [
    {
      kind: 'dashboard.create',
      dashboard: { id: dashboardId, name: 'Task overview', config: { tiles: [number] } },
    },
    {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Task desk',
        pages: [
          {
            id: 'pageMain01',
            name: 'Tasks',
            blocks: [
              number,
              {
                id: 'custom01',
                kind: 'code',
                title: 'Custom panel',
                place: { x: 3, y: 0, w: 6, h: 4 },
                html: '<main>Private source marker</main>',
                css: 'main { color: red; }',
                javascript: 'document.body.dataset.privateSource = "marker"',
              },
            ],
          },
        ],
      },
    },
  ]);

  await visit(page, `${base()}/settings/oauth-apps`);
  const registration = page.getByRole('switch', {
    name: 'Allow dynamic registration for MCP clients',
    exact: true,
  });
  if (!(await registration.isChecked())) {
    await flip(registration);
    const bar = page.getByRole('region', { name: 'Save changes', exact: true });
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
  }
  const callback = `${base()}/local-client/callback`;
  await context.route(`${callback}**`, (route) => route.fulfill({ body: '' }));
  const client = oauthClient(`${base()}/mcp`, callback);
  try {
    await expect(client.connect()).rejects.toThrow();
    await visit(page, client.authorizationUrl()!.href);
    await page.getByRole('button', { name: 'Approve access', exact: true }).click();
    await expect(page).toHaveURL(/\/local-client\/callback\?/);
    await client.finish(new URL(page.url()).searchParams.get('code')!);
    const dashboard = await client.client.callTool({
      name: 'get_dashboard',
      arguments: { databaseId: database.id, id: dashboardId },
    });
    expect(dashboard.isError).not.toBe(true);
    expect(dashboard.structuredContent).toMatchObject({
      id: dashboardId,
      config: { tiles: [{ id: 'number01', kind: 'number' }] },
    });
    const read = await client.client.callTool({
      name: 'get_interface',
      arguments: { databaseId: database.id, id: interfaceId },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      id: interfaceId,
      pages: [{ blocks: [number, { id: 'custom01', kind: 'code' }] }],
    });
    const code = (read.structuredContent as { pages: Array<{ blocks: object[] }> }).pages[0]!.blocks[1]!;
    expect(code).toEqual({ id: 'custom01', kind: 'code' });
    const missing = await client.client.callTool({
      name: 'get_interface',
      arguments: { databaseId: database.id, id: `itf${newId('rec').slice(3)}` },
    });
    expect(missing.isError).toBe(true);
  } finally {
    try {
      // A shared account must not carry this test's app approval into another spec.
      const clientId = client.authorizationUrl()?.searchParams.get('client_id');
      if (clientId) {
        const grants = await asOwner<Array<{ id: string; clientId: string }>>(
          page,
          'GET',
          '/api/oauth/grants',
        );
        for (const grant of grants.filter((grant) => grant.clientId === clientId))
          await asOwner(page, 'DELETE', `/api/oauth/grants/${grant.id}`);
        await expect
          .poll(async () =>
            (await asOwner<Array<{ clientId: string }>>(page, 'GET', '/api/oauth/grants')).some(
              (grant) => grant.clientId === clientId,
            ),
          )
          .toBe(false);
      }
    } finally {
      await client.client.close();
      await context.unroute(`${callback}**`);
    }
  }

  const toolReplies: Array<{ content: string }> = [];
  const endpoint = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const prompt = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const replies = prompt.messages.filter((message) => message.role === 'tool');
    toolReplies.push(...replies);
    const delta = replies.length
      ? { content: 'Read the dashboard and interface.' }
      : {
          tool_calls: [dashboardId, interfaceId].map((id, index) => ({
            index,
            id: `read-${index}`,
            type: 'function',
            function: {
              name: index === 0 ? 'get_dashboard' : 'get_interface',
              arguments: JSON.stringify({ databaseId: database.id, id }),
            },
          })),
        };
    response.setHeader('content-type', 'text/event-stream');
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: replies.length ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
    page,
    'GET',
    '/api/ai/settings',
  );
  const providerId = settings.providers.find((provider) => provider.local)!.providerId;
  try {
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId, baseUrl: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1` }],
      models: { everyday: { providerId, model: 'fixture' }, power: null },
      autonomy: 'ask',
      monthlyBudgetUsd: null,
    });
    await visit(page, `${base()}/${database.id}/dashboards/${dashboardId}`);
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.locator('.rio-assistant__panel');
    await panel.getByRole('button', { name: 'New conversation', exact: true }).first().click();
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data', exact: true });
    await input.fill('Read the dashboard and interface');
    await input.press('Enter');
    await expect(panel.getByText('Read the dashboard and interface.', { exact: true })).toBeVisible();
    expect(toolReplies).toHaveLength(2);
    expect(toolReplies.map((reply) => JSON.parse(reply.content))).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: dashboardId }) }),
      expect.objectContaining({ data: expect.objectContaining({ id: interfaceId }) }),
    ]);
    expect(JSON.stringify(toolReplies)).not.toContain('Private source marker');
    expect(JSON.stringify(toolReplies)).not.toContain('privateSource');
  } finally {
    await asOwner(page, 'PUT', '/api/ai/settings', { enabled: false });
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

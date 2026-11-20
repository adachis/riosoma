import { expect, test } from '../accessibility';
import { oauthClient } from '../../server/src/mcp/client.test-support';
import { asOwner, createDatabase, createView, flip, openTable, signIn, tick, visit } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

for (const width of [1280, 390])
  test(`authorizes an SDK MCP client and revokes it through settings at ${width} pixels`, async ({
    page,
    context,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    const previousGrants = await asOwner<Array<{ id: string }>>(page, 'GET', '/api/oauth/grants');
    if (width === 390)
      for (let index = 0; index < 10; index += 1)
        await createDatabase(page, `Consent choices ${index}`, [
          { name: 'Items', fields: [{ name: 'Name', type: 'text' }], records: [] },
        ]);
    const databaseName = `MCP 読み書き 🧭 ${width}`;
    const database = await createDatabase(page, databaseName, [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Before' }, { Name: 'Excluded' }],
      },
    ]);
    const excluded = await createDatabase(page, `Private ${width}`, [
      {
        name: 'Items',
        fields: [{ name: 'Name', type: 'text' }],
        records: [],
      },
    ]);
    const views: string[] = [];
    for (const type of [
      'kanban',
      'gallery',
      'calendar',
      'form',
      'timeline',
      'gantt',
      'list',
      'map',
      'pivot',
      'chart',
      'orgChart',
    ] as const) {
      views.push(
        await createView(page, database, 'Items', {
          name: type,
          type,
          config: {
            filter: {
              conjunction: 'and',
              conditions: [
                {
                  id: 'before',
                  fieldId: database.tables.Items!.fields.Name,
                  operator: 'is',
                  value: 'Before',
                },
              ],
            },
          },
        }),
      );
    }
    await visit(page, `${base()}/settings/oauth-apps`);
    const registration = page.getByRole('switch', { name: 'Allow dynamic registration for MCP clients' });
    if (!(await registration.isChecked())) {
      await flip(registration);
      const bar = page.getByRole('region', { name: 'Save changes', exact: true });
      await bar.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
    }
    const callback = `${base()}/local-client/callback`;
    await context.route(`${callback}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Client callback</title></head><body><main><h1>Client callback</h1></main></body></html>',
      }),
    );
    const sdk = oauthClient(`${base()}/mcp`, callback);
    try {
      await expect(sdk.connect()).rejects.toThrow();
      const authorization = sdk.authorizationUrl();
      expect(authorization?.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorization?.searchParams.get('resource')).toBe(`${base()}/mcp`);
      const clientId = authorization!.searchParams.get('client_id')!;
      await visit(page, authorization!.href);
      await expect(page.getByRole('heading', { name: 'Connect an app', exact: true })).toBeVisible();
      await page.getByText('Only these databases', { exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Only these databases', exact: true })).toBeChecked();
      const databaseCheckbox = page.getByRole('checkbox', { name: databaseName, exact: true });
      const databaseOption = page.getByRole('option', { name: databaseName, exact: true });
      await expect(databaseCheckbox.or(databaseOption)).toBeVisible();
      if (await databaseCheckbox.isVisible()) await tick(page, databaseName);
      else {
        await databaseOption.click();
        await expect(databaseOption).toHaveAttribute('aria-selected', 'true');
      }
      await page.getByRole('button', { name: 'Approve access', exact: true }).click();
      await expect(page).toHaveURL(new RegExp('/local-client/callback\\?'));
      const code = new URL(page.url()).searchParams.get('code')!;
      await sdk.finish(code);
      const tools = (await sdk.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('get_record');
      expect(tools).toContain('update_records');
      expect(tools).not.toContain('create_table');
      const listed = await sdk.client.callTool({ name: 'list_databases', arguments: {} });
      expect(listed.structuredContent).toMatchObject({ databases: [{ id: database.id }] });
      const home = await sdk.client.callTool({ name: 'list_folders', arguments: {} });
      expect(home.structuredContent).toMatchObject({ folders: [], databases: [{ id: database.id }] });
      const hidden = await sdk.client.callTool({
        name: 'get_schema',
        arguments: { databaseId: excluded.id },
      });
      expect(hidden.isError).toBe(true);
      const schema = await sdk.client.callTool({
        name: 'get_schema',
        arguments: { databaseId: database.id },
      });
      const tableId = (schema.structuredContent as { tables: { id: string }[] }).tables[0]!.id;
      const read = await sdk.client.callTool({ name: 'find_records', arguments: { tableId } });
      const record = (read.structuredContent as { records: { id: string; fields: { Name: string } }[] })
        .records[0]!;
      expect(record.fields.Name).toBe('Before');
      for (const view of views) {
        const result = await sdk.client.callTool({ name: 'find_records', arguments: { tableId, view } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          records: [{ id: record.id, fields: { Name: 'Before' } }],
        });
      }
      const argumentsFor = { tableId, records: [{ id: record.id, fields: { Name: 'After 共有 🧭' } }] };
      const proposal = await sdk.client.callTool({ name: 'propose_record_update', arguments: argumentsFor });
      expect(proposal.structuredContent).toMatchObject({ requiresConfirmation: true, applied: false });
      const before = await sdk.client.callTool({
        name: 'get_record',
        arguments: { tableId, recordId: record.id },
      });
      expect(before.structuredContent).toMatchObject({ record: { fields: { Name: 'Before' } } });
      const write = await sdk.client.callTool({ name: 'update_records', arguments: argumentsFor });
      expect(write.isError).not.toBe(true);
      for (const view of views) {
        const result = await sdk.client.callTool({ name: 'find_records', arguments: { tableId, view } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ records: [] });
      }
      await visit(page, base());
      const grid = await openTable(page, database, 'Items');
      await expect(grid.getByRole('gridcell', { name: 'After 共有 🧭', exact: true })).toBeVisible();
      const history = await asOwner<{ events: { action: string }[] }>(
        page,
        'GET',
        '/api/org/audit?limit=100',
      );
      expect(history.events.some((entry) => entry.action === 'data.records.updated')).toBe(true);
      const connectionsUrl = `${base()}/settings/connected-apps`;
      if (browserName === 'firefox') {
        // A poll can stay in the departing document.  Wait for the replacement's navigation event.
        const navigation = page.waitForURL(connectionsUrl, { waitUntil: 'domcontentloaded' });
        await page.evaluate((destination) => window.location.assign(destination), connectionsUrl);
        await navigation;
      } else {
        await visit(page, connectionsUrl);
      }
      // Other specs approve clients with this display name, so target the registered client.
      const connection = page
        .locator('section.rio-oauth__card')
        .filter({ has: page.getByText(clientId, { exact: true }) });
      await expect(connection.getByText('Local MCP client', { exact: true })).toBeVisible();
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
      await connection.getByRole('button', { name: 'Revoke access', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Revoke this connection?' });
      await dialog.getByRole('button', { name: 'Revoke access', exact: true }).focus();
      await dialog.getByRole('button', { name: 'Revoke access', exact: true }).press('Enter');
      await expect(connection).toBeHidden();
      if (previousGrants.length === 0)
        await expect(page.getByText('No connected apps.', { exact: true })).toBeVisible();
      const remainingGrants = await asOwner<Array<{ id: string }>>(page, 'GET', '/api/oauth/grants');
      expect(remainingGrants.map((grant) => grant.id).sort()).toEqual(
        previousGrants.map((grant) => grant.id).sort(),
      );
      await expect(sdk.client.callTool({ name: 'list_databases', arguments: {} })).rejects.toThrow();
    } finally {
      await sdk.client.close();
      await context.unroute(`${callback}**`);
    }
  });

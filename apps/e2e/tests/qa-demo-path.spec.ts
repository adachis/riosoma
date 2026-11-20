import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page, type TestInfo } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { connection, sql } from '../sql';
import { csvRows, workbookRows } from '../files';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', actionTimeout: 15_000 });

for (const width of [1440, 390]) {
  test(`builds a grouped view from a late warehouse column after two schema calls at ${width} pixels`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, `Late metrics ${width}`, [
      {
        name: 'Wide metrics',
        fields: Array.from({ length: 300 }, (_, index) => ({ name: `metric_${index}`, type: 'text' })),
        records: [
          { metric_0: 'First', metric_299: 'West' },
          { metric_0: 'Second', metric_299: 'East' },
        ],
      },
    ]);
    const other = await createDatabase(page, `Related metrics ${width}`, [
      {
        name: 'Related',
        fields: Array.from({ length: 90 }, (_, index) => ({
          name: `metric_${index}_${'東京\\"'.repeat(12)}`,
          type: 'text',
        })),
      },
    ]);
    const table = database.tables['Wide metrics']!;
    const viewId = newId('viw');
    const requests: Array<{
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string; parameters: unknown } }>;
    }> = [];
    const endpoint = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (request.method === 'GET') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
          return;
        }
        const prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof requests)[number];
        requests.push(prompt);
        const results = prompt.messages.filter((message) => message.role === 'tool');
        const schema = results[0] ? JSON.parse(results[0].content) : undefined;
        const field = schema?.data?.tables?.[0]?.fields?.find(
          (field: { name: string }) => field.name === 'metric_299',
        );
        const calls =
          results.length === 0
            ? [
                {
                  name: 'get_schema',
                  arguments: { databaseId: database.id, tableId: table.id, fields: ['metric_299'] },
                },
                { name: 'get_schema', arguments: { databaseId: other.id } },
              ]
            : results.length === 2 && field
              ? [
                  {
                    name: 'propose_changes',
                    arguments: {
                      databaseId: database.id,
                      summary: 'Group the late metric',
                      steps: ['Create a view grouped by metric_299'],
                      commands: [
                        {
                          kind: 'view.create',
                          view: {
                            id: viewId,
                            tableId: table.id,
                            name: 'Late metric groups',
                            type: 'grid',
                            config: { groups: [{ fieldId: field.id, direction: 'asc' }] },
                          },
                        },
                      ],
                    },
                  },
                ]
              : [];
        const delta = calls.length
          ? {
              tool_calls: calls.map((call, index) => ({
                index,
                id: randomUUID(),
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : { content: field ? 'Review the grouped view.' : 'The requested field is unavailable.' };
        response.setHeader('content-type', 'text/event-stream');
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, resolve));
    const settings = await asOwner<{
      settings: Record<string, unknown>;
      providers: Array<{ providerId: string; local: boolean }>;
    }>(page, 'GET', '/api/ai/settings');
    try {
      const providerId = settings.providers.find((provider) => provider.local)!.providerId;
      await asOwner(page, 'PUT', '/api/ai/settings', {
        enabled: true,
        providers: [
          {
            providerId,
            baseUrl: `http://${new URL(base()).hostname}:${(endpoint.address() as AddressInfo).port}/v1`,
          },
        ],
        models: { everyday: { providerId, model: 'fixture' }, power: null },
        autonomy: 'ask',
        monthlyBudgetUsd: null,
      });
      await openTable(page, database, 'Wide metrics');
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      const panel = page.locator('.rio-assistant__panel');
      const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
      await input.fill('Create a view grouped by metric_299 and compare the related schema');
      await input.press('Enter');
      const plan = panel.locator('.rio-assistant__block').filter({ hasText: 'Group the late metric' });
      await expect(plan).toContainText('Create a view grouped by metric_299');
      const supplied = requests[1]!;
      const results = supplied.messages.filter((message) => message.role === 'tool');
      expect(results).toHaveLength(2);
      expect(JSON.parse(results[0]!.content)).toMatchObject({
        data: { tables: [{ id: table.id, fields: [{ id: table.fields.metric_299, name: 'metric_299' }] }] },
      });
      expect(
        requests[0]!.tools!.find((tool) => tool.function.name === 'get_schema')!.function.parameters,
      ).toMatchObject({ properties: { tableId: {}, fields: {}, offset: {}, limit: {} } });
      await plan.getByRole('link', { name: 'Preview', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'Preview', exact: true });
      const previewGrid = preview.getByRole('treegrid', { name: 'Late metric groups', exact: true });
      await expect(previewGrid).toBeVisible();
      await expect(previewGrid.locator('.rio-grid-group-value')).toHaveText(['East', 'West']);
      await preview.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(preview).toBeHidden();
      const stored = await asOwner<{
        views: Array<{ id: string; config: { groups: Array<{ fieldId: string }> } }>;
      }>(page, 'GET', `/api/databases/${database.id}/schema`);
      expect(stored.views.find((view) => view.id === viewId)!.config.groups).toEqual([
        { fieldId: table.fields.metric_299, direction: 'asc' },
      ]);
      await page.reload();
      if (!(await panel.isVisible()))
        await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      await expect(plan).toBeVisible();
      await plan.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(plan.getByRole('status')).toHaveText('Undone');
      const undone = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
      expect(undone.views.some((view) => view.id === viewId)).toBe(false);
    } finally {
      await attachJson(info, 'late-schema-requests', requests);
      await asOwner(page, 'PUT', '/api/ai/settings', settings.settings);
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  });
}

async function attachJson(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

async function connectSource(page: Page, name: string) {
  const address = connection();
  await page.goto(`${base()}/settings/sources?source=new&kind=postgres`);
  const dialog = page.getByRole('dialog', { name: 'Add a data source' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  for (const [label, value] of [
    ['Host', address.host],
    ['Port', String(address.port)],
    ['Database', address.database],
    ['User', address.user],
  ])
    await dialog.getByRole('textbox', { name: label, exact: true }).fill(value!);
  await dialog
    .getByLabel('Password', { exact: true })
    .and(dialog.locator('input'))
    .fill(randomBytes(24).toString('hex'));
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('button', { name: /Secure connection/ }).click();
  await page.getByRole('option', { name: labelName('Off'), exact: true }).click();
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(dialog.getByText(/Connected to PostgreSQL/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
}

interface DemoSchema {
  tables: Array<{ id: string; name: string }>;
  fields: Array<{ id: string; tableId: string; name: string }>;
  dashboards: Array<{ id: string }>;
  views: Array<{ id: string; name: string; tableId: string }>;
}

async function helpTopic(page: Page, topic: string, title: string) {
  // Help belongs to the personal menu on every signed-in screen.
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: labelName('Help'), exact: true }).click();
  const help = page.locator('.rio-docs-panel');
  await help.getByRole('button', { name: 'All topics', exact: true }).click();
  await help.getByRole('searchbox', { name: 'Search help', exact: true }).fill(topic);
  await help.getByRole('link', { name: title, exact: true }).click();
  await expect(help.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await help.getByRole('button', { name: 'Close help', exact: true }).click();
}

for (const size of [2000, 2200]) {
  test(`walks snapshots, related keys, views, dashboards, exports, and approved plans with ${size} customers`, async ({
    page,
  }, info) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const schema = `qa_demo_${randomBytes(8).toString('hex')}`;
    const timings: Array<{ step: string; ms: number }> = [];
    const slowRequests: Array<{ method: string; path: string; ms: number }> = [];
    page.on('requestfinished', (request) => {
      const path = new URL(request.url()).pathname;
      const ms = request.timing().responseEnd;
      if (path.startsWith('/api/') && ms > 1000) slowRequests.push({ method: request.method(), path, ms });
    });
    const stamp = async <T>(step: string, work: () => Promise<T>) => {
      const started = Date.now();
      const result = await work();
      timings.push({ step, ms: Date.now() - started });
      return result;
    };
    await sql(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".customers (cust_no text PRIMARY KEY, name text, region text);
      INSERT INTO "${schema}".customers SELECT (1000 + i)::text,
        CASE WHEN i = 1 THEN '東京 🌊 مرحبا' ELSE 'Customer ' || i END,
        CASE WHEN i % 2 = 0 THEN 'West' ELSE 'East' END FROM generate_series(1, ${size}) i;
      CREATE TABLE "${schema}".products (product_code text PRIMARY KEY, name text, price numeric);
      INSERT INTO "${schema}".products SELECT 'SKU-' || i, 'Product ' || i,
        round((i % 97 + 1)::numeric / 3, 2) FROM generate_series(1, ${size}) i;
      CREATE TABLE "${schema}".orders (id integer PRIMARY KEY, customer_id integer, name text, status text, placed_on date);
      INSERT INTO "${schema}".orders SELECT 100000 + i, 1000 + i,
        'Order ' || i, CASE WHEN i % 2 = 0 THEN 'Shipped' ELSE 'Pending' END,
        CURRENT_DATE - (i % 7) FROM generate_series(1, ${size}) i;
      CREATE TABLE "${schema}".order_lines (id integer PRIMARY KEY, prefix_order_ref text, "SKU" text, label text, quantity integer);
      INSERT INTO "${schema}".order_lines SELECT i, ' ' || (100000 + (i - 1) % ${size} + 1)::text || ' ',
        'SKU-' || ((i - 1) % ${size} + 1), 'Line ' || i, i % 5 + 1 FROM generate_series(1, ${size * 2}) i;`);
    try {
      await signIn(page);
      const source = `Commerce ${size}`;
      await stamp('Connect and check the outside database', () => connectSource(page, source));
      await helpTopic(page, 'Syncing a table', 'Syncing a table from a data source');
      const database = await createDatabase(page, `Commerce demo ${size}`, [
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      await openTable(page, database, 'Notes');
      for (const [object, name, first] of [
        ['customers', 'Customers', '東京 🌊 مرحبا'],
        ['products', 'Products', 'Product 1'],
        ['orders', 'Orders', 'Order 1'],
        ['order_lines', 'Order lines', 'Line 1'],
      ]) {
        const dialog = await stamp(`List and preview ${name}`, () => sourceFields(page, source, object!));
        await dialog.getByRole('button', { name: 'Next', exact: true }).click();
        await dialog.getByRole('textbox', { name: 'Table name' }).fill(name!);
        await dialog.getByRole('button', { name: /Every hour Sync/ }).click();
        await page.getByRole('option', { name: labelName('Only when asked'), exact: true }).click();
        await stamp(`Create and first copy of ${name}`, async () => {
          await dialog.getByRole('button', { name: 'Create synced table', exact: true }).click();
          await expect(dialog).toBeHidden();
          await expect(page.getByRole('gridcell', { name: first, exact: true })).toBeVisible({
            timeout: 45_000,
          });
        });
        await page.reload();
        await expect(page.getByRole('gridcell', { name: first, exact: true })).toBeVisible();
      }
      const metadata = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
      const table = (name: string) => metadata.tables.find((table) => table.name === name)!;
      const field = (name: string, column: string) =>
        metadata.fields.find((field) => field.tableId === table(name).id && field.name === column)!.id;
      const suggestions = await asOwner<{
        suggestions: Array<{ fromFieldId: string; toFieldId: string; coverage: number; examples: unknown[] }>;
      }>(page, 'POST', `/api/databases/${database.id}/join-suggestions`, {});
      for (const [from, fromKey, to, toKey] of [
        ['Orders', 'customer_id', 'Customers', 'cust_no'],
        ['Order lines', 'prefix_order_ref', 'Orders', 'id'],
        ['Order lines', 'SKU', 'Products', 'product_code'],
      ]) {
        const found = suggestions.suggestions.find(
          (item) => item.fromFieldId === field(from!, fromKey!) && item.toFieldId === field(to!, toKey!),
        );
        expect(found).toMatchObject({ coverage: 1 });
        expect(found!.examples.length).toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: 'Find links', exact: true }).click();
      const links = page.getByRole('dialog', { name: 'Suggested links', exact: true });
      await expect(links).toContainText('From SKU in Order lines to product_code in Products');
      await expect(links).not.toContainText('From customer_id in Orders to id in Order lines');
      await expect(links.getByRole('meter').first()).toBeVisible();
      await links.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
      const joined = page.getByRole('dialog', { name: 'Create joined table', exact: true });
      await expect(
        joined.getByRole('button', { name: 'Match id with customer_id in Orders', exact: true }),
      ).toHaveCount(0);
      await joined
        .getByRole('button', { name: 'Match prefix_order_ref with id in Orders', exact: true })
        .click();
      for (const [next, left, right] of [
        ['Customers', 'Orders customer_id', 'cust_no'],
        ['Products', 'Order lines SKU', 'product_code'],
      ] as const) {
        await joined.getByRole('button', { name: 'Add another table', exact: true }).click();
        const step = joined.locator('fieldset.rio-joined-step').nth(next === 'Customers' ? 1 : 2);
        await step.getByRole('button', { name: /Next table$/ }).click();
        await page.getByRole('option', { name: labelName(next), exact: true }).click();
        await step.getByRole('button', { name: /Key from an earlier table$/ }).click();
        await page.getByRole('option', { name: labelName(left), exact: true }).click();
        await step.getByRole('button', { name: /Key from the next table$/ }).click();
        await page.getByRole('option', { name: labelName(right), exact: true }).click();
      }
      await joined.getByRole('textbox', { name: 'Table name' }).fill('Sales');
      for (const name of [
        'Order lines label',
        'Orders status',
        'Orders placed_on',
        'Customers name',
        'Customers region',
        'Products name',
        'Products price',
        'Order lines quantity',
      ])
        await joined
          .getByRole('group', { name: 'Fields to include', exact: true })
          .getByText(name, { exact: true })
          .click();
      await stamp('Create joined sales', async () => {
        await joined.getByRole('button', { name: 'Create joined table', exact: true }).click();
        await expect(joined).toBeHidden();
        await expect(page.getByRole('gridcell', { name: /^Line \d+$/ }).first()).toBeVisible();
      });
      const salesId = new URL(page.url()).pathname.split('/')[2]!;
      const joinedSchema = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
      const gridId = joinedSchema.views.find((view) => view.tableId === salesId)!.id;
      const salesFields = new Map(
        joinedSchema.fields
          .filter((field) => field.tableId === salesId)
          .map((field) => [field.name, field.id]),
      );
      const seen = new Set<string>();
      for (let offset = 0; offset < size * 2; offset += 200) {
        const sales = await asOwner<{
          total: number;
          rows: Array<{ id: string; values: Record<string, unknown> }>;
        }>(page, 'GET', `/api/views/${gridId}/rows?offset=${offset}&limit=200`);
        expect(sales.total).toBe(size * 2);
        expect(sales.rows).toHaveLength(200);
        const actualRows: unknown[][] = [];
        const expectedRows: unknown[][] = [];
        for (const row of sales.rows) {
          seen.add(row.id);
          const value = (name: string) => row.values[salesFields.get(name)!];
          const line = Number(String(value('Order lines label')).split(' ')[1]);
          const customer = ((line - 1) % size) + 1;
          actualRows.push([
            value('Customers name'),
            value('Customers region'),
            value('Orders status'),
            value('Products name'),
            value('Products price'),
            value('Order lines quantity'),
          ]);
          expectedRows.push([
            customer === 1 ? '東京 🌊 مرحبا' : `Customer ${customer}`,
            customer % 2 ? 'East' : 'West',
            customer % 2 ? 'Pending' : 'Shipped',
            `Product ${customer}`,
            Number((((customer % 97) + 1) / 3).toFixed(2)),
            (line % 5) + 1,
          ]);
        }
        expect(actualRows).toEqual(expectedRows);
      }
      expect(seen.size).toBe(size * 2);
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      const filter = page.getByRole('dialog', { name: /^Filter/ });
      await filter.getByRole('button', { name: 'Add condition', exact: true }).click();
      await filter.getByRole('button', { name: /Field$/ }).click();
      await page.getByRole('option', { name: labelName('Orders status'), exact: true }).click();
      await filter.getByRole('textbox', { name: 'Value', exact: true }).fill('Pending');
      await filter.press('Escape');
      await page.getByRole('button', { name: 'Group', exact: true }).click();
      const group = page.getByRole('dialog', { name: /^Group/ });
      await group.getByRole('button', { name: 'Add group', exact: true }).click();
      await page.getByRole('menuitem', { name: labelName('Customers region'), exact: true }).click();
      await group.press('Escape');
      await expect(page.getByRole('treegrid')).toBeVisible();
      await page.reload();
      await expect(page.getByRole('treegrid')).toBeVisible();
      await helpTopic(page, 'Finding links', 'Finding links between tables');
      const viewURLs: string[] = [];
      for (const [name, selector] of [
        ['Chart', '.rio-chart-view'],
        ['Pivot table', '.rio-pivot'],
        ['Calendar', '.rio-calendar-view'],
      ] as const) {
        const started = Date.now();
        await page.getByRole('button', { name: 'Add view', exact: true }).click();
        await page.getByRole('menuitem', { name: labelName(name), exact: true }).click();
        await expect(page.locator(selector!).first()).toBeVisible();
        if (name === 'Chart') {
          await page.getByRole('button', { name: /^Group by/ }).click();
          const picker = page.getByRole('dialog', { name: 'Group by', exact: true });
          await picker.getByRole('button', { name: /Group by$/ }).click();
          await page.getByRole('option', { name: labelName('Customers region'), exact: true }).click();
          await picker.press('Escape');
          await page.getByRole('button', { name: 'Show as table', exact: true }).click();
          await expect(page.locator('.rio-chart-view').getByRole('table')).toContainText('East');
        } else if (name === 'Pivot table') {
          await page.getByRole('button', { name: /^Rows:/ }).click();
          const picker = page.getByRole('dialog', { name: 'Rows', exact: true });
          await picker.getByRole('button', { name: /Row field 1$/ }).click();
          await page.getByRole('option', { name: labelName('Customers region'), exact: true }).click();
          await picker.press('Escape');
          await expect(page.locator('.rio-pivot').getByRole('table')).toContainText('East');
        } else {
          await page.getByRole('button', { name: 'Calendar settings', exact: true }).click();
          const picker = page.getByRole('dialog', { name: 'Calendar settings', exact: true });
          await picker
            .getByRole('combobox', { name: /^Start date/ })
            .selectOption({ label: 'Orders placed_on' });
          await picker.press('Escape');
          await expect(page.locator('.rio-calendar-view__event').first()).toBeVisible();
        }
        viewURLs.push(page.url());
        await page.reload();
        await expect(page.locator(selector!).first()).toBeVisible();
        timings.push({ step: `Create, configure, and reload ${name}`, ms: Date.now() - started });
      }
      await page.goBack();
      await expect(page).toHaveURL(viewURLs[1]!);
      await page.goForward();
      await expect(page).toHaveURL(viewURLs[2]!);
      await page.getByRole('button', { name: 'Add a dashboard', exact: true }).click();
      await page.getByRole('button', { name: 'Add a tile', exact: true }).click();
      const tileEditor = page.getByRole('dialog', { name: 'Add a tile', exact: true });
      await tileEditor.getByRole('radio', { name: 'Chart', exact: true }).click();
      await tileEditor.getByRole('textbox', { name: 'Title', exact: true }).fill('Sales by region');
      await tileEditor.getByRole('button', { name: /Table$/ }).click();
      await page.getByRole('option', { name: labelName('Sales'), exact: true }).click();
      await tileEditor.getByRole('button', { name: /View$/ }).click();
      await page.getByRole('option', { name: labelName('Chart'), exact: true }).click();
      await tileEditor.getByRole('button', { name: /Group by$/ }).click();
      await page.getByRole('option', { name: labelName('Customers region'), exact: true }).click();
      await tileEditor.getByRole('button', { name: 'Save tile', exact: true }).click();
      const tile = page.getByRole('article', { name: 'Sales by region', exact: true });
      await tile.getByRole('button', { name: 'Show as table', exact: true }).click();
      await tile
        .getByRole('button', { name: `East, ${new Intl.NumberFormat('en-US').format(size)}`, exact: true })
        .click();
      const drill = page.getByRole('dialog', {
        name: `Customers region is East, ${new Intl.NumberFormat('en-US').format(size)} records`,
      });
      await expect(drill.getByRole('link', { name: /^Line \d+$/ }).first()).toBeVisible();
      await page.reload();
      await expect(drill).toBeVisible();
      await drill.press('Escape');
      await page.getByRole('button', { name: 'Add a tile', exact: true }).click();
      const pivotEditor = page.getByRole('dialog', { name: 'Add a tile', exact: true });
      await pivotEditor.getByRole('radio', { name: 'Pivot', exact: true }).click();
      await pivotEditor.getByRole('textbox', { name: 'Title', exact: true }).fill('Regional pivot');
      await pivotEditor.getByRole('button', { name: /Table$/ }).click();
      await page.getByRole('option', { name: labelName('Sales'), exact: true }).click();
      await pivotEditor.getByRole('button', { name: /View$/ }).click();
      await page.getByRole('option', { name: labelName('Pivot table'), exact: true }).click();
      await pivotEditor.getByRole('button', { name: /Row field 1$/ }).click();
      await page.getByRole('option', { name: labelName('Customers region'), exact: true }).click();
      await pivotEditor.getByRole('button', { name: 'Save tile', exact: true }).click();
      await expect(page.getByRole('article', { name: 'Regional pivot', exact: true })).toContainText('East');
      await helpTopic(page, 'Summarizing records', 'Summarizing records on a dashboard');
      await page.getByRole('link', { name: 'Sales', exact: true }).click();
      await page.getByRole('link', { name: 'Grid', exact: true }).click();
      for (const name of ['Download CSV', 'Download Excel']) {
        const started = Date.now();
        await page.getByRole('button', { name: 'More for Grid', exact: true }).click();
        const [file] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('menuitem', { name: labelName(name), exact: true }).click(),
        ]);
        const bytes = await readFile((await file.path())!);
        timings.push({ step: name, ms: Date.now() - started });
        expect(bytes.length).toBeGreaterThan(1000);
        const rows = name === 'Download CSV' ? csvRows(bytes) : (await workbookRows(bytes))[0]!;
        expect(rows).toHaveLength(size + 1);
        const headers = rows[0]!.map(String);
        expect(headers).toEqual([...salesFields.keys()]);
        const exported = new Set<string>();
        const actualRows: unknown[][] = [];
        const expectedRows: unknown[][] = [];
        for (const row of rows.slice(1)) {
          const value = (field: string) => row[headers.indexOf(field)];
          const label = String(value('Order lines label'));
          const line = Number(label.split(' ')[1]);
          const customer = ((line - 1) % size) + 1;
          exported.add(label);
          actualRows.push([
            value('Orders status'),
            value('Customers region'),
            value('Customers name'),
            value('Products name'),
            Number(value('Products price')),
            Number(value('Order lines quantity')),
          ]);
          expectedRows.push([
            'Pending',
            'East',
            customer === 1 ? '東京 🌊 مرحبا' : `Customer ${customer}`,
            `Product ${customer}`,
            Number((((customer % 97) + 1) / 3).toFixed(2)),
            (line % 5) + 1,
          ]);
        }
        expect(actualRows).toEqual(expectedRows);
        expect(exported.size).toBe(size);
        await file.saveAs(info.outputPath(file.suggestedFilename()));
      }
      const token = await asOwner<{ id: string; token: string }>(page, 'POST', '/api/tokens', {
        name: 'Demo exports',
        scopes: ['data.records:read'],
        databases: [database.id],
      });
      try {
        const response = await page.request.get(
          `${base()}/api/v1/tables/${salesId}/records?pageSize=2&shape=list`,
          {
            headers: { authorization: `Bearer ${token.token}` },
          },
        );
        expect(response.ok()).toBe(true);
        expect(((await response.json()) as { records: unknown[] }).records).toHaveLength(2);
      } finally {
        await asOwner(page, 'DELETE', `/api/tokens/${token.id}`);
      }
      await runCommands(page, database.id, [
        { kind: 'view.update', viewId: gridId, config: { filter: null, groups: [] } },
      ]);
      const requests: Array<{
        messages: Array<{ role: string; content?: string }>;
        tools?: Array<{ function: { name: string; parameters: unknown } }>;
      }> = [];
      const viewId = newId('viw');
      const dashboardId = `dsh${newId('rec').slice(3)}`;
      const proposal = {
        databaseId: database.id,
        summary: 'Create a sales review',
        steps: ['Create a review view and a sales dashboard'],
        commands: [
          {
            kind: 'dashboard.create',
            dashboard: {
              id: dashboardId,
              name: 'Sales draft',
              config: {
                tiles: [
                  {
                    id: 'salesCount01',
                    kind: 'number',
                    title: 'Sales line count',
                    source: { tableId: salesId },
                    value: { fn: 'count' },
                    place: { x: 0, y: 0, w: 4, h: 2 },
                  },
                ],
              },
            },
          },
          { kind: 'view.create', view: { id: viewId, tableId: salesId, name: 'Sales review', type: 'grid' } },
        ],
      };
      const endpoint = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          if (request.method === 'GET') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
            return;
          }
          const prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof requests)[number];
          requests.push(prompt);
          const last = prompt.messages.findLastIndex((message) => message.role === 'user');
          const replies = prompt.messages.slice(last + 1).filter((message) => message.role === 'tool');
          const insights = prompt.messages[last]!.content!.includes('insights');
          const call = insights
            ? replies.length === 0
              ? { name: 'get_schema', arguments: { databaseId: database.id } }
              : replies.length === 1
                ? { name: 'count_records', arguments: { tableId: salesId } }
                : replies.length === 2
                  ? {
                      name: 'query_records',
                      arguments: {
                        tableId: salesId,
                        fields: ['Order lines label', 'Customers name', 'Products price'],
                        where: [{ field: 'Order lines label', operator: 'is', value: 'Line 1' }],
                        limit: 2,
                      },
                    }
                  : null
            : replies.length === 0
              ? { name: 'propose_changes', arguments: proposal }
              : null;
          const delta = call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: randomUUID(),
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              }
            : {
                content: insights
                  ? `There are ${size * 2} sales lines across ${size} customers.`
                  : 'Review the proposed sales view and dashboard.',
              };
          response.setHeader('content-type', 'text/event-stream');
          response.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      await new Promise<void>((resolve) => endpoint.listen(0, resolve));
      try {
        const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
          page,
          'GET',
          '/api/ai/settings',
        );
        const providerId = settings.providers.find((provider) => provider.local)!.providerId;
        await asOwner(page, 'PUT', '/api/ai/settings', {
          enabled: true,
          providers: [
            {
              providerId,
              baseUrl: `http://${new URL(base()).hostname}:${(endpoint.address() as AddressInfo).port}/v1`,
            },
          ],
          models: { everyday: { providerId, model: 'fixture' }, power: null },
          autonomy: 'ask',
          monthlyBudgetUsd: null,
        });
        await page.reload();
        await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
        const panel = page.locator('.rio-assistant__panel');
        const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
        const insightsStarted = Date.now();
        await input.fill('Give me insights about these sales');
        await input.press('Enter');
        await expect(
          panel.getByText(`There are ${size * 2} sales lines across ${size} customers.`, { exact: true }),
        ).toBeVisible();
        timings.push({ step: 'Ask for data insights', ms: Date.now() - insightsStarted });
        const received = requests.at(-1)!;
        expect(received.tools!.map((tool) => tool.function.name)).toEqual(
          expect.arrayContaining(['get_schema', 'count_records', 'query_records', 'propose_changes']),
        );
        const toolData = received.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.content)
          .join('\n');
        expect(toolData).toContain('Orders placed_on');
        expect(toolData).toContain('Customers region');
        expect(toolData).toContain(String(size * 2));
        expect(toolData).toContain('東京 🌊 مرحبا');
        await input.fill('Create a sales view and dashboard');
        await input.press('Enter');
        await expect(
          panel.locator('.rio-assistant__block').filter({ hasText: 'Create a sales review' }),
        ).toContainText('Create a review view and a sales dashboard');
        await panel.getByRole('link', { name: 'Preview', exact: true }).click();
        const preview = page.getByRole('dialog', { name: 'Preview', exact: true });
        const proposedChanges = preview.getByRole('navigation', { name: 'Proposed changes', exact: true });
        await expect(
          proposedChanges.getByRole('button', { name: 'Sales review', exact: true }),
        ).toBeVisible();
        await expect(preview.getByRole('heading', { name: 'Sales draft', exact: true })).toBeVisible();
        await expect(
          preview.getByText(new Intl.NumberFormat('en-US').format(size * 2), { exact: true }),
        ).toBeVisible();
        const before = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
        expect(before.dashboards.some((dashboard) => dashboard.id === dashboardId)).toBe(false);
        await preview.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(preview).toBeHidden();
        const receipt = panel.locator('.rio-assistant__block').filter({ hasText: 'Create a sales review' });
        await receipt.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(receipt.getByRole('status')).toHaveText('Undone');
        const after = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
        expect(after.dashboards.some((dashboard) => dashboard.id === dashboardId)).toBe(false);
        expect(after.views.some((view) => view.id === viewId)).toBe(false);
        await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
      } finally {
        await attachJson(info, 'model-requests', requests);
        endpoint.closeAllConnections();
        await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      }
      await page.screenshot({ path: info.outputPath('commerce-sales.png') });
      await page.getByRole('button', { name: /: Personal menu$/ }).click();
      await page.getByRole('menuitem', { name: labelName('Help'), exact: true }).click();
      const help = page.locator('.rio-docs-panel');
      await help.getByRole('button', { name: 'All topics', exact: true }).click();
      await help.getByRole('searchbox', { name: 'Search help', exact: true }).fill('Syncing a table');
      await help.getByRole('link', { name: 'Syncing a table from a data source', exact: true }).click();
      await expect(help).toContainText('500');
      await expect(help).toContainText('Select by type');
      await expect(help).toContainText('first sync is queued');
      await help.getByRole('button', { name: 'Show me', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Demo', exact: true })).toBeVisible();
      await expect(page.locator('.rio-demo-highlight')).toBeVisible();
      await expect(page.locator('[role="status"]', { hasText: 'The demo is over' })).toHaveCount(1, {
        timeout: 150_000,
      });
      await help.getByRole('button', { name: 'Close help', exact: true }).click();
    } finally {
      await attachJson(info, 'demo-timings', timings);
      await attachJson(info, 'slow-api-requests', slowRequests);
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}

async function sourceFields(page: Page, source: string, object: string) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Sync from a data source'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync from a data source' });
  await dialog.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: labelName(source), exact: true }).click();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Search tables and views' }).fill(object);
  await dialog.getByRole('option', { name: labelName(object), exact: true }).click();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'Key columns' })).toBeVisible();
  return dialog;
}

test('creates distinct joined columns with long matching prefixes on a phone', async ({ page }) => {
  await signIn(page);
  const prefix = 'x'.repeat(249);
  const first = prefix + 'a';
  const second = prefix + 'b';
  const database = await createDatabase(page, 'Long joined columns', [
    {
      name: 'Sources',
      fields: [
        { name: first, type: 'text' },
        { name: second, type: 'number' },
      ],
      records: [{ [first]: '東京 🌊 مرحبا', [second]: 42 }],
    },
    { name: 'Keys', fields: [{ name: 'Key', type: 'number' }], records: [{ Key: 42 }] },
  ]);
  await openTable(page, database, 'Sources');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create joined table', exact: true });
  await dialog.getByRole('button', { name: /Next table$/ }).click();
  await page.getByRole('option', { name: labelName('Keys'), exact: true }).click();
  await dialog.getByRole('button', { name: /Key from an earlier table$/ }).click();
  await page.getByRole('option', { name: labelName(`Sources ${second}`), exact: true }).click();
  await dialog.getByRole('button', { name: /Key from the next table$/ }).click();
  await page.getByRole('option', { name: labelName('Key'), exact: true }).click();
  const included = dialog.getByRole('group', { name: 'Fields to include', exact: true });
  await included.getByText(`Sources ${first}`, { exact: true }).click();
  await included.getByText(`Sources ${second}`, { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Table name' }).fill('Long joined');
  await dialog.getByRole('button', { name: 'Create joined table', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: '東京 🌊 مرحبا', exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/')[2]!;
  const metadata = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
  const names = metadata.fields.filter((field) => field.tableId === id).map((field) => field.name);
  expect(names).toHaveLength(2);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(2);
  expect(names.every((name) => name.length === 255)).toBe(true);
  await page.reload();
  await expect(page.getByRole('gridcell', { name: '東京 🌊 مرحبا', exact: true })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`creates, syncs, scrolls, and joins a 300-column source at ${width} pixels`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const schema = `qa_demo_${randomBytes(8).toString('hex')}`;
    const columns = Array.from({ length: 297 }, (_, index) => {
      const number = index + 3;
      return `metric_${number} ${number % 2 ? 'text' : 'numeric'}`;
    });
    const values = Array.from({ length: 297 }, (_, index) => {
      const number = index + 3;
      return number % 2 ? `'value-${number}-' || id` : `id * ${number}`;
    });
    await sql(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".wide (id integer PRIMARY KEY, customer_id integer, name text, ${columns.join(', ')});
      INSERT INTO "${schema}".wide SELECT id, id, '海鳥 🚢 مرحبا ' || id, ${values.join(', ')} FROM generate_series(1001, 1064) id;
      CREATE TABLE "${schema}".customers (cust_no text PRIMARY KEY, city text);
      INSERT INTO "${schema}".customers SELECT id::text, 'Boston ' || id FROM generate_series(1001, 1064) id;`);
    try {
      await signIn(page);
      const source = `Wide demo source ${width} ${randomBytes(4).toString('hex')}`;
      await connectSource(page, source);
      const database = await createDatabase(page, `Wide warehouse ${width}`, [
        { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
      ]);
      await openTable(page, database, 'Notes');
      const dialog = await sourceFields(page, source, 'wide');
      await expect(dialog.getByRole('status')).toHaveText('300 of 300 fields selected');
      await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      const search = dialog.getByRole('searchbox', { name: 'Search fields', exact: true });
      await search.fill('METRIC_299');
      await search.press('Enter');
      await expect(dialog.getByRole('heading', { name: 'Choose fields' })).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: 'Include metric_299', exact: true })).toBeChecked();
      await dialog.getByRole('button', { name: 'Select none', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('0 of 300 fields selected');
      await dialog.getByRole('button', { name: /Select by type/ }).click();
      await page.getByRole('option', { name: labelName('Number'), exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('150 of 300 fields selected');
      await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('300 of 300 fields selected');
      const primary = dialog.getByRole('button', { name: /Primary field/ });
      await primary.click();
      await page.getByRole('option', { name: labelName('metric_299'), exact: true }).click();
      await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
      await expect(primary).toHaveText('metric_299');
      await dialog.getByRole('button', { name: /Select by type/ }).click();
      await page.getByRole('option', { name: labelName('Text'), exact: true }).click();
      await expect(primary).toHaveText('metric_299');
      await expect(dialog.getByRole('status')).toHaveText('150 of 300 fields selected');
      await dialog.getByRole('button', { name: /Select by type/ }).click();
      await page.getByRole('option', { name: labelName('Number'), exact: true }).click();
      await expect(primary).toHaveText('id');
      await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('300 of 300 fields selected');
      await expect(primary).toHaveText('name');
      const keyList = dialog.getByRole('region', { name: 'Key columns', exact: true });
      await keyList.focus();
      await keyList.press('ArrowDown');
      expect(await keyList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await dialog.getByRole('button', { name: /Primary field/ }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button', { name: /Primary field/ })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await dialog.screenshot({ path: info.outputPath('wide-fields.png') });
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await dialog.getByRole('textbox', { name: 'Table name' }).fill('Wide');
      await dialog.getByRole('button', { name: /Every hour Sync/ }).click();
      await page.getByRole('option', { name: labelName('Only when asked'), exact: true }).click();
      await dialog.getByRole('button', { name: 'Create synced table', exact: true }).click();
      await expect(dialog).toBeHidden();
      const grid = page.getByRole('grid', { name: 'Grid', exact: true });
      await expect(grid.getByRole('gridcell', { name: '海鳥 🚢 مرحبا 1001', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      const wideId = new URL(page.url()).pathname.split('/')[2]!;
      await expect(
        page.getByText('What you can see or change in this database changed, so it was reloaded.', {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(grid.locator('.rio-grid-summary__value').first()).toHaveText('64 records');
      const metadata = await asOwner<{ fields: Array<{ tableId: string }> }>(
        page,
        'GET',
        `/api/databases/${database.id}/schema`,
      );
      expect(metadata.fields.filter((field) => field.tableId === wideId)).toHaveLength(300);
      await grid.locator('.rio-grid__scroller').evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(grid.getByRole('columnheader', { name: /metric_299/ })).toBeVisible();
      await expect(grid.getByRole('gridcell', { name: 'value-299-1001', exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('wide-grid.png') });
      await page.reload();
      const customers = await sourceFields(page, source, 'customers');
      await customers.getByRole('button', { name: 'Next', exact: true }).click();
      await customers.getByRole('textbox', { name: 'Table name' }).fill('Customers');
      await customers.getByRole('button', { name: 'Create synced table', exact: true }).click();
      await expect(customers).toBeHidden();
      await expect(grid.getByRole('gridcell', { name: 'Boston 1001', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      if (
        (await page.getByRole('button', { name: 'Menu', exact: true }).isVisible()) &&
        !(await page.getByRole('dialog', { name: 'Menu', exact: true }).isVisible())
      )
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('link', { name: 'Wide', exact: true }).click();
      await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
      const joined = page.getByRole('dialog', { name: 'Create joined table', exact: true });
      await joined
        .getByRole('button', { name: 'Match customer_id with cust_no in Customers', exact: true })
        .click();
      await joined.getByRole('textbox', { name: 'Table name' }).fill('Wide joined');
      const included = joined.getByRole('group', { name: 'Fields to include', exact: true });
      await included.getByText('Wide name', { exact: true }).click();
      await included.getByText('Wide metric_299', { exact: true }).click();
      await included.getByText('Customers city', { exact: true }).click();
      await joined.getByRole('button', { name: 'Create joined table', exact: true }).click();
      await expect(joined).toBeHidden();
      await grid.locator('.rio-grid__scroller').evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(grid.getByRole('gridcell', { name: /^Boston 10\d{2}$/ }).first()).toBeVisible();
      const joinedId = new URL(page.url()).pathname.split('/')[2]!;
      const joinedSchema = await asOwner<DemoSchema>(page, 'GET', `/api/databases/${database.id}/schema`);
      const joinedFields = joinedSchema.fields.filter((field) => field.tableId === joinedId);
      const joinedView = joinedSchema.views.find((view) => view.tableId === joinedId)!;
      const copied = await asOwner<{ total: number; rows: Array<{ values: Record<string, string> }> }>(
        page,
        'GET',
        `/api/views/${joinedView.id}/rows?limit=100`,
      );
      expect(copied.total).toBe(64);
      for (const row of copied.rows) {
        const value = (name: string) => row.values[joinedFields.find((field) => field.name === name)!.id];
        const key = value('Wide name')!.split(' ').at(-1)!;
        expect(value('Wide metric_299')).toBe(`value-299-${key}`);
        expect(value('Customers city')).toBe(`Boston ${key}`);
      }
      await page.reload();
      await grid.locator('.rio-grid__scroller').evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(grid.getByRole('gridcell', { name: /^Boston 10\d{2}$/ }).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath('wide-joined.png') });
    } finally {
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}

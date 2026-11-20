import { expect, test, type Page } from '../accessibility';
import { CHART_TYPES, LIMITS, type Block, type InterfaceMeta } from '../../../packages/contracts/src/index';
import { base } from '../base';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  openTable,
  runCommands,
  signIn,
  visit,
} from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', actionTimeout: 15_000 });

async function seed(page: Page) {
  await signIn(page);
  const database = await createDatabase(page, 'Dashboard and interface checks', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Status', type: 'singleSelect', choices: ['Open', 'Done'] },
        { name: 'Date', type: 'date' },
      ],
      records: [
        { Name: '東京 🌊', Amount: 12, Status: 'Open', Date: '2026-01-03' },
        { Name: 'مرحبا', Amount: 8, Status: 'Done', Date: '2026-02-03' },
      ],
    },
  ]);
  return { database, table: database.tables.Tasks! };
}

async function interfaceSchema(page: Page, databaseId: string, id: string) {
  const schema = await asOwner<{ interfaces: InterfaceMeta[] }>(
    page,
    'GET',
    `/api/databases/${databaseId}/schema`,
  );
  return schema.interfaces.find((value) => value.id === id)!;
}

test('duplicating a page with a maximum-length Unicode name saves and survives reload', async ({ page }) => {
  const { database } = await seed(page);
  const id = `itf${newId('rec').slice(3)}`;
  const name = '界'.repeat(LIMITS.nameLength);
  await runCommands(page, database.id, [
    {
      kind: 'interface.create',
      interface: { id, name: 'Long pages', pages: [{ id: 'pageMain01', name, blocks: [] }] },
    },
  ]);
  await visit(page, `${base()}/${database.id}/interfaces/${id}/pageMain01`);
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  await page.getByRole('button', { name: `More for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Duplicate page'), exact: true }).click();
  await expect.poll(async () => (await interfaceSchema(page, database.id, id)).pages.length).toBe(2);
  const copy = (await interfaceSchema(page, database.id, id)).pages[1]!;
  expect(copy.id).not.toBe('pageMain01');
  expect(copy.name.length).toBeLessThanOrEqual(LIMITS.nameLength);
  expect(copy.name).toMatch(/ copy$/);
  await visit(page, `${base()}/${database.id}/interfaces/${id}/${copy.id}`);
  await expect(
    page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: copy.name, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('every dashboard chart type can be added, drilled into, moved, resized, duplicated, and deleted', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { database } = await seed(page);
  await openTable(page, database, 'Tasks');
  await page.getByRole('button', { name: 'Add a dashboard' }).click();
  for (const chart of CHART_TYPES) {
    await page.getByRole('button', { name: 'Add a tile', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add a tile', exact: true });
    await editor.getByRole('radio', { name: 'Chart', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(chart);
    await editor.getByRole('button', { name: /Chart type$/ }).click();
    await page
      .getByRole('option', {
        name: chart === 'scatter' ? 'Scatter' : chart[0]!.toUpperCase() + chart.slice(1),
        exact: true,
      })
      .click();
    await editor.getByRole('button', { name: 'Save tile', exact: true }).click();
    const tile = page.getByRole('article', { name: chart, exact: true });
    await expect(tile.locator('canvas')).toBeVisible();
    await tile.getByRole('button', { name: 'Show as table' }).click();
    await tile.getByRole('button', { name: 'Open, 1', exact: true }).click();
    const drill = page.getByRole('dialog', { name: 'Status is Open, 1 record' });
    await expect(drill.getByRole('link', { name: '東京 🌊', exact: true })).toBeVisible();
    await drill.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
    const handle = tile.getByRole('button', { name: `Move or resize ${chart}`, exact: true });
    await handle.press('ArrowDown');
    await handle.press('Shift+ArrowDown');
    await expect(tile).toHaveAttribute('style', /--rio-dashboard-h: 5/);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await tile.getByRole('button', { name: `More for ${chart}`, exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Duplicate'), exact: true }).click();
    await expect(page.getByRole('article', { name: chart, exact: true })).toHaveCount(2);
    for (let remaining = 2; remaining > 0; remaining--) {
      await page
        .getByRole('article', { name: chart, exact: true })
        .last()
        .getByRole('button', { name: `More for ${chart}`, exact: true })
        .click();
      await page.getByRole('menuitem', { name: labelName('Delete'), exact: true }).click();
      await expect(page.getByRole('article', { name: chart, exact: true })).toHaveCount(remaining - 1);
    }
  }
});

test('number, list, and note tiles save, duplicate, delete, undo, and redo', async ({ page }) => {
  test.setTimeout(120_000);
  const { database } = await seed(page);
  await openTable(page, database, 'Tasks');
  await page.getByRole('button', { name: 'Add a dashboard' }).click();
  for (const kind of ['Number', 'Records', 'Note']) {
    await page.getByRole('button', { name: 'Add a tile', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add a tile', exact: true });
    await editor.getByRole('radio', { name: kind, exact: true }).click();
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(kind);
    if (kind === 'Note')
      await editor.getByRole('textbox', { name: 'Note', exact: true }).fill('東京 🌊 مرحبا');
    await editor.getByRole('button', { name: 'Save tile', exact: true }).click();
    const tile = page.getByRole('article', { name: kind, exact: true });
    await expect(tile).toBeVisible();
    if (kind === 'Number') await expect(tile.getByText('2', { exact: true })).toBeVisible();
    if (kind === 'Records') {
      await tile.getByRole('link', { name: '東京 🌊', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await tile.getByRole('button', { name: `More for ${kind}`, exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Duplicate'), exact: true }).click();
    await expect(page.getByRole('article', { name: kind, exact: true })).toHaveCount(2);
    await page
      .getByRole('article', { name: kind, exact: true })
      .last()
      .getByRole('button', { name: `More for ${kind}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: labelName('Delete'), exact: true }).click();
    await page.getByRole('button', { name: 'Edit layout', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByRole('article', { name: kind, exact: true })).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByRole('article', { name: kind, exact: true })).toHaveCount(1);
  }
  await visit(page, page.url());
  await expect(page.getByRole('article')).toHaveCount(3);
});

test.describe('touch dashboard', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('moving between three tiles from one desktop row preserves the phone order', async ({ page }) => {
    const { database } = await seed(page);
    const id = `dsh${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'dashboard.create',
        dashboard: {
          id,
          name: 'Three tiles',
          config: {
            tiles: ['First', 'Second', 'Third'].map((title, index) => ({
              id: `note000${index}`,
              kind: 'text',
              title,
              place: { x: index * 4, y: 0, w: 4, h: 2 },
              text: title,
            })),
          },
        },
      },
    ]);
    const href = `${base()}/${database.id}/dashboards/${id}`;
    await visit(page, href);
    await page.getByRole('button', { name: 'Edit layout', exact: true }).tap();
    const handle = page.getByRole('button', { name: 'Move or resize First', exact: true });
    const titles = () =>
      page
        .getByRole('article')
        .evaluateAll((tiles) => tiles.map((tile) => tile.querySelector('h3')?.textContent));
    await handle.press('ArrowDown');
    await expect.poll(titles).toEqual(['Second', 'First', 'Third']);
    await handle.press('ArrowUp');
    await expect.poll(titles).toEqual(['First', 'Second', 'Third']);
    const surface = page
      .getByRole('article', { name: 'First', exact: true })
      .locator('.rio-dashboard-tile__header');
    const origin = (await surface.boundingBox())!;
    const destination = (await page.getByRole('article', { name: 'Second', exact: true }).boundingBox())!;
    const pointer = {
      button: 0,
      pointerId: 23,
      pointerType: 'touch',
      isPrimary: true,
      clientX: origin.x + origin.width / 2,
      clientY: origin.y + origin.height / 2,
    };
    await surface.dispatchEvent('pointerdown', pointer);
    await page.waitForTimeout(250);
    const target = { ...pointer, clientY: destination.y + destination.height / 2 };
    await page.dispatchEvent('body', 'pointermove', target);
    await page.dispatchEvent('body', 'pointerup', target);
    await expect.poll(titles).toEqual(['Second', 'First', 'Third']);
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    await visit(page, href);
    await expect.poll(titles).toEqual(['Second', 'First', 'Third']);
  });

  test('date filters, error retry, record taps, sharing, and live updates', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const { database, table } = await seed(page);
    const id = `dsh${newId('rec').slice(3)}`;
    const source = {
      tableId: table.id,
      viewId: table.viewId,
      filter: {
        conjunction: 'and',
        conditions: [
          {
            id: 'after',
            fieldId: table.fields.Date,
            operator: 'isOnOrAfter',
            value: { mode: 'exactDate', date: '2026-02-01' },
          },
        ],
      },
    };
    await runCommands(page, database.id, [
      {
        kind: 'dashboard.create',
        dashboard: {
          id,
          name: 'Shared dashboard',
          config: {
            tiles: [
              {
                id: 'total001',
                kind: 'number',
                title: 'February amount',
                place: { x: 0, y: 0, w: 3, h: 2 },
                source,
                value: { fn: 'sum', fieldId: table.fields.Amount },
              },
              {
                id: 'list0001',
                kind: 'records',
                title: 'February tasks',
                place: { x: 3, y: 0, w: 6, h: 4 },
                source,
                fieldIds: [table.fields.Amount],
                limit: 10,
              },
            ],
          },
        },
      },
    ]);
    let fail = true;
    await page.route(`**/api/dashboards/${id}/data`, async (route) => {
      if (fail)
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', messageKey: 'errors.internal' } }),
        });
      else await route.continue();
    });
    const href = `${base()}/${database.id}/dashboards/${id}`;
    await visit(page, href);
    const total = page.getByRole('article', { name: 'February amount', exact: true });
    await expect(total.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    fail = false;
    await total.getByRole('button', { name: 'Try again', exact: true }).tap();
    await expect(total.getByText('8', { exact: true })).toBeVisible();
    const list = page.getByRole('article', { name: 'February tasks', exact: true });
    await list.getByRole('button', { name: 'Try again', exact: true }).tap();
    await expect(list.getByRole('link', { name: '東京 🌊', exact: true })).toBeHidden();
    await list.getByRole('link', { name: 'مرحبا', exact: true }).tap();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit layout', exact: true }).tap();
    const origin = (await total.boundingBox())!;
    const destination = (await list.boundingBox())!;
    const pointer = {
      button: 0,
      pointerId: 17,
      pointerType: 'touch',
      isPrimary: true,
      clientX: origin.x + origin.width / 2,
      clientY: origin.y + origin.height / 2,
    };
    await total.dispatchEvent('pointerdown', pointer);
    await page.waitForTimeout(250);
    await page.dispatchEvent('body', 'pointermove', {
      ...pointer,
      clientY: destination.y + destination.height / 2,
    });
    await page.dispatchEvent('body', 'pointerup', {
      ...pointer,
      clientY: destination.y + destination.height / 2,
    });
    await expect(page.getByRole('article').first()).toHaveAccessibleName('February tasks');
    await total.getByRole('button', { name: 'Move or resize February amount', exact: true }).press('ArrowUp');
    await expect(page.getByRole('article').first()).toHaveAccessibleName('February amount');
    await total
      .getByRole('button', { name: 'Move or resize February amount', exact: true })
      .press('ArrowDown');
    await expect(page.getByRole('article').first()).toHaveAccessibleName('February tasks');
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    const person = await invite(page, browser, 'Shared Dashboard Guest', 'guest');
    try {
      const session = await person.page.request.get(`${base()}/api/auth/session`);
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const hidden = await person.page.request.post(`${base()}/api/dashboards/${id}/data`, {
        headers: { 'x-csrf-token': csrfToken },
        data: { timeZone: 'UTC' },
      });
      expect(hidden.status()).toBe(404);
      await share(page, database.id, person, 'reader');
      await visit(person.page, href);
      await expect(person.page.getByRole('button', { name: 'Add a tile', exact: true })).toBeHidden();
      await expect(person.page.getByRole('button', { name: 'Edit layout', exact: true })).toBeHidden();
      await runCommands(page, database.id, [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: table.records[1], values: { [table.fields.Amount!]: 16 } }],
        },
      ]);
      await expect(total.getByText('16', { exact: true })).toBeVisible();
      await expect(
        person.page
          .getByRole('article', { name: 'February amount', exact: true })
          .getByText('16', { exact: true }),
      ).toBeVisible();
    } finally {
      await person.context.close();
    }
  });
});

async function seedInterface(page: Page) {
  const { database, table } = await seed(page);
  const formViewId = await createView(page, database, 'Tasks', {
    name: 'Task form',
    type: 'form',
    config: { form: { title: 'New task', questions: [{ fieldId: table.fields.Name }] } },
  });
  const id = `itf${newId('rec').slice(3)}`;
  const source = { tableId: table.id, viewId: table.viewId, filter: null };
  const blocks: Block[] = [
    {
      id: 'records01',
      kind: 'records',
      title: 'Queue',
      place: { x: 0, y: 0, w: 6, h: 5 },
      source,
      fieldIds: [table.fields.Amount!],
      display: 'list',
      showFieldNames: true,
    },
    {
      id: 'details01',
      kind: 'record',
      title: 'Details',
      place: { x: 6, y: 0, w: 6, h: 5 },
      recordsBlockId: 'records01',
      fieldIds: [table.fields.Name!],
    },
    {
      id: 'number01',
      kind: 'number',
      title: 'Total amount',
      place: { x: 0, y: 5, w: 3, h: 2 },
      source,
      value: { fn: 'sum', fieldId: table.fields.Amount! },
    },
    {
      id: 'chart01',
      kind: 'chart',
      title: 'By status',
      place: { x: 3, y: 5, w: 6, h: 4 },
      source,
      chart: 'column',
      groupBy: { fieldId: table.fields.Status!, dateBucket: null },
      value: { fn: 'count', fieldId: null },
      seriesBy: null,
      sort: 'category',
      limit: 20,
      stacked: false,
    },
    {
      id: 'search01',
      kind: 'filter',
      title: 'Find a task',
      place: { x: 9, y: 5, w: 3, h: 2 },
      control: 'search',
      tableId: table.id,
      fieldId: table.fields.Name!,
      blockIds: ['records01'],
    },
    {
      id: 'note0001',
      kind: 'text',
      title: 'Notes',
      place: { x: 0, y: 9, w: 6, h: 2 },
      style: 'paragraph',
      text: '東京 🌊 **مرحبا**',
    },
    {
      id: 'form0001',
      kind: 'button',
      title: 'Add task',
      place: { x: 6, y: 9, w: 3, h: 2 },
      label: 'New task',
      action: { kind: 'form', tableId: table.id, viewId: formViewId },
    },
    {
      id: 'link0001',
      kind: 'button',
      title: 'Reference',
      place: { x: 9, y: 9, w: 3, h: 2 },
      label: 'Documentation',
      action: { kind: 'url', url: 'https://example.test/help' },
    },
  ];
  const value = { id: 'pageMain01', name: 'Tasks', blocks };
  await runCommands(page, database.id, [
    { kind: 'interface.create', interface: { id, name: 'Desk', pages: [value] } },
  ]);
  const href = `${base()}/${database.id}/interfaces/${id}/${value.id}`;
  await visit(page, href);
  return { database, table, id, value, href };
}

test('the visual designer moves, resizes, edits, duplicates, and deletes every native block kind', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const value = await seedInterface(page);
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  for (const original of value.value.blocks) {
    const name = original.title;
    const article = page.getByRole('article', { name, exact: true });
    const handle = article.getByRole('button', { name: `Move or resize ${name}`, exact: true });
    await handle.press('ArrowDown');
    await handle.press('Shift+ArrowDown');
    await expect(article).toHaveAttribute('style', new RegExp(`--rio-interface-h: ${original.place.h + 1}`));
    await article.getByRole('button', { name: `More for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Edit'), exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit block', exact: true });
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(`${name} updated`);
    if (original.kind === 'records') await editor.getByRole('radio', { name: 'Table', exact: true }).click();
    await editor.getByRole('button', { name: 'Save block', exact: true }).click();
    const updated = page.getByRole('article', { name: `${name} updated`, exact: true });
    await updated.getByRole('button', { name: `More for ${name} updated`, exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Duplicate'), exact: true }).click();
    await expect(updated).toHaveCount(2);
    await updated
      .last()
      .getByRole('button', { name: `More for ${name} updated`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: labelName('Delete'), exact: true }).click();
    await expect(updated).toHaveCount(1);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('grid', { name: 'Queue updated', exact: true })).toBeVisible();
  await visit(page, page.url());
  await expect(page.getByRole('article')).toHaveCount(value.value.blocks.length);
});

test('pages and every block kind can be added through the designer and removed with their page', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const value = await seedInterface(page);
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  await page.getByRole('button', { name: 'Add a page', exact: true }).click();
  await expect(page.getByText(/^This page is empty\./)).toBeVisible();
  await page.getByRole('button', { name: 'More for Page 2', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Rename'), exact: true }).click();
  const name = '新頁 🌊 مرحبا';
  const rename = page.getByRole('textbox', { name: 'Rename', exact: true });
  await rename.fill(name);
  await rename.press('Enter');
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await pages.getByRole('link', { name, exact: true }).press('Alt+ArrowLeft');
  await expect.poll(() => pages.getByRole('link').allTextContents()).toEqual([name, 'Tasks']);
  const kinds = ['Records', 'Record details', 'Number', 'Chart', 'Text', 'Filter', 'Button', 'Custom code'];
  for (const kind of kinds) {
    await page
      .getByRole('toolbar', { name: 'Desk', exact: true })
      .getByRole('button', { name: 'Add a block', exact: true })
      .click();
    const editor = page.getByRole('dialog', { name: 'Add a block', exact: true });
    await editor.getByRole('button', { name: /Type$/ }).click();
    await page.getByRole('option', { name: labelName(kind), exact: true }).click();
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill(`${kind} added`);
    if (kind === 'Filter') {
      await editor.getByRole('button', { name: /Field$/ }).click();
      await page.getByRole('option', { name: labelName('Status'), exact: true }).click();
    }
    if (kind === 'Button') {
      await editor.getByRole('textbox', { name: 'Label', exact: true }).fill('Open task form');
    }
    await editor.getByRole('button', { name: 'Save block', exact: true }).click();
    await expect(page.getByRole('article', { name: `${kind} added`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('article')).toHaveCount(kinds.length);
  await visit(page, page.url());
  await expect(page.getByRole('article')).toHaveCount(kinds.length);
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  await page.getByRole('button', { name: `More for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Delete page'), exact: true }).click();
  await page
    .getByRole('dialog', { name: `Delete ${name}?`, exact: true })
    .getByRole('button', { name: 'Delete page', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await interfaceSchema(page, value.database.id, value.id)).pages.map((item) => item.name),
    )
    .toEqual(['Tasks']);
  await expect(page.getByRole('article', { name: 'Queue', exact: true })).toBeVisible();
});

test.describe('phone interface designer', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('reorders blocks sharing a desktop row with the keyboard and touch, then reloads', async ({
    page,
  }) => {
    const value = await seedInterface(page);
    await page.getByRole('button', { name: 'Edit interface', exact: true }).tap();
    const block = page.getByRole('article', { name: 'Add task', exact: true });
    const handle = block.getByRole('button', { name: 'Move or resize Add task', exact: true });
    const order = () =>
      page
        .locator('.rio-interface-grid > article')
        .evaluateAll((articles) => articles.map((article) => article.getAttribute('aria-label')));
    await handle.press('ArrowUp');
    await expect.poll(async () => (await order()).slice(-3)).toEqual(['Add task', 'Notes', 'Reference']);
    await block.scrollIntoViewIfNeeded();
    const surface = block.locator('.rio-interface-block__shield');
    const origin = (await surface.boundingBox())!;
    const destination = (await page.getByRole('article', { name: 'Reference', exact: true }).boundingBox())!;
    const pointer = {
      button: 0,
      pointerId: 19,
      pointerType: 'touch',
      isPrimary: true,
      clientX: origin.x + origin.width / 2,
      clientY: origin.y + origin.height / 2,
    };
    await surface.dispatchEvent('pointerdown', pointer);
    await page.waitForTimeout(250);
    await page.dispatchEvent('body', 'pointermove', {
      ...pointer,
      clientY: destination.y + destination.height / 2,
    });
    await page.dispatchEvent('body', 'pointerup', {
      ...pointer,
      clientY: destination.y + destination.height / 2,
    });
    await expect.poll(async () => (await order()).slice(-3)).toEqual(['Notes', 'Reference', 'Add task']);
    await expect
      .poll(
        async () =>
          (await interfaceSchema(page, value.database.id, value.id)).pages[0]!.blocks.find(
            (item) => item.id === 'form0001',
          )?.place.y,
      )
      .toBe(15);
    await visit(page, value.href);
    await expect.poll(async () => (await order()).slice(-3)).toEqual(['Notes', 'Reference', 'Add task']);
  });
});

for (const width of [390, 1280]) {
  test(`interface record picking, filtering, forms, page duplication, and publishing at width ${width}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const value = await seedInterface(page);
    const queue = page.getByRole('article', { name: 'Queue', exact: true });
    await queue.getByRole('option', { name: /東京/ }).click();
    await expect(
      page
        .getByRole('article', { name: 'Details', exact: true })
        .getByRole('textbox', { name: 'Name', exact: true }),
    ).toHaveValue('東京 🌊');
    const search = page.getByRole('searchbox', { name: 'Find a task', exact: true });
    await search.fill('مرحبا');
    await expect(queue.getByRole('option')).toHaveCount(1);
    await expect(queue.getByRole('option')).toContainText('مرحبا');
    await search.fill('');
    await expect(queue.getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('link', { name: /Documentation/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New task', exact: true });
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Added through the interface');
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByText(/Thanks/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(queue.getByRole('option', { name: /Added through the interface/ })).toBeVisible();
    await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Pages', exact: true })
      .getByRole('button', { name: 'More for Tasks', exact: true })
      .click();
    await page.getByRole('menuitem', { name: labelName('Duplicate page'), exact: true }).click();
    await expect
      .poll(async () => (await interfaceSchema(page, value.database.id, value.id)).pages.length)
      .toBe(2);
    const copy = (await interfaceSchema(page, value.database.id, value.id)).pages[1]!;
    const records = copy.blocks.find((block) => block.kind === 'records')!;
    expect(copy.blocks.find((block) => block.kind === 'record')).toMatchObject({
      recordsBlockId: records.id,
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Publish site', exact: true }).click();
    const publisher = page.getByRole('dialog', { name: 'Publish site', exact: true });
    await publisher.getByRole('button', { name: 'Publish selected pages', exact: true }).click();
    const address = publisher.locator('a[href^="/sites/"]');
    await expect(address).toBeVisible();
    const publicContext = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width, height: 900 },
    });
    try {
      const publicPage = await publicContext.newPage();
      await visit(publicPage, `${base()}${(await address.getAttribute('href'))!}`);
      await expect(publicPage.getByText('東京 🌊', { exact: false }).first()).toBeVisible();
    } finally {
      await publicContext.close();
    }
  });
}

test('shared interfaces enforce reader permissions and keep concurrent JSON drafts safe', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const value = await seedInterface(page);
  const person = await invite(page, browser, 'Dashboard Reader');
  try {
    await share(page, value.database.id, person, 'reader');
    await visit(person.page, `${value.href}?editor=json`);
    await expect(person.page.getByRole('button', { name: 'Edit interface', exact: true })).toBeHidden();
    await expect(person.page.getByRole('textbox', { name: 'Page JSON', exact: true })).toBeHidden();
    await expect(person.page.getByRole('button', { name: 'New task', exact: true })).toBeDisabled();
    await visit(page, `${value.href}?editor=json`);
    const json = page.getByRole('textbox', { name: 'Page JSON', exact: true });
    const before = JSON.parse(await json.inputValue()) as typeof value.value;
    const draft = JSON.stringify({ ...before, name: 'Local draft' });
    await json.fill(draft);
    const denied = await asOwner<{ results: Array<{ status: string }> }>(
      person.page,
      'POST',
      `/api/databases/${value.database.id}/commands`,
      {
        clientId: newId('cli'),
        commands: [
          {
            id: newId('cmd'),
            groupId: newId('act'),
            kind: 'record.update',
            tableId: value.table.id,
            records: [{ id: value.table.records[0], values: { [value.table.fields.Amount!]: 30 } }],
          },
        ],
      },
    );
    expect(denied.results[0]?.status).toBe('rejected');
    await runCommands(page, value.database.id, [
      {
        kind: 'record.update',
        tableId: value.table.id,
        records: [{ id: value.table.records[0], values: { [value.table.fields.Amount!]: 30 } }],
      },
    ]);
    await expect(
      person.page
        .getByRole('article', { name: 'Total amount', exact: true })
        .getByText('38', { exact: true }),
    ).toBeVisible();
    await runCommands(page, value.database.id, [
      { kind: 'interface.update', interfaceId: value.id, pages: [{ ...before, name: 'Shared update' }] },
    ]);
    await expect(page.getByRole('alert').filter({ hasText: 'This page changed' })).toBeVisible();
    await expect(json).toHaveValue(draft);
    await expect(page.getByRole('button', { name: 'Save page', exact: true })).toBeDisabled();
  } finally {
    await person.context.close();
  }
});

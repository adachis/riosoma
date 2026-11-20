import { expect, test, type Locator, type Page } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { base } from '../base';
import { recordLayoutAudit } from '../tight-space-audit';
import { dragInput } from '../pointer-input';
import { releaseDrag } from '../drag-release';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
const themes = [
  { theme: 'nature', scheme: 'grove' },
  { theme: 'bauhaus', scheme: 'midnight' },
  { theme: 'brutalist', scheme: 'raw' },
];
const longName = 'PlanningReferenceMaterialAndImplementationRequirementsForTheEntireOrganization';

test('the phone add-record action stays inside a viewport shortened by the keyboard', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Short grid', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Reference' }],
    },
  ]);
  await openTable(page, database, 'Items');
  const viewport = page.locator('.rio-grid__viewport');
  const initial = (await viewport.boundingBox())!;
  const height = 844 + 57 - initial.height;
  await page.setViewportSize({ width: 390, height });
  const add = page.getByRole('button', { name: 'Add record', exact: true });
  await expect(add).toBeHidden();
  await recordLayoutAudit(page, info, 'phone-short-grid');
  await page.setViewportSize({ width: 390, height: height + 7 });
  await expect(add).toBeVisible();
  await expect(add).toBeInViewport({ ratio: 1 });
  await recordLayoutAudit(page, info, 'phone-add-record-fits');
  await page.screenshot({ path: info.outputPath('phone-add-record.png') });
});

test('note text remains selectable through browser hit testing while editing dashboard layout', async ({
  page,
}, info) => {
  await signIn(page);
  const database = await createDatabase(page, 'Selectable dashboard', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
    },
  ]);
  const id = `dsh${newId('rec').slice(3)}`;
  const text = 'Planning reference material';
  await runCommands(page, database.id, [
    {
      kind: 'dashboard.create',
      dashboard: {
        id,
        name: 'Notes',
        config: {
          tiles: [
            {
              id: 'note0001',
              kind: 'text',
              title: 'Reference',
              text,
              place: { x: 0, y: 0, w: 6, h: 3 },
            },
          ],
        },
      },
    },
  ]);
  await visit(page, `${base()}/${database.id}/dashboards/${id}`);
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  const note = page.locator('[data-sortable-selectable]').getByText(text, { exact: true });
  const box = (await note.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(text);
  await expect(page.locator('.rio-dashboard-grid__preview')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('dashboard-note-selection.png') });
});
async function dragBody(page: Page, source: Locator, target: Locator) {
  await source.hover();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2);
  await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await releaseDrag(
    target,
    (point) => page.mouse.move(point.x, point.y),
    () => page.mouse.up(),
  );
  await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
}

for (const theme of themes) {
  test(`folder rows fit the sidebar in ${theme.theme} and preserve rename, disclosure, deletion, and undo`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', theme);
    const database = await createDatabase(page, 'Tight folder rows', [
      { name: 'Items', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Items');
    const sidebar = page.getByRole('navigation', { name: 'Tables', exact: true });
    await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toHaveAttribute(
      'aria-valuenow',
      '265',
    );
    await sidebar.getByRole('button', { name: 'Add folder', exact: true }).first().click();
    const folder = sidebar.getByRole('group', { name: 'Folder 1', exact: true });
    await expect(folder.getByRole('textbox')).toHaveCount(0);
    await folder.focus();
    await folder.press('F2');
    const input = folder.getByRole('textbox', { name: 'Folder name' });
    await input.fill('Why?');
    await input.press('Enter');
    const named = sidebar.getByRole('group', { name: 'Why?', exact: true });
    await page.getByRole('grid', { name: 'Grid', exact: true }).click({ position: { x: 10, y: 60 } });
    await page.mouse.move(1000, 700);
    await page
      .locator('.rio-shell__sidebar')
      .screenshot({ path: info.outputPath(`after-${theme.theme}-265.png`) });
    await recordLayoutAudit(page, info, `${theme.theme}-sidebar-rest`, sidebar);
    await named.getByText('Why?', { exact: true }).dblclick();
    await named.getByRole('textbox', { name: 'Folder name' }).fill('Canceled name');
    await named.getByRole('textbox', { name: 'Folder name' }).press('Escape');
    await expect(named).toBeVisible();
    await named.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await named.getByRole('textbox').fill(longName);
    await recordLayoutAudit(page, info, `${theme.theme}-sidebar-editing`, sidebar);
    await named.getByRole('textbox').press('Enter');
    const renamed = sidebar.getByRole('group', { name: longName, exact: true });
    await expect(renamed.locator('.rio-folder-row__name')).toHaveAttribute('title', longName);
    await recordLayoutAudit(page, info, `${theme.theme}-sidebar-long`, sidebar);
    await dragBody(
      page,
      sidebar.getByRole('link', { name: 'Items', exact: true }),
      renamed.locator('.rio-folder-row__name'),
    );
    const container = renamed.locator('xpath=../..');
    await expect(container.getByRole('link', { name: 'Items', exact: true })).toBeVisible();
    await renamed.getByRole('button', { name: `Collapse ${longName}`, exact: true }).click();
    await expect(container.getByRole('link', { name: 'Items', exact: true })).toBeHidden();
    await renamed.getByRole('button', { name: `Expand ${longName}`, exact: true }).click();
    await renamed.getByRole('button', { name: `More for ${longName}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
    const warning = page.getByRole('dialog', { name: 'Delete folder?' });
    await expect(warning).toContainText('Nothing inside is deleted.');
    await warning.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(sidebar.locator('.rio-sidebar-folder')).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Items', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo history', exact: true }).click();
    await page
      .getByRole('listbox', { name: 'Changes to undo, newest first' })
      .getByRole('option')
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expect(sidebar.getByRole('group', { name: longName, exact: true })).toBeVisible();
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await recordLayoutAudit(page, info, `${theme.theme}-database-${width}`);
    }
  });
}

test('phone hold and keyboard moves work on Home, sidebar items, and sort rules', async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  await signIn(page);
  const databaseName = `Phone arrangement ${newId('act')}`;
  const database = await createDatabase(page, databaseName, [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
      ],
    },
    { name: 'Second table', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const folderId = newId('act');
  const parentId = newId('act');
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId: parentId, name: 'Phone checks', parentId: null },
  });
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, name: longName, parentId },
  });
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId: newId('act'), name: 'Second folder', parentId },
  });
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'database.move', databaseId: database.id, parentId, confirmedLosses: [] },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/home/folders/${parentId}`);
  const folder = page.getByRole('group', { name: longName, exact: true });
  await expect(folder).toBeVisible();
  const secondFolder = page.getByRole('group', { name: 'Second folder', exact: true });
  const homeHandle = secondFolder.locator('xpath=ancestor::*[@data-sortable-id][1]').getByRole('button', {
    name: 'Move Second folder',
    exact: true,
  });
  await homeHandle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await expect(
    page.locator('.rio-sortable-announcement').filter({ hasText: `in ${longName}` }),
  ).toContainText('Second folder');
  await expect(page.locator('.rio-sortable-refusal')).toHaveText('');
  await page.keyboard.press('Space');
  await expect(
    page.locator('.rio-sortable-announcement').filter({ hasText: 'Dropped Second folder' }),
  ).toBeAttached();
  await expect(secondFolder).toHaveCount(0);
  await page.keyboard.press('Tab');
  await recordLayoutAudit(page, info, 'phone-home');
  const card = page.getByRole('link').filter({ hasText: databaseName });
  const surface = card.locator('xpath=ancestor::*[@data-sortable-id][1]');
  await expect(surface.getByRole('button', { name: `Move ${databaseName}`, exact: true })).toBeEnabled();
  await card.scrollIntoViewIfNeeded();
  await folder.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + 20, bounds.y + 20));
      }),
    )
    .toBe(true);
  const from = await card.boundingBox();
  const to = await folder.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  const input = await dragInput(page, context, browserName, surface);
  try {
    await input.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from!.x + 20, y: from!.y + 20, id: 1 }],
    });
    await page.waitForTimeout(250);
    await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
    await input.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: to!.x + to!.width / 2, y: to!.y + to!.height / 2, id: 1 }],
    });
    await expect(
      page.locator('.rio-sortable-announcement').filter({ hasText: `in ${longName}` }),
    ).toContainText(databaseName);
    await releaseDrag(
      folder,
      (point) =>
        input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] }),
      () => input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      { event: 'touchend' },
    );
    await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => {
        const listing = await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
          page,
          'GET',
          '/api/home',
        );
        return listing.databases.find((item) => item.id === database.id)?.parentId;
      })
      .toBe(folderId);
  } finally {
    await input.detach();
  }
  await openTable(page, database, 'Items');
  const table = database.tables.Items!;
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        sorts: [
          { fieldId: table.fields.Name, direction: 'asc' },
          { fieldId: table.fields.Status, direction: 'asc' },
        ],
      },
    },
  ]);
  await page.reload();
  await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
  const sorts = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
  await recordLayoutAudit(page, info, 'phone-sorts', sorts);
  const row = sorts.locator('[data-sortable-id]').first();
  const before = await row.boundingBox();
  await row.hover();
  expect(await row.boundingBox()).toEqual(before);
  for (const direction of ['ltr', 'rtl']) {
    await sorts.evaluate((element, dir) => element.setAttribute('dir', dir), direction);
    const bounds = (await row.boundingBox())!;
    const grip = (await row.getByRole('button', { name: 'Move sort', exact: true }).boundingBox())!;
    expect(
      direction === 'ltr' ? grip.x - bounds.x : bounds.x + bounds.width - grip.x - grip.width,
    ).toBeLessThan(3);
  }
  await sorts.evaluate((element) => element.removeAttribute('dir'));
  await sorts.getByRole('button', { name: 'Move sort', exact: true }).first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(sorts.locator('.rio-sortable-announcement')).toContainText('Dropped Name, position 2');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByRole('navigation', { name: 'Tables', exact: true });
  await sidebar.getByRole('button', { name: 'Move Items', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(
    page.locator('.rio-sortable-announcement').filter({ hasText: 'Dropped Items, position 2' }),
  ).toBeAttached();
  const addFolder = sidebar.getByRole('button', { name: 'Add folder', exact: true }).first();
  await addFolder.hover();
  await expect(page.getByRole('tooltip', { name: 'Add folder', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip', { name: 'Add folder', exact: true })).toBeHidden();
});

test('filled search, rating, and date editors fit phone and laptop layouts', async ({ page }, info) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Compact editor checks', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Score', type: 'rating' },
        { name: 'Day', type: 'date' },
      ],
      records: [{ Name: longName, Score: 3, Day: '2026-10-03' }],
    },
  ]);
  const table = database.tables.Items!;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const grid = await openTable(page, database, 'Items');
    const input = page.locator('.rio-grid__input');
    await grid.locator('[data-rio-row="0"][data-rio-col="0"]').click();
    await input.press('ArrowRight');
    await input.press('Enter');
    const rating = page.locator('.rio-cell-editor');
    await expect(rating).toBeVisible();
    await recordLayoutAudit(page, info, `rating-${width}`, rating);
    await page.keyboard.press('Escape');
    await grid.getByRole('button', { name: 'Expand row 1', exact: true }).click();
    const record = page.getByRole('dialog', { name: longName, exact: true });
    await record.getByRole('button', { name: 'Choose a date Day', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeVisible();
    await recordLayoutAudit(page, info, `date-${width}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
    await expect(page.getByRole('region', { name: longName, exact: true })).toBeVisible();
    await expect(page.locator('.rio-record-card__position')).toHaveText('1 of 1');
    await recordLayoutAudit(page, info, `record-page-${width}`);
    await visit(page, `${base()}/settings/appearance`);
    await page.getByRole('combobox', { name: 'Search settings', exact: true }).fill('theme');
    await recordLayoutAudit(page, info, `filled-search-${width}`);
    await page.keyboard.press('Escape');
  }
});

test('Home beside a right panel and long function names fit their available width', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.setViewportSize({ width: 1024, height: 720 });
  await visit(page, `${base()}/`);
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const panel = page.locator('.rio-assistant__panel');
  await expect(panel).toBeVisible();
  const files = page.locator('.rio-home-files');
  await expect
    .poll(() =>
      files.evaluate((node) => {
        const navigation = node.querySelector('.rio-home-files__sidebar')!.getBoundingClientRect();
        const content = node.querySelector('.rio-home-files__content')!.getBoundingClientRect();
        return navigation.bottom <= content.top;
      }),
    )
    .toBe(true);
  await recordLayoutAudit(page, info, 'home-tablet-right-panel');
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();

  const database = await createDatabase(page, 'Function layout checks', [
    {
      name: 'Items',
      fields: [{ name: 'Name', type: 'text' }],
    },
  ]);
  await openTable(page, database, 'Items');
  const ask = page.getByRole('button', { name: 'AI: Ask Rio', exact: true });
  await ask.focus();
  await expect(page.getByRole('tooltip', { name: 'AI: Ask Rio', exact: true })).toBeVisible();
  await ask.click();
  await expect(panel).toBeVisible();
  await recordLayoutAudit(page, info, 'database-tablet-right-panel');
  await page.setViewportSize({ width: 768, height: 720 });
  await expect
    .poll(() => page.locator('.rio-shell__main').evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(480);
  await recordLayoutAudit(page, info, 'database-narrow-tablet-right-panel');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  const help = page.locator('.rio-shell__dock');
  await expect(help).toBeVisible();
  await expect
    .poll(() => page.locator('.rio-shell__main').evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(350);
  await recordLayoutAudit(page, info, 'database-help-and-right-panel');
  await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
  await help.getByRole('button', { name: 'Close help', exact: true }).click();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create function', exact: true });
  await expect(create).toHaveAttribute('data-icon-only', 'true');
  await create.click();
  const name = 'PLANNING_REFERENCE_MATERIAL_AND_IMPLEMENTATION_REQUIREMENTS';
  await page.getByRole('textbox', { name: 'Function name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Parameters (comma separated)', exact: true }).fill('value');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('value');
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  const signature = page.getByRole('button', { name: `${name}(value)`, exact: true });
  await expect(signature).toHaveAttribute('data-tooltip', `${name}(value)`);
  await recordLayoutAudit(page, info, 'named-functions-long-signature');
  await page.setViewportSize({ width: 390, height: 844 });
  await recordLayoutAudit(page, info, 'named-functions-phone');
});

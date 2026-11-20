import { expect, test, type Locator, type Page } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, signIn } from '../helpers';
import { base } from '../base';
import { dragInput } from '../pointer-input';
import { releaseDrag } from '../drag-release';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function point(locator: Locator, fraction = 0.5) {
  await locator.scrollIntoViewIfNeeded();
  return measuredPoint(locator, fraction);
}
async function measuredPoint(locator: Locator, fraction = 0.5) {
  const box = await locator.evaluate((element) => {
    const row = element.closest<HTMLElement>('[data-sortable-id]');
    const body =
      element.classList.contains('rio-sortable-handle') && row && !row.hasAttribute('data-sortable-controls')
        ? (row.querySelector('.rio-folder-row__name, a[href], [data-sortable-surface]') ?? row)
        : element;
    const rect = body.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height * fraction };
}
async function drag(page: Page, handle: Locator, target: Locator, fraction = 0.5) {
  await handle.scrollIntoViewIfNeeded();
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
  );
  // Revealing a handle can scroll its destination.  Measure both in the same viewport.
  const from = await measuredPoint(handle);
  const to = await measuredPoint(target, fraction);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y);
  await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await releaseDrag(
    target,
    (point) => page.mouse.move(point.x, point.y),
    () => page.mouse.up(),
    {
      measure: () => measuredPoint(target, fraction),
    },
  );
  await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
}

test('moves a table into a sidebar folder by mouse and shares the result', async ({ page, context }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Sidebar arrangement', [
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Projects');
  const sidebar = page.getByRole('navigation', { name: 'Tables', exact: true });
  await sidebar.getByRole('button', { name: 'Add folder', exact: true }).first().click();
  const created = sidebar.getByRole('group', { name: 'Folder 1', exact: true });
  await created.focus();
  await created.press('F2');
  const editor = created.getByRole('textbox', { name: 'Folder name', exact: true });
  await editor.fill('Planning');
  await editor.press('Enter');
  const folder = sidebar.getByRole('group', { name: 'Planning', exact: true });
  const peer = await context.newPage();
  try {
    await peer.goto(page.url());
    await drag(page, sidebar.getByRole('button', { name: 'Move Projects', exact: true }), folder);
    const moved = sidebar
      .locator('.rio-sidebar-folder')
      .filter({ has: page.getByRole('group', { name: 'Planning', exact: true }) });
    await expect(moved.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    await expect(
      peer.locator('.rio-sidebar-folder').getByRole('link', { name: 'Projects', exact: true }),
    ).toBeVisible();
    const schema = await asOwner<{
      database: {
        navigation: { parents: Record<string, string>; folders: Array<{ id: string; name: string }> };
      };
    }>(page, 'GET', `/api/databases/${database.id}/schema`);
    expect(schema.database.navigation.parents[database.tables.Projects!.id]).toBe(
      schema.database.navigation.folders.find((item) => item.name === 'Planning')!.id,
    );
    await sidebar.getByRole('button', { name: 'More for Planning', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete folder?' })
      .getByRole('button', { name: 'Delete folder', exact: true })
      .click();
    await expect(sidebar.locator('.rio-sidebar-folder')).toHaveCount(0);
    await expect(peer.locator('.rio-sidebar-folder')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo history', exact: true }).click();
    await page
      .getByRole('listbox', { name: 'Changes to undo, newest first', exact: true })
      .getByRole('option')
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expect(
      sidebar.locator('.rio-sidebar-folder').getByRole('link', { name: 'Projects', exact: true }),
    ).toBeVisible();
  } finally {
    await peer.close();
  }
});

test('keeps Home filter links from filing a dragged database into a nearby folder', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Filter destination checks', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const folderId = newId('act');
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, name: 'Keep here', parentId: null },
  });
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'database.move', databaseId: database.id, parentId: folderId },
  });
  await page.goto(`${base()}/home/folders/${folderId}`);
  for (const name of ['Shared with me', 'Recent', 'Favorites']) {
    await drag(
      page,
      page.getByRole('button', { name: 'Move Filter destination checks', exact: true }),
      page.getByRole('link', { name, exact: true }),
    );
    const listing = await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
      page,
      'GET',
      '/api/home',
    );
    expect(listing.databases.find((item) => item.id === database.id)?.parentId).toBe(folderId);
  }
});

test('keeps Recent list gestures from changing the filing location and refuses shortcut drops on filter links', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Recent arrangement', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const second = await createDatabase(page, 'Recent neighbor', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const folderId = newId('act');
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'folder.create', folderId, name: 'Recent source', parentId: null },
  });
  await asOwner(page, 'POST', '/api/home/commands', {
    id: newId('cmd'),
    action: { kind: 'database.move', databaseId: database.id, parentId: folderId },
  });
  await openTable(page, second, 'Tasks');
  await openTable(page, database, 'Tasks');
  await page.goto(`${base()}/home/recent`);
  const handle = page.getByRole('button', { name: 'Move Recent arrangement', exact: true });
  await handle.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.rio-sortable-refusal')).toContainText('Drop on a folder');
  await page.keyboard.press('Escape');
  await expect(page.locator('.rio-sortable-refusal')).toBeEmpty();
  await drag(page, handle, page.getByRole('button', { name: 'Move Recent neighbor', exact: true }), 0.85);
  const listing = await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
    page,
    'GET',
    '/api/home',
  );
  expect(listing.databases.find((item) => item.id === database.id)?.parentId).toBe(folderId);
  const commands: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/home/commands')) commands.push(request.postData() ?? '');
  });
  const transfer = await page.evaluateHandle((viewId) => {
    const data = new DataTransfer();
    data.setData('application/x-rio-shortcut', JSON.stringify({ kind: 'view', id: viewId }));
    return data;
  }, database.tables.Tasks!.viewId);
  try {
    for (const name of ['Trash', 'Shared with me', 'Recent', 'Favorites']) {
      const target = page.getByRole('link', { name, exact: true });
      await target.dispatchEvent('dragover', { dataTransfer: transfer });
      expect(await transfer.evaluate((data) => data.dropEffect)).toBe('none');
      await target.dispatchEvent('drop', { dataTransfer: transfer });
    }
    expect(commands).toEqual([]);
  } finally {
    await transfer.dispose();
  }
});

test.describe('phone touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('reorders dashboard tiles with touch while neighboring tiles stay still', async ({
    page,
    context,
    browserName,
  }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Phone tiles', [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const dashboardId = `dsh${newId('act').slice(3)}`;
    const config = {
      tiles: ['Alpha', 'Beta'].map((title, index) => ({
        id: newId('act'),
        kind: 'text',
        title,
        text: title,
        place: { x: 0, y: index * 2, w: 12, h: 2 },
      })),
    };
    await asOwner(page, 'POST', `/api/databases/${database.id}/commands`, {
      clientId: newId('cli'),
      commands: [
        {
          id: newId('cmd'),
          groupId: newId('act'),
          kind: 'dashboard.create',
          dashboard: { id: dashboardId, name: 'Phone board', config },
        },
      ],
    });
    await page.goto(`${base()}/${database.id}/dashboards/${dashboardId}`);
    await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
    const handle = page
      .getByRole('article', { name: 'Alpha', exact: true })
      .locator('.rio-dashboard-tile__header');
    const to = await point(page.getByRole('article', { name: 'Beta', exact: true }));
    const from = await point(handle);
    const before = await page.getByRole('article', { name: 'Beta', exact: true }).boundingBox();
    const session = await dragInput(page, context, browserName, handle, 'touch-pointer');
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      await page.waitForTimeout(250);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...to, id: 1 }] });
      await expect(page.getByRole('article', { name: 'Alpha', exact: true })).toHaveAttribute(
        'data-dragging',
        'true',
      );
      expect(await page.getByRole('article', { name: 'Beta', exact: true }).boundingBox()).toEqual(before);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.locator('.rio-dashboard-tile').first()).toHaveAccessibleName('Beta');
      await page.reload();
      await expect(page.locator('.rio-dashboard-tile').first()).toHaveAccessibleName('Beta');
    } finally {
      await session.detach();
    }
  });
  for (const theme of ['nature', 'system-7'])
    test(
      theme === 'nature'
        ? 'moves a database into a home folder with touch'
        : 'moves a database into a home folder with touch in System 7',
      async ({ page, context, browserName }) => {
        await page.route('**/api/auth/session', async (route) => {
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const session = (await response.json()) as { preferences: { locale?: string; theme?: string } };
          session.preferences = { ...session.preferences, locale: 'en-US', theme };
          await route.fulfill({ response, json: session });
        });
        await signIn(page);
        const database = await createDatabase(page, 'Phone arrangement', [
          { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
        ]);
        const folderId = newId('act');
        await asOwner(page, 'POST', '/api/home/commands', {
          id: newId('cmd'),
          action: { kind: 'folder.create', folderId, name: 'Phone destination', parentId: null },
        });
        await page.goto(base());
        const destination = page.locator(
          `.rio-home-files__folders .rio-sortable-target[data-sortable-parent="${folderId}"]`,
        );
        const target = destination.getByRole('button', { name: 'Phone destination', exact: true });
        const source = page.locator(`a.rio-database-card[href="/${database.id}"]`);
        await expect(source).toHaveAccessibleName(/Phone arrangement/);
        const session = await dragInput(page, context, browserName, source);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        const from = await point(source);
        const height = page.viewportSize()!.height;
        const initial = await measuredPoint(target);
        const to = { x: initial.x, y: Math.max(80, Math.min(height - 80, initial.y)) };
        try {
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ ...from, id: 1 }],
          });
          await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
          for (let step = 1; step <= 12; step++)
            await session.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [
                {
                  x: from.x + ((to.x - from.x) * step) / 12,
                  y: from.y + ((to.y - from.y) * step) / 12,
                  id: 1,
                },
              ],
            });
          await expect(page.locator('.rio-sortable-refusal')).toHaveText('');
          await releaseDrag(
            target,
            (point) =>
              session.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ ...point, id: 1 }],
              }),
            () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
            { highlight: destination, attribute: 'data-drop-target', event: 'touchend' },
          );
          await expect
            .poll(
              async () =>
                (
                  await asOwner<{ databases: Array<{ id: string; parentId: string | null }> }>(
                    page,
                    'GET',
                    '/api/home',
                  )
                ).databases.find((item) => item.id === database.id)?.parentId,
            )
            .toBe(folderId);
          await target.click();
          await expect(source).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally {
          await session.detach();
        }
      },
    );
});

test('reorders attachments with the keyboard and retains the saved order', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Attachment arrangement', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Review' }],
    },
  ]);
  await openTable(page, database, 'Tasks');
  await page.getByRole('grid').getByRole('button', { name: 'Expand row 1' }).click();
  const record = page.getByRole('dialog', { name: 'Review', exact: true });
  await record.locator('input[type="file"]').setInputFiles([
    { name: 'First.txt', mimeType: 'text/plain', buffer: Buffer.from('First file') },
    { name: 'Second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file') },
  ]);
  await expect(record.getByRole('button', { name: 'Move Second.txt', exact: true })).toBeVisible();
  const handle = record.getByRole('button', { name: 'Move First.txt', exact: true });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(record.locator('.rio-files__name').first()).toHaveText('First.txt');
  await page.keyboard.press('Space');
  await expect(record.locator('.rio-files__name').first()).toHaveText('Second.txt');
  await expect(handle).toBeFocused();
  await page.reload();
  await expect(page.locator('.rio-files__name').first()).toHaveText('Second.txt');
});

test('moves a form field by mouse and retains the saved question order', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Form arrangement', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText' },
      ],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add view', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Form', exact: true }).click();
  await page.getByRole('button', { name: 'Edit form', exact: true }).click();
  const destination = page.locator('.rio-form-view__question').first();
  const scrolled = await destination.evaluateHandle((element) => {
    const panel = element.closest<HTMLElement>('.rio-form-view')!;
    const position = { before: 0, after: 0 };
    const observer = new MutationObserver(() => {
      if (!element.hasAttribute('data-drop-before')) return;
      observer.disconnect();
      // Force the destination to move after its insertion marker appears, before release.
      position.before = panel.scrollTop;
      panel.scrollTop -= 160;
      position.after = panel.scrollTop;
    });
    observer.observe(element, { attributes: true, attributeFilter: ['data-drop-before'] });
    return position;
  });
  await drag(page, page.getByRole('button', { name: 'Reorder Notes', exact: true }), destination, 0.05);
  const position = await scrolled.jsonValue();
  await scrolled.dispose();
  expect(position.before - position.after).toBe(160);
  await expect(page.locator('.rio-form-view__question').first()).toContainText('Notes');
  const table = database.tables.Requests!;
  await expect
    .poll(async () => {
      const schema = await asOwner<{
        views: Array<{ type: string; config: { form: { questions: Array<{ fieldId: string }> } } }>;
      }>(page, 'GET', `/api/databases/${database.id}/schema`);
      return schema.views
        .find((view) => view.type === 'form')
        ?.config.form.questions.map((question) => question.fieldId);
    })
    .toEqual([table.fields.Notes, table.fields.Name]);
});

test('uploads desktop files dropped directly onto an attachment cell', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Desktop file drop', [
    {
      name: 'Documents',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Draft' }],
    },
  ]);
  await openTable(page, database, 'Documents');
  const cell = page.getByRole('row', { name: /Draft/ }).getByRole('gridcell').last();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['Draft content'], 'Draft.txt', { type: 'text/plain' }));
    return data;
  });
  await cell.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(cell).toHaveAttribute('data-file-drop', 'ready');
  await expect(page.getByText('Drop files to add them', { exact: true })).toBeVisible();
  await cell.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByRole('button', { name: 'Move Draft.txt', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('grid').getByRole('button', { name: 'Expand row 1' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Draft', exact: true })
      .getByRole('button', { name: 'Move Draft.txt', exact: true }),
  ).toBeVisible();
  await transfer.dispose();
});

test('arranges published page navigation with the keyboard', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Published arrangement', [
    { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const interfaceId = `itf${newId('act').slice(3)}`;
  const pages = ['First page', 'Second page'].map((name) => ({ id: newId('act'), name, blocks: [] }));
  await asOwner(page, 'POST', `/api/databases/${database.id}/commands`, {
    clientId: newId('cli'),
    commands: [
      {
        id: newId('cmd'),
        groupId: newId('act'),
        kind: 'interface.create',
        interface: { id: interfaceId, name: 'Published pages', pages },
      },
    ],
  });
  await page.goto(`${base()}/${database.id}/interfaces/${interfaceId}/${pages[0]!.id}`);
  await page.getByRole('button', { name: 'Publish site', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish site', exact: true });
  await dialog.getByRole('button', { name: 'Move Second page', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await dialog.getByRole('button', { name: 'Publish selected pages', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Visit site', exact: true })).toBeVisible();
  const site = await asOwner<{ settings: { pages: Array<{ pageId: string }> } }>(
    page,
    'GET',
    `/api/interfaces/${interfaceId}/site`,
  );
  expect(site.settings.pages.map((item) => item.pageId)).toEqual([pages[1]!.id, pages[0]!.id]);
});

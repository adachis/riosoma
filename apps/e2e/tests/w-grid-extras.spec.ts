import { expect, test, type Page } from '../accessibility';
import { labelName, asOwner, createDatabase, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block', hasTouch: true });

async function projects(page: Page) {
  await signIn(page);
  const database = await createDatabase(page, 'Grid arrangements', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Notes', type: 'text' },
      ],
      records: Array.from({ length: 45 }, (_, index) => ({
        Name: `Project ${index}`,
        Status: index < 22 ? 'Ready' : 'Done',
        Amount: index,
      })),
    },
  ]);
  await openTable(page, database, 'Projects');
  return { database, table: database.tables.Projects! };
}

test('pins records, freezes them while scrolling, saves colored column groups, and works on a phone', async ({
  page,
}) => {
  const { table } = await projects(page);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  await grid.getByRole('gridcell', { name: 'Project 2', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: labelName('Pin record') }).click();
  const pinned = page.locator('.rio-grid__pinned');
  await expect(pinned.getByRole('gridcell', { name: 'Project 2', exact: true })).toBeVisible();
  await grid.getByRole('columnheader', { name: 'Status', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Headers and column groups', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Headers and column groups' });
  await expect(page).toHaveURL(new RegExp(`gridField=${table.fields.Status}`));
  await dialog.getByLabel('Header color', { exact: true }).selectOption('blue');
  await dialog.getByLabel('Column group', { exact: true }).selectOption('new');
  await dialog.getByLabel('Group name', { exact: true }).fill('Details');
  await dialog.getByLabel('Group color', { exact: true }).selectOption('green');
  await dialog.getByLabel('Amount', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const bandRow = grid
    .getByRole('button', { name: 'Details', exact: true })
    .first()
    .locator('xpath=ancestor::*[@role="row"]');
  await expect(bandRow).toHaveAttribute('aria-rowindex', '1');
  await expect(
    grid.getByRole('columnheader', { name: 'Status', exact: true }).locator('xpath=ancestor::*[@role="row"]'),
  ).toHaveAttribute('aria-rowindex', '2');
  await expect(grid).toHaveAttribute('aria-rowcount', '49');
  await expect(grid.getByRole('button', { name: 'Details', exact: true }).first()).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await grid.getByRole('button', { name: 'Details', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('columnheader', { name: /Amount/ })).toHaveCount(0);
  await expect(grid.getByRole('button', { name: 'Details', exact: true }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('columnheader', { name: /Amount/ })).toBeVisible();
  await page.locator('.rio-grid__scroller').evaluate((node) => {
    node.scrollTop = 600;
  });
  await expect(pinned.getByRole('gridcell', { name: 'Project 2', exact: true })).toBeVisible();
  await page.reload();
  await expect(pinned.getByRole('gridcell', { name: 'Project 2', exact: true })).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: /Status/ })).toHaveAttribute(
    'style',
    /--rio-aa-choice-blue-soft/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pinned.getByRole('gridcell', { name: 'Project 2', exact: true })).toBeVisible();
  expect(await page.locator('.rio-grid__scroller').evaluate((node) => node.clientHeight)).toBeGreaterThan(
    100,
  );
});

test('previews a header drag without moving columns and commits keyboard record moves with undo', async ({
  page,
}) => {
  const { table } = await projects(page);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  const status = grid.getByRole('columnheader', { name: 'Status', exact: true });
  const amount = grid.getByRole('columnheader', { name: 'Amount', exact: true });
  const before = await status.boundingBox();
  const destination = (await amount.boundingBox())!;
  await page.mouse.move(before!.x + 50, before!.y + 16);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width - 15, destination.y + 16, { steps: 6 });
  expect((await status.boundingBox())!.x).toBe(before!.x);
  await page.mouse.up();
  await expect.poll(async () => (await status.boundingBox())!.x).toBe(destination.x);
  const first = grid.getByRole('button', { name: 'Move record', exact: true }).first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.rio-grid__live')).toContainText('Use arrow keys');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.rio-grid__live')).toContainText('Move to row 2');
  await page.keyboard.press('Enter');
  const read = async () =>
    asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
  await expect.poll(async () => (await read()).rows[0]!.values[table.fields.Name!]).toBe('Project 1');
  await grid.getByRole('gridcell', { name: 'Project 1', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await read()).rows[0]!.values[table.fields.Name!]).toBe('Project 0');
});

test('moves into a record group and announces a sorted move refusal before drop', async ({ page }) => {
  const { database, table } = await projects(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { groups: [{ fieldId: table.fields.Status!, direction: 'asc' }] },
    },
  ]);
  const grid = page.getByRole('treegrid');
  const done = grid.getByRole('row', { name: 'Done, 23 records', exact: true });
  const ready = grid.getByRole('row', { name: 'Ready, 22 records', exact: true });
  await done.getByRole('button', { name: 'Done, 23 records', exact: true }).click();
  await ready.getByRole('button', { name: 'Ready, 22 records', exact: true }).focus();
  const handle = grid.getByRole('button', { name: 'Move record', exact: true }).first();
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('row', { name: 'Done, 24 records', exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { groups: [], sorts: [{ fieldId: table.fields.Amount!, direction: 'asc' }] },
    },
  ]);
  const sortedHandle = page
    .getByRole('grid')
    .getByRole('button', { name: 'Move record', exact: true })
    .first();
  await sortedHandle.focus();
  await expect(sortedHandle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.rio-grid__live')).toContainText('Remove the sort');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.rio-grid__drag-hint')).toContainText('Remove the sort to reorder records.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.rio-grid__drag-hint')).toBeHidden();
});

test('moves columns into and out of groups and cancels a preview with Escape', async ({ page }) => {
  const { database, table } = await projects(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { columnGroups: [{ id: 'details', name: 'Details', fieldIds: [table.fields.Amount!] }] },
    },
  ]);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  const status = grid.getByRole('columnheader', { name: 'Status', exact: true });
  const configuration = async () => {
    const schema = await asOwner<{
      views: Array<{ id: string; config: { columnGroups: Array<{ fieldIds: string[] }> } }>;
    }>(page, 'GET', `/api/databases/${database.id}/schema`);
    return schema.views.find((view) => view.id === table.viewId)!.config.columnGroups;
  };
  await status.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  expect((await configuration())[0]!.fieldIds).toEqual([table.fields.Amount]);
  await status.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await configuration())[0]!.fieldIds).toContain(table.fields.Status);
  await status.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await configuration())[0]!.fieldIds).toEqual([table.fields.Amount]);
});

test('keeps native touch capture through a long press, and cancels or moves the header on release', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Native touch capture uses the Chromium input protocol');
  await projects(page);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  const status = grid.getByRole('columnheader', { name: 'Status', exact: true });
  const amount = grid.getByRole('columnheader', { name: 'Amount', exact: true });
  const from = (await status.boundingBox())!;
  const to = (await amount.boundingBox())!;
  const input = await page.context().newCDPSession(page);
  const body = (await page.locator('.rio-grid__scroller').boundingBox())!;
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    input.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  // Letting go below the header band cancels, which is the only way out a touch has.
  await touch('touchStart', from.x + 40, from.y + 16);
  await touch('touchMove', from.x + 41, from.y + 16);
  await expect(page.locator('.rio-grid__live')).toContainText('Use arrow keys');
  await touch('touchMove', to.x + 60, body.y + 120);
  await expect(page.locator('.rio-grid__drag-hint')).toContainText('Release here to cancel the move.');
  await expect(page.locator('.rio-grid__drop-indicator')).toBeHidden();
  await touch('touchEnd', to.x + 60, body.y + 120);
  expect((await status.boundingBox())!.x).toBe(from.x);
  await expect(page.locator('.rio-grid__drag-hint')).toBeHidden();
  await touch('touchStart', from.x + 40, from.y + 16);
  await touch('touchMove', from.x + 41, from.y + 16);
  await expect(page.locator('.rio-grid__live')).toContainText('Use arrow keys');
  await touch('touchMove', to.x + 60, to.y + 16);
  await expect(page.locator('.rio-grid__drag-hint')).toBeVisible();
  await touch('touchEnd', to.x + 60, to.y + 16);
  await expect.poll(async () => (await status.boundingBox())!.x).toBe(to.x);
  await grid.getByRole('gridcell', { name: 'Project 0', exact: true }).click();
  await expect(page.locator('.rio-grid__input')).toBeFocused();
  await input.detach();
});

test('unpins the records a filter hides once the pin limit is reached', async ({ page }) => {
  const { database, table } = await projects(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        pinnedRecordIds: table.records.slice(10, 30),
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'ready', fieldId: table.fields.Status!, operator: 'is', value: 'Ready' }],
        },
      },
    },
  ]);
  await page.reload();
  const pinned = page.locator('.rio-grid__pinned');
  await expect(pinned.locator('.rio-grid__row')).toHaveCount(12);
  const configuration = async () => {
    const schema = await asOwner<{ views: Array<{ id: string; config: { pinnedRecordIds: string[] } }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
    return schema.views.find((view) => view.id === table.viewId)!.config.pinnedRecordIds;
  };
  expect(await configuration()).toHaveLength(20);
  const scrolling = page.locator('.rio-grid__scroller');
  await scrolling.getByRole('gridcell', { name: 'Project 0', exact: true }).click({ button: 'right' });
  const pin = page.getByRole('menuitem', { name: labelName('Pin record') });
  await expect(pin).toHaveAttribute('aria-disabled', 'true');
  await expect(pin).toContainText('8 pinned records are not shown in this view');
  await page.getByRole('menuitem', { name: 'Unpin the 8 records not shown', exact: true }).click();
  await expect.poll(configuration).toEqual(table.records.slice(10, 22));
  await expect(pinned.locator('.rio-grid__row')).toHaveCount(12);
  await scrolling.getByRole('gridcell', { name: 'Project 0', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: labelName('Pin record') })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
});

test('edits and selects pinned cells without moving the scrolling rows', async ({ page }) => {
  const { database, table } = await projects(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { pinnedRecordIds: table.records.slice(0, 2) },
    },
  ]);
  const pinned = page.locator('.rio-grid__pinned');
  const first = pinned.getByRole('gridcell', { name: 'Project 0', exact: true });
  const second = pinned.getByRole('gridcell', { name: 'Project 1', exact: true });
  await expect(first).toBeVisible();
  await first.dblclick();
  const input = page.locator('.rio-grid__input');
  await expect(input).toHaveAttribute('data-editing');
  const editor = (await input.boundingBox())!;
  const cell = (await first.boundingBox())!;
  expect(editor.y).toBe(cell.y);
  expect(
    await input.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return document.elementFromPoint(box.left + 5, box.top + 5) === node;
    }),
  ).toBe(true);
  await input.fill('Pinned edit');
  await page.keyboard.press('Enter');
  await expect(pinned.getByRole('gridcell', { name: 'Pinned edit', exact: true })).toBeVisible();
  const amount = pinned.locator('[data-rio-row="1"][data-rio-col="2"]');
  await amount.dblclick();
  await input.fill('invalid');
  await page.keyboard.press('Enter');
  const error = page.locator('.rio-grid__error');
  await expect(error).toBeVisible();
  expect(
    await error.evaluate((node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      node.style.pointerEvents = 'auto';
      const visible =
        document.elementFromPoint(box.left + 5, box.top + 5)?.closest('.rio-grid__error') === node;
      node.style.pointerEvents = '';
      return visible;
    }),
  ).toBe(true);
  await page.keyboard.press('Escape');
  const start = (await pinned.getByRole('gridcell', { name: 'Pinned edit', exact: true }).boundingBox())!;
  const end = (await second.boundingBox())!;
  await page.mouse.move(start.x + 30, start.y + 15);
  await page.mouse.down();
  await page.mouse.move(end.x + 30, end.y + 15, { steps: 4 });
  await page.mouse.up();
  await expect(pinned.locator('[data-rio-row="1"][data-rio-col="0"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await page.locator('.rio-grid__scroller').evaluate((node) => node.scrollTop)).toBe(0);
  const origin = pinned.locator('[data-rio-row="0"][data-rio-col="0"]');
  await origin.click();
  // The handle moves on the next frame, so it's grabbed once it sits at the clicked cell's corner
  // instead of where the earlier two-row selection left it.
  const corner = (await origin.boundingBox())!;
  const fillHandle = page.locator('.rio-grid__fill-handle');
  const center = async () => {
    const box = (await fillHandle.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await expect
    .poll(async () => Math.abs((await center()).y - (corner.y + corner.height)))
    .toBeLessThanOrEqual(2);
  const fill = await center();
  await page.mouse.move(fill.x, fill.y);
  await page.mouse.down();
  await page.mouse.move(end.x + 30, end.y + 15, { steps: 4 });
  await page.mouse.up();
  await expect(pinned.locator('[data-rio-row="1"][data-rio-col="0"]')).toHaveText('Pinned edit');
  await expect(page.getByRole('gridcell', { name: 'Project 2', exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { pinnedRecordIds: table.records.slice(0, 20) },
    },
  ]);
  const fourth = pinned.locator('[data-rio-row="3"][data-rio-col="0"]');
  await fourth.click();
  // As above, the handle reaches the clicked cell's corner on the next frame.  Measured any sooner,
  // it's still where the two-row fill left it.
  const handle = page.locator('.rio-grid__fill-handle');
  await expect
    .poll(async () => {
      const box = (await fourth.boundingBox())!;
      const corner = await handle.boundingBox();
      return corner ? Math.abs(corner.y + corner.height / 2 - (box.y + box.height)) : Infinity;
    })
    .toBeLessThanOrEqual(2);
  const beforeScroll = (await handle.boundingBox())!.y;
  await pinned.evaluate((node) => {
    node.scrollTop = 32;
  });
  await expect.poll(async () => (await handle.boundingBox())!.y).toBe(beforeScroll - 32);
});

test('keeps keyboard moves cancelable after the source is virtualized and reaches headers from cells', async ({
  page,
}) => {
  await projects(page);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  const handle = grid.getByRole('button', { name: 'Move record', exact: true }).first();
  await handle.focus();
  await page.keyboard.press('Space');
  for (let index = 0; index < 35; index++) await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-rio-row="0"]')).toHaveCount(0);
  await expect(page.getByRole('application', { name: /Use arrow keys/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rio-grid__drag-hint')).toBeHidden();
  await expect(page.locator('.rio-grid__input')).toBeFocused();
  const cell = grid.getByRole('gridcell', { name: 'Project 0', exact: true });
  await cell.click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(grid.getByRole('columnheader', { name: 'Name', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('columnheader', { name: 'Status', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.rio-grid__input')).toBeFocused();
});

test('paints group bands across sibling headers and keeps the label when the first member scrolls away', async ({
  page,
}) => {
  const { database, table } = await projects(page);
  await page.setViewportSize({ width: 800, height: 700 });
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        columnWidths: {
          [table.fields.Status!]: 300,
          [table.fields.Amount!]: 300,
          [table.fields.Notes!]: 300,
        },
        columnGroups: [
          {
            id: 'details',
            name: 'Details',
            fieldIds: [table.fields.Status!, table.fields.Amount!, table.fields.Notes!],
            color: 'green',
          },
        ],
      },
    },
  ]);
  const band = page.getByRole('button', { name: 'Details', exact: true });
  await expect(band).toBeVisible();
  const painted = () =>
    band.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return (
        document.elementFromPoint(box.right - 8, box.top + 8)?.closest('[data-rio-column-group]') === node
      );
    });
  expect(await painted()).toBe(true);
  await page.locator('.rio-grid__scroller').evaluate((node) => {
    node.scrollLeft = 650;
  });
  await expect.poll(async () => (await band.boundingBox())!.width).toBeGreaterThan(20);
  expect(await painted()).toBe(true);
  const member = page.locator('[data-rio-column="2"]');
  await member.focus();
  await page.keyboard.press('ArrowUp');
  await expect(band).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('columnheader', { name: 'Amount', exact: true })).toHaveCount(0);
});

test('scrolls toward off-screen records while a row handle stays at the edge', async ({ page }) => {
  await projects(page);
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  const handle = (await grid
    .getByRole('button', { name: 'Move record', exact: true })
    .first()
    .boundingBox())!;
  const body = (await page.locator('.rio-grid__scroller').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, body.y + body.height - 8, { steps: 4 });
  await expect
    .poll(() => page.locator('.rio-grid__scroller').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(200);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.rio-grid__drag-hint')).toBeHidden();
});

for (const gesture of ['select', 'fill', 'row'] as const) {
  test(`scrolls upward past pins during a ${gesture} drag`, async ({ page }) => {
    const { database, table } = await projects(page);
    await page.setViewportSize({ width: 1000, height: 700 });
    await runCommands(page, database.id, [
      { kind: 'view.update', viewId: table.viewId, config: { pinnedRecordIds: table.records.slice(0, 2) } },
    ]);
    await page.reload();
    const pinned = page.locator('.rio-grid__pinned');
    await expect(pinned.getByRole('gridcell', { name: 'Project 0', exact: true })).toBeVisible();
    const scroller = page.locator('.rio-grid__scroller');
    const body = (await scroller.boundingBox())!;
    await scroller.evaluate((node) => {
      node.scrollTop = 320;
    });
    const cell = scroller.getByRole('gridcell', { name: 'Project 14', exact: true });
    await expect(cell).toBeVisible();
    // At the top, Project 14 is already drawn in the margin below the body, so it counts as visible
    // before the grid redraws the rows for the scroll on its next frame.  A press any sooner would
    // land under the grid.
    await expect
      .poll(async () => {
        const box = await cell.boundingBox();
        return !!box && box.y >= body.y && box.y + box.height <= body.y + body.height;
      })
      .toBe(true);
    if (gesture === 'fill') {
      await cell.click();
      // The handle reaches the clicked cell's corner on the next frame, too.
      await expect
        .poll(async () => {
          const box = (await cell.boundingBox())!;
          const handle = await page.locator('.rio-grid__fill-handle').boundingBox();
          return handle ? Math.abs(handle.y + handle.height / 2 - (box.y + box.height)) : Infinity;
        })
        .toBeLessThanOrEqual(2);
    }
    const target =
      gesture === 'fill'
        ? page.locator('.rio-grid__fill-handle')
        : gesture === 'row'
          ? cell
              .locator('xpath=ancestor::*[@role="row"]')
              .getByRole('button', { name: 'Move record', exact: true })
          : cell;
    const source = (await target.boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, body.y - 8, { steps: 4 });
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeLessThan(280);
    await expect(pinned.locator('[aria-selected="true"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
}

test('inserts from a pinned row after the pins and types into the new record', async ({ page }) => {
  const { database, table } = await projects(page);
  await runCommands(page, database.id, [
    { kind: 'view.update', viewId: table.viewId, config: { pinnedRecordIds: table.records.slice(0, 2) } },
  ]);
  await page.reload();
  const pinned = page.locator('.rio-grid__pinned');
  await pinned.getByRole('gridcell', { name: 'Project 0', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert record above', exact: true }).click();
  await expect(pinned.locator('.rio-grid__row')).toHaveCount(2);
  await expect(page.locator('.rio-grid__scroller [data-rio-row="2"][data-rio-col="0"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.type('Inserted record');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.rio-grid__scroller').getByRole('gridcell', { name: 'Inserted record', exact: true }),
  ).toBeVisible();
  await expect(pinned.getByRole('gridcell', { name: 'Inserted record', exact: true })).toHaveCount(0);
});

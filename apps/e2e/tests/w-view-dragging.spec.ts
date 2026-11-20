import { assertAccessible, expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { labelName, createDatabase, createView, newId, runCommands, signIn, visit } from '../helpers';
import { dragInput } from '../pointer-input';
import { releaseDrag } from '../drag-release';

test.use({ serviceWorkers: 'block', timezoneId: 'UTC' });

function dayAfter(day: string, offset: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

async function values(page: Page, viewId: string, recordId: string) {
  const response = await page.request.get(`${base()}/api/views/${viewId}/rows?refresh=1`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { rows: Array<{ id: string; values: Record<string, unknown> }> };
  return body.rows.find((row) => row.id === recordId)!.values;
}

/** Chooses a view toolbar item, whether it has room to show itself or is in the More menu. */
async function chooseToolbarItem(page: Page, name: string) {
  const toolbar = page.getByRole('toolbar', { name: 'View controls' });
  const shown = toolbar.getByRole('button', { name, exact: true }).first();
  if (await shown.isVisible().catch(() => false)) {
    await shown.click();
    return;
  }
  await toolbar.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('kanban moves by mouse and keyboard, saves the grouping value, and reaches a peer', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Board dragging', [
    {
      name: 'Work',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Ready', 'Done'] },
      ],
      records: [
        { Name: 'Inspect the lines', Status: 'Ready' },
        { Name: 'Check the lights', Status: 'Ready' },
      ],
    },
  ]);
  const table = database.tables.Work!;
  const viewId = await createView(page, database, 'Work', {
    name: 'Board',
    type: 'kanban',
    config: { kanban: { stackFieldId: table.fields.Status } },
  });
  const address = `${base()}/${database.id}/${table.id}/${viewId}`;
  await assertAccessible(page);
  await visit(page, address);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  const done = page.getByRole('region', { name: 'Done', exact: true });
  const card = ready.getByRole('button', { name: labelName('Inspect the lines') });
  await expect(card).toBeVisible();
  await assertAccessible(page);
  const other = await browser.newContext({
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const peer = await other.newPage();
    await visit(peer, address);
    await expect(
      peer
        .getByRole('region', { name: 'Ready', exact: true })
        .getByRole('button', { name: labelName('Inspect the lines') }),
    ).toBeVisible();
    await assertAccessible(peer);
    await card.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const from = (await card.boundingBox())!;
    const to = (await done.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 100, { steps: 10 });
    await expect(done).toHaveAttribute('data-rio-drop', 'ready');
    await expect(card).toBeVisible();
    await releaseDrag(
      done,
      (point) => page.mouse.move(point.x, point.y),
      () => page.mouse.up(),
      {
        measure: async () => {
          const box = (await done.boundingBox())!;
          return { x: box.x + box.width / 2, y: box.y + 100 };
        },
        highlight: done,
        attribute: 'data-rio-drop',
        value: 'ready',
      },
    );
    await expect(done.getByRole('button', { name: labelName('Inspect the lines') })).toBeVisible();
    await expect(
      peer
        .getByRole('region', { name: 'Done', exact: true })
        .getByRole('button', { name: labelName('Inspect the lines') }),
    ).toBeVisible();
    await expect
      .poll(async () => (await values(page, viewId, table.records[0]!))[table.fields.Status!])
      .toBe(table.choices.Status!.Done);

    const next = ready.getByRole('button', { name: labelName('Check the lights') });
    await next.focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(done.getByRole('button', { name: labelName('Check the lights') })).toBeFocused();
    await expect
      .poll(async () => (await values(page, viewId, table.records[1]!))[table.fields.Status!])
      .toBe(table.choices.Status!.Done);
    await page.reload();
    await expect(done.getByRole('button', { name: labelName('Check the lights') })).toBeVisible();
  } finally {
    await other.close();
  }
});

test.describe('touch calendar', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a short press moves an event on a phone without changing dates before release', async ({
    page,
    context,
    browserName,
  }) => {
    await signIn(page);
    const today = new Date().toISOString().slice(0, 10);
    const destination = dayAfter(today, 1);
    const database = await createDatabase(page, 'Touch scheduling', [
      {
        name: 'Visits',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Starts', type: 'date' },
        ],
        records: [{ Name: 'Dock visit', Starts: today }],
      },
    ]);
    const table = database.tables.Visits!;
    const viewId = await createView(page, database, 'Visits', {
      name: 'Calendar',
      type: 'calendar',
      config: { calendar: { startFieldId: table.fields.Starts } },
    });
    await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
    const card = page.getByRole('button', { name: 'Dock visit', exact: true });
    const target = page.locator(`[data-calendar-day="${destination}"]`);
    await expect(card).toBeVisible();
    await card.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    const touch = await dragInput(page, context, browserName, card, 'touch-pointer');
    try {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2, id: 1 }],
      });
      await expect(page.locator('[data-rio-drop="ready"]')).toHaveCount(1);
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: to.x + to.width / 2, y: to.y + 55, id: 1 }],
      });
      await expect(target).toHaveAttribute('data-rio-drop', 'ready');
      expect((await values(page, viewId, table.records[0]!))[table.fields.Starts!]).toBe(today);
      await releaseDrag(
        target,
        (point) =>
          touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] }),
        () => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
        {
          measure: async () => {
            const box = (await target.boundingBox())!;
            return { x: box.x + box.width / 2, y: box.y + 55 };
          },
          highlight: target,
          attribute: 'data-rio-drop',
          value: 'ready',
          event: 'pointerup',
        },
      );
    } finally {
      await touch.detach();
    }
    await expect
      .poll(async () => (await values(page, viewId, table.records[0]!))[table.fields.Starts!])
      .toBe(destination);
    await expect(target.getByRole('button', { name: 'Dock visit', exact: true })).toBeVisible();
  });
});

test.describe('week view auto-scroll', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a held drag scrolls the calendar near its own edge, over a day’s time targets', async ({
    page,
    context,
    browserName,
  }) => {
    await signIn(page);
    const today = new Date().toISOString().slice(0, 10);
    // The event sits on the week's first day, so it is at the top of a week that runs well past
    // the bottom of a phone, which is what a drag near that bottom edge has to reach.
    const weekStart = dayAfter(today, -new Date(`${today}T12:00:00Z`).getUTCDay());
    const database = await createDatabase(page, 'Scrolling weeks', [
      {
        name: 'Visits',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Starts', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        ],
        records: [{ Name: 'Harbor visit', Starts: `${weekStart}T12:00:00.000Z` }],
      },
    ]);
    const table = database.tables.Visits!;
    const viewId = await createView(page, database, 'Visits', {
      name: 'Week',
      type: 'calendar',
      config: { calendar: { startFieldId: table.fields.Starts, range: 'week' } },
    });
    await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
    const calendar = page.locator('.rio-calendar-view');
    const chip = page.locator('[data-calendar-record]').filter({ hasText: 'Harbor visit' });
    await expect(chip).toBeVisible();
    await calendar.evaluate((node) => {
      node.scrollTop = 0;
    });
    // A week of stacked days is taller than the screen, and its first event is in view.
    expect(await calendar.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(200);
    expect(
      await calendar.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const event = node.querySelector('[data-calendar-record]')!.getBoundingClientRect();
        return event.top >= box.top && event.bottom <= box.bottom;
      }),
    ).toBe(true);
    const from = (await chip.boundingBox())!;
    const touch = await dragInput(page, context, browserName, chip, 'touch-pointer');
    try {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2, id: 1 }],
      });
      await expect(page.getByRole('group', { name: 'Time drop targets' }).first()).toBeVisible();
      // Day headings land differently with each engine's font metrics.  Align a real time target
      // with the calendar's edge, then check scrolling beyond this fixture's starting position.
      const edge = await calendar.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const y = Math.round(box.bottom - 20);
        const target = [...node.querySelectorAll<HTMLElement>('.rio-calendar-view__times')].find(
          (target) => target.getBoundingClientRect().bottom >= y,
        );
        if (!target) return null;
        const targetBox = target.getBoundingClientRect();
        node.scrollTop += targetBox.top + targetBox.height / 2 - y;
        return { x: Math.round(targetBox.left + targetBox.width / 2), y };
      });
      expect(edge, 'a day’s time targets reach the calendar’s bottom edge').not.toBeNull();
      expect(
        await page.evaluate(
          (point) => !!document.elementFromPoint(point.x, point.y)?.closest('.rio-calendar-view__times'),
          edge!,
        ),
      ).toBe(true);
      const startingScroll = await calendar.evaluate((node) => node.scrollTop);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...edge!, id: 1 }] });
      await expect.poll(() => calendar.evaluate((node) => node.scrollTop)).toBeGreaterThan(startingScroll);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
  });
});

test('a timeline end resizes on release and Escape cancels the next resize', async ({ page, browser }) => {
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const end = dayAfter(today, 2);
  const database = await createDatabase(page, 'Timeline dragging', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Starts', type: 'date' },
        { name: 'Ends', type: 'date' },
      ],
      records: [{ Name: 'Paint the rail', Starts: today, Ends: end }],
    },
  ]);
  const table = database.tables.Tasks!;
  const viewId = await createView(page, database, 'Tasks', {
    name: 'Schedule',
    type: 'timeline',
    config: { timeline: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends, zoom: 'day' } },
  });
  await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
  const bar = page.getByRole('button', { name: /^Paint the rail / });
  await expect(bar).toBeVisible();
  const resize = async (cancel: boolean) => {
    const edge = (await bar.locator('[data-edge="end"]').boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 80, edge.y + edge.height / 2, { steps: 10 });
    await expect(bar).toHaveAttribute('data-dragging', 'true');
    if (cancel) await page.keyboard.press('Escape');
    else expect((await values(page, viewId, table.records[0]!))[table.fields.Ends!]).toBe(end);
    await page.mouse.up();
  };
  await resize(false);
  const next = dayAfter(end, 2);
  await expect
    .poll(async () => (await values(page, viewId, table.records[0]!))[table.fields.Ends!])
    .toBe(next);
  await resize(true);
  expect((await values(page, viewId, table.records[0]!))[table.fields.Ends!]).toBe(next);
  await page.reload();
  await expect(bar).toBeVisible();
  const touchContext = await browser.newContext({
    hasTouch: true,
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const touchPage = await touchContext.newPage();
    await visit(touchPage, page.url());
    const edge = touchPage.locator('[data-edge="end"]').first();
    await expect(edge).toBeVisible();
    expect((await edge.boundingBox())!.width).toBeGreaterThanOrEqual(24);
  } finally {
    await touchContext.close();
  }
});

test('gallery and list save independent orders and dependency actions add and remove links', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, 'Arranging views', [
    {
      name: 'Work',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Starts', type: 'date' },
        { name: 'Ends', type: 'date' },
      ],
      records: [
        { Name: 'First', Starts: today, Ends: dayAfter(today, 2) },
        { Name: 'Second', Starts: today, Ends: dayAfter(today, 2) },
      ],
    },
  ]);
  const table = database.tables.Work!;
  const gallery = await createView(page, database, 'Work', { name: 'Cards', type: 'gallery' });
  const list = await createView(page, database, 'Work', { name: 'List', type: 'list' });
  const address = (viewId: string) => `${base()}/${database.id}/${table.id}/${viewId}`;
  await page.goto(address(gallery));
  await page.getByRole('gridcell', { name: labelName('Second') }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('gridcell').first()).toHaveAccessibleName(labelName('Second'));
  await page.reload();
  await expect(page.getByRole('gridcell').first()).toHaveAccessibleName(labelName('Second'));
  const firstCard = page.getByRole('gridcell', { name: labelName('Second') });
  const movingCard = page.getByRole('gridcell', { name: labelName('First') });
  expect(await movingCard.evaluate((node) => getComputedStyle(node).userSelect)).toBe('none');
  expect(await movingCard.evaluate((node) => getComputedStyle(node).touchAction)).toBe('manipulation');
  const fromCard = (await movingCard.boundingBox())!;
  const targetCard = (await firstCard.boundingBox())!;
  await page.mouse.move(fromCard.x + fromCard.width / 2, fromCard.y + 30);
  await page.mouse.down();
  await page.mouse.move(targetCard.x + targetCard.width - 10, targetCard.y + 30, { steps: 5 });
  await expect(firstCard).toHaveAttribute('data-rio-drop-side', 'after');
  expect(await firstCard.evaluate((node) => getComputedStyle(node, '::after').width)).toBe('4px');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.goto(address(list));
  await expect(page.getByRole('treeitem').first()).toContainText('First');
  await page.getByRole('treeitem').filter({ hasText: 'Second' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('treeitem').first()).toContainText('Second');

  const dependency = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: dependency,
        name: 'Depends on',
        type: 'link',
        options: { linkedTableId: table.id },
      },
    },
  ]);
  const gantt = await createView(page, database, 'Work', {
    name: 'Dependencies',
    type: 'gantt',
    config: {
      gantt: {
        startFieldId: table.fields.Starts,
        endFieldId: table.fields.Ends,
        dependencyFieldId: dependency,
        zoom: 'day',
      },
    },
  });
  await page.goto(address(gantt));
  const source = page.getByRole('button', { name: /^First / });
  await source.focus();
  await source.dispatchEvent('keydown', { key: '∂', code: 'KeyD', altKey: true });
  const dialog = page.getByRole('dialog', { name: 'Dependencies', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`dependencies=${table.records[0]}`));
  await dialog.getByLabel('Dependent record').selectOption(table.records[1]!);
  await dialog.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect
    .poll(async () => (await values(page, gantt, table.records[1]!))[dependency])
    .toEqual([table.records[0]]);
  await expect(page.locator('.rio-gantt__arrow')).toHaveCount(1);
  await source.focus();
  await source.dispatchEvent('keydown', { key: '∂', code: 'KeyD', altKey: true });
  await dialog.getByRole('button', { name: 'Remove dependency', exact: true }).click();
  await expect.poll(async () => (await values(page, gantt, table.records[1]!))[dependency]).toEqual([]);
  await expect(page.locator('.rio-gantt__arrow')).toHaveCount(0);
  const touchContext = await browser.newContext({
    hasTouch: true,
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const touchPage = await touchContext.newPage();
    await visit(touchPage, address(gantt));
    const handle = touchPage.locator('[data-dependency]').first();
    await expect(handle).toBeVisible();
    const hit = (await handle.boundingBox())!;
    expect(hit.width).toBeGreaterThanOrEqual(24);
    expect(hit.height).toBeGreaterThanOrEqual(24);
  } finally {
    await touchContext.close();
  }
});

test.describe('stable timed calendar targets', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a stationary touch and a small mouse move preserve event dates and day geometry', async ({
    page,
    context,
    browserName,
  }) => {
    await signIn(page);
    const today = new Date().toISOString().slice(0, 10);
    const starts = `${today}T12:00:00.000Z`;
    const database = await createDatabase(page, 'Timed touch scheduling', [
      {
        name: 'Visits',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Starts', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        ],
        records: [{ Name: 'Stationary visit', Starts: starts }],
      },
    ]);
    const table = database.tables.Visits!;
    const viewId = await createView(page, database, 'Visits', {
      name: 'Week',
      type: 'calendar',
      config: { calendar: { startFieldId: table.fields.Starts, range: 'week' } },
    });
    await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
    const chip = page.locator('[data-calendar-record]').filter({ hasText: 'Stationary visit' });
    await chip.scrollIntoViewIfNeeded();
    const day = page.locator(`[data-calendar-day="${today}"]`);
    const geometry = () =>
      page.locator('[data-calendar-day]').evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { top: box.top, height: box.height };
        }),
      );
    const before = await geometry();
    const box = (await chip.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const input = browserName === 'chromium' ? await context.newCDPSession(page) : null;
    if (input) await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    else
      await chip.dispatchEvent('pointerdown', {
        button: 0,
        pointerId: 1,
        pointerType: 'touch',
        clientX: point.x,
        clientY: point.y,
      });
    await expect(page.getByRole('group', { name: 'Time drop targets' }).first()).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect(day).toHaveAttribute('data-rio-drop', 'ready');
    if (input) await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await chip.dispatchEvent('pointerup', { pointerId: 1, clientX: point.x, clientY: point.y });
    await input?.detach();
    expect((await values(page, viewId, table.records[0]!))[table.fields.Starts!]).toBe(starts);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 5, point.y);
    await expect(page.getByRole('group', { name: 'Time drop targets' }).first()).toBeVisible();
    expect(await geometry()).toEqual(before);
    await page.mouse.up();
    expect((await values(page, viewId, table.records[0]!))[table.fields.Starts!]).toBe(starts);
  });
});

for (const type of ['timeline', 'gantt'] as const) {
  test.describe(`${type} short touch bars`, () => {
    test.use({ hasTouch: true });
    test('keeps a central move target between resize handles', async ({ page }) => {
      await signIn(page);
      const today = new Date().toISOString().slice(0, 10);
      const database = await createDatabase(page, 'Short bars', [
        {
          name: 'Tasks',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Starts', type: 'date' },
            { name: 'Ends', type: 'date' },
          ],
          records: [{ Name: 'Short task', Starts: today, Ends: today }],
        },
      ]);
      const table = database.tables.Tasks!;
      const dependency = newId('fld');
      await runCommands(page, database.id, [
        {
          kind: 'field.create',
          tableId: table.id,
          field: {
            id: dependency,
            name: 'Depends on',
            type: 'link',
            options: { linkedTableId: table.id },
          },
        },
      ]);
      const viewId = await createView(page, database, 'Tasks', {
        name: 'Schedule',
        type,
        config: {
          [type]: {
            startFieldId: table.fields.Starts,
            endFieldId: table.fields.Ends,
            zoom: 'day',
            ...(type === 'gantt' ? { dependencyFieldId: dependency } : {}),
          },
        },
      });
      await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
      const bar = page.getByRole('button', { name: /^Short task / });
      await bar.scrollIntoViewIfNeeded();
      const box = (await bar.boundingBox())!;
      expect(box.width).toBe(40);
      const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      for (const offset of [-11, 0, 11]) {
        expect(
          await page.evaluate(
            ({ x, y }) => {
              const node = document.elementFromPoint(x, y);
              return !!node?.closest('.rio-timeline-bar') && !node.closest('[data-edge], [data-dependency]');
            },
            { x: point.clientX + offset, y: point.clientY },
          ),
        ).toBe(true);
      }
      await bar.dispatchEvent('pointerdown', {
        ...point,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'touch',
      });
      await expect(bar).toHaveAttribute('data-dragging', 'true');
      await bar.dispatchEvent('pointermove', {
        ...point,
        clientX: point.clientX + 40,
        buttons: 1,
        pointerId: 1,
        pointerType: 'touch',
      });
      await bar.dispatchEvent('pointerup', {
        ...point,
        clientX: point.clientX + 40,
        pointerId: 1,
        pointerType: 'touch',
      });
      await expect
        .poll(async () => (await values(page, viewId, table.records[0]!))[table.fields.Starts!])
        .toBe(dayAfter(today, 1));
      expect((await values(page, viewId, table.records[0]!))[table.fields.Ends!]).toBe(dayAfter(today, 1));
    });
  });
}

test.describe('gantt dependencies on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a toolbar item opens dependency actions when a short bar hides its diamond', async ({
    page,
    browser,
  }) => {
    await signIn(page);
    const today = new Date().toISOString().slice(0, 10);
    const database = await createDatabase(page, 'Touch dependencies', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Starts', type: 'date' },
          { name: 'Ends', type: 'date' },
        ],
        records: [
          { Name: 'Frame the wall', Starts: today, Ends: today },
          { Name: 'Hang the door', Starts: dayAfter(today, 1), Ends: dayAfter(today, 1) },
        ],
      },
    ]);
    const table = database.tables.Tasks!;
    const dependency = newId('fld');
    await runCommands(page, database.id, [
      {
        kind: 'field.create',
        tableId: table.id,
        field: {
          id: dependency,
          name: 'Depends on',
          type: 'link',
          options: { linkedTableId: table.id },
        },
      },
    ]);
    const viewId = await createView(page, database, 'Tasks', {
      name: 'Plan',
      type: 'gantt',
      config: {
        gantt: {
          startFieldId: table.fields.Starts,
          endFieldId: table.fields.Ends,
          dependencyFieldId: dependency,
          zoom: 'day',
        },
      },
    });
    const address = `${base()}/${database.id}/${table.id}/${viewId}`;
    await assertAccessible(page);
    await visit(page, address);
    await expect(page.getByRole('button', { name: /^Frame the wall / })).toBeVisible();
    await assertAccessible(page);
    const touchContext = await browser.newContext({
      hasTouch: true,
      storageState: await page.context().storageState(),
      serviceWorkers: 'block',
    });
    try {
      const touchPage = await touchContext.newPage();
      await visit(touchPage, address);
      await expect(touchPage.getByRole('button', { name: /^Frame the wall / })).toBeVisible();
      await assertAccessible(touchPage);
      // A one-day bar is too short to show the diamond here, so there's nothing to drag.
      expect(await touchPage.locator('[data-dependency]').count()).toBe(2);
      await expect(touchPage.locator('[data-dependency]').first()).toBeHidden();
      await chooseToolbarItem(touchPage, 'Dependencies');
      const dialog = touchPage.getByRole('dialog', { name: 'Dependencies', exact: true });
      await expect(dialog).toBeVisible();
      await expect(touchPage).toHaveURL(new RegExp(`dependencies=${table.records[0]}`));
      await dialog.getByLabel('Prerequisite record').selectOption(table.records[0]!);
      await dialog.getByLabel('Dependent record').selectOption(table.records[1]!);
      await dialog.getByRole('button', { name: 'Add dependency', exact: true }).click();
      await expect
        .poll(async () => (await values(page, viewId, table.records[1]!))[dependency])
        .toEqual([table.records[0]]);
      await expect(touchPage.locator('.rio-gantt__arrow')).toHaveCount(1);
    } finally {
      await touchContext.close();
    }
    // A phone keeps the same way in, whether the item has room or the More menu holds it.
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      storageState: await page.context().storageState(),
      serviceWorkers: 'block',
    });
    try {
      const phone = await phoneContext.newPage();
      await visit(phone, address);
      await expect(phone.getByRole('button', { name: /^Frame the wall / })).toBeVisible();
      await assertAccessible(phone);
      await chooseToolbarItem(phone, 'Dependencies');
      await expect(phone.getByRole('dialog', { name: 'Dependencies', exact: true })).toBeVisible();
    } finally {
      await phoneContext.close();
    }
  });
});

test('a gallery insertion marker stays above a record color edge', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Colored card order', [
    {
      name: 'Cards',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'First' }, { Name: 'Second' }],
    },
  ]);
  const table = database.tables.Cards!;
  const viewId = await createView(page, database, 'Cards', { name: 'Gallery', type: 'gallery' });
  await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
  const first = page.getByRole('gridcell', { name: labelName('First') });
  const second = page.getByRole('gridcell', { name: labelName('Second') });
  await first.evaluate((node) => node.classList.add('rio-color-edge'));
  const from = (await second.boundingBox())!;
  const target = (await first.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 30);
  await page.mouse.down();
  await page.mouse.move(target.x + 10, target.y + 30, { steps: 5 });
  await expect(first).toHaveAttribute('data-rio-drop-side', 'before');
  expect(
    await first.evaluate(
      (node) =>
        Number(getComputedStyle(node, '::after').zIndex) > Number(getComputedStyle(node, '::before').zIndex),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

import { openNewField } from '../grid-fields';
import { releaseDrag } from '../drag-release';
import { expect, test, type BrowserContext, type JSHandle, type Locator, type Page } from '../accessibility';
import { asOwner, createDatabase, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
  // Drag assertions use English labels while language specs change their own session preferences.
  await page.route('**/api/auth/session', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const session = (await response.json()) as { preferences: { locale?: string } };
    session.preferences.locale = 'en-US';
    await route.fulfill({ response, json: session });
  });
});

type Condition = { id: string; fieldId: string; operator: string };
type Group = { id?: string; conjunction: string; conditions: Array<Condition | Group> };

async function setup(page: Page, legacy = false, extraField = false) {
  await signIn(page);
  const database = await createDatabase(page, 'Arrange filters', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
        { name: 'Notes', type: 'text' },
        ...(extraField ? [{ name: 'Priority', type: 'number' }] : []),
      ],
      records: [{ Name: 'First', Status: 'Ready', Notes: 'Review' }],
    },
  ]);
  const table = database.tables.Projects!;
  const condition = (id: string, field: string): Condition => ({
    id,
    fieldId: table.fields[field]!,
    operator: 'isNotEmpty',
  });
  const filter: Group = {
    conjunction: 'and',
    conditions: [
      condition('name', 'Name'),
      {
        ...(legacy ? {} : { id: 'outer' }),
        conjunction: 'or',
        conditions: [
          condition('status', 'Status'),
          {
            ...(legacy ? {} : { id: 'inner' }),
            conjunction: 'and',
            conditions: [condition('notes', 'Notes')],
          },
        ],
      },
    ],
  };
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        filter,
        sorts: [
          { fieldId: table.fields.Name, direction: 'asc' },
          { fieldId: table.fields.Status, direction: 'asc' },
        ],
      },
    },
  ]);
  await openTable(page, database, 'Projects');
  async function saved() {
    const schema = await asOwner<{
      views: Array<{ id: string; config: { filter: Group; sorts: Array<{ fieldId: string }> } }>;
    }>(page, 'GET', `/api/databases/${database.id}/schema`);
    return schema.views.find((view) => view.id === table.viewId)!.config;
  }
  return { database, table, filter, saved };
}

async function point(locator: Locator, fraction = 0.5) {
  await locator.scrollIntoViewIfNeeded();
  return measuredPoint(locator, fraction);
}

async function measuredPoint(locator: Locator, fraction = 0.5) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + Math.min(box!.width / 2, 70), y: box!.y + box!.height * fraction };
}

async function mouseDrag(page: Page, handle: Locator, destination: Locator, fraction = 0.5) {
  const to = await point(destination, fraction);
  const from = await point(handle);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y, { steps: 3 });
  await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.locator('[data-drop-before]')).toHaveCount(1);
  await releaseDrag(
    destination,
    (point) => page.mouse.move(point.x, point.y),
    () => page.mouse.up(),
    {
      measure: () => measuredPoint(destination, fraction),
    },
  );
  await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
}

async function pointerInput(page: Page, context: BrowserContext) {
  const session =
    context.browser()?.browserType().name() === 'chromium' ? await context.newCDPSession(page) : null;
  type Point = { x: number; y: number; id: number };
  let touchTarget: JSHandle<Element | null> | undefined;
  let previousPoints: Point[] = [];
  return {
    async touch(input: { type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: Point[] }) {
      if (session) {
        await session.send('Input.dispatchTouchEvent', input);
        return;
      }
      if (input.type === 'touchStart') {
        await touchTarget?.dispose();
        touchTarget = await page.evaluateHandle(
          ({ x, y }) => document.elementFromPoint(x, y),
          input.touchPoints[0]!,
        );
      }
      await page.evaluate(
        ({ target, input, previousPoints }) => {
          if (!target) throw new Error('The touch must start on a mounted element');
          // WebKit does not construct Touch objects.  Pointer coordinates and touch lists exercise
          // the same touch sensor, including its hold delay, movement tolerance, and drop bounds.
          const touch = (point: Point) => ({
            identifier: point.id,
            target,
            clientX: point.x,
            clientY: point.y,
            pageX: point.x + window.scrollX,
            pageY: point.y + window.scrollY,
          });
          const touches = input.touchPoints.map(touch);
          const point = (input.touchPoints[0] ?? previousPoints[0])!;
          const event = new PointerEvent(input.type.toLowerCase(), {
            bubbles: true,
            cancelable: true,
            pointerId: point.id,
            pointerType: 'touch',
            isPrimary: true,
            clientX: point.x,
            clientY: point.y,
          });
          Object.defineProperties(event, {
            touches: { value: touches },
            targetTouches: { value: touches },
            changedTouches: { value: input.type === 'touchEnd' ? previousPoints.map(touch) : touches },
          });
          target.dispatchEvent(event);
        },
        { target: touchTarget!, input, previousPoints },
      );
      previousPoints = input.touchPoints;
    },
    async pen(input: {
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
      x: number;
      y: number;
      button?: 'left';
      buttons?: number;
      clickCount?: number;
      pointerType: 'pen';
    }) {
      if (session) {
        await session.send('Input.dispatchMouseEvent', input);
        return;
      }
      await page.evaluate((input) => {
        const target = document.elementFromPoint(input.x, input.y) ?? document;
        target.dispatchEvent(
          new PointerEvent(
            input.type === 'mousePressed'
              ? 'pointerdown'
              : input.type === 'mouseReleased'
                ? 'pointerup'
                : 'pointermove',
            {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: 'pen',
              isPrimary: true,
              clientX: input.x,
              clientY: input.y,
              button: 0,
              buttons: input.buttons ?? 0,
            },
          ),
        );
      }, input);
    },
    async detach() {
      await session?.detach();
      await touchTarget?.dispose();
    },
  };
}

test('moves a condition into a nested group and back out, moves a whole group, and shares one undoable drop', async ({
  page,
  context,
}) => {
  const { filter, saved } = await setup(page);
  const peer = await context.newPage();
  try {
    await visit(peer, page.url());
    await peer.getByRole('button', { name: 'Filtered by 3 fields' }).click();
    await page.getByRole('button', { name: 'Filtered by 3 fields' }).click();
    const panel = page.getByRole('dialog', { name: 'Filtered by 3 fields' });
    const nested = panel.locator('.rio-view-group-header').nth(1);
    await panel.getByRole('button', { name: 'Move Status', exact: true }).click({ trial: true });
    const originalBox = await panel.getByRole('button', { name: 'Move Status', exact: true }).boundingBox();
    const to = await point(nested);
    const from = await point(panel.getByRole('button', { name: 'Move Name', exact: true }));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y);
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await expect(page.locator('[data-drop-before]')).toHaveCount(1);
    expect(await panel.getByRole('button', { name: 'Move Status', exact: true }).boundingBox()).toEqual(
      originalBox,
    );
    expect((await saved()).filter).toEqual(filter);
    await releaseDrag(
      nested,
      (point) => page.mouse.move(point.x, point.y),
      () => page.mouse.up(),
      {
        measure: () => measuredPoint(nested),
        highlight: panel.locator('[data-sortable-container="group:inner"]'),
      },
    );
    await expect
      .poll(async () => {
        const group = (await saved()).filter.conditions[0] as Group;
        return (group.conditions?.[1] as Group | undefined)?.conditions.map((entry) =>
          'fieldId' in entry ? entry.id : 'group',
        );
      })
      .toEqual(['notes', 'name']);
    await expect(
      peer.locator('.rio-view-filter-group').nth(2).getByRole('button', { name: 'Move Name', exact: true }),
    ).toBeVisible();
    await mouseDrag(
      page,
      panel.getByRole('button', { name: 'Move Name', exact: true }),
      panel.locator('[data-sortable-container="$root"]'),
    );
    await expect
      .poll(async () =>
        (await saved()).filter.conditions.map((entry) => ('fieldId' in entry ? entry.id : 'group')),
      )
      .toEqual(['group', 'name']);
    const beforeGroup = (await saved()).filter;
    const header = panel.locator('.rio-view-group-header').first();
    await mouseDrag(
      page,
      header.locator('.rio-sortable-handle'),
      panel.locator('[data-sortable-container="$root"]'),
    );
    await expect
      .poll(async () => (await saved()).filter.conditions)
      .toEqual([beforeGroup.conditions[1], beforeGroup.conditions[0]]);
    await panel.press('Escape');
    await page.getByRole('button', { name: 'Undo history', exact: true }).click();
    const history = page.getByRole('listbox', { name: 'Changes to undo, newest first' });
    await expect(history.getByRole('option')).toHaveCount(3);
    await history.getByRole('option').first().click();
    await expect.poll(async () => (await saved()).filter).toEqual(beforeGroup);
  } finally {
    await peer.close();
  }
});

test('picks up a sort with the keyboard, previews, cancels, and drops once', async ({ page }) => {
  const { table, saved } = await setup(page);
  await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
  const panel = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
  const handle = panel.getByRole('button', { name: 'Move sort', exact: true }).first();
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Picked up Name');
  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Name, position 2');
  expect((await saved()).sorts.map((sort) => sort.fieldId)).toEqual([table.fields.Name, table.fields.Status]);
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Canceled moving Name');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Picked up Name');
  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Name, position 2');
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await saved()).sorts.map((sort) => sort.fieldId))
    .toEqual([table.fields.Status, table.fields.Name]);
  await expect(panel.getByRole('button', { name: 'Move sort', exact: true }).nth(1)).toBeFocused();
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Dropped Name, position 2');
});

test.describe('phone touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const side of ['below', 'left', 'right'] as const) {
    test(`cancels a touch release ${side === 'below' ? side : `${side} of`} a scrolled overflowing filter panel`, async ({
      page,
      context,
    }) => {
      await page.route('**/api/ai/footprint/mine', (route) =>
        route.fulfill({
          json: {
            used: true,
            month: `${new Date().toISOString().slice(0, 7)}-01`,
            calls: 1,
            estimatedCalls: 1,
            pricedCalls: 0,
            costUsd: 0,
            energyWh: { min: 0.1, max: 0.1 },
            gwpG: { min: 0.06, max: 0.06 },
            byFeature: [],
          },
        }),
      );
      const { database, table, saved } = await setup(page);
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
      const conversation = page.locator('.rio-assistant__panel');
      await expect(conversation.getByRole('button', { name: /^Your AI use this month:/ })).toBeVisible();
      await conversation.getByRole('button', { name: 'Close Rio', exact: true }).click();
      await runCommands(page, database.id, [
        {
          kind: 'view.update',
          viewId: table.viewId,
          config: {
            filter: {
              conjunction: 'and',
              conditions: Array.from({ length: 24 }, (_, index) => ({
                id: `condition-${index}`,
                fieldId: table.fields[['Name', 'Status', 'Notes'][index % 3]!],
                operator: 'isNotEmpty',
              })),
            },
          },
        },
      ]);
      const before = (await saved()).filter;
      await page.getByRole('button', { name: 'Filtered by 3 fields' }).click();
      const panel = page.getByRole('dialog', { name: 'Filtered by 3 fields' });
      const popover = page.locator('.rio-view-popover');
      const scrollArea = popover.locator('.rio-popover__content');
      await expect(panel.locator('.rio-sortable-item')).toHaveCount(24);
      await scrollArea.evaluate((element) => {
        element.scrollTop = 200;
      });
      expect(await scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const bounds = (await popover.boundingBox())!;
      const outsideY = Math.min(bounds.y + bounds.height + 40, 842);
      let rows = await panel
        .locator('.rio-sortable-item')
        .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
      if (side === 'below') {
        // A wrapped header can put the release point between rows.  Align a clipped row with it
        // so the gesture still proves that an out-of-panel row cannot receive the drop.
        const clipped = rows.find((row) => row.bottom > outsideY);
        expect(clipped).toBeDefined();
        await scrollArea.evaluate(
          (element, adjustment) => {
            element.scrollTop += adjustment;
          },
          clipped!.y + clipped!.height / 2 - outsideY,
        );
        rows = await panel
          .locator('.rio-sortable-item')
          .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
      }
      const first = rows.findIndex((row) => row.y > bounds.y + 60);
      const handle = panel.locator('.rio-sortable-handle').nth(first);
      const target = panel.locator('.rio-sortable-item').nth(first + 1);
      await handle.scrollIntoViewIfNeeded();
      await target.evaluate((element) =>
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }),
      );
      // Revealing the destination can scroll the source.  Measure both after they are in view.
      const from = await measuredPoint(handle);
      const to = await measuredPoint(target, 0.85);
      const outside = {
        x: side === 'left' ? 1 : side === 'right' ? 389 : to.x,
        y: side === 'below' ? outsideY : to.y,
        id: 1,
      };
      if (side === 'below') {
        expect(outside.y).toBeGreaterThan(bounds.y + bounds.height);
        expect(rows.some((row) => row.y <= outside.y && row.bottom >= outside.y)).toBe(true);
      }
      const session = await pointerInput(page, context);
      const release = await popover.evaluateHandle((element, side) => {
        let outside = false;
        const record = (event: TouchEvent) => {
          const contact = event.changedTouches[0];
          if (!contact) return;
          const { clientX: x, clientY: y } = contact;
          const { left, right, bottom } = element.getBoundingClientRect();
          const hit = document.elementFromPoint(x, y);
          outside =
            !!hit &&
            !element.contains(hit) &&
            (side === 'below' ? y > bottom : side === 'left' ? x < left : x > right);
        };
        window.addEventListener('touchend', record, { capture: true, once: true });
        return {
          isOutside: () => outside,
          dispose: () => window.removeEventListener('touchend', record, true),
        };
      }, side);
      try {
        await session.touch({
          type: 'touchStart',
          touchPoints: [{ ...from, id: 1 }],
        });
        await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
        await session.touch({ type: 'touchMove', touchPoints: [{ ...to, id: 1 }] });
        await expect(panel.locator('[data-drop-before]')).toHaveCount(1);
        await session.touch({ type: 'touchMove', touchPoints: [outside] });
        await session.touch({ type: 'touchEnd', touchPoints: [] });
        expect(await release.evaluate(({ isOutside }) => isOutside())).toBe(true);
        await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
        await expect(panel.locator('.rio-sortable-announcement')).toContainText('Canceled moving');
        expect((await saved()).filter).toEqual(before);
      } finally {
        await release.evaluate(({ dispose }) => dispose());
        await release.dispose();
        await session.detach();
      }
    });
  }

  test('cancels a touch release outside the popover after previewing a move', async ({ page, context }) => {
    const { saved } = await setup(page);
    const before = await saved();
    await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
    const panel = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
    const from = await point(panel.getByRole('button', { name: 'Move sort', exact: true }).first());
    const to = await point(panel.locator('.rio-sortable-item').last(), 0.85);
    const session = await pointerInput(page, context);
    try {
      await session.touch({
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
      await session.touch({ type: 'touchMove', touchPoints: [{ ...to, id: 1 }] });
      await expect(panel.locator('.rio-sortable-announcement')).toContainText('Name, position 2');
      const bounds = await panel.boundingBox();
      const outside = { x: 195, y: bounds!.y > 180 ? 80 : 780, id: 1 };
      await session.touch({ type: 'touchMove', touchPoints: [outside] });
      await session.touch({ type: 'touchEnd', touchPoints: [] });
      await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
      await expect(panel.locator('.rio-sortable-announcement')).toContainText('Canceled moving Name');
      expect((await saved()).sorts).toEqual(before.sorts);
    } finally {
      await session.detach();
    }
  });

  test('holds a sort grip and drags with touch at phone width', async ({ page, context }) => {
    const { table, saved } = await setup(page);
    await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
    const panel = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
    const from = await point(panel.getByRole('button', { name: 'Move sort', exact: true }).first());
    const to = await point(panel.locator('.rio-sortable-item').nth(1), 0.85);
    const session = await pointerInput(page, context);
    try {
      await session.touch({
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
      for (let step = 1; step <= 10; step++)
        await session.touch({
          type: 'touchMove',
          touchPoints: [
            { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10, id: 1 },
          ],
        });
      await expect(page.locator('[data-drop-before]')).toHaveCount(1);
      const destination = panel.locator('.rio-sortable-item').nth(1);
      await releaseDrag(
        destination,
        (point) => session.touch({ type: 'touchMove', touchPoints: [{ ...point, id: 1 }] }),
        () => session.touch({ type: 'touchEnd', touchPoints: [] }),
        {
          measure: () => measuredPoint(destination, 0.85),
          highlight: panel.locator('[data-sortable-container="$root"]'),
          event: 'touchend',
        },
      );
      await expect
        .poll(async () => (await saved()).sorts.map((sort) => sort.fieldId))
        .toEqual([table.fields.Status, table.fields.Name]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await panel.press('Escape');
      await page.getByRole('button', { name: 'Filtered by 3 fields' }).click();
      const filters = page.getByRole('dialog', { name: 'Filtered by 3 fields' });
      await expect(filters.getByRole('button', { name: 'Move Notes', exact: true })).toBeVisible();
      expect(await filters.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    } finally {
      await session.detach();
    }
  });
});

test('keeps an unsaved choice dialog open when Escape cancels a pointer drag', async ({ page }) => {
  await setup(page);
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await dialog.getByRole('button', { name: /Type$/ }).click();
  await page.getByRole('option', { name: 'Single select', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Draft choices');
  for (const name of ['First', 'Second']) {
    await dialog.getByRole('button', { name: 'Add option' }).click();
    await dialog.getByRole('textbox', { name: 'Option name', exact: true }).last().fill(name);
  }
  const from = await point(dialog.getByRole('button', { name: 'Move First', exact: true }));
  const to = await point(dialog.locator('.rio-sortable-item').last(), 0.85);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
  await page.mouse.up();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Draft choices');
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).first()).toHaveValue(
    'First',
  );
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).last()).toHaveValue(
    'Second',
  );
  await dialog.getByRole('textbox', { name: 'Option name', exact: true }).first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).first()).toHaveValue(
    'First',
  );
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).first()).toBeFocused();
  await dialog.getByRole('button', { name: 'Move First', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).first()).toHaveValue(
    'Second',
  );
  await expect(dialog.getByRole('textbox', { name: 'Option name', exact: true }).last()).toHaveValue('First');
  await expect(dialog.getByRole('button', { name: 'Move First', exact: true })).toBeFocused();
});

test('accepts a release on the insertion line in a row gap', async ({ page }) => {
  const { database, table, saved } = await setup(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        sorts: ['Name', 'Status', 'Notes'].map((name) => ({ fieldId: table.fields[name], direction: 'asc' })),
      },
    },
  ]);
  await page.getByRole('button', { name: 'Sorted by 3 fields' }).click();
  const panel = page.getByRole('dialog', { name: 'Sorted by 3 fields' });
  const from = await point(panel.getByRole('button', { name: 'Move sort', exact: true }).first());
  const third = await panel.locator('.rio-sortable-item').nth(2).boundingBox();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y);
  await page.mouse.move(third!.x + 70, third!.y - 4, { steps: 10 });
  await expect(page.locator('[data-drop-before]')).toHaveCount(1);
  const destination = panel.locator('.rio-sortable-item').nth(2);
  await releaseDrag(
    destination,
    (point) => page.mouse.move(point.x, point.y),
    () => page.mouse.up(),
    {
      measure: async () => {
        const point = await measuredPoint(destination, 0);
        return { x: point.x, y: point.y - 4 };
      },
      highlight: destination,
    },
  );
  await expect
    .poll(async () => (await saved()).sorts.map((sort) => sort.fieldId))
    .toEqual([table.fields.Status, table.fields.Name, table.fields.Notes]);
});

test('reorders after a pen hold while ordinary contact can scroll', async ({ page, context }) => {
  const { table, saved } = await setup(page);
  await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
  const panel = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
  const handle = panel.getByRole('button', { name: 'Move sort', exact: true }).first();
  await expect(handle).toHaveCSS('touch-action', 'manipulation');
  const from = await point(handle);
  const to = await point(panel.locator('.rio-sortable-item').last(), 0.85);
  const session = await pointerInput(page, context);
  try {
    await session.pen({ type: 'mouseMoved', ...from, pointerType: 'pen' });
    await session.pen({
      type: 'mousePressed',
      ...from,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'pen',
    });
    await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
    await page.waitForTimeout(250);
    await session.pen({
      type: 'mouseMoved',
      x: from.x + 8,
      y: from.y,
      buttons: 1,
      pointerType: 'pen',
    });
    await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
    await session.pen({
      type: 'mouseMoved',
      ...to,
      buttons: 1,
      pointerType: 'pen',
    });
    await expect(page.locator('[data-drop-before]')).toHaveCount(1);
    const destination = panel.locator('.rio-sortable-item').last();
    await releaseDrag(
      destination,
      (point) => session.pen({ type: 'mouseMoved', ...point, buttons: 1, pointerType: 'pen' }),
      (point) =>
        session.pen({
          type: 'mouseReleased',
          ...point,
          button: 'left',
          clickCount: 1,
          pointerType: 'pen',
        }),
      {
        measure: () => measuredPoint(destination, 0.85),
        highlight: panel.locator('[data-sortable-container="$root"]'),
      },
    );
    await expect
      .poll(async () => (await saved()).sorts.map((sort) => sort.fieldId))
      .toEqual([table.fields.Status, table.fields.Name]);
  } finally {
    await session.detach();
  }
});

for (const theme of ['nature', 'system-7'])
  test.describe(theme === 'nature' ? 'phone filter touch' : 'phone filter touch in System 7', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/auth/session', async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const session = (await response.json()) as { preferences: { locale?: string; theme?: string } };
        session.preferences = { ...session.preferences, locale: 'en-US', theme };
        await route.fulfill({ response, json: session });
      });
    });
    test('moves a condition into a nested group with touch', async ({ page, context }) => {
      const { saved } = await setup(page);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.getByRole('button', { name: 'Filtered by 3 fields' }).click();
      const panel = page.getByRole('dialog', { name: 'Filtered by 3 fields' });
      const target = panel.locator('.rio-view-group-header').nth(1);
      const from = await point(panel.getByRole('button', { name: 'Move Name', exact: true }));
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      const viewport = page.locator('.rio-view-popover .rio-popover__content');
      const popover = await viewport.boundingBox();
      expect(popover).not.toBeNull();
      const safeTop = popover!.y + popover!.height * 0.3;
      const safeBottom = popover!.y + popover!.height * 0.65;
      const center = box!.y + box!.height / 2;
      const to = {
        x: box!.x + Math.min(box!.width / 2, 70),
        y: center > safeBottom ? popover!.y + popover!.height * 0.85 : center,
      };
      const session = await pointerInput(page, context);
      try {
        await session.touch({
          type: 'touchStart',
          touchPoints: [{ ...from, id: 1 }],
        });
        await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
        for (let step = 1; step <= 10; step++)
          await session.touch({
            type: 'touchMove',
            touchPoints: [
              { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10, id: 1 },
            ],
          });
        // Sample each frame so a coarse poll cannot scroll the header past the middle and
        // move the finger into the opposite scrolling edge before the release.
        await page.waitForFunction(
          ({ header, viewport }) => {
            const row = header!.getBoundingClientRect();
            const bounds = viewport!.getBoundingClientRect();
            return row.y + row.height / 2 <= bounds.y + bounds.height * 0.65;
          },
          { header: await target.elementHandle(), viewport: await viewport.elementHandle() },
          { polling: 'raf', timeout: 10_000 },
        );
        await expect(async () => {
          const destination = await target.boundingBox();
          const center = destination!.y + destination!.height / 2;
          expect(center).toBeGreaterThan(safeTop);
          expect(center).toBeLessThanOrEqual(safeBottom);
          await session.touch({
            type: 'touchMove',
            touchPoints: [
              {
                x: destination!.x + Math.min(destination!.width / 2, 70),
                y: destination!.y + destination!.height / 2,
                id: 1,
              },
            ],
          });
          await expect(panel.locator('[data-sortable-container="group:inner"]')).toHaveAttribute(
            'data-drop-before',
            'true',
            { timeout: 200 },
          );
          // The highlighted destination must stay put until the native touch ends.
          expect((await target.boundingBox())!.y).toBe(destination!.y);
        }).toPass({ timeout: 5_000, intervals: [50, 100] });
        await releaseDrag(
          target,
          (point) => session.touch({ type: 'touchMove', touchPoints: [{ ...point, id: 1 }] }),
          () => session.touch({ type: 'touchEnd', touchPoints: [] }),
          {
            measure: () => measuredPoint(target),
            highlight: panel.locator('[data-sortable-container="group:inner"]'),
            event: 'touchend',
          },
        );
        await expect
          .poll(async () => {
            const outer = (await saved()).filter.conditions[0] as Group;
            return (outer.conditions?.[1] as Group | undefined)?.conditions?.map((entry) =>
              'fieldId' in entry ? entry.id : 'group',
            );
          })
          .toEqual(['notes', 'name']);
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      } finally {
        await session.detach();
      }
    });
  });

for (const legacy of [false, true]) {
  test(`keeps a ${legacy ? 'legacy ' : ''}group drag active while a peer adds a condition to that group`, async ({
    page,
    context,
  }) => {
    const { filter, saved } = await setup(page, legacy);
    const peer = await context.newPage();
    try {
      await visit(peer, page.url());
      await page.getByRole('button', { name: 'Filtered by 3 fields' }).click();
      await peer.getByRole('button', { name: 'Filtered by 3 fields' }).click();
      const panel = page.getByRole('dialog', { name: 'Filtered by 3 fields' });
      const header = panel.locator('.rio-view-group-header').first();
      const from = await point(header.locator('.rio-sortable-handle'));
      const destination = await point(panel.locator('.rio-view-condition-entry').first(), 0.1);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 8, from.y);
      await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
      await peer
        .locator('.rio-view-filter-group')
        .nth(1)
        .locator(':scope > .rio-view-actions')
        .getByRole('button', { name: 'Add condition', exact: true })
        .click();
      await expect(panel.getByRole('button', { name: 'Move Name', exact: true })).toHaveCount(2);
      const updated = (await saved()).filter.conditions[1] as Group;
      expect(updated.conditions).toHaveLength(3);
      await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
      await page.mouse.move(destination.x, destination.y, { steps: 10 });
      const target = panel.locator('.rio-view-condition-entry').first();
      await releaseDrag(
        target,
        (point) => page.mouse.move(point.x, point.y),
        () => page.mouse.up(),
        {
          measure: () => measuredPoint(target, 0.1),
          highlight: target,
        },
      );
      await expect
        .poll(async () => (await saved()).filter.conditions)
        .toEqual([updated, filter.conditions[0]]);
    } finally {
      await peer.close();
    }
  });
}

test('keeps a keyboard destination attached to its row while a peer inserts a sort', async ({ page }) => {
  const { database, table, saved } = await setup(page, false, true);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        sorts: ['Name', 'Status', 'Notes'].map((name) => ({ fieldId: table.fields[name], direction: 'asc' })),
      },
    },
  ]);
  await page.getByRole('button', { name: 'Sorted by 3 fields' }).click();
  const panel = page.getByRole('dialog', { name: 'Sorted by 3 fields' });
  await panel.getByRole('button', { name: 'Move sort', exact: true }).first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('.rio-sortable-announcement')).toContainText('Name, position 2');
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        sorts: ['Name', 'Priority', 'Status', 'Notes'].map((name) => ({
          fieldId: table.fields[name],
          direction: 'asc',
        })),
      },
    },
  ]);
  const updatedPanel = page.getByRole('dialog', { name: 'Sorted by 4 fields' });
  await expect(updatedPanel.locator('.rio-sortable-item')).toHaveCount(4);
  await expect(updatedPanel.locator('[data-drop-before]')).toHaveAttribute(
    'data-sortable-id',
    table.fields.Notes!,
  );
  await expect(updatedPanel.locator('.rio-sortable-announcement')).toContainText('Name, position 3');
  await page.keyboard.press('ArrowUp');
  await expect(updatedPanel.locator('[data-drop-before]')).toHaveAttribute(
    'data-sortable-id',
    table.fields.Status!,
  );
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await saved()).sorts.map((sort) => sort.fieldId))
    .toEqual([table.fields.Priority, table.fields.Name, table.fields.Status, table.fields.Notes]);
});

test('explains locked grips across the view editors', async ({ page }) => {
  const { database, table } = await setup(page);
  await runCommands(page, database.id, [
    { kind: 'view.update', viewId: table.viewId, config: { locked: true } },
  ]);
  await expect(page.getByRole('button', { name: 'Unlock view', exact: true })).toBeVisible();
  for (const name of ['Filtered by 3 fields', 'Sorted by 2 fields', 'Hide fields']) {
    await page.getByRole('button', { name, exact: true }).click();
    const panel = page.getByRole('dialog', { name });
    for (const handle of await panel.locator('.rio-sortable-handle').all()) {
      await expect(handle).toBeDisabled();
      await expect(handle).toHaveAttribute('title', 'This view is locked.');
    }
    await page.keyboard.press('Escape');
  }
});

test('moves a repeated legacy condition ID from its own group and restores focus', async ({ page }) => {
  const { database, table, saved } = await setup(page);
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        filter: {
          conjunction: 'and',
          conditions: ['Name', 'Status'].map((name) => ({
            id: 'repeated',
            conjunction: 'and',
            conditions: [{ id: 'same', fieldId: table.fields[name], operator: 'isNotEmpty' }],
          })),
        },
      },
    },
  ]);
  await page.getByRole('button', { name: 'Filtered by 2 fields' }).click();
  const panel = page.getByRole('dialog', { name: 'Filtered by 2 fields' });
  const handles = await panel
    .locator('.rio-sortable-handle')
    .evaluateAll((items) => items.map((item) => item.id));
  expect(new Set(handles).size).toBe(handles.length);
  await panel.getByRole('button', { name: 'Move Status', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(async () => (await saved()).filter.conditions.at(-1))
    .toMatchObject({ fieldId: table.fields.Status });
  await expect(panel.getByRole('button', { name: 'Move Status', exact: true })).toBeFocused();
});

for (const orientation of ['horizontal', 'grid']) {
  test(`reserves the end zone in a ${orientation} flex layout before pickup`, async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Sorted by 2 fields' }).click();
    const panel = page.getByRole('dialog', { name: 'Sorted by 2 fields' });
    // Exercise the shared styles in both host layouts without changing the saved view
    await page.evaluate(() => document.fonts.ready);
    await panel.locator('.rio-view-editor').evaluate((editor, orientation) => {
      const host = editor as HTMLElement;
      host.style.setProperty('--rio-sortable-test-width', `${host.getBoundingClientRect().width}px`);
      host.style.inlineSize = 'var(--rio-sortable-test-width)';
      host.style.display = 'flex';
      host.style.flexDirection = 'row';
      host.style.flexWrap = orientation === 'grid' ? 'wrap' : 'nowrap';
      for (const node of host.querySelectorAll<HTMLElement>('.rio-sortable-item, .rio-sortable-end')) {
        node.dataset.orientation = orientation;
        node.style.flexShrink = '0';
      }
    }, orientation);
    const geometry = () =>
      panel
        .locator('.rio-sortable-item, .rio-sortable-end')
        .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
    await panel.getByRole('button', { name: 'Move sort', exact: true }).first().focus();
    // Let the popover settle after its host changes size and focus scrolls into view
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const before = await geometry();
    await page.keyboard.press('Space');
    await expect(panel.locator('.rio-sortable-end')).toHaveAttribute('data-active', 'true');
    expect(await geometry()).toEqual(before);
    await page.keyboard.press('Escape');
    expect(await geometry()).toEqual(before);
  });
}

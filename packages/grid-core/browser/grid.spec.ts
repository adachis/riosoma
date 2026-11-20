import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]')).toHaveText('Record 1');
}

async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test.beforeEach(async ({ page }) => ready(page));

test('reorders headers before the first record is added', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.update({ rowCount: 0 }));
  await settle(page);
  const from = (await page.locator('[data-rio-column="1"]').boundingBox())!;
  const target = (await page.locator('[data-rio-column="3"]').boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(target.x + 40, target.y + 16, { steps: 5 });
  await expect(page.locator('[data-rio-column="1"]')).toHaveText('Field 2');
  await page.mouse.up();
  await expect(page.locator('[data-rio-column="3"]')).toHaveText('Field 2');
});

test('reaches the millionth row and last column through the public API', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 999_999, col: 19 }, 'start'));
  await expect(page.locator('[role="gridcell"][data-rio-row="999999"][data-rio-col="0"]')).toHaveText(
    'Record 1000000',
  );
  await expect(page.locator('[role="gridcell"][data-rio-row="999999"][data-rio-col="19"]')).toBeVisible();
  // The header, a million records, and the add-record row
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '1000002');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '20');
  await expect(page.locator('[role="row"][data-rio-row="999999"]')).toHaveAttribute(
    'aria-rowindex',
    '1000001',
  );
  await expect(page.locator('[role="gridcell"][data-rio-row="999999"][data-rio-col="19"]')).toHaveAttribute(
    'aria-colindex',
    '20',
  );
  const bounds = await page.locator('.rio-grid__spacer').evaluate((el) => el.getBoundingClientRect().height);
  expect(bounds).toBe(8_000_000);
  await page.getByRole('button', { name: 'Add row' }).click();
  expect(await page.evaluate(() => window.gridDemo.added)).toBe(1);
});

test('native scrollbar thumb dragging reaches the final row', async ({ page }) => {
  // Explicit native scrollbar dimensions make the drag reproducible on hosts with overlay scrollbars.
  await page.addStyleTag({
    content:
      '@layer rio.components { .rio-grid__scroller::-webkit-scrollbar { inline-size: 16px; block-size: 16px; } .rio-grid__scroller::-webkit-scrollbar-thumb { background: var(--rio-aa-text-muted); } .rio-grid__scroller::-webkit-scrollbar-track { background: var(--rio-surface); } }',
  });
  await settle(page);
  const bar = await page.locator('.rio-grid__scroller').evaluate((el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.right - (el.offsetWidth - el.clientWidth) / 2,
      top: rect.top,
      bottom: rect.bottom,
      gutter: el.offsetWidth - el.clientWidth,
    };
  });
  expect(bar.gutter).toBeGreaterThan(0);
  await page.mouse.move(bar.x, bar.top + 10);
  await page.mouse.down();
  await page.mouse.move(bar.x, bar.bottom - 20, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator('[role="gridcell"][data-rio-row="999999"][data-rio-col="0"]')).toHaveText(
    'Record 1000000',
  );
});

test('wheel input preserves exact content pixels and fractional deltas above the cap', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 1000 }, 'start'));
  await settle(page);
  await page.locator('.rio-grid__viewport').hover();
  await page.mouse.wheel(0, 32);
  await expect.poll(() => page.evaluate(() => window.gridDemo.grid.getVisibleRange().firstRow)).toBe(1001);
  await settle(page);
  const cell = page.locator('[role="gridcell"][data-rio-row="1001"][data-rio-col="0"]');
  const before = (await cell.boundingBox())!.y;
  await page.evaluate(() => {
    const target = document.querySelector('.rio-grid__viewport')!;
    for (let step = 0; step < 8; step++)
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: 0.125, bubbles: true, cancelable: true }));
  });
  await settle(page);
  expect((await cell.boundingBox())!.y).toBeCloseTo(before - 1, 3);
  expect(await page.evaluate(() => window.gridDemo.grid.anchorRow())).toBe(1002);
});

test('keeps header and frozen cells fixed, and reuses a bounded DOM pool', async ({ page }) => {
  const header = page.locator('[data-rio-column="0"]');
  const first = await header.boundingBox();
  const originalNode = await page
    .locator('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]')
    .elementHandle();
  for (const row of [200, 900_000, 50, 999_999, 0]) {
    await page.evaluate((row) => window.gridDemo.grid.scrollToCell({ row, col: 19 }, 'start'), row);
    await settle(page);
    expect(await page.getByRole('gridcell').count()).toBeLessThan(400);
    expect(await page.getByRole('row').count()).toBeLessThan(30);
    expect(await header.boundingBox()).toEqual(first);
    expect(await originalNode!.evaluate((node) => node.isConnected)).toBe(true);
  }
});

test('resizes live, clamps the minimum, and commits on release', async ({ page }) => {
  const header = page.locator('[data-rio-column="1"]');
  const handle = header.locator('[data-rio-resize]');
  const start = (await handle.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + 16);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 48, start.y + 16, { steps: 4 });
  await expect
    .poll(() => page.evaluate(() => window.gridDemo.resizes.some((resize) => !resize.final)))
    .toBe(true);
  await page.mouse.up();
  expect(await page.evaluate(() => window.gridDemo.resizes.at(-1))).toEqual({
    id: 'field-1',
    width: 192,
    final: true,
  });
  expect((await header.boundingBox())!.width).toBe(192);
  const resized = (await handle.boundingBox())!;
  await page.mouse.move(resized.x + resized.width / 2, resized.y + 16);
  await page.mouse.down();
  await page.mouse.move(resized.x - 500, resized.y + 16, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => header.evaluate((el) => el.getBoundingClientRect().width)).toBe(60);
  expect(await page.evaluate(() => window.gridDemo.resizes.at(-1)?.width)).toBe(60);
});

test('shows a drop indicator and reorders within the frozen boundary', async ({ page }) => {
  const from = (await page.locator('[data-rio-column="1"]').boundingBox())!;
  const target = (await page.locator('[data-rio-column="3"]').boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 20, target.y + 16, { steps: 8 });
  await expect(page.locator('.rio-grid__drop-indicator')).toBeVisible();
  expect(await page.evaluate(() => window.gridDemo.moves.length)).toBe(0);
  await page.mouse.up();
  await expect(page.locator('[data-rio-column="3"]')).toHaveText('Field 2');
  expect(await page.evaluate(() => window.gridDemo.moves.at(-1))).toEqual({ id: 'field-1', to: 3 });
  await expect(page.locator('.rio-grid__drop-indicator')).toBeHidden();
  const frozen = (await page.locator('[data-rio-column="0"]').boundingBox())!;
  await page.mouse.move(frozen.x + 30, frozen.y + 16);
  await page.mouse.down();
  await page.mouse.move(target.x + 30, target.y + 16, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.gridDemo.moves.length)).toBe(1);
  await expect(page.locator('[data-rio-column="0"]')).toHaveText('Field 1');
});

test('mirrors frozen columns, horizontal scrolling, and resizing in RTL', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.update({ direction: 'rtl' }));
  await settle(page);
  const frozen = page.locator('[data-rio-column="0"]');
  const first = (await frozen.boundingBox())!;
  const second = (await page.locator('[data-rio-column="1"]').boundingBox())!;
  expect(first.x).toBeGreaterThan(second.x);
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 999_999, col: 19 }, 'start'));
  await expect(page.locator('[role="gridcell"][data-rio-row="999999"][data-rio-col="0"]')).toHaveText(
    'Record 1000000',
  );
  expect(await frozen.boundingBox()).toEqual(first);
  const last = await page.locator('[data-rio-column="19"]').boundingBox();
  expect(last!.x).toBeLessThan(first.x);
  const resize = (await frozen.locator('[data-rio-resize]').boundingBox())!;
  await page.mouse.move(resize.x + 3, resize.y + 16);
  await page.mouse.down();
  await page.mouse.move(resize.x - 29, resize.y + 16, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => frozen.evaluate((el) => el.getBoundingClientRect().width)).toBe(192);
});

test('debounces loading while drawing empty placeholders', async ({ page }) => {
  const before = await page.evaluate(() => window.gridDemo.requests.length);
  await page.evaluate(async () => {
    for (let row = 10_000; row < 20_000; row += 100) {
      window.gridDemo.grid.scrollToCell({ row }, 'start');
      await new Promise(requestAnimationFrame);
    }
  });
  const placeholder = page.locator('[role="gridcell"][data-rio-row="19900"][data-rio-col="0"]');
  await expect(placeholder).toHaveAttribute('data-loading', '');
  await expect(placeholder).toHaveText('');
  await expect(placeholder).toHaveText('Record 19901');
  expect((await page.evaluate(() => window.gridDemo.requests.length)) - before).toBeLessThanOrEqual(2);
});

test('decorations follow cells, flashes fade once, and selection has one focus input', async ({ page }) => {
  await page.evaluate(() => {
    window.gridDemo.grid.setSelection({
      active: { row: 0, col: 0 },
      range: { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
      rows: { kind: 'none' },
    });
    window.gridDemo.grid.setDecorations([
      { kind: 'presence', row: 0, col: 0, color: 'var(--rio-accent)', label: 'test.presence' },
      { kind: 'flash', row: 0, col: 1, color: 'var(--rio-accent)' },
    ]);
    window.gridDemo.grid.focus();
  });
  await expect(page.locator('.rio-grid__input')).toBeFocused();
  expect(await page.locator('textarea').count()).toBe(1);
  expect(await page.locator('input').count()).toBe(0);
  await expect(page.locator('[data-active]')).toHaveAttribute('data-rio-col', '0');
  await expect(page.locator('.rio-grid__presence-label')).toHaveText('test.presence');
  await expect
    .poll(() => page.locator('.rio-grid__decoration--flash').evaluate((el) => getComputedStyle(el).opacity))
    .toBe('0');
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 9000 }));
  await expect(page.locator('.rio-grid__presence-label')).toHaveCount(0);
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 0 }));
  await expect(page.locator('.rio-grid__presence-label')).toHaveCount(1);
  expect(
    await page.locator('.rio-grid__decoration--flash').evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.evaluate(() =>
    window.gridDemo.grid.setDecorations([{ kind: 'flash', row: 0, col: 0, color: 'var(--rio-accent)' }]),
  );
  await expect
    .poll(() => page.locator('.rio-grid__decoration--flash').evaluate((el) => getComputedStyle(el).opacity))
    .toBe('0');
});

test('native touch scrolling retains momentum above the cap', async ({ page, context }) => {
  const session = await context.newCDPSession(page);
  const box = (await page.locator('.rio-grid__viewport').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height - 40;
  const release = await page.evaluateHandle(() => {
    const state = { row: 0, native: 0 };
    document.addEventListener(
      'touchend',
      () => {
        state.row = window.gridDemo.grid.anchorRow();
        state.native = document.querySelector('.rio-grid__scroller')!.scrollTop;
      },
      { once: true },
    );
    return state;
  });
  // The native gesture driver includes a fling; individual protocol touch events do not.
  await session.send('Input.synthesizeScrollGesture', {
    x,
    y,
    yDistance: -200,
    speed: 1200,
    gestureSourceType: 'touch',
    preventFling: false,
  });
  const released = await release.jsonValue();
  expect(released.row).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.gridDemo.grid.anchorRow()))
    .toBeGreaterThan(released.row);
  expect(await page.locator('.rio-grid__scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(
    released.native + 50,
  );
  await release.dispose();
  await session.detach();
});

test('updates geometry, handles short tables, and destroys cleanly', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 999_999 }));
  await settle(page);
  await page.evaluate(() =>
    window.gridDemo.grid.update({ rowCount: 100, headerHeight: 40, rowHeaderWidth: 80, showAddRow: false }),
  );
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '101');
  await page.evaluate(() => window.gridDemo.grid.scrollToCell({ row: 0 }, 'start'));
  await settle(page);
  await page.locator('.rio-grid__viewport').hover();
  await page.mouse.wheel(0, 32);
  await expect.poll(() => page.evaluate(() => window.gridDemo.grid.getVisibleRange().firstRow)).toBe(1);
  await page.evaluate(() => window.gridDemo.grid.destroy());
  await expect(page.locator('#grid')).toBeEmpty();
  await expect(page.locator('#grid')).not.toHaveAttribute('role');
});

test('sustains the frame budget during three seconds of continuous wheel scrolling', async ({ page }) => {
  const timings = await page.evaluate(async () => {
    const target = document.querySelector('.rio-grid__viewport')!;
    const frames: number[] = [];
    let first = 0;
    let previous = 0;
    await new Promise<void>((resolve) => {
      function tick(time: number) {
        if (!first) first = time;
        if (previous) frames.push(time - previous);
        previous = time;
        target.dispatchEvent(new WheelEvent('wheel', { deltaY: 8, bubbles: true, cancelable: true }));
        if (time - first >= 3000) resolve();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames: frames.length,
      p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]! * 1000) / 1000,
      fps: 1000 / (frames.reduce((sum, interval) => sum + interval, 0) / frames.length),
      cells: document.querySelectorAll('[role="gridcell"]').length,
      row: window.gridDemo.grid.getVisibleRange().firstRow,
    };
  });
  console.log(
    `Grid scrolling: ${timings.frames} frames, p95 ${timings.p95.toFixed(3)} ms, average ${timings.fps.toFixed(2)} fps, ${timings.cells} cells`,
  );
  expect(timings.row).toBeGreaterThan(30);
  expect(timings.cells).toBeLessThan(400);
  expect(timings.p95).toBeLessThanOrEqual(16.7);
  expect(timings.fps).toBeGreaterThanOrEqual(55);
});

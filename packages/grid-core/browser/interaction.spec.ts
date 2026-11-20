import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const cell = (page: Page, row = 0, col = 0) =>
  page.locator(`[role="gridcell"][data-rio-row="${row}"][data-rio-col="${col}"]`);
const sink = (page: Page) => page.locator('.rio-grid__input');
const active = (page: Page) => page.evaluate(() => window.gridDemo.grid.getSelection().active);
async function modifier(page: Page) {
  return page.evaluate(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control'));
}
async function editing(page: Page, value: boolean) {
  await expect.poll(() => page.evaluate(() => window.gridDemo.grid.isEditing())).toBe(value);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(cell(page)).toHaveText('Record 1');
});

test('typing replaces a value, Enter commits and moves down, and F2 starts at the end', async ({ page }) => {
  await cell(page).click();
  await expect(sink(page)).toBeFocused();
  await expect(sink(page)).toHaveAccessibleName('Synthetic records');
  const bounds = (await cell(page).boundingBox())!;
  expect(await sink(page).boundingBox()).toEqual(bounds);
  await page.keyboard.type('Changed');
  await expect(sink(page)).toHaveValue('Changed');
  await page.keyboard.press('Enter');
  await expect(cell(page)).toHaveText('Changed');
  expect(await active(page)).toEqual({ row: 1, col: 0 });
  await page.keyboard.press('F2');
  await expect(sink(page)).toHaveValue('Record 2');
  expect(await sink(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(8);
  await page.keyboard.press('ArrowLeft');
  expect(await active(page)).toEqual({ row: 1, col: 0 });
  await page.keyboard.type('!');
  await page.keyboard.press('Shift+Enter');
  await expect(cell(page, 1)).toHaveText('Record !2');
  expect(await active(page)).toEqual({ row: 0, col: 0 });
});

test('double-click edits, Escape cancels, and clicking elsewhere commits', async ({ page }) => {
  await cell(page).dblclick();
  await editing(page, true);
  await expect(sink(page)).toHaveValue('Record 1');
  await sink(page).fill('Canceled');
  await page.keyboard.press('Escape');
  await editing(page, false);
  await expect(cell(page)).toHaveText('Record 1');
  await page.keyboard.press('Enter');
  await sink(page).fill('Accepted');
  await cell(page, 1).click();
  await expect(cell(page)).toHaveText('Accepted');
  expect(await active(page)).toEqual({ row: 1, col: 0 });
});

test('composition starts in the same textarea and commits the finished text', async ({ page, context }) => {
  await cell(page).click();
  expect(await sink(page).evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(false);
  const original = await sink(page).elementHandle();
  const session = await context.newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await editing(page, true);
  await expect(sink(page)).toHaveValue('にほん');
  await session.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await session.send('Input.insertText', { text: '日本' });
  await expect(sink(page)).toHaveValue('日本');
  expect(await original!.evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(cell(page)).toHaveText('日本');
  expect(await active(page)).toEqual({ row: 1, col: 0 });
  await session.detach();
});

test('rejected commits retain focus, value, selection, and a polite validation message', async ({ page }) => {
  await page.evaluate(() => {
    window.gridDemo.rejectText = 'invalid';
  });
  await cell(page).click();
  await page.keyboard.type('invalid');
  await page.keyboard.press('Enter');
  await editing(page, true);
  await expect(sink(page)).toHaveValue('invalid');
  await expect(sink(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(sink(page)).toHaveAccessibleDescription('Enter a valid value.');
  await expect(page.locator('.rio-grid__error')).toHaveAttribute('aria-live', 'polite');
  await cell(page, 1).click();
  expect(await active(page)).toEqual({ row: 0, col: 0 });
  await expect(sink(page)).toBeFocused();
  await sink(page).fill('valid');
  await page.keyboard.press('Tab');
  await editing(page, false);
  await expect(cell(page)).toHaveText('valid');
  expect(await active(page)).toEqual({ row: 0, col: 1 });
  await expect(page.locator('.rio-grid__error')).toBeHidden();
});

test('drag selection copies native clipboard text and HTML, cut clears, and paste reaches the host', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = (await cell(page).boundingBox())!;
  const last = (await cell(page, 2, 1).boundingBox())!;
  await page.mouse.move(first.x + 50, first.y + 16);
  await page.mouse.down();
  await page.mouse.move(last.x + 50, last.y + 16, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(6);
  const mod = await modifier(page);
  await page.keyboard.press(`${mod}+c`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Record 1\t0.08\nRecord 2\t0.16\nRecord 3\t0.24',
  );
  const types = await page.evaluate(async () => (await navigator.clipboard.read())[0]!.types);
  expect(types).toContain('text/html');
  await page.keyboard.press(`${mod}+x`);
  await expect(cell(page)).toHaveText('');
  expect(await page.evaluate(() => window.gridDemo.clears.length)).toBe(1);
  await page.evaluate(async () =>
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(['pasted'], { type: 'text/plain' }),
        'text/html': new Blob(['<b>pasted</b>'], { type: 'text/html' }),
      }),
    ]),
  );
  await page.keyboard.press(`${mod}+v`);
  await expect.poll(() => page.evaluate(() => window.gridDemo.pastes.length)).toBe(1);
  const pasted = await page.evaluate(() => window.gridDemo.pastes[0]!.data);
  expect(pasted.text).toBe('pasted');
  expect(pasted.html).toContain('<b>pasted</b>');
  await expect(cell(page)).toHaveText('pasted');
});

test('Delete, Backspace, undo, redo, expand, toggles, and context menus reach the host', async ({ page }) => {
  await cell(page).click();
  await page.keyboard.press('Delete');
  await expect(cell(page)).toHaveText('');
  const mod = await modifier(page);
  await page.keyboard.press(`${mod}+z`);
  await expect(cell(page)).toHaveText('Record 1');
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(cell(page)).toHaveText('');
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => window.gridDemo.redos)).toBe(2);
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.gridDemo.clears.length)).toBe(2);
  await page.keyboard.press('Shift+Space');
  expect(await page.evaluate(() => window.gridDemo.expanded)).toEqual([0]);
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ContextMenu');
  await cell(page, 2, 1).click({ button: 'right' });
  expect(await page.evaluate(() => window.gridDemo.contexts.map((entry) => entry.target))).toEqual([
    { kind: 'cell', cell: { row: 0, col: 0 } },
    { kind: 'cell', cell: { row: 0, col: 0 } },
    { kind: 'cell', cell: { row: 2, col: 1 } },
  ]);
  await page.locator('[data-rio-column="1"]').click({ button: 'right' });
  await page.locator('[data-rio-row="2"] [role="rowheader"]').click({ button: 'right' });
  expect(await page.evaluate(() => window.gridDemo.contexts.slice(-2).map((entry) => entry.target))).toEqual([
    { kind: 'header', col: 1 },
    { kind: 'rowHeader', row: 2 },
  ]);
  await cell(page, 0, 4).click();
  await expect(cell(page, 0, 4)).toHaveText('Checked');
  await page.keyboard.press('Space');
  await expect(cell(page, 0, 4)).toHaveText('Unchecked');
  await editing(page, false);
});

test('custom editors receive typed and composed text and clean up with focus restoration', async ({
  page,
  context,
}) => {
  await cell(page, 0, 2).click();
  await page.keyboard.type('x');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit value' })).toHaveValue('x');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sink(page)).toBeFocused();
  expect(await page.evaluate(() => window.gridDemo.cleanups)).toBe(1);
  const session = await context.newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await session.send('Input.insertText', { text: '中文' });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit value' })).toHaveValue('中文');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(cell(page, 0, 2)).toHaveText('中文');
  await expect(sink(page)).toBeFocused();
  expect(await active(page)).toEqual({ row: 1, col: 2 });
  expect(await page.evaluate(() => window.gridDemo.cleanups)).toBe(2);
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => window.gridDemo.editors.at(-1)!.initialText)).toBeNull();
  await page.evaluate(() => window.gridDemo.grid.stopEditing(false));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sink(page)).toBeFocused();
  await session.detach();
});

test('keyboard navigation extends and collapses ranges, wraps, jumps, and handles RTL', async ({ page }) => {
  await cell(page, 2, 1).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  expect(await page.evaluate(() => window.gridDemo.grid.getSelection().range)).toEqual({
    start: { row: 2, col: 1 },
    end: { row: 4, col: 2 },
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('[aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+Tab');
  expect(await active(page)).toEqual({ row: 1, col: 19 });
  await page.keyboard.press('Tab');
  expect(await active(page)).toEqual({ row: 2, col: 0 });
  const mod = await modifier(page);
  await page.keyboard.press(`${mod}+End`);
  expect(await active(page)).toEqual({ row: 999_999, col: 19 });
  await expect(cell(page, 999_999, 19)).toBeVisible();
  await page.keyboard.press(`${mod}+Home`);
  await page.evaluate(() => window.gridDemo.grid.update({ direction: 'rtl' }));
  await page.keyboard.press('ArrowLeft');
  expect(await active(page)).toEqual({ row: 0, col: 1 });
  await page.keyboard.press('ArrowRight');
  expect(await active(page)).toEqual({ row: 0, col: 0 });
  await page.keyboard.press(`${mod}+a`);
  expect(await page.evaluate(() => window.gridDemo.grid.getSelection().range?.end)).toEqual({
    row: 999_999,
    col: 19,
  });
});

test('row headers select runs and toggle rows, and selection changes only once', async ({ page }) => {
  const header = (row: number) => page.locator(`[data-rio-row="${row}"] [role="rowheader"]`);
  await header(2).click();
  await header(4).click({ modifiers: ['Shift'] });
  await expect(page.locator('[role="gridcell"][aria-selected="true"][data-rio-row="3"]')).not.toHaveCount(0);
  await header(3).click({ modifiers: [await modifier(page)] });
  expect(
    await page.evaluate(() => {
      const rows = window.gridDemo.grid.getSelection().rows;
      return rows.kind === 'some' ? [...rows.rows] : [];
    }),
  ).toEqual([2, 4]);
  await cell(page).click();
  const before = await page.evaluate(() => window.gridDemo.selections.length);
  await cell(page).click();
  expect(await page.evaluate(() => window.gridDemo.selections.length)).toBe(before);
  await expect(page.locator('.rio-grid__live')).toHaveText('Field 1, Record 1, Record 1');
});

test('multiline editing overlays at most eight lines and leaves row geometry fixed', async ({ page }) => {
  const next = (await cell(page, 1, 3).boundingBox())!;
  await cell(page, 0, 3).click();
  await page.keyboard.type('first');
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.type('second');
  await page.keyboard.press(`${await modifier(page)}+Enter`);
  await page.keyboard.type('third');
  await expect(sink(page)).toHaveValue('first\nsecond\nthird');
  expect((await sink(page).boundingBox())!.height).toBeGreaterThan(32);
  expect(await cell(page, 1, 3).boundingBox()).toEqual(next);
  await sink(page).fill(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
  const geometry = await sink(page).evaluate((el: HTMLTextAreaElement) => ({
    height: el.clientHeight,
    scroll: el.scrollHeight,
    line: Number.parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(geometry.height).toBeLessThanOrEqual(geometry.line * 8 + 10);
  expect(geometry.scroll).toBeGreaterThan(geometry.height);
  expect(await cell(page, 1, 3).boundingBox()).toEqual(next);
  await page.keyboard.press('Enter');
  await editing(page, false);
  expect(await active(page)).toEqual({ row: 1, col: 3 });
});

test('read-only grids copy while refusing all mutations and editor APIs', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => window.gridDemo.grid.update({ readOnly: true }));
  await cell(page).click();
  const mod = await modifier(page);
  await page.keyboard.press(`${mod}+c`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Record 1');
  await page.keyboard.press(`${mod}+x`);
  await page.keyboard.press(`${mod}+v`);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('x');
  await page.keyboard.press('F2');
  await page.evaluate(() => window.gridDemo.grid.startEditing({ row: 0, col: 0 }, 'x'));
  await cell(page, 0, 4).click();
  await page.keyboard.press('Space');
  await editing(page, false);
  expect(
    await page.evaluate(() => [
      window.gridDemo.commits.length,
      window.gridDemo.clears.length,
      window.gridDemo.pastes.length,
      window.gridDemo.toggles.length,
    ]),
  ).toEqual([0, 0, 0, 0]);
  await expect(cell(page)).toHaveText('Record 1');
});

test('public editing APIs commit and cancel and destroying cleans up custom editors', async ({ page }) => {
  await page.evaluate(() => window.gridDemo.grid.startEditing({ row: 2, col: 1 }, 'api'));
  await editing(page, true);
  await expect(sink(page)).toHaveValue('api');
  await page.evaluate(() => window.gridDemo.grid.stopEditing(true));
  await expect(cell(page, 2, 1)).toHaveText('api');
  await page.evaluate(() => {
    window.gridDemo.grid.startEditing(undefined, 'discard');
    window.gridDemo.grid.stopEditing(false);
  });
  await expect(cell(page, 2, 1)).toHaveText('api');
  await page.evaluate(() => window.gridDemo.grid.startEditing({ row: 0, col: 2 }));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => window.gridDemo.grid.destroy());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.gridDemo.cleanups)).toBe(1);
});

test('touch taps select, double taps edit, and a stationary long press opens context', async ({
  page,
  context,
}) => {
  const box = (await cell(page).boundingBox())!;
  await page.touchscreen.tap(box.x + 50, box.y + 16);
  expect(await active(page)).toEqual({ row: 0, col: 0 });
  await page.touchscreen.tap(box.x + 50, box.y + 16);
  await editing(page, true);
  await page.keyboard.press('Escape');
  const next = (await cell(page, 2).boundingBox())!;
  const session = await context.newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: next.x + 50, y: next.y + 16 }],
  });
  await expect.poll(() => page.evaluate(() => window.gridDemo.contexts.length)).toBe(1);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await page.evaluate(() => window.gridDemo.contexts[0]!.target)).toEqual({
    kind: 'cell',
    cell: { row: 2, col: 0 },
  });
  await session.detach();
});

test('dragging near an edge extends the selection while scrolling', async ({ page }) => {
  const first = (await cell(page, 3).boundingBox())!;
  const viewport = (await page.locator('.rio-grid__viewport').boundingBox())!;
  await page.mouse.move(first.x + 50, first.y + 16);
  await page.mouse.down();
  await page.mouse.move(first.x + 50, viewport.y + viewport.height - 2);
  await expect
    .poll(() => page.evaluate(() => window.gridDemo.grid.getSelection().range?.end.row ?? 0))
    .toBeGreaterThan(25);
  await page.mouse.up();
  expect(await page.evaluate(() => window.gridDemo.grid.getVisibleRange().firstRow)).toBeGreaterThan(0);
});

test('the editor retains native undo and clipboard behavior and commits on outside clicks', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await cell(page).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type(' draft');
  const mod = await modifier(page);
  await page.keyboard.press(`${mod}+z`);
  await expect(sink(page)).toHaveValue('Record 1');
  expect(await page.evaluate(() => window.gridDemo.undos)).toBe(0);
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Record 1');
  await page.evaluate(() => navigator.clipboard.writeText('native paste'));
  await page.keyboard.press(`${mod}+v`);
  await expect(sink(page)).toHaveValue('native paste');
  expect(await page.evaluate(() => window.gridDemo.pastes.length)).toBe(0);
  await page.locator('#title').click();
  await expect(cell(page)).toHaveText('native paste');
  await editing(page, false);
});

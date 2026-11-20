import { assertAccessible, expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, signIn } from '../helpers';

test.use({ serviceWorkers: 'block', timezoneId: 'UTC' });

function dayAfter(day: string, offset: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** What one bar shows at its current width, measured against the content box it must stay inside. */
interface BarFit {
  barWidth: number;
  barTop: number;
  barBottom: number;
  borderTop: number;
  borderBottom: number;
  contentTop: number;
  contentBottom: number;
  innerLeft: number;
  innerRight: number;
  label: { top: number; bottom: number };
  fields: Array<{
    text: string;
    visible: boolean;
    insideInner: boolean;
    top: number;
    bottom: number;
    pill: boolean;
  }>;
}

/**
 * Reads the bar's geometry in the page.  A field is visible when any part of it survives the
 * content's clip, and it sits inside only when it stays clear of the inline padding.
 */
function readFit(bar: HTMLElement): BarFit {
  const content = bar.querySelector<HTMLElement>('.rio-timeline-bar__content')!;
  const label = bar.querySelector<HTMLElement>('.rio-timeline-bar__label')!;
  const styles = getComputedStyle(content);
  const barStyles = getComputedStyle(bar);
  const box = content.getBoundingClientRect();
  const barBox = bar.getBoundingClientRect();
  const labelBox = label.getBoundingClientRect();
  const innerLeft = box.left + parseFloat(styles.paddingLeft);
  const innerRight = box.right - parseFloat(styles.paddingRight);
  const fields = [...content.querySelectorAll<HTMLElement>('.rio-timeline-bar__field')].map((field) => {
    const rect = field.getBoundingClientRect();
    const across = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left));
    const down = Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
    return {
      text: (field.textContent ?? '').trim(),
      visible: across > 0.5 && down > 0.5,
      insideInner:
        rect.left >= innerLeft - 0.5 &&
        rect.right <= innerRight + 0.5 &&
        rect.top >= box.top - 0.5 &&
        rect.bottom <= box.bottom + 0.5,
      top: rect.top,
      bottom: rect.bottom,
      pill: field.querySelector('.rio-choice-pill') !== null,
    };
  });
  return {
    barWidth: barBox.width,
    barTop: barBox.top,
    barBottom: barBox.bottom,
    borderTop: parseFloat(barStyles.borderTopWidth),
    borderBottom: parseFloat(barStyles.borderBottomWidth),
    contentTop: box.top,
    contentBottom: box.bottom,
    innerLeft,
    innerRight,
    label: { top: labelBox.top, bottom: labelBox.bottom },
    fields,
  };
}

/**
 * The bar's name and the words the eye can see on it, in display order.  A field counts only
 * when it survives the content's clip, and a mark's hidden word is not a visible word.
 */
function readNameWords(bar: HTMLElement): { name: string; words: string[] } {
  const content = bar.querySelector<HTMLElement>('.rio-timeline-bar__content')!;
  const box = content.getBoundingClientRect();
  const label = bar.querySelector<HTMLElement>('.rio-timeline-bar__label')!;
  const words = [(label.textContent ?? '').trim()];
  for (const field of content.querySelectorAll<HTMLElement>('.rio-timeline-bar__field')) {
    const rect = field.getBoundingClientRect();
    const across = Math.max(0, Math.min(rect.right, box.right) - Math.max(rect.left, box.left));
    const down = Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
    if (across <= 0.5 || down <= 0.5) continue;
    const clone = field.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll('.rio-card-value__text, [aria-hidden="true"]'))
      hidden.remove();
    const text = (clone.textContent ?? '').trim();
    if (text) words.push(text);
  }
  return { name: bar.getAttribute('aria-label') ?? '', words };
}

/** The words a name comparison uses, without case or punctuation. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Every visible field stays whole inside the padding, and the visible fields are a leading run. */
function assertFit(fit: BarFit, width: number) {
  const shown = fit.fields.filter((field) => field.visible);
  const firstHidden = fit.fields.findIndex((field) => !field.visible);
  const trailing = firstHidden === -1 ? [] : fit.fields.slice(firstHidden);
  expect(
    trailing.every((field) => !field.visible),
    `at ${width}px a hidden field is followed by a visible one, so the words are not a prefix`,
  ).toBe(true);
  for (const field of shown) {
    expect(
      field.insideInner,
      `at ${width}px the field "${field.text}" is visible but crosses the content's padding edge`,
    ).toBe(true);
  }
}

/**
 * The label and every visible field keep the vertical position they have when all fields fit,
 * and the text stays centered between the bar's borders.  A wrapped line must not lift the
 * visible line, and a pill on the hidden line must not change the visible line's height.
 */
function assertVertical(fit: BarFit, baseline: BarFit, width: number) {
  expect(
    Math.abs(fit.label.top - baseline.label.top),
    `at ${width}px the label sits at ${fit.label.top} instead of its all-fit top ${baseline.label.top}`,
  ).toBeLessThanOrEqual(1);
  const shown = fit.fields.filter((field) => field.visible);
  for (const field of shown) {
    const index = fit.fields.indexOf(field);
    expect(
      Math.abs(field.top - baseline.fields[index]!.top),
      `at ${width}px the field "${field.text}" sits at ${field.top} instead of its all-fit top ${baseline.fields[index]!.top}`,
    ).toBeLessThanOrEqual(1);
  }
  const textTop = Math.min(fit.label.top, ...shown.map((field) => field.top));
  const textBottom = Math.max(fit.label.bottom, ...shown.map((field) => field.bottom));
  const gapAbove = textTop - (fit.barTop + fit.borderTop);
  const gapBelow = fit.barBottom - fit.borderBottom - textBottom;
  expect(
    Math.abs(gapAbove - gapBelow),
    `at ${width}px the gap above the text is ${gapAbove}px and below it ${gapBelow}px, so the text is not centered`,
  ).toBeLessThanOrEqual(1);
}

async function seedBar(
  page: Page,
  type: 'timeline' | 'gantt',
  zoom: string,
  pillWrap = false,
): Promise<Locator> {
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, `Bar fit ${type} ${zoom}${pillWrap ? ' pills' : ''}`, [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        ...(pillWrap
          ? [
              { name: 'Status', type: 'singleSelect', choices: ['Ready', 'Done'] },
              { name: 'Phase', type: 'singleSelect', choices: ['Framing', 'Finishing'] },
              { name: 'Owner', type: 'text' },
              { name: 'Starts', type: 'date' },
              { name: 'Ends', type: 'date' },
            ]
          : [
              { name: 'Starts', type: 'date' },
              { name: 'Ends', type: 'date' },
              { name: 'Owner', type: 'text' },
              { name: 'Status', type: 'singleSelect', choices: ['Ready', 'Done'] },
              { name: 'Budget', type: 'number' },
            ]),
      ],
      records: [
        {
          Name: 'Paint the rail',
          Starts: today,
          Ends: dayAfter(today, 40),
          Owner: 'Ada',
          Status: 'Ready',
          ...(pillWrap ? { Phase: 'Framing' } : { Budget: 42 }),
        },
      ],
    },
  ]);
  const table = database.tables.Tasks!;
  const viewId = await createView(page, database, 'Tasks', {
    name: 'Schedule',
    type,
    config: { [type]: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends, zoom } },
  });
  await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
  const bar = page.locator('.rio-timeline-bar');
  await expect(bar).toHaveCount(1);
  await expect(bar).toBeVisible();
  await bar.scrollIntoViewIfNeeded();
  return bar;
}

/**
 * A bar whose shown fields are a text field, a checked checkbox, and another text field, in
 * that order, so its name must keep the visible words together around the mark.
 */
async function seedMarkBar(page: Page, type: 'timeline' | 'gantt'): Promise<Locator> {
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, `Bar marks ${type}`, [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Note', type: 'text' },
        { name: 'Done', type: 'checkbox' },
        { name: 'Tag', type: 'text' },
        { name: 'Starts', type: 'date' },
        { name: 'Ends', type: 'date' },
      ],
      records: [
        {
          Name: 'Paint the rail',
          Note: 'Alpha',
          Done: true,
          Tag: 'Beta',
          Starts: today,
          Ends: dayAfter(today, 40),
        },
      ],
    },
  ]);
  const table = database.tables.Tasks!;
  const viewId = await createView(page, database, 'Tasks', {
    name: 'Schedule',
    type,
    config: { [type]: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends, zoom: 'day' } },
  });
  await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
  const bar = page.locator('.rio-timeline-bar');
  await expect(bar).toHaveCount(1);
  await expect(bar).toBeVisible();
  await bar.scrollIntoViewIfNeeded();
  return bar;
}

async function setWidth(page: Page, bar: Locator, width: number) {
  await bar.evaluate((node, size) => {
    (node as HTMLElement).style.inlineSize = `${size}px`;
  }, width);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

/**
 * Sweeps the bar through every width, checks the fit and the vertical position at each, and
 * scans the three width cases.  Returns whether a width was seen where an earlier choice pill
 * stays on the visible line while a later one wraps to the hidden line.
 */
async function auditBar(page: Page, bar: Locator): Promise<{ sawPillWrap: boolean }> {
  const fieldCount = await bar.locator('.rio-timeline-bar__field').count();
  expect(fieldCount, 'the bar shows at least three fields').toBeGreaterThanOrEqual(3);

  const widths: number[] = [];
  for (let width = 30; width <= 420; width += 6) widths.push(width);
  widths.push(560, 900);

  let labelOnly = -1;
  let partly = -1;
  let allFit = -1;
  let sawPillWrap = false;
  for (const width of widths) {
    await setWidth(page, bar, width);
    const fit = await bar.evaluate(readFit);
    assertFit(fit, width);
    const shown = fit.fields.filter((field) => field.visible);
    if (shown.length === 0 && labelOnly === -1) labelOnly = width;
    if (shown.length > 0 && shown.length < fieldCount && partly === -1) partly = width;
    if (shown.length === fieldCount && allFit === -1) allFit = width;
    const pills = fit.fields.filter((field) => field.pill);
    if (pills.length >= 2 && pills[0]!.visible && !pills[1]!.visible) sawPillWrap = true;
  }
  expect(labelOnly, 'a width where only the label fits').toBeGreaterThan(-1);
  expect(partly, 'a width where some fields fit and the rest hide').toBeGreaterThan(-1);
  expect(allFit, 'a width where every field fits').toBeGreaterThan(-1);

  // The all-fit width sets the vertical position every other width must keep.
  await setWidth(page, bar, allFit);
  const baseline = await bar.evaluate(readFit);
  for (const width of widths) {
    await setWidth(page, bar, width);
    const fit = await bar.evaluate(readFit);
    assertVertical(fit, baseline, width);
  }

  // The accessibility scan runs at each of the three cases, so the spoken name matches the words
  // the eye can see whether the bar is wide, middling, or narrow.  The name must also start with
  // those visible words as one run, before any word a mark keeps for screen readers alone.
  for (const width of [allFit, partly, labelOnly]) {
    await setWidth(page, bar, width);
    const { name, words } = await bar.evaluate(readNameWords);
    const visible = words.flatMap(wordsOf);
    expect(
      wordsOf(name).slice(0, visible.length),
      `at ${width}px the name "${name}" does not start with the visible words "${words.join(' ')}"`,
    ).toEqual(visible);
    await assertAccessible(page);
  }
  return { sawPillWrap };
}

test('timeline day bars keep each field whole inside the padding at every width', async ({ page }) => {
  const bar = await seedBar(page, 'timeline', 'day');
  await auditBar(page, bar);
});

test('timeline week bars keep each field whole inside the padding at every width', async ({ page }) => {
  const bar = await seedBar(page, 'timeline', 'week');
  await auditBar(page, bar);
});

test('gantt bars keep each field whole inside the padding at every width', async ({ page }) => {
  const bar = await seedBar(page, 'gantt', 'day');
  await auditBar(page, bar);
});

test('a wrapping choice pill never lifts the visible line or changes its height', async ({ page }) => {
  const bar = await seedBar(page, 'gantt', 'day', true);
  const { sawPillWrap } = await auditBar(page, bar);
  expect(sawPillWrap, 'a width where the first pill fits and the second pill wraps').toBe(true);
});

test('timeline bars keep the visible words together around a checked checkbox', async ({ page }) => {
  const bar = await seedMarkBar(page, 'timeline');
  await auditBar(page, bar);
});

test('gantt bars keep the visible words together around a checked checkbox', async ({ page }) => {
  const bar = await seedMarkBar(page, 'gantt');
  await auditBar(page, bar);
});

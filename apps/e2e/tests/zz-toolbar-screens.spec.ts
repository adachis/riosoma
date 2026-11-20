import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, signIn } from '../helpers';

/**
 * Review screenshots for the view toolbar polish: the Filter, Sort, Group, and Color panels, each
 * holding a row or two, in the two nature color schemes at desktop and phone widths.  Not pixel
 * comparison; saved to the evidence folder for a person to inspect.  Set SHOT_LABEL to "before" or
 * "after" to tag the run.
 */
test.describe.configure({ mode: 'serial' });

const LABEL = process.env.SHOT_LABEL ?? 'after';
const DIR = join(homedir(), 'riosoma-work', 'evidence', 'view-toolbar-polish');
const SCHEMES = ['grove', 'night-grove'] as const;
const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const PANELS: Array<{ key: string; button: RegExp }> = [
  { key: 'filter', button: /^(Filter|Filtered by)/ },
  { key: 'sort', button: /^(Sort|Sorted by)/ },
  { key: 'group', button: /^(Group|Grouped by)/ },
  { key: 'color', button: /^(Color|\d+ color rule)/ },
];

async function useTheme(page: Page, scheme: string) {
  await page.evaluate(async (scheme) => {
    const session = await (await fetch('/api/auth/session')).json();
    await fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ theme: 'nature', scheme }),
    });
  }, scheme);
}

async function openPanel(page: Page, button: RegExp) {
  const toolbar = page.getByRole('toolbar', { name: 'View controls' });
  const direct = toolbar.getByRole('button', { name: button });
  if (await direct.count()) {
    await direct.first().click();
    return true;
  }
  const more = toolbar.getByRole('button', { name: 'More', exact: true });
  if (!(await more.count())) return false;
  await more.click();
  const item = page.getByRole('menuitem', { name: button });
  if (!(await item.count())) {
    await page.keyboard.press('Escape');
    return false;
  }
  await item.first().click();
  return true;
}

test('toolbar panels in both schemes at both widths', async ({ page }) => {
  mkdirSync(DIR, { recursive: true });
  await signIn(page);
  const database = await createDatabase(page, 'Toolbar polish', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'currency' },
        { name: 'Score', type: 'rating' },
        { name: 'Due', type: 'date' },
        { name: 'Status', type: 'singleSelect', choices: ['Open', 'Done', 'Blocked'] },
        { name: 'Done', type: 'checkbox' },
        { name: 'Tags', type: 'multipleSelect', choices: ['Red', 'Blue'] },
      ],
      records: [
        { Name: 'First', Amount: 10, Score: 3, Status: 'Open' },
        { Name: 'Second', Amount: 40, Score: 5, Status: 'Done' },
      ],
    },
  ]);
  const table = database.tables.Items!;
  const open = table.choices.Status!.Open!;
  const viewId = await createView(page, database, 'Items', {
    name: 'Seeded',
    type: 'grid',
    config: {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'condStatus', fieldId: table.fields.Status, operator: 'is', value: open }],
      },
      // Amount is currency and Due is a date, so their directions show the type-aware labels.
      sorts: [
        { fieldId: table.fields.Amount, direction: 'asc' },
        { fieldId: table.fields.Due, direction: 'asc' },
      ],
      groups: [{ fieldId: table.fields.Status, direction: 'asc' }],
      colorRules: [
        {
          id: 'ruleOpen',
          name: '',
          target: 'cell',
          condition: { id: 'rcOpen', fieldId: table.fields.Status, operator: 'is', value: open },
          color: 'green',
        },
      ],
    },
  });

  for (const scheme of SCHEMES) {
    await useTheme(page, scheme);
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
      await expect(page.getByRole('toolbar', { name: 'View controls' })).toBeVisible();
      await expect(page.locator('.rio-feature-loading')).toHaveCount(0);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      for (const panel of PANELS) {
        const opened = await openPanel(page, panel.button);
        if (!opened) continue;
        const dialog = page.locator('.rio-view-dialog');
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(200);
        await dialog.screenshot({
          path: join(DIR, `${LABEL}-${panel.key}-${scheme}-${size.name}.png`),
        });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
    }
  }
});

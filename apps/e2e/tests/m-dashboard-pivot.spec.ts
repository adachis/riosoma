import { expect, test } from '../accessibility';
import { labelName, createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const phone of [false, true]) {
  test(`a pivot tile can be configured, drilled, duplicated, and ${phone ? 'reordered on a phone' : 'resized on a desktop'}`, async ({
    page,
  }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Release totals', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Status', type: 'singleSelect', choices: ['Done', 'Open'] },
          { name: 'Team', type: 'singleSelect', choices: ['Design', 'Engineering'] },
          { name: 'Amount', type: 'number' },
          { name: 'Due', type: 'date' },
        ],
        records: [
          {
            Name: 'Write notes',
            Status: 'Done',
            Team: 'Engineering',
            Amount: 10,
            Due: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          },
          { Name: 'Tag build', Status: 'Done', Team: 'Engineering', Amount: 20, Due: '2000-01-01' },
          {
            Name: 'Announce',
            Status: 'Open',
            Team: 'Design',
            Amount: 1000,
            Due: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          },
        ],
      },
    ]);
    await openTable(page, database, 'Tasks');
    await page.getByRole('button', { name: 'Add a dashboard' }).click();
    const dashboard = page.getByRole('region', { name: 'Untitled dashboard' });
    await dashboard.getByRole('button', { name: 'Add a tile' }).click();
    const editor = page.getByRole('dialog', { name: 'Add a tile' });
    await editor.getByRole('radio', { name: 'Pivot', exact: true }).click();
    for (const name of ['Add a row field', 'Add a value', 'Remove Status', 'Remove value 1'])
      await expect(editor.getByRole('button', { name, exact: true })).toHaveAttribute(
        'data-icon-only',
        'true',
      );
    await editor.getByRole('textbox', { name: 'Title' }).fill('Release pivot');
    await editor.getByRole('button', { name: /Row field 1$/ }).click();
    await page.getByRole('option', { name: labelName('Status'), exact: true }).click();
    await editor.getByRole('button', { name: /Columns$/ }).click();
    await page.getByRole('option', { name: labelName('Team'), exact: true }).click();
    await editor.getByRole('button', { name: /Value 1$/ }).click();
    await page.getByRole('option', { name: labelName('Sum'), exact: true }).click();
    await editor.getByRole('button', { name: /Field for value 1$/ }).click();
    await page.getByRole('option', { name: labelName('Amount'), exact: true }).click();
    await editor.getByRole('button', { name: 'Save tile' }).click();
    await expect(editor).toBeHidden();
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const tile = dashboard.getByRole('article', { name: 'Release pivot' });
    await expect(tile.getByRole('table', { name: 'Release pivot' })).toBeVisible();
    const cell = tile.getByRole('button', { name: 'Done, Engineering, 30' });
    await cell.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Status is Done and Team is Engineering, 2 records' });
    await expect(drawer.getByRole('link', { name: 'Write notes' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Tag build' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Announce' })).toHaveCount(0);
    await expect(page).toHaveURL(/\?drill=/);
    await page.reload();
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await cell.focus();
    await page.keyboard.press('Enter');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    // The tile contains scrolling and sticky headers, keeping the phone page within its viewport.
    const scroll = tile.getByRole('region', { name: 'Release pivot' });
    await expect(scroll).toHaveCSS('overflow', 'auto');
    await expect(tile.locator('thead')).toHaveCSS('position', 'sticky');
    if (phone)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await dashboard.getByRole('button', { name: 'Dashboard filters', exact: true }).click();
    const filters = page.getByRole('dialog', { name: 'Dashboard filters' });
    await filters.getByRole('button', { name: 'Add condition', exact: true }).click();
    let condition = filters.getByRole('group', { name: 'Condition', exact: true }).first();
    await condition.getByRole('button', { name: /Field$/ }).click();
    await page.getByRole('option', { name: labelName('Amount'), exact: true }).click();
    await condition.getByRole('button', { name: /Condition$/ }).click();
    await page.getByRole('option', { name: labelName('<'), exact: true }).click();
    await condition.getByRole('textbox', { name: 'Value', exact: true }).fill('100');
    await filters.getByRole('button', { name: 'Add condition', exact: true }).click();
    condition = filters.getByRole('group', { name: 'Condition', exact: true }).nth(1);
    await condition.getByRole('button', { name: /Field$/ }).click();
    await page.getByRole('option', { name: labelName('Due'), exact: true }).click();
    await condition.getByRole('button', { name: /Condition$/ }).click();
    await page.getByRole('option', { name: labelName('is within'), exact: true }).click();
    await condition.getByRole('button', { name: /Value$/ }).click();
    await page.getByRole('option', { name: labelName('the past month'), exact: true }).click();
    await filters.getByRole('button', { name: 'Close', exact: true }).click();
    const filteredCell = tile.getByRole('button', { name: 'Done, Engineering, 10', exact: true });
    await expect(filteredCell).toBeVisible();
    await expect(tile.getByRole('button', { name: 'Open, Design, 1,000' })).toHaveCount(0);
    await expect(page).toHaveURL(/dashboardFilters=/);
    await page.reload();
    await filteredCell.focus();
    await page.keyboard.press('Enter');
    const filteredDrawer = page.getByRole('dialog', {
      name: 'Status is Done and Team is Engineering, 1 record',
    });
    await expect(filteredDrawer.getByRole('link', { name: 'Write notes' })).toBeVisible();
    await expect(filteredDrawer.getByRole('link', { name: 'Tag build' })).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]drill=/);
    await page.reload();
    await expect(filteredDrawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filteredDrawer).toBeHidden();
    await filteredCell.focus();
    await page.keyboard.press('Enter');
    await expect(filteredDrawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filteredCell).toBeFocused();
    await tile.getByRole('button', { name: 'More for Release pivot' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(dashboard.getByRole('table', { name: 'Release pivot' })).toHaveCount(2);
    await dashboard.getByRole('button', { name: 'Edit layout' }).click();
    const handle = dashboard.getByRole('button', { name: 'Move or resize Release pivot' }).first();
    const originalId = await dashboard
      .getByRole('article', { name: 'Release pivot' })
      .first()
      .getAttribute('data-tile');
    await handle.focus();
    await page.keyboard.press(phone ? 'ArrowDown' : 'Shift+ArrowRight');
    await dashboard.getByRole('button', { name: 'Done', exact: true }).click();
    const first = dashboard.getByRole('article', { name: 'Release pivot' }).first();
    if (phone) await expect(first).not.toHaveAttribute('data-tile', originalId!);
    else await expect(first).toHaveAttribute('style', /--rio-dashboard-w: 7/);
    await expect(page.locator('link[rel="stylesheet"][href*="/themes/"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.fonts.status)).toBe('loaded');
  });
}

import { expect, test } from '../accessibility';
import { asOwner, createDatabase, createView, openTable, signIn } from '../helpers';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);

for (const type of ['timeline', 'gantt']) {
  test(`${type} keeps its horizontal scroll viewport inside the workspace with and without a record panel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
    try {
      const database = await createDatabase(page, 'Chart record layouts', [
        {
          name: 'Tasks',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Start', type: 'date' },
            { name: 'End', type: 'date' },
          ],
          records: [{ Name: 'Long project', Start: '2026-01-01', End: '2026-12-31' }],
        },
      ]);
      const table = database.tables.Tasks!;
      const viewId = await createView(page, database, 'Tasks', {
        name: type,
        type,
        config: { [type]: { startFieldId: table.fields.Start, endFieldId: table.fields.End, zoom: 'day' } },
      });
      const href = `${base()}/${database.id}/${table.id}/${viewId}`;
      for (const expanded of [false, true]) {
        await page.goto(expanded ? `${href}/${table.records[0]}` : href);
        const workspace = page.locator('.rio-record-workspace');
        const scroller = workspace.locator('.rio-timeline-chart__scroller');
        await expect(scroller).toBeVisible();
        const panel = page.getByRole('region', { name: 'Long project', exact: true });
        if (expanded) await expect(panel).toBeVisible();
        else await expect(panel).toHaveCount(0);
        const workspaceBounds = await workspace.boundingBox();
        const panelBounds = expanded ? await panel.boundingBox() : null;
        const available = workspaceBounds!.width - (panelBounds?.width ?? 0);
        await expect
          .poll(() => scroller.evaluate((element) => element.clientWidth))
          .toBeLessThanOrEqual(Math.ceil(available));
        const viewportWidth = await scroller.evaluate((element) => element.clientWidth);
        expect(viewportWidth).toBeGreaterThan(available - 20);
        expect(await scroller.evaluate((element) => element.scrollWidth)).toBeGreaterThan(viewportWidth);
        await scroller.evaluate((element) => {
          element.scrollLeft = 200;
        });
        await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(200);
      }
    } finally {
      await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    }
  });
}

for (const phone of [false, true]) {
  test(`dashboard record panels restore focus at ${phone ? 'phone' : 'desktop'} width`, async ({ page }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
    try {
      const database = await createDatabase(page, 'Dashboard record layouts', [
        {
          name: 'Tasks',
          fields: [{ name: 'Name', type: 'text' }],
          records: [{ Name: 'Dashboard record' }],
        },
      ]);
      await openTable(page, database, 'Tasks');
      if (phone) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: 'Add a dashboard' }).click();
      if (phone) await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
      const dashboard = page.getByRole('region', { name: 'Untitled dashboard', exact: true });
      await dashboard.getByRole('button', { name: 'Add a tile' }).click();
      const editor = page.getByRole('dialog', { name: 'Add a tile' });
      await editor.getByRole('radio', { name: 'Records', exact: true }).click();
      await editor.getByRole('textbox', { name: 'Title' }).fill('Latest tasks');
      await editor.getByRole('button', { name: 'Save tile' }).click();
      await expect(editor).toHaveCount(0);
      const link = dashboard.getByRole('link', { name: 'Dashboard record', exact: true });
      for (const action of ['Escape', 'Close']) {
        await link.focus();
        await link.press('Enter');
        const panel = page.getByRole('region', { name: 'Dashboard record', exact: true });
        await expect(panel).toBeFocused();
        if (action === 'Escape') await panel.press('Escape');
        else await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(link).toBeFocused();
      }
    } finally {
      await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    }
  });

  test(`record panel navigation and full page at ${phone ? 'phone' : 'desktop'} width`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    const database = await createDatabase(page, 'Record layouts', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Notes', type: 'text' },
        ],
        records: [
          { Name: 'First record', Notes: 'First note' },
          { Name: 'Second record', Notes: 'Second note' },
          { Name: 'Third record', Notes: 'Third note' },
        ],
      },
    ]);
    const table = database.tables.Tasks!;
    const viewHref = `${base()}/${database.id}/${table.id}/${table.viewId}`;
    try {
      const grid = await openTable(page, database, 'Tasks');
      await grid.getByRole('button', { name: 'Expand row 1' }).click();
      const card = page.getByRole('dialog', { name: 'First record' });
      await card.getByRole('button', { name: 'Record layout' }).click();
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/me/preferences') && response.request().method() === 'PATCH',
      );
      await page.getByRole('menuitemradio', { name: 'Side panel', exact: true }).click();
      expect((await saved).ok()).toBe(true);
      let panel = page.getByRole('region', { name: 'First record', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel).toBeFocused();
      await expect(panel).not.toHaveAttribute('aria-modal', 'true');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      if (phone) {
        const bounds = await panel.boundingBox();
        expect(bounds?.width).toBe(390);
        expect(bounds?.height).toBe(844);
        await panel.getByRole('button', { name: 'Next record' }).click();
      } else {
        const handle = panel.getByRole('separator', { name: 'Resize record panel' });
        await handle.focus();
        const width = Number(await handle.getAttribute('aria-valuenow'));
        await handle.press('ArrowLeft');
        await expect(handle).toHaveAttribute('aria-valuenow', String(width + 4));
        await grid.getByRole('gridcell', { name: 'First record', exact: true }).click();
        await page.keyboard.press('ArrowDown');
      }
      panel = page.getByRole('region', { name: 'Second record', exact: true });
      await expect(panel).toBeVisible();
      await expect(page).toHaveURL(`${viewHref}/${table.records[1]}`);
      if (!phone) {
        await expect(page.locator('.rio-grid__input')).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(page.getByRole('region', { name: 'First record', exact: true })).toBeVisible();
        await grid.getByRole('gridcell', { name: 'Second record', exact: true }).click();
        await expect(panel).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(page.locator('.rio-grid__input')).toBeFocused();
        await grid.getByRole('button', { name: 'Expand row 2' }).click();
        await expect(panel).toBeVisible();
      } else {
        await panel.press('Alt+ArrowUp');
        await expect(page.getByRole('region', { name: 'First record', exact: true })).toBeVisible();
        await page.getByRole('region', { name: 'First record', exact: true }).press('Alt+ArrowDown');
        await expect(panel).toBeVisible();
      }
      const recordHref = `${viewHref}/${table.records[1]}`;
      await page.reload();
      panel = page.getByRole('region', { name: 'Second record', exact: true });
      await expect(panel).toBeVisible();
      const link = panel.getByRole('link', { name: 'Open in new window' });
      await expect(link).toHaveAttribute('href', new URL(`${recordHref}/page`).pathname);
      const opened = context.waitForEvent('page');
      await link.click();
      const full = await opened;
      await full.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
      await expect(full).toHaveURL(`${recordHref}/page`);
      const record = full.getByRole('region', { name: 'Second record', exact: true });
      await expect(record.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Second note');
      await expect(record.getByRole('tab', { name: 'Comments', exact: true })).toBeVisible();
      await record.getByRole('tab', { name: 'History', exact: true }).click();
      await expect(record.getByRole('tabpanel', { name: 'History', exact: true })).toBeVisible();
      await expect(full.getByRole('grid')).toHaveCount(0);
      await expect(full.getByRole('navigation', { name: 'Views', exact: true })).toBeVisible();
      await full.close();
      await panel.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(page.locator('.rio-grid__input')).toBeFocused();

      await page.goto(`${recordHref}/page/invalid`);
      await expect(page).toHaveURL(recordHref);
      await expect(
        page.getByText('That link pointed to something that no longer exists, so here’s the closest match.'),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Second record', exact: true })).toBeVisible();
      await page.goto(`${base()}/settings/appearance`);
      await page.getByRole('button', { name: 'Record layout' }).click();
      const changed = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/me/preferences') && response.request().method() === 'PATCH',
      );
      await page.getByRole('option', { name: 'Card', exact: true }).click();
      await page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      expect((await changed).ok()).toBe(true);
      await page.goto(recordHref);
      await expect(page.getByRole('dialog', { name: 'Second record', exact: true })).toBeVisible();
    } finally {
      await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    }
  });
}

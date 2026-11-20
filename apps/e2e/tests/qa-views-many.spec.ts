import { expect, test } from '../accessibility';
import { base } from '../base';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  offlineMap,
  runCommands,
  signIn,
  visit,
} from '../helpers';

test.use({
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  timezoneId: 'UTC',
});

test('all non-grid views load a paged table on a phone and virtual cards reach its last record', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await offlineMap(page);
  const today = new Date().toISOString().slice(0, 10);
  const title = (index: number) => `Record ${index + 1} 東京 🚢 مرحبا`;
  const database = await createDatabase(page, 'Many view records', [
    {
      name: 'Work',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Planned', 'Done'] },
        { name: 'Starts', type: 'date' },
        { name: 'Ends', type: 'date' },
        { name: 'Place', type: 'location' },
      ],
      records: Array.from({ length: 500 }, (_, index) => ({
        Name: title(index),
        Status: index % 2 ? 'Done' : 'Planned',
        Starts: today,
        Ends: today,
        Place: { lat: 47.6 + index * 0.0001, lng: -122.3, label: title(index) },
      })),
    },
  ]);
  const table = database.tables.Work!;
  const parent = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: table.id } },
    },
  ]);
  const views = [
    ['kanban', '.rio-kanban'],
    ['gallery', '.rio-gallery-view'],
    ['calendar', '.rio-calendar-view'],
    ['form', '.rio-form-view'],
    ['timeline', '.rio-timeline-chart'],
    ['gantt', '.rio-gantt'],
    ['list', '.rio-list-view'],
    ['map', '.rio-map-view'],
    ['pivot', '.rio-pivot'],
    ['chart', '.rio-chart-view'],
    ['orgChart', '.rio-org-chart'],
  ] as const;
  for (const [type, selector] of views) {
    const viewId = await createView(page, database, 'Work', {
      name: type,
      type,
      config: {
        kanban: { stackFieldId: table.fields.Status },
        calendar: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends },
        timeline: {
          startFieldId: table.fields.Starts,
          endFieldId: table.fields.Ends,
          groupFieldId: table.fields.Status,
        },
        gantt: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends },
        map: { locationFieldId: table.fields.Place },
        chart: { groupBy: { fieldId: table.fields.Status } },
        pivot: { rows: [{ fieldId: table.fields.Status }] },
        orgChart: { parentFieldId: parent },
        form: { questions: [{ fieldId: table.fields.Name, required: true }] },
      },
    });
    await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
    await expect(page.locator(selector).first()).toBeVisible();
    if (type !== 'form') {
      const result = await asOwner<{ rows: Array<{ id: string }> }>(
        page,
        'GET',
        `/api/views/${viewId}/rows?offset=450&limit=50`,
      );
      expect(result.rows.at(-1)?.id).toBe(table.records[499]);
    }
    if (type === 'gallery' || type === 'list') {
      const role = type === 'gallery' ? 'gridcell' : 'treeitem';
      const first = page.getByRole(role, { name: labelName(title(0)) });
      await expect(first).toBeVisible();
      if (type === 'list')
        await expect(page.getByRole('tree', { name: type, exact: true })).not.toHaveAttribute(
          'aria-busy',
          'true',
        );
      await first.press('End');
      const last = page.getByRole(role, { name: labelName(title(499)) });
      await expect(last).toBeVisible();
      await expect(last).toBeFocused();
    } else if (type === 'calendar') {
      await page
        .locator(`[data-calendar-day="${today}"]`)
        .getByRole('button', { name: '+497 more', exact: true })
        .click();
      const last = page.getByRole('dialog').getByRole('button', { name: labelName(title(499)) });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      await page.keyboard.press('Escape');
    } else if (type === 'map') {
      await expect(page.getByLabel('map map, 500 pins', { exact: true })).toBeVisible();
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
});

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
import { invite } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(180_000);

for (const phone of [false, true]) {
  test(`record views open editable cards, panels, and pages at ${phone ? 'phone' : 'desktop'} width`, async ({
    page: owner,
    browser,
  }) => {
    await signIn(owner);
    const editor = await invite(owner, browser, 'Record Reviewer');
    const page = editor.page;
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await offlineMap(page);
    const name = 'Review 東京 🧭 שלום';
    const today = new Date().toISOString().slice(0, 10);
    const database = await createDatabase(page, 'Record opening paths', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Room', type: 'text' },
          { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
          { name: 'Start', type: 'date' },
          { name: 'End', type: 'date' },
          { name: 'Place', type: 'location' },
        ],
        records: [
          {
            Name: name,
            Room: 'Before',
            Status: 'Ready',
            Start: today,
            End: today,
            Place: { lat: 47.6062, lng: -122.3321, label: 'Site' },
          },
        ],
      },
    ]);
    const table = database.tables.Tasks!;
    const parent = newId('fld');
    await runCommands(page, database.id, [
      {
        kind: 'field.create',
        tableId: table.id,
        field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: table.id } },
      },
    ]);
    const views = [{ type: 'grid', id: table.viewId }];
    for (const type of ['gallery', 'kanban', 'list', 'calendar', 'timeline', 'gantt', 'orgChart', 'map']) {
      views.push({
        type,
        id: await createView(page, database, 'Tasks', {
          name: type,
          type,
          config: {
            kanban: { stackFieldId: table.fields.Status },
            calendar: { startFieldId: table.fields.Start, endFieldId: table.fields.End },
            timeline: { startFieldId: table.fields.Start, endFieldId: table.fields.End },
            gantt: { startFieldId: table.fields.Start, endFieldId: table.fields.End },
            orgChart: { parentFieldId: parent },
            map: { locationFieldId: table.fields.Place },
          },
        }),
      });
    }
    try {
      for (const layout of ['card', 'panel', 'page'] as const) {
        await asOwner(page, 'PATCH', '/api/me/preferences', {
          level: 'advanced',
          recordLayout: layout === 'page' ? 'card' : layout,
        });
        for (const view of views) {
          const address = `${base()}/${database.id}/${table.id}/${view.id}`;
          await visit(page, address);
          if (view.type === 'grid')
            await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
          else if (view.type === 'gallery')
            await page.getByRole('gridcell', { name: labelName(name) }).click();
          else if (view.type === 'list' || view.type === 'orgChart') {
            const item = page.getByRole('treeitem', { name: labelName(name) });
            await item.focus();
            await item.press('Enter');
          } else if (view.type === 'map') {
            if (phone) {
              await page.getByRole('button', { name: 'More', exact: true }).click();
              await page.getByRole('menuitem', { name: 'List records and places', exact: true }).click();
            } else await page.getByRole('button', { name: 'List records and places', exact: true }).click();
            await page.getByRole('button', { name: `Show on map: ${name}`, exact: true }).click();
            await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
          } else
            await page
              .getByRole('button', { name: new RegExp(`^${name}`) })
              .first()
              .click();
          if (layout === 'page') await visit(page, `${address}/${table.records[0]}/page`);
          const record = page
            .getByRole(layout === 'card' ? 'dialog' : 'region', { name, exact: true })
            .filter({ has: page.getByRole('tab', { name: 'Comments', exact: true }) });
          await expect(record).toBeVisible();
          const value = `${layout} ${view.type} 共有 🧭`;
          const room = record.getByRole('textbox', { name: 'Room', exact: true });
          await room.fill(value);
          await room.press('Enter');
          await expect
            .poll(async () => {
              const row = await asOwner<{ values: Record<string, unknown> }>(
                page,
                'GET',
                `/api/tables/${table.id}/records/${table.records[0]}`,
              );
              return row.values[table.fields.Room!];
            })
            .toBe(value);
          await record.getByRole('button', { name: 'Close', exact: true }).click();
          await expect(record).toHaveCount(0);
        }
      }
    } finally {
      await editor.context.close();
    }
  });
}

import { expect, test } from '../accessibility';
import { base } from '../base';
import {
  asOwner,
  createDatabase,
  createView,
  newId,
  openTable,
  runCommands,
  signIn,
  visit,
} from '../helpers';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function fixture(page: Parameters<typeof signIn>[0]) {
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  const database = await createDatabase(page, 'Sparklines', [
    {
      name: 'Series',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Numbers', type: 'json' },
        { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
      ],
      records: [{ Name: 'History', Numbers: '[8,-2,5]', Status: 'Ready' }],
    },
    {
      name: 'Points',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Value', type: 'number' },
        { name: 'Day', type: 'date' },
      ],
      records: [
        { Name: 'First', Value: 8, Day: '2026-09-03' },
        { Name: 'Second', Value: -2, Day: '2026-09-01' },
        { Name: 'Third', Value: 5, Day: '2026-09-02' },
      ],
    },
  ]);
  const table = database.tables.Series!,
    points = database.tables.Points!;
  const link = newId('fld'),
    lookup = newId('fld'),
    rollup = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: { id: link, name: 'Points', type: 'link', options: { linkedTableId: points.id } },
    },
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: lookup,
        name: 'History points',
        type: 'lookup',
        options: { linkFieldId: link, targetFieldId: points.fields.Value },
      },
    },
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: rollup,
        name: 'Total',
        type: 'rollup',
        options: { linkFieldId: link, targetFieldId: points.fields.Value, fn: 'sum' },
      },
    },
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0], values: { [link]: points.records } }],
    },
  ]);
  return { database, table, points, link, lookup, rollup };
}

for (const phone of [false, true])
  test(`sparkline options, accessible charts, cards, and saved phone layout ${phone}`, async ({
    page,
  }, info) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const { database, table } = await fixture(page);
    const grid = await openTable(page, database, 'Series');
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}?colors=open`);
    const editor = page.getByRole('dialog', { name: /^(Color|\d+ color rules?)$/ });
    await editor.getByRole('button', { name: 'Add sparkline' }).click();
    const cell = grid.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]');
    await expect(cell.locator('svg')).toBeVisible();
    await expect(cell).toHaveAccessibleDescription('Minimum -2, maximum 8, last 5; trend falling');
    for (const type of ['Column', 'Win and loss', 'Line']) {
      await editor.getByRole('button', { name: /Chart type/ }).click();
      await page.getByRole('option', { name: type, exact: true }).click();
      await expect(cell.locator(type === 'Line' ? 'path' : 'rect').first()).toBeVisible();
    }
    const scheme = await page.evaluate(() => document.documentElement.dataset.scheme);
    await page.evaluate(() => (document.documentElement.dataset.scheme = 'night-grove'));
    await expect
      .poll(() =>
        cell.evaluate((host) => {
          const point = host.querySelector('circle');
          if (!host.isConnected || !point) return false;
          const probe = document.createElement('span');
          probe.style.color = 'var(--rio-aa-choice-gray)';
          host.append(probe);
          try {
            return getComputedStyle(point).fill === getComputedStyle(probe).color;
          } finally {
            probe.remove();
          }
        }),
      )
      .toBe(true);
    await page.evaluate((scheme) => {
      if (scheme) document.documentElement.dataset.scheme = scheme;
      else document.documentElement.removeAttribute('data-scheme');
    }, scheme);
    await editor.getByRole('checkbox', { name: 'Highlight minimum', exact: true }).focus();
    await page.keyboard.press('Space');
    await editor.getByRole('switch', { name: 'Shared axis across rows', exact: true }).focus();
    await page.keyboard.press('Space');
    await editor.getByRole('button', { name: /Chart type/ }).press('Escape');
    await expect(editor).toBeHidden();
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const record = page.getByRole('dialog', { name: 'History', exact: true });
    await expect(
      record.getByRole('img', { name: 'Minimum -2, maximum 8, last 5; trend falling', exact: true }),
    ).toBeVisible();
    await record.screenshot({ path: info.outputPath(phone ? 'phone.png' : 'record.png') });
    await record.press('Escape');
    for (const type of ['gallery', 'kanban', 'list']) {
      const view = await createView(page, database, 'Series', {
        name: type,
        type,
        config: {
          sparklines: [{ fieldId: table.fields.Numbers }],
          ...(type === 'kanban' ? { kanban: { stackFieldId: table.fields.Status } } : {}),
        },
      });
      await visit(page, `${base()}/${database.id}/${table.id}/${view}`);
      await expect(
        page.getByRole('img', { name: 'Minimum -2, maximum 8, last 5; trend falling', exact: true }).first(),
      ).toBeVisible();
    }
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}?colors=open`);
    await expect(editor.getByRole('checkbox', { name: 'Highlight minimum' })).toBeChecked();
    await editor.getByRole('button', { name: 'Remove sparkline' }).click();
    await expect(grid.locator('.rio-sparkline')).toHaveCount(0);
  });

for (const phone of [false, true])
  test(`dragging linked records changes sparkline point order and survives reload at phone width ${phone}`, async ({
    page,
  }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const { database, table, points, link, lookup, rollup } = await fixture(page);
    await runCommands(page, database.id, [
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: {
          sparklines: [{ fieldId: lookup }],
          ...(phone ? { hiddenFieldIds: [table.fields.Numbers, table.fields.Status, link, rollup] } : {}),
        },
      },
    ]);
    const grid = await openTable(page, database, 'Series');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const record = page.getByRole('dialog', { name: 'History', exact: true });
    const label = 'Minimum -2, maximum 8, last 5; trend falling';
    await expect(record.getByRole('img', { name: label, exact: true })).toBeVisible();
    const handle = record
      .locator('.rio-link-picker__pill')
      .filter({ hasText: 'First' })
      .getByRole('button', { name: 'First', exact: true });
    const target = record.locator('.rio-link-picker__pill').filter({ hasText: 'Third' });
    await target.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const from = await handle.boundingBox(),
      to = await target.boundingBox();
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 10, from!.y + from!.height / 2);
    await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
    await page.mouse.move(to!.x + to!.width - 2, to!.y + to!.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.rio-sortable-overlay')).toBeHidden();
    await expect(
      record.getByRole('img', { name: 'Minimum -2, maximum 8, last 8; trend rising', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole('dialog')
        .getByRole('img', { name: 'Minimum -2, maximum 8, last 8; trend rising', exact: true }),
    ).toBeVisible();
    const response = await page.request.get(`${base()}/api/views/${table.viewId}/rows`);
    const row = (await response.json()).rows[0];
    expect(row.values[lookup]).toEqual([-2, 5, 8]);
    expect(points.records).toHaveLength(3);
    await page.getByRole('dialog').press('Escape');
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}?colors=open`);
    const editor = page.getByRole('dialog', { name: /^(Color|\d+ color rules?)$/ });
    await editor.getByRole('button', { name: /Point order/ }).click();
    await page.getByRole('option', { name: 'Day', exact: true }).click();
    const cell = grid.locator('.rio-grid__cell[role="gridcell"]').filter({ has: page.locator('svg') });
    await expect(cell).toHaveAccessibleDescription('Minimum -2, maximum 8, last 8; trend rising');
    await editor.getByRole('button', { name: /Order direction/ }).click();
    await page.getByRole('option', { name: 'Descending', exact: true }).click();
    await expect(cell).toHaveAccessibleDescription('Minimum -2, maximum 8, last -2; trend falling');
  });

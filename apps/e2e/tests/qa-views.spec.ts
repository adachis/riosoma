import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  offlineMap,
  openTable,
  runCommands,
  signIn,
  visit,
} from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', timezoneId: 'UTC' });

const kinds = [
  ['kanban', 'Kanban', '.rio-kanban'],
  ['gallery', 'Gallery', '.rio-gallery-view'],
  ['calendar', 'Calendar', '.rio-calendar-view'],
  ['form', 'Form', '.rio-form-view'],
  ['timeline', 'Timeline', '.rio-timeline-chart'],
  ['gantt', 'Gantt', '.rio-gantt'],
  ['list', 'List', '.rio-list-view'],
  ['map', 'Map', '.rio-map-view'],
  ['pivot', 'Pivot table', '.rio-pivot'],
  ['chart', 'Chart', '.rio-chart-view'],
  ['orgChart', 'Org chart', '.rio-org-chart'],
] as const;

async function addView(page: Page, name: string, phone: boolean, active: string) {
  if (phone)
    await page
      .getByRole('navigation', { name: 'Views', exact: true })
      .getByRole('button', { name: active, exact: true })
      .click();
  await page.getByRole('button', { name: 'Add view', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName(name), exact: true }).click();
}

for (const phone of [false, true]) {
  test.describe(phone ? 'phone view menu' : 'desktop view menu', () => {
    test.use({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      hasTouch: phone,
    });

    test('creates every non-grid type twice and keeps distinct deep links after reload', async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page);
      await offlineMap(page);
      const today = new Date().toISOString().slice(0, 10);
      const database = await createDatabase(page, 'View menu checks', [
        {
          name: 'Work',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Status', type: 'singleSelect', choices: ['Planned', 'Done'] },
            { name: 'Starts', type: 'date' },
            { name: 'Ends', type: 'date' },
            { name: 'Place', type: 'location' },
            { name: 'Cover', type: 'attachment' },
          ],
          records: phone
            ? []
            : [
                {
                  Name: '東京 🚢 مرحبا',
                  Status: 'Planned',
                  Starts: today,
                  Ends: today,
                  Place: { lat: 47.6, lng: -122.3, label: 'Harbor' },
                },
              ],
        },
      ]);
      const table = database.tables.Work!;
      await runCommands(page, database.id, [
        {
          kind: 'field.create',
          tableId: table.id,
          field: {
            id: newId('fld'),
            name: 'Parent',
            type: 'link',
            options: { linkedTableId: table.id },
          },
        },
      ]);
      await openTable(page, database, 'Work');
      let active = 'Grid';
      for (const [type, name, selector] of kinds) {
        await addView(page, name, phone, active);
        await expect(page.locator(selector).first()).toBeVisible();
        active = name;
        const navigation = page.getByRole('navigation', { name: 'Views', exact: true });
        if (phone) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
        else
          await expect(navigation.getByRole('link', { name, exact: true })).toHaveAttribute(
            'aria-current',
            'page',
          );
        const first = page.url();
        await addView(page, name, phone, active);
        active = `${name} (2)`;
        await expect(page.locator(selector).first()).toBeVisible();
        if (phone) await expect(navigation.getByRole('button', { name: active, exact: true })).toBeVisible();
        else
          await expect(navigation.getByRole('link', { name: active, exact: true })).toHaveAttribute(
            'aria-current',
            'page',
          );
        await expect
          .poll(async () => {
            const schema = await asOwner<{ views: Array<{ id: string; name: string; type: string }> }>(
              page,
              'GET',
              `/api/databases/${database.id}/schema`,
            );
            return schema.views.filter((view) => view.type === type).map((view) => view.name);
          })
          .toEqual([name, active]);
        const second = page.url();
        expect(second).not.toBe(first);
        await visit(page, first);
        await expect(page.locator(selector).first()).toBeVisible();
        await visit(page, second);
        await expect(page.locator(selector).first()).toBeVisible();
        if (phone)
          await expect(
            page
              .getByRole('navigation', { name: 'Views', exact: true })
              .getByRole('button', { name: active, exact: true }),
          ).toBeVisible();
        else
          await expect(page.getByRole('link', { name: active, exact: true })).toHaveAttribute(
            'aria-current',
            'page',
          );
      }
    });
  });
}

test('repeated duplication preserves view settings and a long renamed view', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'View copies', [
    { name: 'Cards', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: '東京 🚢 مرحبا' }] },
  ]);
  await openTable(page, database, 'Cards');
  await addView(page, 'Gallery', false, 'Grid');
  await expect(page.getByRole('grid', { name: 'Gallery', exact: true })).toBeVisible();
  const viewId = page.url().split('/').at(-1)!;
  await runCommands(page, database.id, [
    { kind: 'view.update', viewId, config: { gallery: { cardSize: 'large', coverFit: 'fit' } } },
  ]);
  for (const name of ['Gallery copy', 'Gallery copy (2)']) {
    await page.getByRole('button', { name: 'More for Gallery', exact: true }).click();
    await page.getByRole('menuitem', { name: labelName('Duplicate'), exact: true }).click();
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect
      .poll(async () => {
        const schema = await asOwner<{
          views: Array<{ name: string; config: { gallery: { cardSize: string; coverFit: string } } }>;
        }>(page, 'GET', `/api/databases/${database.id}/schema`);
        return schema.views.find((view) => view.name === name)?.config.gallery;
      })
      .toMatchObject({ cardSize: 'large', coverFit: 'fit' });
  }
  const renamed = '東京 🚢 مرحبا '.repeat(18).trim();
  await page.getByRole('button', { name: 'More for Gallery copy (2)', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Rename'), exact: true }).click();
  await page.getByRole('textbox', { name: 'Rename', exact: true }).fill(renamed);
  await page.getByRole('textbox', { name: 'Rename', exact: true }).press('Enter');
  await expect(page.getByRole('link', { name: renamed, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.reload();
  await expect(page.getByRole('grid', { name: renamed, exact: true })).toBeVisible();
});

test('copies a maximum-length Unicode view name without rejecting the new view', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Long view names', [
    { name: 'Cards', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const name = `${'界'.repeat(253)}🚢`;
  const viewId = await createView(page, database, 'Cards', { name, type: 'gallery' });
  await visit(page, `${base()}/${database.id}/${database.tables.Cards!.id}/${viewId}`);
  await page.getByRole('button', { name: `More for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Duplicate'), exact: true }).click();
  await expect
    .poll(async () => {
      const schema = await asOwner<{ views: Array<{ name: string; type: string }> }>(
        page,
        'GET',
        `/api/databases/${database.id}/schema`,
      );
      return schema.views.filter((view) => view.type === 'gallery').map((view) => view.name);
    })
    .toEqual([name, `${'界'.repeat(250)} copy`]);
  await expect(page.getByRole('grid', { name: `${'界'.repeat(250)} copy`, exact: true })).toBeVisible();
});

test('delayed view creation preserves a later selection', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Delayed view', [
    { name: 'Cards', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Keep this view' }] },
  ]);
  await openTable(page, database, 'Cards');
  await addView(page, 'Gallery', false, 'Grid');
  await expect(page.getByRole('grid', { name: 'Gallery', exact: true })).toBeVisible();
  let release: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    await held;
    const response = await route.fetch();
    await route.fulfill({ response });
    finish!();
  });
  await addView(page, 'Kanban', false, 'Gallery');
  await page
    .getByRole('navigation', { name: 'Views', exact: true })
    .getByRole('link', { name: 'Grid', exact: true })
    .click();
  const address = page.url();
  release!();
  await finished;
  await expect(page.getByRole('link', { name: 'Kanban', exact: true })).toBeVisible();
  await expect(page).toHaveURL(address);
  await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(address);
  await expect(page.getByRole('link', { name: 'Kanban', exact: true })).toBeVisible();
});

test('a rejected view creation keeps the current view open', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Refused view', [
    { name: 'Cards', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Keep this view' }] },
  ]);
  await openTable(page, database, 'Cards');
  await addView(page, 'Gallery', false, 'Grid');
  await expect(page.getByRole('grid', { name: 'Gallery', exact: true })).toBeVisible();
  const address = page.url();
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    const payload = route.request().postDataJSON();
    for (const command of payload.commands) if (command.kind === 'view.create') command.view.name = 'Grid';
    const response = await route.fetch({ postData: JSON.stringify(payload) });
    await route.fulfill({ response });
  });
  await addView(page, 'Kanban', false, 'Gallery');
  await expect(
    page.getByText('Another view of this table already has that name.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(address);
  await expect(page.getByRole('gridcell', { name: labelName('Keep this view') })).toBeVisible();
});

test('a calendar using one field for both dates keeps end resizing from changing its start', async ({
  page,
}) => {
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, 'Point events', [
    {
      name: 'Visits',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'When', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
      ],
      records: [{ Name: '東京 🚢 مرحبا', When: `${today}T10:00:00Z` }],
    },
  ]);
  const table = database.tables.Visits!;
  const viewId = await createView(page, database, 'Visits', {
    name: 'Calendar',
    type: 'calendar',
    config: { calendar: { startFieldId: table.fields.When, endFieldId: table.fields.When } },
  });
  await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
  const event = page.locator(`[data-calendar-record="${table.records[0]}"]`);
  await expect(event).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resize end of 東京 🚢 مرحبا', exact: true })).toHaveCount(0);
  await event.press('Alt+Shift+ArrowDown');
  await event.press('Alt+ArrowDown');
  await expect
    .poll(async () => {
      const result = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${viewId}/rows`,
      );
      return result.rows[0]!.values[table.fields.When!];
    })
    .toBe(`${today}T10:30:00.000Z`);
});

test('record creation inside cards, lists, and calendars writes the selected stack or date', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, 'New view records', [
    {
      name: 'Work',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Planned', 'Done'] },
        { name: 'Starts', type: 'date' },
      ],
    },
  ]);
  const table = database.tables.Work!;
  for (const type of ['kanban', 'gallery', 'list', 'calendar'] as const) {
    const viewId = await createView(page, database, 'Work', {
      name: type,
      type,
      config: {
        kanban: { stackFieldId: table.fields.Status },
        calendar: { startFieldId: table.fields.Starts },
      },
    });
    await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
    if (type === 'calendar') await page.locator(`[data-calendar-day="${today}"]`).focus();
    const created = page.waitForRequest(
      (request) =>
        request.url().endsWith('/commands') &&
        request
          .postDataJSON()
          ?.commands?.some((command: { kind: string }) => command.kind === 'record.create'),
    );
    if (type === 'kanban')
      await page
        .getByRole('region', { name: 'Done', exact: true })
        .getByRole('button', { name: 'New card', exact: true })
        .click();
    else if (type === 'calendar')
      await page
        .locator(`[data-calendar-day="${today}"]`)
        .getByRole('button', { name: /^Add a record on/ })
        .click();
    else await page.getByRole('button', { name: 'New record', exact: true }).click();
    const command = (await created)
      .postDataJSON()
      .commands.find((command: { kind: string }) => command.kind === 'record.create');
    if (type === 'kanban')
      expect(command.records[0].values[table.fields.Status!]).toBe(table.choices.Status!.Done);
    if (type === 'calendar') expect(command.records[0].values[table.fields.Starts!]).toBe(today);
    const name = `New ${type} 東京 🚢 مرحبا`;
    const editor = page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true });
    await editor.fill(name);
    await editor.press('Enter');
    await expect
      .poll(async () => {
        const row = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${table.id}/records/${command.records[0].id}`,
        );
        return row.values[table.fields.Name!];
      })
      .toBe(name);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

test('all non-grid views retain per-view settings and enforce reader access through the API', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const today = new Date().toISOString().slice(0, 10);
  const database = await createDatabase(page, 'View access and settings', [
    {
      name: 'Work',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Planned', 'Done'] },
        { name: 'Starts', type: 'date' },
        { name: 'Ends', type: 'date' },
        { name: 'Place', type: 'location' },
      ],
      records: [
        { Name: 'Visible 東京 🚢 مرحبا', Status: 'Planned', Starts: today, Ends: today },
        { Name: 'Excluded', Status: 'Done', Starts: today, Ends: today },
      ],
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
  const views: string[] = [];
  for (const [type, name] of kinds) {
    const viewId = await createView(page, database, 'Work', {
      name,
      type,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [
            {
              id: 'planned',
              fieldId: table.fields.Status,
              operator: 'is',
              value: table.choices.Status!.Planned,
            },
          ],
        },
        sorts: [{ fieldId: table.fields.Name, direction: 'desc' }],
        hiddenFieldIds: [table.fields.Ends],
        kanban: { stackFieldId: table.fields.Status },
        calendar: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends },
        timeline: {
          startFieldId: table.fields.Starts,
          endFieldId: table.fields.Ends,
          groupFieldId: table.fields.Status,
        },
        gantt: { startFieldId: table.fields.Starts, endFieldId: table.fields.Ends },
        map: { locationFieldId: table.fields.Place, colorFieldId: table.fields.Status },
        chart: { groupBy: { fieldId: table.fields.Status } },
        pivot: { rows: [{ fieldId: table.fields.Status }] },
        orgChart: { parentFieldId: parent },
        form: { questions: [{ fieldId: table.fields.Name, required: true }] },
      },
    });
    views.push(viewId);
    if (type !== 'form') {
      const rows = await asOwner<{ rows: Array<{ id: string }> }>(page, 'GET', `/api/views/${viewId}/rows`);
      expect(rows.rows.map((row) => row.id)).toEqual([table.records[0]]);
    }
  }
  const person = await invite(page, browser, 'View Reader');
  const guest = await invite(page, browser, 'View Guest', 'guest');
  try {
    for (const viewId of views) {
      expect((await person.page.request.get(`${base()}/api/views/${viewId}/rows`)).status()).toBe(404);
      expect((await guest.page.request.get(`${base()}/api/views/${viewId}/rows`)).status()).toBe(404);
    }
    for (const role of ['creator', 'editor', 'commenter', 'reader'] as const) {
      await share(page, database.id, person, role);
      for (const viewId of views) {
        const response = await person.page.request.get(`${base()}/api/views/${viewId}/rows`);
        expect(response.ok(), `${role} can read the view`).toBe(true);
      }
      const schema = await asOwner<{
        views: Array<{ id: string; config: { hiddenFieldIds: string[]; sorts: unknown[]; filter: unknown } }>;
      }>(person.page, 'GET', `/api/databases/${database.id}/schema`);
      expect(schema.views.filter((view) => views.includes(view.id))).toHaveLength(kinds.length);
      for (const view of schema.views.filter((view) => views.includes(view.id))) {
        expect(view.config.hiddenFieldIds).toEqual([table.fields.Ends]);
        expect(view.config.sorts).toEqual([{ fieldId: table.fields.Name, direction: 'desc' }]);
        expect(view.config.filter).not.toBeNull();
      }
    }
    await share(page, database.id, guest, 'reader');
    for (const viewId of views)
      expect((await guest.page.request.get(`${base()}/api/views/${viewId}/rows`)).ok()).toBe(true);
    const visitor = await browser.newContext({ serviceWorkers: 'block' });
    try {
      for (const viewId of views)
        expect((await visitor.request.get(`${base()}/api/views/${viewId}/rows`)).ok()).toBe(false);
    } finally {
      await visitor.close();
    }
  } finally {
    await person.context.close();
    await guest.context.close();
  }
});

test('a signed-in form validates required answers, uploads an attachment, and focuses confirmation', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Form files', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Form',
    type: 'form',
    config: {
      form: { questions: [{ fieldId: table.fields.Name, required: true }, { fieldId: table.fields.Files }] },
    },
  });
  await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Answer this question.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Name', exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  const name = '東京 🚢 مرحبا';
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  const filename = '資料 🚢.txt';
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('Form attachment 東京 🚢 مرحبا'),
  });
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const confirmation = page.getByRole('status').filter({ hasText: 'Thanks!  Your answer was recorded.' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  const result = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows`,
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.values[table.fields.Name!]).toBe(name);
  expect(result.rows[0]!.values[table.fields.Files!]).toEqual([expect.any(String)]);
});

test('a gallery record edit survives a lost connection and saves after reconnecting', async ({
  page,
  context,
}) => {
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  const database = await createDatabase(page, 'Offline cards', [
    {
      name: 'Cards',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Before' }],
    },
  ]);
  const table = database.tables.Cards!;
  const viewId = await createView(page, database, 'Cards', { name: 'Gallery', type: 'gallery' });
  await visit(page, `${base()}/${database.id}/${table.id}/${viewId}`);
  await page.getByRole('gridcell', { name: labelName('Before') }).dblclick();
  const editor = page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true });
  await expect(editor).toHaveValue('Before');
  await context.setOffline(true);
  try {
    await editor.fill('After 東京 🚢 مرحبا');
    await editor.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    await expect(editor).toHaveValue('After 東京 🚢 مرحبا');
  } finally {
    await context.setOffline(false);
  }
  await expect
    .poll(async () => {
      const row = await asOwner<{ values: Record<string, unknown> }>(
        page,
        'GET',
        `/api/tables/${table.id}/records/${table.records[0]}`,
      );
      return row.values[table.fields.Name!];
    })
    .toBe('After 東京 🚢 مرحبا');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('gridcell', { name: labelName('After 東京 🚢 مرحبا') })).toBeVisible();
});

test('a signed-out form submits a corrected required answer on its first press', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Public form corrections', [
    {
      name: 'Requests',
      fields: [{ name: 'Name', type: 'text' }],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Form',
    type: 'form',
    config: { form: { questions: [{ fieldId: table.fields.Name, required: true }] } },
  });
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, `${base()}${shared.path}`);
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByText('Answer this question.', { exact: true })).toBeVisible();
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('東京 🚢 مرحبا');
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    const confirmation = form.getByRole('status').filter({ hasText: 'Thanks!  Your answer was recorded.' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toBeFocused();
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.values[table.fields.Name!]).toBe('東京 🚢 مرحبا');
  } finally {
    await visitor.close();
  }
});

import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { csvRows, part, slides, tableRows, texts, unzip, workbookRows } from '../files';
import {
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
import { invite, personId, share, waitForMail } from '../people';
import { rows } from '../sql';
import { readReportPdf } from '../../server/src/reports/pdf.test-support';
import type { ReportSchedule } from '../../../packages/contracts/src/reports';

test.use({ serviceWorkers: 'block' });

async function saved(page: Page, press: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download'), press.click()]);
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

async function reports(page: Page, view = 'Grid') {
  const navigation = page.getByRole('navigation', { name: 'Views' });
  if (await navigation.getByRole('button', { name: view, exact: true }).isVisible())
    await navigation.getByRole('button', { name: view, exact: true }).click();
  await page.getByRole('button', { name: `More for ${view}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Scheduled reports' }).click();
  return page.getByRole('dialog', { name: 'Scheduled reports' });
}

async function schedule(page: Page, viewId: string, name: string, recipients?: string[]) {
  return asOwner<ReportSchedule>(page, 'POST', `/api/views/${viewId}/reports`, {
    name,
    format: 'pdf',
    recipients: (recipients ?? [await personId(page)]).map((userId) => ({ kind: 'member', userId })),
    frequency: { kind: 'daily', at: '09:00' },
    timeZone: 'America/Los_Angeles',
    enabled: false,
  });
}

for (const width of [1280, 390]) {
  test(`a reader downloads a received PDF through their own rows at width ${width}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const reader = await invite(page, browser, 'Report Reader');
    try {
      const database = await createDatabase(page, 'Recipient reports', [
        {
          name: 'Orders',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Visible', type: 'checkbox' },
          ],
          records: [
            { Name: 'Reader order', Visible: true },
            { Name: 'Owner order', Visible: false },
          ],
        },
      ]);
      const orders = database.tables.Orders!;
      await share(page, database.id, reader, 'reader');
      await asOwner(page, 'PUT', `/api/tables/${orders.id}/record-rules`, {
        rules: [
          {
            id: newId('rul'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: orders.fields.Visible, operator: 'is', value: true }],
            },
          },
        ],
      });
      await schedule(page, orders.viewId, 'Team PDF', [await personId(page), reader.id]);
      await reader.page.setViewportSize({ width, height: 900 });
      await openTable(reader.page, database, 'Orders');
      const dialog = await reports(reader.page);
      await dialog.getByRole('button', { name: 'More for Team PDF' }).click();
      for (const name of ['Edit', 'Send now', 'History', 'Delete'])
        await expect(reader.page.getByRole('menuitem', { name })).toHaveCount(0);
      await reader.page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const ownerGrid = await openTable(page, database, 'Orders');
      await ownerGrid.getByRole('gridcell', { name: 'Reader order', exact: true }).dblclick();
      const editor = page.locator('textarea[data-editing]');
      await editor.fill('Latest reader order');
      await editor.press('Enter');
      const readerGrid = reader.page.getByRole('grid', { name: 'Grid', exact: true });
      await expect(
        readerGrid.getByRole('gridcell', { name: 'Latest reader order', exact: true }),
      ).toBeVisible();
      await ownerGrid.getByRole('gridcell', { name: 'Latest reader order', exact: true }).click();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(readerGrid.getByRole('gridcell', { name: 'Reader order', exact: true })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(
        readerGrid.getByRole('gridcell', { name: 'Latest reader order', exact: true }),
      ).toBeVisible();
      const refreshed = await reports(reader.page);
      await refreshed.getByRole('button', { name: 'More for Team PDF' }).click();
      const file = await saved(reader.page, reader.page.getByRole('menuitem', { name: 'Download PDF' }));
      const text = (await readReportPdf(file.bytes)).map((page) => page.text).join(' ');
      expect(text).toContain('Latest reader order');
      expect(text).not.toContain('Owner order');
    } finally {
      await reader.context.close();
    }
  });
}

test('reads all five report formats from every view with filters and hidden fields', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await offlineMap(page);
  const database = await createDatabase(page, 'Report formats', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Notes', type: 'longText', options: { richText: true } },
        { name: 'Hidden', type: 'text' },
        { name: 'Date', type: 'date' },
        { name: 'Stage', type: 'singleSelect', choices: ['Ready', 'Waiting'] },
      ],
      records: [
        {
          Name: '東京 고객 中文 order',
          Amount: 120,
          Notes: '**Rich text**\n\nSecond paragraph',
          Hidden: 'Hidden sentinel',
          Date: '2026-10-02',
          Stage: 'Ready',
        },
        { Name: 'Filtered sentinel', Amount: 0, Hidden: 'Hidden sentinel', Stage: 'Waiting' },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  const config = {
    hiddenFieldIds: [orders.fields.Hidden],
    filter: {
      conjunction: 'and',
      conditions: [{ id: 'positive', fieldId: orders.fields.Amount, operator: 'gt', value: 0 }],
    },
    groups: [{ fieldId: orders.fields.Stage, direction: 'asc' }],
    summaries: { [orders.fields.Amount!]: 'sum' },
    colorRules: [
      {
        id: 'positive',
        target: 'cell',
        color: 'green',
        condition: { id: 'positive', fieldId: orders.fields.Amount, operator: 'gt', value: 0 },
      },
    ],
    calendar: { dateFieldId: orders.fields.Date },
    kanban: { stackFieldId: orders.fields.Stage },
    chart: { groupBy: { fieldId: orders.fields.Stage }, value: { fieldId: orders.fields.Amount, fn: 'sum' } },
  };
  await runCommands(page, database.id, [{ kind: 'view.update', viewId: orders.viewId, config }]);
  const views = [{ id: orders.viewId, name: 'Grid', type: 'grid' }];
  for (const type of [
    'kanban',
    'gallery',
    'calendar',
    'form',
    'timeline',
    'gantt',
    'chart',
    'pivot',
    'list',
    'map',
    'orgChart',
  ])
    views.push({
      id: await createView(page, database, 'Orders', { name: type, type, config }),
      name: type,
      type,
    });
  await visit(page, `${base()}/${database.id}/${orders.id}/${orders.viewId}`);
  await expect(page.getByRole('treegrid', { name: 'Grid' })).toBeVisible();
  for (const view of views) {
    for (const [format, label] of [
      ['csv', 'Download CSV'],
      ['xlsx', 'Download Excel'],
      ['docx', 'Word document'],
      ['pptx', 'PowerPoint deck'],
    ] as const) {
      await page
        .getByRole('navigation', { name: 'Views' })
        .getByRole('button', { name: `More for ${view.name}` })
        .click();
      let file: Awaited<ReturnType<typeof saved>>;
      if (format === 'docx' || format === 'pptx') {
        await page.getByRole('menuitem', { name: label }).click();
        file = await saved(
          page,
          page
            .getByRole('dialog', {
              name: format === 'docx' ? 'Download a Word document' : 'Download a PowerPoint deck',
            })
            .getByRole('button', { name: 'Download', exact: true }),
        );
      } else file = await saved(page, page.getByRole('menuitem', { name: label }));
      expect(file.name).toBe(`Orders - ${view.name}.${format}`);
      let content: string;
      if (format === 'csv') {
        const cells = csvRows(file.bytes);
        expect(cells).toHaveLength(2);
        content = cells.flat().join(' ');
      } else if (format === 'docx')
        content = tableRows(part(unzip(file.bytes), 'word/document.xml'))
          .flat()
          .join(' ');
      else if (format === 'pptx')
        content = slides(unzip(file.bytes))
          .flatMap((slide) => texts(slide, 'a:t'))
          .join(' ');
      else {
        const sheets = await workbookRows(file.bytes);
        expect(sheets[0]).toHaveLength(2);
        expect(sheets[0]![1]).toContain(120);
        content = sheets.flat(2).join(' ');
      }
      expect(content).toContain('東京 고객 中文 order');
      expect(content).toContain('Rich text');
      for (const value of ['Filtered sentinel', 'Hidden sentinel', 'Hidden'])
        expect(content).not.toContain(value);
    }
    const report = await schedule(page, view.id, `PDF ${view.name}`);
    if (view.type === 'form') {
      const response = await page.request.get(`${base()}/api/reports/${report.id}/download`);
      expect(response.ok()).toBe(true);
      expect(
        (await readReportPdf(await response.body()))
          .map((page) => page.text)
          .join(' ')
          .replaceAll(' ', ''),
      ).toContain('東京고객中文order');
    } else {
      const dialog = await reports(page, view.name);
      await dialog.getByRole('button', { name: `More for PDF ${view.name}` }).click();
      const file = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
      const content = (await readReportPdf(file.bytes)).map((page) => page.text).join(' ');
      expect(content.replaceAll(' ', '')).toContain('東京고객中文order');
      expect(content).toContain('Rich text');
      for (const value of ['Filtered sentinel', 'Hidden sentinel', 'Hidden'])
        expect(content).not.toContain(value);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  }
});

test('edits, pauses, resumes, retries errors, and sends a report now from a phone', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 900 });
  await signIn(page);
  const database = await createDatabase(page, 'Schedule lifecycle', [
    {
      name: 'Orders',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Lifecycle order' }],
    },
  ]);
  const viewId = database.tables.Orders!.viewId;
  await openTable(page, database, 'Orders');
  const dialog = await reports(page);
  await expect(dialog.getByText('No scheduled reports for this view yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Set up a report' }).click();
  const form = page.getByRole('dialog', { name: 'Set up a report' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('');
  await form.getByRole('button', { name: 'Set up report', exact: true }).click();
  await expect(form.getByText('Give the report a name.')).toBeVisible();
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Lifecycle PDF');
  await form.getByRole('radio', { name: 'PDF document' }).press('Space');
  await form.getByRole('combobox', { name: 'Time zone', exact: true }).fill('Asia/Tokyo');
  await page.getByRole('option', { name: 'Asia/Tokyo', exact: true }).click();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/views/${viewId}/reports`) && response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Set up report', exact: true }).press('Enter');
  const report = (await (await created).json()) as ReportSchedule;
  await expect(form).toBeHidden();

  const [schema] = await rows<{ table_schema: string }>(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = 'report_schedules'",
  );
  const nextRun = new Date(Date.now() + 3_600_000).toISOString();
  await rows(`UPDATE "${schema!.table_schema}".report_schedules SET next_run_at = $1 WHERE id = $2`, [
    nextRun,
    report.id,
  ]);
  await dialog.getByRole('button', { name: 'More for Lifecycle PDF' }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit report' });
  await expect(edit.getByRole('combobox', { name: 'Time zone', exact: true })).toHaveValue('Asia/Tokyo');
  await edit.getByRole('textbox', { name: 'Name', exact: true }).fill('Updated lifecycle PDF');
  const endpoint = `**/api/reports/${report.id}`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', messageKey: 'errors.internal' } }),
    }),
  );
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit.getByRole('alert')).toBeVisible();
  await page.unroute(endpoint);
  await page.route(endpoint, (route) => route.abort('failed'));
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit.getByRole('alert')).toBeVisible();
  await page.unroute(endpoint);
  const updated = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/reports/${report.id}`) && response.request().method() === 'PUT',
  );
  await edit.getByRole('button', { name: 'Save', exact: true }).press('Enter');
  expect(((await (await updated).json()) as ReportSchedule).nextRunAt).toBe(nextRun);
  await expect(edit).toBeHidden();
  const toggle = dialog.getByRole('switch', { name: 'Updated lifecycle PDF' });
  await toggle.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await asOwner<{ owned: ReportSchedule[] }>(page, 'GET', '/api/reports')).owned.find(
          (item) => item.id === report.id,
        )?.nextRunAt,
    )
    .toBeNull();
  await toggle.press('Space');
  await expect(toggle).toBeChecked();
  await toggle.press('Space');
  await expect(toggle).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  const reopened = await reports(page);
  await expect(reopened.getByRole('switch', { name: 'Updated lifecycle PDF' })).not.toBeChecked();
  await reopened.getByRole('button', { name: 'More for Updated lifecycle PDF' }).click();
  await page.getByRole('menuitem', { name: 'Send now' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Sent Updated lifecycle PDF' })).toBeVisible();
  const mail = await waitForMail(
    (mail) => mail.subject === 'Updated lifecycle PDF: Grid',
    'the manually sent paused report',
  );
  expect((await readReportPdf(mail.attachments[0]!.content)).map((page) => page.text).join(' ')).toContain(
    'Lifecycle order',
  );
  await reopened.getByRole('button', { name: 'More for Updated lifecycle PDF' }).click();
  await page.getByRole('menuitem', { name: 'History', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'History' }).getByText('Sent now', { exact: true }),
  ).toBeVisible();
});

test('reads right-to-left text in a downloaded report PDF', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Unicode reports', [
    {
      name: 'Orders',
      fields: [{ name: 'Customer', type: 'text' }],
      records: [{ Customer: 'مرحبا שלום 中文 東京 고객' }],
    },
  ]);
  await schedule(page, database.tables.Orders!.viewId, 'تقرير שלום');
  await openTable(page, database, 'Orders');
  const dialog = await reports(page);
  await dialog.getByRole('button', { name: 'More for تقرير שלום' }).click();
  const file = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
  const content = (await readReportPdf(file.bytes)).map((page) => page.text).join(' ');
  const compact = content.replaceAll(' ', '');
  for (const value of ['中文', '東京', '고객']) expect(compact).toContain(value);
  for (const value of ['مرحبا', 'שלום']) expect(compact).toContain([...value].reverse().join(''));
});

test('keeps PDF download errors in the dialog and retries without navigating away', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Download errors', [
    {
      name: 'Orders',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Retry order' }],
    },
  ]);
  const report = await schedule(page, database.tables.Orders!.viewId, 'Retry PDF');
  await openTable(page, database, 'Orders');
  const dialog = await reports(page);
  const endpoint = `**/api/reports/${report.id}/download`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', messageKey: 'errors.internal' } }),
    }),
  );
  await dialog.getByRole('button', { name: 'More for Retry PDF' }).click();
  await page.getByRole('menuitem', { name: 'Download PDF' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute(endpoint);
  await dialog.getByRole('button', { name: 'More for Retry PDF' }).click();
  const file = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
  expect((await readReportPdf(file.bytes)).map((page) => page.text).join(' ')).toContain('Retry order');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('retains task completion when downloading and emailing a PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Task reports', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText', options: { richText: true } },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  const recordId = newId('rec');
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: orders.id,
      records: [{ id: recordId, values: { [orders.fields.Name!]: 'Task order' } }],
    },
  ]);
  const report = await schedule(page, orders.viewId, 'Task PDF');
  await openTable(page, database, 'Orders');
  for (const checked of [true, false]) {
    const marker = checked ? '[x]' : '[ ]';
    const otherMarker = checked ? '[ ]' : '[x]';
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: orders.id,
        records: [
          {
            id: recordId,
            values: {
              [orders.fields.Notes!]: `- ${marker} **Pay invoice**\n  - ${otherMarker} Review receipt`,
            },
          },
        ],
      },
    ]);
    const dialog = await reports(page);
    await dialog.getByRole('button', { name: 'More for Task PDF' }).click();
    const file = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
    const text = (await readReportPdf(file.bytes)).map((page) => page.text).join(' ');
    expect(text).toContain(`${marker} Pay invoice`);
    expect(text).toContain(`${otherMarker} Review receipt`);
    await dialog.getByRole('button', { name: 'More for Task PDF' }).click();
    const sent = page.waitForResponse((response) =>
      response.url().endsWith(`/api/reports/${report.id}/send`),
    );
    await page.getByRole('menuitem', { name: 'Send now' }).click();
    expect((await sent).ok()).toBe(true);
    await expect(page.getByRole('alertdialog', { name: 'Sent Task PDF' })).toBeVisible();
    const mail = await waitForMail(
      (mail) => mail.subject === 'Task PDF: Grid' && mail.html.includes(`${marker} Pay invoice`),
      'the report with current task completion',
    );
    expect(mail.html).toContain(`${otherMarker} Review receipt`);
    expect(mail.attachments).toHaveLength(1);
    const attachment = (await readReportPdf(mail.attachments[0]!.content)).map((page) => page.text).join(' ');
    expect(attachment).toContain(`${marker} Pay invoice`);
    expect(attachment).toContain(`${otherMarker} Review receipt`);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const notification = page.getByRole('alertdialog', { name: 'Sent Task PDF' });
    await notification.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(notification).toHaveCount(0);
  }
});

test('opens every emailed format with attachments, rich text, line items, and long text', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signIn(page);
  const description = newId('fld'),
    amount = newId('fld');
  const long = `Long content ${'wrapping text, "quoted" value\n'.repeat(30)}Final content`;
  const database = await createDatabase(page, 'Report content', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'longText', options: { richText: true } },
        { name: 'Files', type: 'attachment' },
        {
          name: 'Lines',
          type: 'lineItems',
          options: {
            columns: [
              { id: description, name: 'Description', type: 'text' },
              { id: amount, name: 'Amount', type: 'number' },
            ],
          },
        },
        { name: 'Long', type: 'longText' },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  const { csrfToken } = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
    csrfToken: string;
  };
  const upload = await page.request.post(
    `${base()}/api/tables/${orders.id}/fields/${orders.fields.Files}/files`,
    {
      headers: {
        'x-csrf-token': csrfToken,
        'content-type': 'text/plain',
        'x-file-name': encodeURIComponent('Delivery 東京.txt'),
      },
      data: Buffer.from('Report attachment'),
    },
  );
  expect(upload.ok(), await upload.text()).toBe(true);
  const file = (await upload.json()) as { id: string };
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: orders.id,
      records: [
        {
          id: newId('rec'),
          values: {
            [orders.fields.Name!]: 'Content order',
            [orders.fields.Notes!]: '**Rich words**\n\nSecond paragraph',
            [orders.fields.Files!]: [file.id],
            [orders.fields.Lines!]: [
              { id: newId('rec'), values: { [description]: 'Labor', [amount]: 12.5 } },
              { id: newId('rec'), values: { [description]: 'Parts', [amount]: 7.5 } },
            ],
            [orders.fields.Long!]: long,
          },
        },
      ],
    },
  ]);
  await openTable(page, database, 'Orders');
  for (const format of ['csv', 'xlsx', 'docx', 'pptx', 'pdf']) {
    const name = `Content ${format}`;
    const report = await asOwner<ReportSchedule>(page, 'POST', `/api/views/${orders.viewId}/reports`, {
      name,
      format,
      recipients: [{ kind: 'member', userId: await personId(page) }],
      frequency: { kind: 'daily', at: '09:00' },
      timeZone: 'America/New_York',
      enabled: false,
    });
    const dialog = await reports(page);
    await dialog.getByRole('button', { name: `More for ${name}` }).click();
    const sent = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/reports/${report.id}/send`) && response.request().method() === 'POST',
    );
    await page.getByRole('menuitem', { name: 'Send now' }).click();
    expect((await sent).ok()).toBe(true);
    await expect(page.getByRole('alertdialog', { name: `Sent ${name}` })).toBeVisible();
    const mail = await waitForMail(
      (mail) => mail.subject === `${name}: Grid`,
      `the ${format} report with content`,
    );
    expect(mail.attachments).toHaveLength(1);
    const attachment = mail.attachments[0]!;
    expect(attachment.filename).toBe(`Orders - Grid.${format}`);
    let content: string;
    if (format === 'csv') {
      const cells = csvRows(attachment.content);
      expect(cells).toHaveLength(2);
      expect(cells[1]).toContain(long);
      content = cells.flat().join(' ');
    } else if (format === 'xlsx') {
      const sheets = await workbookRows(attachment.content);
      expect(sheets[0]![1]).toContain(long);
      expect(sheets).toHaveLength(2);
      expect(sheets[1]!.flat()).toEqual(expect.arrayContaining(['Labor', 'Parts', 12.5, 7.5]));
      content = sheets.flat(2).join(' ');
    } else if (format === 'docx') {
      const document = part(unzip(attachment.content), 'word/document.xml');
      expect(document).toContain('<w:b');
      content = tableRows(document).flat().join(' ');
    } else if (format === 'pptx')
      content = slides(unzip(attachment.content))
        .flatMap((slide) => texts(slide, 'a:t'))
        .join(' ');
    else {
      content = (await readReportPdf(attachment.content)).map((page) => page.text).join(' ');
      expect(content).not.toContain('**Rich words**');
    }
    for (const value of ['Content order', 'Rich words', 'Second paragraph', 'Labor', 'Parts', 'Long content'])
      expect(content).toContain(value);
    expect(content.replaceAll(' ', '')).toContain('Delivery東京.txt');
    if (format !== 'pptx') expect(content).toContain('Final content');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('emails each recipient their permitted PDF rows and shows both deliveries in history', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const reader = await invite(page, browser, 'Delivery Reader');
  try {
    const database = await createDatabase(page, 'Recipient delivery', [
      {
        name: 'Orders',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Visible', type: 'checkbox' },
        ],
        records: [
          { Name: 'Public delivery', Visible: true },
          { Name: 'Private delivery', Visible: false },
        ],
      },
    ]);
    const orders = database.tables.Orders!;
    await share(page, database.id, reader, 'reader');
    await asOwner(page, 'PUT', `/api/tables/${orders.id}/record-rules`, {
      rules: [
        {
          id: newId('rul'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: orders.fields.Visible, operator: 'is', value: true }],
          },
        },
      ],
    });
    const report = await schedule(page, orders.viewId, 'Recipient PDF', [await personId(page), reader.id]);
    await openTable(page, database, 'Orders');
    const dialog = await reports(page);
    await dialog.getByRole('button', { name: 'More for Recipient PDF' }).click();
    const sent = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/reports/${report.id}/send`) && response.request().method() === 'POST',
    );
    await page.getByRole('menuitem', { name: 'Send now' }).click();
    expect((await sent).ok()).toBe(true);
    await expect(page.getByRole('alertdialog', { name: 'Sent Recipient PDF' })).toBeVisible();
    const own = await waitForMail(
      (mail) => mail.subject === 'Recipient PDF: Grid' && !mail.to.includes(reader.email),
      'the owner PDF',
    );
    const received = await waitForMail(
      (mail) => mail.subject === 'Recipient PDF: Grid' && mail.to.includes(reader.email),
      'the reader PDF',
    );
    for (const mail of [own, received]) {
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments[0]!.filename).toBe('Orders - Grid.pdf');
    }
    const text = async (bytes: Buffer) => (await readReportPdf(bytes)).map((page) => page.text).join(' ');
    expect(await text(own.attachments[0]!.content)).toContain('Private delivery');
    const permitted = await text(received.attachments[0]!.content);
    expect(permitted).toContain('Public delivery');
    expect(permitted).not.toContain('Private delivery');
    expect(received.html).not.toContain('Private delivery');
    await dialog.getByRole('button', { name: 'More for Recipient PDF' }).click();
    await page.getByRole('menuitem', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'History' });
    await expect(history.getByText(reader.name, { exact: true })).toBeVisible();
    await expect(history.getByText('2 records, with the file', { exact: true })).toBeVisible();
    await expect(history.getByText('1 record, with the file', { exact: true })).toBeVisible();
  } finally {
    await reader.context.close();
  }
});

test('reads every field and record across wide PDF sections and handles an empty report', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const fields = [
    { name: 'Name', type: 'text' },
    ...Array.from({ length: 18 }, (_, index) => ({ name: `Column ${index + 1}`, type: 'text' })),
  ];
  const records = Array.from({ length: 24 }, (_, row) =>
    Object.fromEntries([
      ['Name', `Wide record ${row + 1}`],
      ...fields.slice(1).map((field, index) => [field.name, `Value ${row + 1}/${index + 1}`]),
    ]),
  );
  const database = await createDatabase(page, 'Wide reports', [
    { name: 'Orders', fields, records },
    { name: 'Empty', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await schedule(page, database.tables.Orders!.viewId, 'Wide PDF');
  await openTable(page, database, 'Orders');
  const dialog = await reports(page);
  await dialog.getByRole('button', { name: 'More for Wide PDF' }).click();
  const downloaded = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
  const pages = await readReportPdf(downloaded.bytes);
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) {
    expect(page.width).toBeGreaterThan(page.height);
    expect(page.text).toContain('Name');
  }
  const content = pages.map((page) => page.text).join(' ');
  for (const field of fields) expect(content).toContain(field.name);
  for (const row of records) for (const value of Object.values(row)) expect(content).toContain(value);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await schedule(page, database.tables.Empty!.viewId, 'Empty PDF');
  await openTable(page, database, 'Empty');
  const emptyDialog = await reports(page);
  await emptyDialog.getByRole('button', { name: 'More for Empty PDF' }).click();
  const empty = await saved(page, page.getByRole('menuitem', { name: 'Download PDF' }));
  const emptyPages = await readReportPdf(empty.bytes);
  expect(emptyPages).toHaveLength(1);
  expect(emptyPages[0]!.text).toContain('0 records');
  expect(emptyPages[0]!.text).toContain('Name');
});

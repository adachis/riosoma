import { expect, test } from '../accessibility';
import { asOwner, createDatabase, flip, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('edits additional fields and runs both button actions', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
  const scriptId = newId('scr');
  const automationId = newId('aut');
  const database = await createDatabase(page, 'More field types', [
    {
      name: 'Entries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Code', type: 'text' },
        { name: 'Clock', type: 'time', options: { timeFormat: '24h' } },
        { name: 'Price', type: 'multiCurrency' },
        { name: 'Changes', type: 'changeLog' },
        { name: 'Run script', type: 'button' },
        {
          name: 'Run automation',
          type: 'button',
          options: { action: { kind: 'runAutomation', automationId } },
        },
      ],
      records: [
        { Name: 'First' },
        { Name: 'Second', Code: '00012', Clock: '14:30', Price: { amount: 12.5, code: 'EUR' } },
      ],
    },
  ]);
  const table = database.tables.Entries!;
  await runCommands(page, database.id, [
    {
      kind: 'script.create',
      script: {
        id: scriptId,
        name: 'Rename entry',
        source: `const clicked = await input.buttonRecordAsync()\nawait records.update(clicked.tableId, clicked.recordId, { '${table.fields.Name}': 'Script ran' })`,
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Rename automatically',
        config: {
          trigger: {
            kind: 'recordMatches',
            tableId: table.id,
            filter: {
              conjunction: 'and',
              conditions: [{ id: 'second', fieldId: table.fields.Name, operator: 'is', value: 'Second' }],
            },
          },
          steps: [
            {
              id: 'rename',
              kind: 'updateRecord',
              tableId: table.id,
              record: 'trigger',
              values: { [table.fields.Name!]: 'Automation ran' },
            },
          ],
        },
      },
    },
    { kind: 'automation.update', automationId, enabled: true },
  ]);
  const grid = await openTable(page, database, 'Entries');
  await grid.getByRole('columnheader', { name: 'Code', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  let settings = page.getByRole('dialog', { name: 'Edit field' });
  await settings.getByRole('button', { name: /Type/ }).click();
  await page.getByRole('option', { name: 'Barcode', exact: true }).click();
  await expect(settings.getByText('Every value converts.', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();
  await grid.getByRole('columnheader', { name: 'Run script', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  settings = page.getByRole('dialog', { name: 'Edit field' });
  await settings.getByRole('button', { name: /Action/ }).click();
  await page.getByRole('option', { name: 'Run a script', exact: true }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();
  await grid.getByRole('columnheader', { name: 'Run automation', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  settings = page.getByRole('dialog', { name: 'Edit field' });
  await flip(
    settings.getByRole('checkbox', { name: 'Allow matching records and recorded form submissions' }),
  );
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();
  await grid.getByRole('columnheader', { name: 'Changes', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'A → Z', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Filter by this field', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(grid.getByRole('gridcell', { name: '14:30:00', exact: true })).toBeVisible();
  await grid.getByRole('gridcell', { name: '00012', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill('00034');
  await page.getByRole('textbox', { name: 'Code', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: '00034', exact: true })).toBeVisible();
  await grid.getByRole('button', { name: 'Expand row 2', exact: true }).click();
  await page.getByRole('textbox', { name: 'Clock', exact: true }).fill('2:45 PM');
  await page.getByRole('textbox', { name: 'Clock', exact: true }).press('Tab');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('20');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).press('Tab');
  await expect(page.getByText(/Code,|, Code|: Code/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Run automation', exact: true }).last().click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Automation ran');
  await page.getByRole('button', { name: 'Run script', exact: true }).last().focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Rename entry' });
  await expect(panel.getByRole('status')).toContainText('Finished');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Script ran');
  await expect(grid.getByRole('gridcell', { name: 'First', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`script=${scriptId}`));
  const changes = page
    .getByRole('region', { name: 'Script ran', exact: true })
    .getByRole('group', { name: 'Changes', exact: true });
  await expect
    .poll(() => changes.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(0);
  await changes.focus();
  await expect(changes).toBeFocused();
  await changes.press('End');
  await expect.poll(() => changes.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

for (const phone of [false, true]) {
  test(`read-only record values keep keyboard focus in forced colors${phone ? ' on a phone' : ''}`, async ({
    page,
  }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
    const database = await createDatabase(page, 'Read-only focus', [
      {
        name: 'Entries',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Changes', type: 'changeLog' },
        ],
        records: [{ Name: 'First' }],
      },
    ]);
    const table = database.tables.Entries!;
    // Enough history makes the value scrollable, which is why it needs a tab stop.
    for (let index = 0; index < 16; index++) {
      await runCommands(page, database.id, [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [
            {
              id: table.records[0],
              values: { [table.fields.Name!]: index === 15 ? 'First' : `Entry ${index}` },
            },
          ],
        },
      ]);
    }
    await openTable(page, database, 'Entries');
    await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
    const changes = page
      .getByRole('dialog', { name: 'First', exact: true })
      .getByRole('group', { name: 'Changes', exact: true });
    await expect
      .poll(() => changes.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(0);
    await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(changes).toBeFocused();
    await expect(changes).toHaveClass(/rio-record-card__value/);
    await expect(page.locator('.rio-record-card__value:focus-visible')).toHaveCount(1);
    await expect(changes).not.toHaveCSS('box-shadow', 'none');

    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(changes).toBeFocused();
    await expect(page.locator('.rio-record-card__value:focus-visible')).toHaveCount(1);
    await expect(changes).toHaveCSS('outline-style', 'solid');
    await expect(changes).toHaveCSS('outline-width', '2px');
    const canvasText = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'CanvasText';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(changes).toHaveCSS('outline-color', canvasText);
  });
}

test('scans on a phone and stops the camera after a result', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Phone scanning', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Code', type: 'barcode' },
      ],
      records: [{ Name: 'Package' }],
    },
  ]);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'BarcodeDetector', {
      configurable: true,
      value: class {
        async detect() {
          return [{ rawValue: '000987' }];
        }
      },
    });
    // WebKit can collect the mediaDevices wrapper and lose its mocked method.  Keep it on
    // navigator for the life of the page so scanning always uses the silent stand-in stream.
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        const stream = canvas.captureStream(5);
        const draw = setInterval(() => canvas.getContext('2d')!.fillRect(0, 0, 10, 10), 100);
        const track = stream.getTracks()[0]!;
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(draw);
          stop();
          document.documentElement.dataset.cameraStopped = 'true';
        };
        return stream;
      },
    });
  });
  await openTable(page, database, 'Items');
  await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  await page.getByRole('button', { name: 'Scan barcode', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Code', exact: true })).toHaveValue('000987');
  await expect(page.locator('html')).toHaveAttribute('data-camera-stopped', 'true');
});

test('accepts the editable types in a public form on a phone', async ({ page, browser }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Delivery times', [
    {
      name: 'Deliveries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Code', type: 'barcode' },
        { name: 'Clock', type: 'time', options: { timeFormat: '12h' } },
        { name: 'Price', type: 'multiCurrency' },
        { name: 'Changes', type: 'changeLog' },
      ],
      records: [],
    },
  ]);
  await openTable(page, database, 'Deliveries');
  await page.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: 'Form', exact: true }).click();
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const share = page.getByRole('dialog', { name: 'Share publicly' });
  await flip(share.getByRole('switch', { name: 'Share publicly' }));
  const link = await share.getByRole('textbox', { name: 'Public link' }).inputValue();
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, link);
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Parcel');
    await form.getByRole('textbox', { name: 'Code', exact: true }).fill('000654');
    await form.getByRole('textbox', { name: 'Clock', exact: true }).fill('2:30 PM');
    await form.getByRole('textbox', { name: 'Amount', exact: true }).fill('12.5');
    await form.getByRole('textbox', { name: 'Amount', exact: true }).press('Tab');
    await form.getByRole('combobox', { name: 'Currency', exact: true }).fill('EUR');
    await form.getByRole('option', { name: 'EUR', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Changes', exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('Thanks!  Your answer was recorded.');
  } finally {
    await visitor.close();
  }
  const grid = await openTable(page, database, 'Deliveries');
  await expect(grid.getByRole('gridcell', { name: '000654', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'EUR 12.50', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: /2:30:00.*PM/ })).toBeVisible();
});

test('an external time update clears an invalid draft in an open record', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Live time updates', [
    {
      name: 'Entries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Clock', type: 'time', options: { timeFormat: '24h' } },
      ],
      records: [{ Name: 'Appointment', Clock: '14:30:00' }],
    },
  ]);
  const table = database.tables.Entries!;
  await openTable(page, database, 'Entries');
  await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  const clock = page.getByRole('textbox', { name: 'Clock', exact: true });
  await clock.fill('invalid');
  await clock.press('Tab');
  await expect(clock).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a valid time without a date.', { exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0], values: { [table.fields.Clock!]: '15:45:00' } }],
    },
  ]);
  await expect(clock).toHaveValue('15:45:00');
  await expect(clock).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a valid time without a date.', { exact: true })).toHaveCount(0);
});

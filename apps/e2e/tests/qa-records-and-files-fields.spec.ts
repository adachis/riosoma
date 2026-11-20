import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite } from '../people';
import { recordLayoutAudit } from '../tight-space-audit';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120_000);

test('an empty number saves on Enter in a record', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Empty number editing', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'Review' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
  const card = page.getByRole('region', { name: 'Review', exact: true });
  const input = card.getByRole('textbox', { name: 'Amount', exact: true });
  await input.pressSequentially('42');
  await expect(input).toHaveValue('42');
  await input.press('Enter');
  await expect
    .poll(
      async () =>
        (
          await asOwner<{ values: Record<string, unknown> }>(
            page,
            'GET',
            `/api/tables/${table.id}/records/${table.records[0]}`,
          )
        ).values[table.fields.Amount!],
    )
    .toBe(42);
});

for (const layout of ['panel', 'page'] as const) {
  test(`Escape dismisses a select picker before the record ${layout}`, async ({ page: owner, browser }) => {
    await signIn(owner);
    const editor = await invite(owner, browser, 'Picker Reviewer');
    const page = editor.page;
    try {
      await asOwner(page, 'PATCH', '/api/me/preferences', { level: 'advanced', recordLayout: 'panel' });
      const database = await createDatabase(page, 'Picker keyboard dismissal', [
        {
          name: 'Tasks',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
          ],
          records: [{ Name: 'Review', Status: 'Ready' }],
        },
      ]);
      const table = database.tables.Tasks!;
      if (layout === 'page')
        await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
      else {
        const grid = await openTable(page, database, 'Tasks');
        await grid.getByRole('button', { name: 'Expand row 1' }).click();
      }
      const record = page.getByRole('region', { name: 'Review', exact: true });
      const picker = record.getByRole('combobox', { name: 'Status', exact: true });
      await picker.focus();
      await picker.press('ArrowDown');
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      await picker.press('Escape');
      await expect(record).toBeVisible();
      await expect(picker).toHaveAttribute('aria-expanded', 'false');
      await picker.press('Escape');
      await expect(record).toHaveCount(0);
    } finally {
      await editor.context.close();
    }
  });
}

for (const width of [1440, 390]) {
  for (const layout of ['card', 'panel', 'page'] as const) {
    test(`record field editors save and reload in a ${layout} at ${width} pixels`, async ({
      page: owner,
      browser,
    }, info) => {
      await signIn(owner);
      const editor = await invite(owner, browser, 'Field Reviewer');
      const page = editor.page;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await asOwner(page, 'PATCH', '/api/me/preferences', {
        level: 'advanced',
        recordLayout: layout === 'page' ? 'card' : layout,
      });
      const description = newId('fld');
      const database = await createDatabase(page, 'Record field editing', [
        {
          name: 'Tasks',
          fields: [
            { name: 'Name', type: 'text' },
            ...[
              'email',
              'url',
              'phone',
              'number',
              'currency',
              'percent',
              'duration',
              'barcode',
              'time',
              'json',
              'location',
              'signature',
              'rating',
              'user',
              'checkbox',
              'multiCurrency',
            ].map((type) => ({ name: type, type })),
            { name: 'Notes', type: 'longText' },
            { name: 'Rich notes', type: 'longText', options: { richText: true } },
            { name: 'Date', type: 'date' },
            { name: 'Range', type: 'dateRange' },
            { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
            { name: 'Tags', type: 'multipleSelect', choices: ['Ready'] },
            { name: 'Files', type: 'attachment' },
            {
              name: 'Lines',
              type: 'lineItems',
              options: { columns: [{ id: description, name: 'Description', type: 'text' }] },
            },
            ...[
              'createdTime',
              'lastModifiedTime',
              'createdBy',
              'lastModifiedBy',
              'recordId',
              'autoNumber',
              'changeLog',
            ].map((type) => ({ name: type, type })),
            { name: 'Formula', type: 'formula', options: { expression: '1 + 1' } },
          ],
          records: [
            { Name: 'Review 東京 🧭', Date: '2026-09-27', Range: { start: '2026-09-27', end: '2026-09-27' } },
          ],
        },
        {
          name: 'Targets',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Amount', type: 'number' },
          ],
          records: [{ Name: 'Linked task', Amount: 5 }],
        },
      ]);
      const table = database.tables.Tasks!;
      const target = database.tables.Targets!;
      const link = newId('fld');
      await runCommands(page, database.id, [
        {
          kind: 'field.create',
          tableId: table.id,
          field: { id: link, name: 'Related', type: 'link', options: { linkedTableId: target.id } },
        },
        ...[
          {
            name: 'Lookup',
            type: 'lookup',
            options: { linkFieldId: link, targetFieldId: target.fields.Name },
          },
          {
            name: 'Rollup',
            type: 'rollup',
            options: { linkFieldId: link, targetFieldId: target.fields.Amount, fn: 'sum' },
          },
          { name: 'Count', type: 'count', options: { linkFieldId: link } },
        ].map((field) => ({
          kind: 'field.create',
          tableId: table.id,
          field: { id: newId('fld'), ...field },
        })),
      ]);
      try {
        const address = `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`;
        if (layout === 'page') await visit(page, `${address}/page`);
        else {
          const grid = await openTable(page, database, 'Tasks');
          await grid.getByRole('button', { name: 'Expand row 1' }).click();
        }
        const record = page.getByRole(layout === 'card' ? 'dialog' : 'region', {
          name: 'Review 東京 🧭',
          exact: true,
        });
        const expected: Record<string, unknown> = {};
        for (const [name, value] of [
          ['email', 'review@example.test'],
          ['url', 'https://example.test/review'],
          ['phone', '+1 555 0100'],
          ['number', '42'],
          ['currency', '12.50'],
          ['percent', '25%'],
          ['duration', '1:30'],
          ['barcode', '00034'],
          ['time', '14:30'],
          ['Notes', 'First 東京 🧭\nSecond שלום'],
          ['Rich notes', 'Rich 東京 🧭'],
          ['json', '{"status":"Ready 東京 🧭"}'],
        ]) {
          const input = record.getByRole('textbox', { name, exact: true });
          if (name === 'number') await input.pressSequentially(value!);
          else await input.fill(value!);
          await input.press(
            ['Notes', 'Rich notes', 'json'].includes(name!) ? 'ControlOrMeta+Enter' : 'Enter',
          );
        }
        expected[table.fields.email!] = 'review@example.test';
        expected[table.fields.url!] = 'https://example.test/review';
        expected[table.fields.phone!] = '+1 555 0100';
        expected[table.fields.number!] = 42;
        expected[table.fields.currency!] = 12.5;
        expected[table.fields.percent!] = 0.25;
        expected[table.fields.duration!] = 5400;
        expected[table.fields.barcode!] = '00034';
        expected[table.fields.time!] = '14:30:00';
        expected[table.fields.Notes!] = 'First 東京 🧭\nSecond שלום';
        const checkbox = record.getByRole('checkbox', { name: 'checkbox', exact: true });
        await checkbox.focus();
        await checkbox.press('Space');
        expected[table.fields.checkbox!] = true;
        for (const name of ['Status', 'Tags']) {
          const choice = record.getByRole('combobox', { name, exact: true });
          await choice.fill('Ready');
          await choice.press('ArrowDown');
          await choice.press('Enter');
          if ((await choice.getAttribute('aria-expanded')) === 'true') await choice.press('Escape');
        }
        expected[table.fields.Status!] = table.choices.Status!.Ready;
        expected[table.fields.Tags!] = [table.choices.Tags!.Ready];
        await record
          .getByRole('group', { name: 'rating', exact: true })
          .getByRole('button', { name: '3 of 5', exact: true })
          .click();
        expected[table.fields.rating!] = 3;
        const person = record.getByRole('group', { name: 'user', exact: true });
        await person.getByRole('searchbox', { name: 'Find a person' }).fill(editor.email);
        // Earlier layouts invite people with the same name.  The address identifies this reviewer.
        await person
          .getByRole('option', { name: new RegExp(editor.name) })
          .filter({ hasText: editor.email })
          .click();
        expected[table.fields.user!] = [editor.id];
        const money = record.getByRole('group', { name: 'multiCurrency', exact: true });
        await money.getByRole('textbox', { name: 'Amount', exact: true }).pressSequentially('19.5');
        await money.getByRole('textbox', { name: 'Amount', exact: true }).press('Tab');
        expected[table.fields.multiCurrency!] = { amount: 19.5, code: 'USD' };
        await record.getByRole('textbox', { name: 'Place', exact: true }).fill('Site 東京 🧭');
        const coordinates = record.getByRole('textbox', { name: 'Latitude, longitude', exact: true });
        await coordinates.fill('47.6062, -122.3321');
        await coordinates.press('Enter');
        expected[table.fields.location!] = { lat: 47.6062, lng: -122.3321, label: 'Site 東京 🧭' };
        await record
          .getByRole('button', { name: /Choose a date/ })
          .first()
          .click();
        await page.getByRole('button', { name: 'Monday, September 28, 2026', exact: true }).click();
        expected[table.fields.Date!] = '2026-09-28';
        const range = record.getByRole('group', { name: 'Range', exact: true });
        await range
          .getByRole('button', { name: /Choose a date/ })
          .last()
          .click();
        await page.getByRole('button', { name: 'Monday, September 28, 2026', exact: true }).click();
        expected[table.fields.Range!] = { start: '2026-09-27', end: '2026-09-28' };
        await record.getByRole('button', { name: 'Add line', exact: true }).click();
        const lines = record.getByRole('table', { name: 'Lines', exact: true });
        await lines.getByRole('textbox').fill('Line 東京 🧭');
        await lines.getByRole('textbox').press('Tab');
        const pad = record.getByRole('img', { name: /^Signature pad for signature/ });
        await pad.scrollIntoViewIfNeeded();
        const box = (await pad.boundingBox())!;
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
        await page.mouse.up();
        await record.getByRole('textbox', { name: 'Your name', exact: true }).fill('Review signer');
        await record.getByRole('button', { name: 'Sign', exact: true }).click();
        const chooser = page.waitForEvent('filechooser');
        await record.getByRole('button', { name: 'Add files', exact: true }).click();
        await (
          await chooser
        ).setFiles({
          name: 'Review 東京.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Record attachment'),
        });
        await expect(record.getByRole('button', { name: /^Review 東京\.txt(?: |$)/ })).toBeVisible();
        await record.getByRole('button', { name: 'Link a record', exact: true }).click();
        await record.getByRole('option', { name: 'Linked task', exact: true }).click();
        expected[link] = [target.records[0]];
        await expect
          .poll(
            async () =>
              (
                await asOwner<{ values: Record<string, unknown> }>(
                  page,
                  'GET',
                  `/api/tables/${table.id}/records/${table.records[0]}`,
                )
              ).values,
          )
          .toMatchObject(expected);
        const row = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${table.id}/records/${table.records[0]}`,
        );
        expect(row.values[table.fields['Rich notes']!]).toContain('Rich 東京 🧭');
        expect(JSON.parse(row.values[table.fields.json!] as string)).toEqual({ status: 'Ready 東京 🧭' });
        expect(row.values[table.fields.signature!]).toMatchObject({
          name: 'Review signer',
          drawing: { path: expect.any(String) },
        });
        expect(row.values[table.fields.user!]).toHaveLength(1);
        expect(row.values[table.fields.Files!]).toHaveLength(1);
        expect(row.values[table.fields.Lines!]).toHaveLength(1);
        await page.reload();
        await expect(record.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
          'First 東京 🧭\nSecond שלום',
        );
        await expect(record.getByRole('button', { name: 'Remove signature', exact: true })).toBeVisible();
        for (const name of [
          'createdTime',
          'lastModifiedTime',
          'createdBy',
          'lastModifiedBy',
          'recordId',
          'autoNumber',
          'changeLog',
          'Formula',
          'Lookup',
          'Rollup',
          'Count',
        ]) {
          const computed = record.getByRole('group', { name, exact: true });
          await expect(computed).toBeVisible();
          await expect(computed.getByRole('textbox')).toHaveCount(0);
          if (name === 'changeLog') {
            await expect(computed).toHaveAttribute('tabindex', '0');
            await computed.focus();
            await expect(computed).toBeFocused();
            await computed.press('End');
            await expect.poll(() => computed.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          }
        }
        const position = record.locator('.rio-record-card__position');
        const bounds = (await position.boundingBox())!;
        const surface = (await record.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(surface.y);
        await recordLayoutAudit(page, info, `record-fields-${layout}-${width}`);
      } finally {
        await editor.context.close();
      }
    });
  }
}

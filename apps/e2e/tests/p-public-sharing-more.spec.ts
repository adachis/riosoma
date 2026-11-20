import { expect, test } from '../accessibility';
import { base } from '../base';
import {
  asOwner,
  createDatabase,
  createView,
  everythingReceived,
  flip,
  openTable,
  signIn,
  tick,
  visit,
} from '../helpers';

test.use({ serviceWorkers: 'block' });

test('form embedding accepts exact origins and gives accessible frame code on a phone', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  const database = await createDatabase(page, 'Public Intake', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Instructions' }],
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('grid').getByRole('button', { name: 'Expand row 1' }).click();
  const record = page.getByRole('dialog', { name: 'Instructions' });
  await record.locator('input[type="file"]').setInputFiles({
    name: 'Instructions.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Bring your notes'),
  });
  await expect(record.getByText('Instructions.txt', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  // On a phone the views sit behind the one that's open, and a new one comes from that sheet.
  const views = page.getByRole('navigation', { name: 'Views' });
  await views.getByRole('button', { name: 'Grid', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Views' });
  await sheet.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: 'Form', exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: 'Share publicly' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share publicly' });
  await flip(dialog.getByRole('switch', { name: 'Share publicly' }));
  await tick(dialog, 'Instructions.txt');
  await flip(dialog.getByRole('switch', { name: 'Allow embedding on other sites' }));
  const sites = dialog.getByRole('textbox', { name: 'Sites that may embed it' });
  const origin = new URL(base()).origin;
  // A path, like a wildcard host, isn't an exact origin, and the box says so.
  await sites.fill(`${origin}/private`);
  await dialog.getByRole('button', { name: 'Save sites' }).click();
  await expect(sites).toHaveAttribute('aria-invalid', 'true');
  await sites.fill(origin);
  await dialog.getByRole('button', { name: 'Save sites' }).click();
  await expect(sites).not.toHaveAttribute('aria-invalid', 'true');
  const code = await dialog.getByRole('textbox', { name: 'Embed code' }).inputValue();
  expect(code).toContain('title=');
  expect(code).toContain('<iframe');
  await sites.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Embed code' })).toBeVisible();
});

test('an organization administrator changes public file access from its deep link', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  await page.goto(`${base()}/settings/public-sharing`);
  const files = page.getByRole('switch', { name: 'Allow signed public file links' });
  await expect(files).toBeVisible();
  const wasEnabled = await files.isChecked();
  await flip(files);
  const lifetime = page.getByRole('spinbutton', { name: 'File link lifetime in seconds' });
  const previous = await lifetime.inputValue();
  await lifetime.fill('120');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Save changes', exact: true }).getByRole('status'),
  ).toHaveText('No unsaved changes');
  await page.reload();
  await expect(files).toBeChecked({ checked: !wasEnabled });
  await expect(lifetime).toHaveValue('120');
  await flip(files);
  await lifetime.fill(previous);
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
});

for (const type of ['timeline', 'gantt', 'chart', 'pivot'] as const) {
  test(`a public ${type} opens read-only and keeps private fields off the network`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const database = await createDatabase(page, 'Shared schedule', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Start', type: 'date' },
          { name: 'Status', type: 'singleSelect', choices: ['Open'] },
          { name: 'Private note', type: 'text' },
        ],
        records: [
          {
            Name: 'First task',
            Start: new Date().toISOString().slice(0, 10),
            Status: 'Open',
            'Private note': 'Restricted draft',
          },
        ],
      },
    ]);
    const table = database.tables.Tasks!;
    const name = `Public ${type}`;
    const config = {
      hiddenFieldIds: [table.fields['Private note']],
      timeline: { startFieldId: table.fields.Start },
      gantt: { startFieldId: table.fields.Start },
      chart: { groupBy: { fieldId: table.fields.Status } },
      pivot: { rows: [{ fieldId: table.fields.Status }] },
    };
    const viewId = await createView(page, database, 'Tasks', { name, type, config });
    await page.goto(`${base()}/${database.id}/${table.id}/${viewId}`);
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('button', { name: `More for ${name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Share view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share view' });
    await flip(dialog.getByRole('switch', { name: 'Share by link' }));
    const link = await dialog.getByRole('textbox', { name: 'Link' }).inputValue();
    expect(link).toMatch(new RegExp(`^${base()}/v/\\S+$`));
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const reader = await context.newPage();
      const received = everythingReceived(reader);
      await visit(reader, link);
      await expect(reader.getByRole('heading', { name, level: 1 })).toBeVisible();
      if (type === 'chart') await reader.getByRole('button', { name: 'Show as table' }).click();
      await expect(
        reader
          .getByText(type === 'chart' || type === 'pivot' ? 'Open' : 'First task', { exact: true })
          .first(),
      ).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Add record' })).toHaveCount(0);
      await reader.waitForLoadState('networkidle');
      expect((await received()).join('\n')).not.toContain('Restricted draft');
    } finally {
      await context.close();
    }
  });
}

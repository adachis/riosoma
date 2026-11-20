import { readFile } from 'node:fs/promises';
import { expect, test } from '../accessibility';
import { createDatabase, newId, openTable, OWNER, runCommands, signIn } from '../helpers';
import { waitForMail } from '../people';
import { rows } from '../sql';
import { readReportPdf } from '../../server/src/reports/pdf.test-support';

test.use({ serviceWorkers: 'block' });

test('schedules a PDF report, reads its email attachment, and downloads it', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'PDF reports', [
    {
      name: 'Orders',
      fields: [
        { name: 'Customer', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: orders.id,
      records: [
        {
          id: newId('rec'),
          values: { [orders.fields.Customer!]: 'Harbor order', [orders.fields.Amount!]: 120 },
        },
        {
          id: newId('rec'),
          values: {
            [orders.fields.Customer!]: 'Marina order 東京 山田 고객 주문',
            [orders.fields.Amount!]: 80,
          },
        },
      ],
    },
  ]);
  await openTable(page, database, 'Orders');
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'More for Grid' })
    .click();
  await page.getByRole('menuitem', { name: 'Scheduled reports' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheduled reports' });
  await dialog.getByRole('button', { name: 'Set up a report' }).click();
  const form = page.getByRole('dialog', { name: 'Set up a report' });
  await form.getByRole('textbox', { name: 'Name' }).fill('Harbor PDF');
  await form.getByText('PDF document', { exact: true }).click();
  await expect(form.getByRole('radio', { name: 'PDF document' })).toBeChecked();
  await form.getByRole('button', { name: 'Set up report' }).click();
  await expect(form).toBeHidden();
  const report = dialog.getByRole('listitem').filter({ hasText: 'Harbor PDF' });
  await expect(report).toBeVisible();
  // Make the saved schedule due so the worker claims and sends it on its normal poll.
  const [schema] = await rows<{ table_schema: string }>(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = 'report_schedules'",
  );
  const [schedule] = await rows<{ id: string }>(
    `UPDATE "${schema!.table_schema}".report_schedules SET next_run_at = now() - interval '1 minute' WHERE view_id = $1 AND name = $2 RETURNING id`,
    [orders.viewId, 'Harbor PDF'],
  );
  expect(schedule).toBeTruthy();
  const mail = await waitForMail(
    (message) => message.to.includes(OWNER.email) && message.subject === 'Harbor PDF: Grid',
    'the scheduled PDF report',
  );
  const attachment = mail.attachments.find((file) => file.contentType === 'application/pdf');
  expect(attachment?.filename).toBe('Orders - Grid.pdf');
  const emailed = await readReportPdf(attachment!.content);
  expect(emailed).toHaveLength(1);
  for (const text of ['Harbor PDF', 'Customer', 'Amount', 'Harbor order', 'Marina order', 'Page 1 of 1'])
    expect(emailed[0]!.text).toContain(text);
  expect(emailed[0]!.text.replaceAll(' ', '')).toContain('東京山田고객주문');

  await report.getByRole('button', { name: 'More for Harbor PDF' }).click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download PDF' }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('Orders - Grid.pdf');
  const downloaded = await readReportPdf(await readFile((await download.path())!));
  expect(downloaded).toHaveLength(1);
  for (const text of ['Harbor PDF', 'Customer', 'Amount', 'Harbor order', 'Marina order', 'Page 1 of 1'])
    expect(downloaded[0]!.text).toContain(text);
  expect(downloaded[0]!.text.replaceAll(' ', '')).toContain('東京山田고객주문');
  await report.getByRole('button', { name: 'More for Harbor PDF' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  await expect(
    page.getByRole('dialog', { name: 'History' }).getByText('On schedule', { exact: true }),
  ).toBeVisible();
});

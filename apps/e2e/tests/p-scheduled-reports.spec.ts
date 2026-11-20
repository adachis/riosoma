import { expect, test, type Locator, type Page } from '../accessibility';
import {
  asOwner,
  createDatabase,
  newId,
  openTable,
  OWNER,
  runCommands,
  signIn,
  type SeededDatabase,
} from '../helpers';
import type { Mail } from '../mail';
import { invite, personId, share, waitForMail, type Person } from '../people';

/**
 * Scheduled reports by email.  The owner sets up a report on a view from the view's menu, for
 * themselves and for a member a record rule limits, and presses "Send now".  The test server's mail
 * goes to the mail catcher the stack runs, so the test reads both emails: the owner's has every
 * order, and the member's has only the orders the rule lets them see, in its summary and in its
 * file.  The report's history says who got it and how many records each got.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** The member's own orders */
const THEIRS = ['Diesel for the Kittiwake', 'Diesel for the Gannet'];
/** The owner's, which the member's report may never hold */
const OTHERS = ['Petrol for the Albatross', 'Petrol for the Skua'];

/** Fuel orders, half of them the member's, and a rule that editors see only their own. */
async function fuelOrders(page: Page, member: Person): Promise<SeededDatabase> {
  const database = await createDatabase(page, 'Fuel Dock', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Owner', type: 'user' },
        { name: 'Gallons', type: 'number' },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  const owner = await personId(page);
  const plan: Array<[string, string, number]> = [
    [THEIRS[0]!, member.id, 120],
    [THEIRS[1]!, member.id, 80],
    [OTHERS[0]!, owner, 300],
    [OTHERS[1]!, owner, 45],
  ];
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: orders.id,
      records: plan.map(([name, person, gallons]) => ({
        id: newId('rec'),
        values: {
          [orders.fields.Name!]: name,
          [orders.fields.Owner!]: [person],
          [orders.fields.Gallons!]: gallons,
        },
      })),
    },
  ]);
  await asOwner(page, 'PUT', `/api/tables/${orders.id}/record-rules`, {
    rules: [
      {
        id: newId('rul'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [
            { id: 'mine', fieldId: orders.fields.Owner, operator: 'hasAnyOf', value: ['currentPerson'] },
          ],
        },
      },
    ],
  });
  return database;
}

/** Everything a person could read in an email: its subject, text, HTML, and files. */
function contents(mail: Mail): string {
  return [
    mail.subject,
    mail.text,
    mail.html,
    ...mail.attachments.map((file) => `${file.filename}\n${file.content.toString('utf8')}`),
  ].join('\n');
}

/** Opens the view's scheduled reports from its menu. */
async function scheduledReports(page: Page): Promise<Locator> {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'More for Grid' })
    .click();
  await page.getByRole('menuitem', { name: 'Scheduled reports' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheduled reports' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the form for a new report fits a laptop’s window, with its buttons in reach', async ({
  page,
  browser,
}) => {
  // The form wraps the dialog's body and footer but, unlike the dialogs for tokens and webhooks,
  // doesn't stand in for the dialog's column, so its body never scrolls.  At 1280 by 720 the
  // buttons sit below the dialog, out of reach, and the report can't be set up.
  test.setTimeout(90_000);
  await signIn(page);
  const ruth = await invite(page, browser, 'Ruth Achebe');
  const database = await fuelOrders(page, ruth);
  await share(page, database.id, ruth, 'editor');
  await openTable(page, database, 'Orders');
  const dialog = await scheduledReports(page);
  await expect(dialog.getByText('No scheduled reports for this view yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Set up a report' }).click();
  const form = page.getByRole('dialog', { name: 'Set up a report' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Grid');
  await form.getByRole('textbox', { name: 'Name' }).fill('Fuel summary');
  await form.getByText('CSV file', { exact: true }).click();
  await expect(form.getByRole('radio', { name: 'CSV file' })).toBeChecked();
  const recipients = form.getByRole('group', { name: 'Send to' });
  await expect(recipients).toContainText(OWNER.name);
  const member = form.getByRole('combobox', { name: 'Add a member of this database' });
  // Filling an offscreen input does not consistently scroll the dialog body in every browser.
  await member.scrollIntoViewIfNeeded();
  await expect(member).toBeInViewport();
  await member.fill('Ruth');
  await page.getByRole('option', { name: /Ruth Achebe/ }).click();
  await expect(recipients).toContainText('Ruth Achebe');
  // The list closes after a choice, as other people pickers do, rather than saying no one else matches.
  await expect(page.getByRole('listbox', { name: /^Suggestions/ })).toBeHidden();
  await expect(page.getByText('No matches')).toHaveCount(0);
  const create = form.getByRole('button', { name: 'Set up report' });
  await expect(create).toBeInViewport();
  await create.click();
  await expect(form).toBeHidden();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Fuel summary' })).toBeVisible();
  await ruth.context.close();
});

test('“Send now” emails a view’s report, and a member a rule limits gets only their rows', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const lena = await invite(page, browser, 'Lena Park');
  const database = await fuelOrders(page, lena);
  await share(page, database.id, lena, 'editor');
  const orders = database.tables.Orders!;
  // Set up through the API, since its form can't be finished in this window (see the test above).
  await asOwner(page, 'POST', `/api/views/${orders.viewId}/reports`, {
    name: 'Fuel summary',
    format: 'csv',
    recipients: [
      { kind: 'member', userId: await personId(page) },
      { kind: 'member', userId: lena.id },
    ],
    frequency: { kind: 'weekly', days: [1], at: '09:00' },
    timeZone: 'America/Los_Angeles',
    enabled: true,
  });
  const grid = await openTable(page, database, 'Orders');
  await expect(grid.getByText('4 records', { exact: true })).toBeVisible();
  const dialog = await scheduledReports(page);
  const report = dialog.getByRole('listitem').filter({ hasText: 'Fuel summary' });
  await expect(report).toBeVisible();

  // "Send now" sends it at once, whatever its schedule.
  const sent = page.waitForResponse(
    (response) =>
      /\/api\/reports\/rpt\w+\/send$/.test(response.url()) && response.request().method() === 'POST',
  );
  await report.getByRole('button', { name: 'More for Fuel summary' }).click();
  await page.getByRole('menuitem', { name: 'Send now' }).click();
  expect((await sent).ok()).toBe(true);
  await expect(page.getByRole('alertdialog', { name: 'Sent Fuel summary' })).toBeVisible();

  // The owner's email holds every order.
  const subject = 'Fuel summary: Grid';
  const ownerMail = await waitForMail(
    (mail) => mail.to.includes(OWNER.email) && mail.subject === subject,
    'the owner’s report',
  );
  expect(ownerMail.text).toContain('4 records are in the view.');
  const ownerFile = ownerMail.attachments.find((file) => file.filename.endsWith('.csv'));
  expect(ownerFile, 'the owner’s report has its CSV file').toBeTruthy();
  for (const order of [...THEIRS, ...OTHERS]) expect(ownerFile!.content.toString('utf8')).toContain(order);

  // Lena's holds her two orders, in its summary and in its file, and nothing of the owner's.
  const lenaMail = await waitForMail(
    (mail) => mail.to.includes(lena.email) && mail.subject === subject,
    'Lena’s report',
  );
  expect(lenaMail.text).toContain('2 records are in the view.');
  for (const order of THEIRS) expect(lenaMail.html).toContain(order);
  const lenaFile = lenaMail.attachments.find((file) => file.filename.endsWith('.csv'));
  expect(lenaFile, 'Lena’s report has its CSV file').toBeTruthy();
  const rows = lenaFile!.content
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  expect(rows).toHaveLength(1 + THEIRS.length);
  for (const order of THEIRS) expect(rows.join('\n')).toContain(order);
  const text = contents(lenaMail);
  expect(OTHERS.filter((order) => text.includes(order))).toEqual([]);

  // The report's history says who got it and how many records each got.
  await report.getByRole('button', { name: 'More for Fuel summary' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'History' });
  const run = history.getByRole('listitem').filter({ hasText: 'Sent now' }).first();
  await expect(run.getByRole('listitem')).toHaveText([
    new RegExp(`^${OWNER.name}\\s*Sent\\s*4 records, with the file$`),
    /^Lena Park\s*Sent\s*2 records, with the file$/,
  ]);
  await lena.context.close();
});

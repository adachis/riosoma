import { expect, request, test } from '../accessibility';
import { base } from '../base';
import { calendarEvents, icalInstant } from '../files';
import { createDatabase, createView, signIn } from '../helpers';

/**
 * Calendar feeds, as someone subscribes a calendar app to a view.  They turn the feed on from the
 * calendar view's menu, copy the private address the dialog shows once, and hand it to a calendar
 * app, which the test plays with no session at all.  The feed holds the view's records as events,
 * at their times and with the view's filter, and says a calendar app read it.  Turned off, the
 * address stops working.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const HOUR = 3_600_000;

test('a calendar view’s feed serves its events to a calendar app, and stops when turned off', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  // Two days from now, on the hour, so the events are near today whenever the test runs.
  const lesson = Math.ceil((Date.now() + 2 * 24 * HOUR) / HOUR) * HOUR;
  const cleanup = lesson + 26 * HOUR;
  const closed = lesson + 50 * HOUR;
  await signIn(page);
  const database = await createDatabase(page, 'Marina Events', [
    {
      name: 'Events',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Starts', type: 'date', options: { includeTime: true } },
        { name: 'Ends', type: 'date', options: { includeTime: true } },
        { name: 'Dock', type: 'text' },
      ],
      records: [
        {
          Name: 'Kayak lesson',
          Starts: new Date(lesson).toISOString(),
          Ends: new Date(lesson + 1.5 * HOUR).toISOString(),
          Dock: 'North',
        },
        {
          Name: 'Harbor cleanup',
          Starts: new Date(cleanup).toISOString(),
          Ends: new Date(cleanup + 3 * HOUR).toISOString(),
          Dock: 'South',
        },
        {
          Name: 'Regatta',
          Starts: new Date(closed).toISOString(),
          Ends: new Date(closed + HOUR).toISOString(),
          Dock: 'Closed',
        },
      ],
    },
  ]);
  const events = database.tables.Events!;
  // The calendar leaves out what happens at the closed dock, and so should the feed.
  const viewId = await createView(page, database, 'Events', {
    name: 'Schedule',
    type: 'calendar',
    config: {
      calendar: { startFieldId: events.fields.Starts, endFieldId: events.fields.Ends, range: 'month' },
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'open', fieldId: events.fields.Dock, operator: 'isNot', value: 'Closed' }],
      },
    },
  });
  if (browserName === 'chromium')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${base()}/${database.id}/${events.id}/${viewId}`);
  const views = page.getByRole('navigation', { name: 'Views' });
  await expect(views.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');

  // The feed starts from the view's menu, and its address shows once.
  const openDialog = async () => {
    await views.getByRole('button', { name: 'More for Schedule' }).click();
    await page.getByRole('menuitem', { name: 'Subscribe in a calendar app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Subscribe in a calendar app' });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  let dialog = await openDialog();
  await dialog.getByRole('button', { name: 'Make a private address' }).click();
  const field = dialog.getByRole('textbox', { name: 'Private address' });
  await expect(field).toHaveValue(
    new RegExp(`^${base().replace(/[.]/g, '\\.')}/feeds/[A-Za-z0-9_-]{43}\\.ics$`),
  );
  const address = await field.inputValue();
  await expect(dialog.getByRole('link', { name: 'Open in your calendar app' })).toHaveAttribute(
    'href',
    address.replace(/^http:/, 'webcal:'),
  );
  await dialog.getByRole('button', { name: 'Copy address' }).click();
  if (browserName === 'chromium') {
    await expect(dialog.getByRole('status')).toHaveText('Copied the address');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A calendar app, with the address and nothing else, reads the view's events.
  const app = await request.newContext();
  const feed = await app.get(address);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toMatch(/^text\/calendar/);
  const read = calendarEvents(await feed.text());
  expect(read.map((event) => event.get('SUMMARY')?.value).sort()).toEqual(['Harbor cleanup', 'Kayak lesson']);
  const kayak = read.find((event) => event.get('SUMMARY')?.value === 'Kayak lesson')!;
  expect(kayak.get('DTSTART')?.value).toBe(icalInstant(lesson));
  expect(kayak.get('DTEND')?.value).toBe(icalInstant(lesson + 1.5 * HOUR));
  expect(kayak.get('DESCRIPTION')?.value).toContain('Dock: North');
  expect(kayak.get('URL')?.value).toMatch(
    new RegExp(`^${base().replace(/[.]/g, '\\.')}/${database.id}/${events.id}/${viewId}/rec\\w{14}$`),
  );
  const harbor = read.find((event) => event.get('SUMMARY')?.value === 'Harbor cleanup')!;
  expect(harbor.get('DTSTART')?.value).toBe(icalInstant(cleanup));

  // The dialog now says the feed is on and that a calendar app has read it, but not its address.
  dialog = await openDialog();
  await expect(dialog.getByText(/^Your calendar feed is on\./)).toContainText(
    'A calendar app last read it on',
  );
  await expect(dialog.getByRole('textbox', { name: 'Private address' })).toHaveCount(0);

  // Turned off, the address answers that it's gone.
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  const confirm = page.getByRole('dialog', { name: 'Turn off this calendar feed?' });
  await confirm.getByRole('button', { name: 'Turn off' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Make a private address' })).toBeVisible();
  const after = await app.get(address);
  expect(after.status()).toBe(410);
  expect(await after.text()).toBe('');
  await app.dispose();
});

import { expect, test, type Browser, type Page } from '../accessibility';
import { base } from '../base';
import { calendarEvents, icalInstant } from '../files';
import {
  createDatabase,
  everythingReceived,
  flip,
  openTable,
  signIn,
  tick,
  visit as visitPage,
} from '../helpers';
import { waitForMail } from '../people';

/**
 * Booking pages, as people use them.  The owner sets up a page on a table from the table's menu,
 * with weekly hours in their own time zone, 30-minute bookings, and a 10-minute buffer.  Visitors
 * who aren't signed in open the public page in a browser of their own, in another time zone, pick
 * a day and a time, fill in their details, and book.  The booking lands in the owner's grid, the
 * confirmation email carries an invitation whose times match the one booked, and its cancel link
 * frees the time again.  A second visitor who was after the same time is told it was just taken,
 * and nothing either visitor's browser receives ever names the other.
 */

/** Where the owner's browser, and so the page's hours, are */
const OWNER_ZONE = 'America/Chicago';
/** Where the visitors' browsers are, an hour ahead of the owner all year */
const VISITOR_ZONE = 'America/New_York';
const TITLE = 'Harbor Clinic visits';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block', timezoneId: OWNER_ZONE });

interface Booker {
  name: string;
  email: string;
}

const MARISOL: Booker = { name: 'Marisol Vega', email: 'marisol.vega@example.test' };
const THEO: Booker = { name: 'Theo Brandt', email: 'theo.brandt@example.test' };

/** The day an instant falls on in a zone, as `YYYY-MM-DD`. */
function dayIn(instant: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function firstDayNextMonth(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** The instant a zone's clocks read this time of day on this day. */
function wallClock(day: string, time: string, zone: string): number {
  const asUtc = Date.parse(`${day}T${time}:00Z`);
  const offset = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      })
        .formatToParts(instant)
        .map((piece) => [piece.type, Number(piece.value)]),
    );
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) - instant;
  };
  return asUtc - offset(asUtc - offset(asUtc));
}

/** A day as the calendar names its button, such as "Tuesday, September 29, 2026". */
function dayName(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${day}T12:00:00Z`));
}

/** A time of day as the page shows it, whatever space a browser puts before AM or PM. */
function clock(text: string): RegExp {
  return new RegExp(`^${text.replace(' ', '\\s')}$`);
}

interface Visit {
  page: Page;
  close(): Promise<void>;
  /** Everything the visitor's browser received, once it has all arrived */
  received(): Promise<string>;
}

/** Someone with the link and no account opens the page in a browser of their own. */
async function visit(browser: Browser, link: string): Promise<Visit> {
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: VISITOR_ZONE });
  const page = await context.newPage();
  const received = everythingReceived(page);
  await visitPage(page, link);
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
  await expect(page.getByText(`Times are shown in your time zone, ${VISITOR_ZONE}.`)).toBeVisible();
  return {
    page,
    close: () => context.close(),
    received: async () => (await received()).join('\n'),
  };
}

/**
 * Picks a day on the page's calendar, moving to the next month when the day is in it.  A day can't
 * be chosen until its month's open times have arrived, so a press that came too soon is tried again.
 */
async function chooseDay(page: Page, day: string): Promise<void> {
  // The next month's first days can be visible but disabled in the current month's last row.
  const button = page
    .getByRole('button', { name: new RegExp(dayName(day)) })
    .and(page.locator(':not([data-outside-month])'));
  await expect(
    page.getByText(/^(Choose a day with open times\.|No open times this month\.\s+Try the next one\.)$/),
  ).toBeVisible();
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'Next month' }).click();
  const times = page.getByRole('radiogroup', { name: 'Time' });
  await expect(async () => {
    await button.click();
    await expect(times).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

/** Fills in the visitor's details, after a time is picked. */
async function fillDetails(page: Page, booker: Booker, reason: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill(booker.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(booker.email);
  await page.getByRole('textbox', { name: 'Reason' }).fill(reason);
}

/** Presses "Book this time", and returns what the server answered. */
async function book(page: Page): Promise<{ status: string; start?: string; end?: string; next?: unknown[] }> {
  const answered = page.waitForResponse(
    (response) =>
      /\/api\/public\/bookings\/\w+\/bookings$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Book this time' }).click();
  const response = await answered;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('a visitor books an open time, gets an invitation, and cancels it, and a second visitor finds it taken', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await signIn(page);
  const database = await createDatabase(page, 'Harbor Clinic', [
    {
      name: 'Appointments',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Email', type: 'email' },
        { name: 'When', type: 'date', options: { includeTime: true } },
        { name: 'Reason', type: 'longText' },
      ],
    },
  ]);
  const grid = await openTable(page, database, 'Appointments');

  // The owner sets the page up from the table's menu.
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('button', { name: 'More for Appointments' })
    .click();
  await page.getByRole('menuitem', { name: 'Booking pages' }).click();
  const list = page.getByRole('dialog', { name: 'Booking pages' });
  await expect(list.getByText('No booking pages for this table yet.')).toBeVisible();
  await list.getByRole('button', { name: 'Make a booking page' }).click();
  const form = page.getByRole('dialog', { name: 'Make a booking page' });
  await form.getByRole('textbox', { name: 'Title' }).fill(TITLE);
  // The page picks the fields that fit, and the hours start in the owner's own zone.
  await expect(form.getByRole('button', { name: /Time field$/ })).toHaveText('When');
  await expect(form.getByRole('combobox', { name: 'Time zone' })).toHaveValue(OWNER_ZONE);
  await expect(form.getByRole('textbox', { name: 'Length, in minutes' })).toHaveValue('30');
  const buffer = form.getByRole('textbox', { name: 'Buffer, in minutes' });
  await buffer.fill('10');
  await buffer.press('Tab');
  await expect(buffer).toHaveValue('10');
  // Weekdays start open from nine to five.  The weekend opens too, so the chosen day always has times.
  for (const weekend of ['Saturday', 'Sunday']) {
    const day = form.getByRole('switch', { name: weekend });
    await flip(day);
    await expect(day).toBeChecked();
  }
  await tick(form, 'Ask for Reason');
  await form.getByRole('button', { name: 'Make booking page' }).click();
  const item = list.getByRole('listitem').filter({ hasText: TITLE });
  await expect(item.getByRole('switch', { name: TITLE })).toBeChecked();
  await expect(item.getByText('No upcoming bookings')).toBeVisible();
  const link = await item.getByRole('textbox', { name: 'Public link' }).inputValue();
  expect(link).toMatch(new RegExp(`^${base().replace(/[.]/g, '\\.')}/b/[0-9A-Za-z]{22}$`));
  // The form that had the focus is gone, so the new page's link takes it, and Escape still closes
  // the dialog.  In Firefox and Safari the focus used to fall out of the dialog instead.
  await expect(item.getByRole('button', { name: 'Copy link' })).toBeFocused();
  await flip(item.getByRole('switch', { name: 'Allow embedding on other sites' }));
  await item.getByRole('textbox', { name: 'Sites that may embed it' }).fill(new URL(base()).origin);
  await item.getByRole('button', { name: 'Save sites' }).click();
  await expect(item.getByRole('textbox', { name: 'Embed code' })).toHaveValue(/<iframe.*title=/);

  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  // Cross a month boundary on every run, including when its first day appears in this month's last row.
  // The first time is nine in the morning where the owner is, and ten where the visitors are.
  const bookingDay = firstDayNextMonth(dayIn(Date.now(), OWNER_ZONE));
  const first = wallClock(bookingDay, '09:00', OWNER_ZONE);
  const marisol = await visit(browser, link);
  const theo = await visit(browser, link);
  await chooseDay(marisol.page, bookingDay);
  // A booking lasts 30 minutes, and the buffer keeps 10 free after it, so times come every 40.
  const times = marisol.page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio');
  await expect(times).toHaveCount(12);
  await expect(times.nth(0)).toHaveAccessibleName(clock('10:00 AM'));
  await expect(times.nth(1)).toHaveAccessibleName(clock('10:40 AM'));
  await expect(times.nth(2)).toHaveAccessibleName(clock('11:20 AM'));
  await expect(times.nth(11)).toHaveAccessibleName(clock('5:20 PM'));

  // Both visitors are after ten o'clock, its only place.
  for (const [who, booker, reason] of [
    [marisol, MARISOL, 'A sore shoulder'],
    [theo, THEO, 'A checkup'],
  ] as const) {
    if (who === theo) await chooseDay(theo.page, bookingDay);
    await who.page.getByText(clock('10:00 AM')).click();
    await expect(who.page.getByRole('radio', { name: clock('10:00 AM') })).toBeChecked();
    await fillDetails(who.page, booker, reason);
  }

  // Marisol books first.
  const booked = await book(marisol.page);
  expect(booked.status).toBe('booked');
  expect(Date.parse(booked.start!)).toBe(first);
  expect(Date.parse(booked.end!)).toBe(first + 30 * 60_000);
  await expect(marisol.page.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(
    marisol.page.getByText(`A confirmation with a calendar invitation is on its way to ${MARISOL.email}.`),
  ).toBeVisible();

  // Theo's press comes too late, and he's offered the next open times instead.
  const late = await book(theo.page);
  expect(late.status).toBe('taken');
  const taken = theo.page.getByRole('alert').filter({ hasText: 'Someone just took that time.' });
  await expect(taken).toContainText('Here are the next open times.');
  const offered = taken.getByRole('button');
  await expect(offered.first()).toContainText(/10:40/);
  await expect(theo.page.getByRole('radio', { name: clock('10:00 AM') })).toHaveCount(0);
  await offered.first().click();
  await expect(theo.page.getByRole('textbox', { name: 'Name' })).toHaveValue(THEO.name);
  const second = await book(theo.page);
  expect(second.status).toBe('booked');
  expect(Date.parse(second.start!)).toBe(first + 40 * 60_000);
  await expect(theo.page.getByRole('heading', { name: 'You’re booked' })).toBeVisible();

  // Both bookings are records in the owner's grid, which hears about them and offers them.
  await page.getByRole('button', { name: '2 new records' }).click();
  await expect(grid.getByRole('gridcell', { name: MARISOL.name })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: THEO.name })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'A sore shoulder' })).toBeVisible();

  // Marisol's confirmation carries an invitation for the time she booked.
  const mail = await waitForMail(
    (message) => message.to.includes(MARISOL.email) && message.subject.startsWith(`Booked: ${TITLE}`),
    'Marisol’s confirmation',
  );
  expect(mail.text).toContain(`You’re booked for ${TITLE}.`);
  expect(mail.text).toContain(`(${VISITOR_ZONE})`);
  const invite = mail.attachments.find((file) => file.filename === 'invite.ics');
  expect(invite, 'the confirmation has an invitation').toBeTruthy();
  expect(invite!.contentType).toBe('text/calendar');
  const events = calendarEvents(invite!.content.toString('utf8'));
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(event.get('DTSTART')?.value).toBe(icalInstant(first));
  expect(event.get('DTEND')?.value).toBe(icalInstant(first + 30 * 60_000));
  expect(event.get('SUMMARY')?.value).toBe(TITLE);
  expect(event.get('ATTENDEE')?.value).toBe(`mailto:${MARISOL.email}`);

  // Her cancel link asks first, and canceling frees ten o'clock for someone else.
  const cancel = new RegExp(`${base().replace(/[.]/g, '\\.')}/bookings/cancel\\?token=[\\w.-]+`).exec(
    mail.text,
  )?.[0];
  expect(cancel, 'the confirmation has a cancel link').toBeTruthy();
  expect(event.get('URL')?.value).toBe(cancel);
  await visitPage(marisol.page, cancel!);
  await expect(marisol.page.getByRole('heading', { name: `Cancel ${TITLE}?` })).toBeVisible();
  await marisol.page.getByRole('button', { name: 'Cancel my booking' }).click();
  await expect(marisol.page.getByRole('heading', { name: 'Your booking is canceled' })).toBeVisible();
  // The owner's grid keeps its rows still until asked, and then her record is gone to the trash.
  await expect(grid.getByRole('gridcell', { name: '1 record' })).toBeVisible();
  await page.getByRole('button', { name: 'View changed' }).click();
  await expect(grid.getByRole('gridcell', { name: MARISOL.name })).toHaveCount(0);
  await expect(grid.getByRole('gridcell', { name: THEO.name })).toBeVisible();
  await visitPage(marisol.page, link);
  await chooseDay(marisol.page, bookingDay);
  await expect(marisol.page.getByRole('radio', { name: clock('10:00 AM') })).toBeVisible();
  await expect(marisol.page.getByRole('radio', { name: clock('10:40 AM') })).toHaveCount(0);

  // Nothing either visitor's browser received names the other.
  const toMarisol = await marisol.received();
  const toTheo = await theo.received();
  for (const text of [THEO.name, THEO.email]) expect(toMarisol).not.toContain(text);
  for (const text of [MARISOL.name, MARISOL.email]) expect(toTheo).not.toContain(text);
  await marisol.close();
  await theo.close();
});

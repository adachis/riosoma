import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type BookingCancelPreview,
  type BookingPage,
  type BookingPageSettings,
  type CommandBatchResult,
  type PublicBookingPage,
  type PublicBookingResult,
  type PublicSlots,
  type TableBookingPages,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { parseCalendar } from '../calendar-feeds/ical.test-helpers.js';
import { issueTicket } from '../data/public-forms.js';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

/**
 * Booking pages end to end: setting one up, what visitors read, booking, the races and limits
 * around it, the confirmation email, and canceling.  The page runs in UTC with hours all day, so
 * its times are on the hour, and every time a test books is a few days after the real today.
 */

const ORIGIN = 'https://riosoma.example';
const DAY = 86_400_000;
const HOUR = 3_600_000;
let kit: TestPostgres;
let server: ServerFixture;
const sent: MailMessage[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'bookings', {
    baseUrl: ORIGIN,
    mailFrom: 'Riosoma Bookings <bookings@riosoma.example>',
  });
  server.ctx.mailer = {
    async send(message) {
      sent.push(message);
    },
  };
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

let addresses = 0;
/** A different address each time, so tests that aren't about the limit never reach it. */
const nextAddress = () => `198.51.100.${(addresses += 1) % 250}`;

/** A day a few days from now, in UTC, and one of its hours. */
const dayAhead = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const hourOf = (day: string, hour: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + hour * HOUR).toISOString();

async function run(databaseId: string, ...commands: Array<Record<string, unknown>>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: commands.map((command) => ({ id: newId('command'), groupId: newId('action'), ...command })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const result of response.json<CommandBatchResult>().results)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})
    ON CONFLICT DO NOTHING`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = ${role}
    WHERE resource_id = ${databaseId} AND principal_id = ${who.userId}`,
  );
}

/** A database whose one table takes bookings: who, their address, when, which room, and notes. */
async function bookingTable() {
  const f = {
    name: newId('field'),
    email: newId('field'),
    when: newId('field'),
    span: newId('field'),
    room: newId('field'),
    notes: newId('field'),
  };
  const oak = newId('choice');
  const pine = newId('choice');
  const databaseId = newId('database');
  const tableId = newId('table');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Appointments',
      table: {
        id: tableId,
        name: 'Appointments',
        fields: [
          { id: f.name, name: 'Name', type: 'text' },
          { id: f.email, name: 'Email', type: 'email' },
          { id: f.when, name: 'When', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
          { id: f.span, name: 'Span', type: 'dateRange', options: { includeTime: true, timeZone: 'UTC' } },
          {
            id: f.room,
            name: 'Room',
            type: 'singleSelect',
            options: {
              choices: [
                { id: oak, name: 'Oak', color: 'green' },
                { id: pine, name: 'Pine', color: 'blue' },
              ],
            },
          },
          { id: f.notes, name: 'Notes', type: 'longText' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, f, oak, pine };
}

type Table = Awaited<ReturnType<typeof bookingTable>>;

function settings(table: Table, overrides: Partial<BookingPageSettings> = {}): BookingPageSettings {
  return {
    title: 'Office hours',
    description: 'Pick a time that suits you.',
    timeFieldId: table.f.when,
    resourceFieldId: null,
    lengthMinutes: 60,
    bufferMinutes: 0,
    timeZone: 'UTC',
    hours: Array.from({ length: 7 }, () => [{ start: '00:00', end: '24:00' }]),
    blockedDays: [],
    maxDaysAhead: 30,
    minNoticeMinutes: 0,
    places: 1,
    nameFieldId: table.f.name,
    emailFieldId: table.f.email,
    questions: [{ fieldId: table.f.notes, required: false }],
    confirmation: 'See you soon.',
    dailyPerEmail: 5,
    ...overrides,
  };
}

async function makePage(table: Table, overrides: Partial<BookingPageSettings> = {}, who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${table.tableId}/booking-pages`,
    headers: who.headers,
    payload: { settings: settings(table, overrides), enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<BookingPage>();
}

const definition = (pageId: string) => server.app.inject({ url: `/api/public/bookings/${pageId}` });

async function slots(pageId: string, day: string, resource?: string): Promise<string[]> {
  const search = new URLSearchParams({
    from: `${day}T00:00:00.000Z`,
    to: new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY).toISOString(),
    ...(resource ? { resource } : {}),
  });
  const response = await server.app.inject({ url: `/api/public/bookings/${pageId}/slots?${search}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PublicSlots>().slots.map((slot) => slot.start);
}

/** A ticket this server would have issued `age` milliseconds ago. */
const ticket = (pageId: string, age = 3_000) =>
  issueTicket(server.config.secretKey, pageId, Date.now() - age, 'bookingPage');

function book(
  pageId: string,
  table: Table,
  start: string,
  who: { name: string; email: string; notes?: string } = { name: 'Ada Lovelace', email: 'ada@example.test' },
  extra: Record<string, unknown> = {},
  remoteAddress = nextAddress(),
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/public/bookings/${pageId}/bookings`,
    remoteAddress,
    payload: {
      ticket: ticket(pageId),
      start,
      values: {
        [table.f.name]: who.name,
        [table.f.email]: who.email,
        ...(who.notes ? { [table.f.notes]: who.notes } : {}),
      },
      timeZone: 'America/New_York',
      locale: 'en-US',
      ...extra,
    },
  });
}

async function booked(response: Awaited<ReturnType<typeof book>>) {
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<PublicBookingResult>();
  expect(result.status, response.body).toBe('booked');
  return result as Extract<PublicBookingResult, { status: 'booked' }>;
}

/** A field's column in the table's physical table. */
async function column(fieldId: string): Promise<string> {
  const result = await query<{ column_name: string }>(
    server.pool,
    sql`SELECT column_name FROM ${ident(server.schemas.app, 'fields')} WHERE id = ${fieldId}`,
  );
  return result.rows[0]!.column_name;
}

/** The table's records out of the trash, with values by field ID. */
async function records(tableId: string): Promise<Array<Record<string, unknown>>> {
  const fields = await query<{ id: string; column_name: string }>(
    server.pool,
    sql`SELECT id, column_name FROM ${ident(server.schemas.app, 'fields')} WHERE table_id = ${tableId}`,
  );
  const result = await query<Record<string, unknown>>(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  return result.rows.map((row) => ({
    __id: row.__id,
    __created_by: row.__created_by,
    ...Object.fromEntries(fields.rows.map((field) => [field.id, row[field.column_name]])),
  }));
}

/** The token in the cancel link of the email most recently sent to an address. */
function cancelTokenFor(address: string): string {
  const message = [...sent].reverse().find((item) => item.to === address);
  expect(message, `no email to ${address}`).toBeTruthy();
  const link = /https:\/\/riosoma\.example\/bookings\/cancel\?token=([^\s<"]+)/.exec(message!.text);
  expect(link).toBeTruthy();
  return decodeURIComponent(link![1]!);
}

const preview = (token: string) =>
  server.app.inject({
    url: `/api/public/bookings/cancel?${new URLSearchParams({ token })}`,
    remoteAddress: nextAddress(),
  });
const cancel = (token: string) =>
  server.app.inject({
    method: 'POST',
    url: '/api/public/bookings/cancel',
    payload: { token },
    remoteAddress: nextAddress(),
  });

describe('setting up a booking page', () => {
  it('refuses a joined table, whose rows its inputs decide', async () => {
    const table = await bookingTable();
    const side = newId('table');
    const sideKey = newId('field');
    await run(table.databaseId, {
      kind: 'table.create',
      table: {
        id: side,
        name: 'Side',
        fields: [{ id: sideKey, name: 'Key', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const joined = newId('table');
    const when = newId('field');
    await run(table.databaseId, {
      kind: 'table.create',
      table: {
        id: joined,
        name: 'Joined',
        fields: [{ id: when, name: 'When', type: 'date', options: { includeTime: true, timeZone: 'UTC' } }],
        view: { id: newId('view'), name: 'Grid' },
        joined: {
          baseTableId: table.tableId,
          steps: [
            {
              tableId: side,
              leftTableId: table.tableId,
              leftFieldId: table.f.name,
              rightFieldId: sideKey,
              kind: 'left',
            },
          ],
          fields: [{ tableId: table.tableId, fieldId: table.f.when, outputFieldId: when }],
        },
      },
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${joined}/booking-pages`,
      headers: server.owner.headers,
      payload: {
        settings: settings({ ...table, tableId: joined, f: { ...table.f, when } }),
        enabled: true,
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error).toMatchObject({ messageKey: 'sources.syncedReadOnly' });
  });

  it('lists pages for people who change the schema, and checks the fields they use', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { resourceFieldId: table.f.room });
    expect(page).toMatchObject({
      path: `/b/${page.pageId}`,
      enabled: true,
      owner: { id: server.owner.userId },
      upcoming: 0,
      problem: null,
    });
    const listed = await server.app.inject({
      url: `/api/tables/${table.tableId}/booking-pages`,
      headers: server.owner.headers,
    });
    expect(listed.json<TableBookingPages>()).toMatchObject({
      pages: [{ pageId: page.pageId }],
      emailAvailable: true,
    });

    const wrong = async (overrides: Partial<BookingPageSettings>, key: string) => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/tables/${table.tableId}/booking-pages`,
        headers: server.owner.headers,
        payload: { settings: settings(table, overrides) },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ error: { messageKey: key } });
    };
    await wrong({ timeFieldId: table.f.name }, 'bookings.settings.timeField');
    await wrong({ resourceFieldId: table.f.notes }, 'bookings.settings.resourceField');
    await wrong({ nameFieldId: table.f.email }, 'bookings.settings.nameField');
    await wrong({ emailFieldId: table.f.name }, 'bookings.settings.emailField');
    await wrong({ questions: [{ fieldId: table.f.when, required: false }] }, 'bookings.settings.question');

    const reader = await server.addMember({ name: 'Riley Reader' });
    await grant(table.databaseId, reader, 'editor');
    const refused = await server.app.inject({
      url: `/api/tables/${table.tableId}/booking-pages`,
      headers: reader.headers,
    });
    expect(refused.statusCode).toBe(403);
  });

  it('shows visitors the page’s questions and its open times, and nothing else', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { resourceFieldId: table.f.room, blockedDays: [dayAhead(4)] });
    const response = await definition(page.pageId);
    expect(response.statusCode, response.body).toBe(200);
    const read = response.json<PublicBookingPage>();
    expect(read).toMatchObject({
      title: 'Office hours',
      lengthMinutes: 60,
      timeZone: 'UTC',
      resources: [
        { id: table.oak, name: 'Oak' },
        { id: table.pine, name: 'Pine' },
      ],
      nameFieldId: table.f.name,
      emailFieldId: table.f.email,
      firstDay: dayAhead(0),
      lastDay: dayAhead(30),
    });
    expect(read.questions.map((question) => [question.label, question.type, question.required])).toEqual([
      ['Name', 'text', true],
      ['Email', 'email', true],
      ['Notes', 'longText', false],
    ]);
    const open = await slots(page.pageId, dayAhead(3), table.oak);
    expect(open).toHaveLength(24);
    expect(open[9]).toBe(hourOf(dayAhead(3), 9));
    expect(await slots(page.pageId, dayAhead(4), table.oak)).toEqual([]);
    // A page with resources needs one picked.
    const unpicked = await server.app.inject({
      url: `/api/public/bookings/${page.pageId}/slots?${new URLSearchParams({
        from: `${dayAhead(3)}T00:00:00.000Z`,
        to: `${dayAhead(4)}T00:00:00.000Z`,
      })}`,
    });
    expect(unpicked.json()).toMatchObject({ error: { messageKey: 'bookings.public.resource' } });
  });
});

describe('booking a time', () => {
  it('adds the record as the page’s owner would, starts automations, and emails an invitation', async () => {
    const table = await bookingTable();
    const logTable = newId('table');
    const logName = newId('field');
    await run(table.databaseId, {
      kind: 'table.create',
      table: {
        id: logTable,
        name: 'Log',
        fields: [{ id: logName, name: 'Entry', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const automationId = newId('automation');
    await run(
      table.databaseId,
      {
        kind: 'automation.create',
        automation: {
          id: automationId,
          name: 'Log bookings',
          config: {
            trigger: { kind: 'recordCreated', tableId: table.tableId },
            steps: [
              { id: 'log-it', kind: 'createRecord', tableId: logTable, values: { [logName]: 'Booked' } },
            ],
          },
        },
      },
      { kind: 'automation.update', automationId, enabled: true },
    );
    const page = await makePage(table, { resourceFieldId: table.f.room });
    const start = hourOf(dayAhead(3), 14);
    sent.length = 0;
    const result = await booked(
      await book(
        page.pageId,
        table,
        start,
        { name: 'Ada Lovelace', email: 'Ada@Example.test', notes: 'Hi' },
        {
          resource: table.oak,
        },
      ),
    );
    expect(result).toMatchObject({
      start,
      end: hourOf(dayAhead(3), 15),
      resource: { id: table.oak, name: 'Oak' },
      confirmation: 'See you soon.',
      emailed: true,
    });

    const [record] = await records(table.tableId);
    expect(record).toMatchObject({
      [table.f.name]: 'Ada Lovelace',
      [table.f.email]: 'Ada@Example.test',
      [table.f.room]: table.oak,
      [table.f.notes]: 'Hi',
      __created_by: server.owner.userId,
    });
    expect((record![table.f.when] as Date).toISOString()).toBe(start);
    const change = await query<{ actor_id: string | null }>(
      server.pool,
      sql`SELECT actor_id FROM ${ident(server.schemas.app, 'changes')}
        WHERE database_id = ${table.databaseId} AND kind = 'record.created' AND table_id = ${table.tableId}`,
    );
    expect(change.rows).toEqual([{ actor_id: server.owner.userId }]);
    const runs = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'automation_runs')} WHERE automation_id = ${automationId}`,
    );
    expect(runs.rowCount).toBe(1);

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message!.to).toBe('Ada@Example.test');
    expect(message!.text).toContain('You’re booked for Office hours.');
    expect(message!.text).toContain('(America/New_York)');
    expect(message!.text).toContain('With: Oak');
    const calendar = parseCalendar(message!.attachments![0]!.content);
    expect(calendar.properties.get('METHOD')).toBe('REQUEST');
    expect(calendar.events[0]).toMatchObject({
      summary: 'Office hours (Oak)',
      start: { instant: new Date(start) },
      end: { instant: new Date(hourOf(dayAhead(3), 15)) },
    });
    expect(calendar.lines.join('\n')).toContain('mailto:Ada@Example.test');
    expect(calendar.lines.join('\n')).toContain('mailto:bookings@riosoma.example');

    const listed = await server.app.inject({
      url: `/api/tables/${table.tableId}/booking-pages`,
      headers: server.owner.headers,
    });
    expect(listed.json<TableBookingPages>().pages[0]).toMatchObject({ upcoming: 1 });
  });

  it('counts each resource’s bookings on their own', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { resourceFieldId: table.f.room });
    const day = dayAhead(3);
    const start = hourOf(day, 10);
    await booked(await book(page.pageId, table, start, undefined, { resource: table.oak }));
    expect(await slots(page.pageId, day, table.oak)).not.toContain(start);
    expect(await slots(page.pageId, day, table.pine)).toContain(start);
    await booked(
      await book(
        page.pageId,
        table,
        start,
        { name: 'Bo', email: 'bo@example.test' },
        { resource: table.pine },
      ),
    );
    expect(await slots(page.pageId, day, table.pine)).not.toContain(start);
  });

  it('counts records added in the app, leaves out ones in the trash, and keeps the buffer free', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { bufferMinutes: 30, lengthMinutes: 30 });
    const day = dayAhead(3);
    const recordId = newId('record');
    // 10:10 to 10:40, off the page's grid of every hour.
    await run(table.databaseId, {
      kind: 'record.create',
      tableId: table.tableId,
      records: [
        { id: recordId, values: { [table.f.name]: 'Walk-in', [table.f.when]: `${day}T10:10:00.000Z` } },
      ],
    });
    const open = await slots(page.pageId, day);
    // Times start every hour (30 minutes plus a 30 minute buffer).  9:00 ends 9:30, and its buffer
    // reaches 10:00, before the record.  10:00 overlaps it, and 11:00 is within its buffer.
    expect(open).toContain(hourOf(day, 9));
    expect(open).not.toContain(hourOf(day, 10));
    expect(open).not.toContain(hourOf(day, 11));
    expect(open).toContain(hourOf(day, 12));
    await run(table.databaseId, { kind: 'record.trash', tableId: table.tableId, recordIds: [recordId] });
    expect(await slots(page.pageId, day)).toEqual(expect.arrayContaining([hourOf(day, 10), hourOf(day, 11)]));
  });

  it('writes and counts a date range when the page books into one', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { timeFieldId: table.f.span });
    const day = dayAhead(3);
    await run(table.databaseId, {
      kind: 'record.create',
      tableId: table.tableId,
      records: [
        {
          id: newId('record'),
          values: { [table.f.span]: { start: hourOf(day, 13), end: `${day}T15:30:00.000Z` } },
        },
      ],
    });
    const open = await slots(page.pageId, day);
    expect(open).toContain(hourOf(day, 12));
    expect(open).not.toContain(hourOf(day, 13));
    expect(open).not.toContain(hourOf(day, 15));
    expect(open).toContain(hourOf(day, 16));
    await booked(await book(page.pageId, table, hourOf(day, 16)));
    const span = await column(table.f.span);
    const name = await column(table.f.name);
    const range = await query<{ start: Date; end: Date }>(
      server.pool,
      sql`SELECT lower(${ident(span)}) AS start, upper(${ident(span)}) AS "end"
        FROM ${ident(server.schemas.data, table.tableId)} WHERE ${ident(name)} = 'Ada Lovelace'`,
    );
    expect(range.rows.map((row) => [row.start.toISOString(), row.end.toISOString()])).toEqual([
      [hourOf(day, 16), hourOf(day, 17)],
    ]);
  });

  it('lets a class fill its places, then offers the next open times', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { places: 2 });
    const day = dayAhead(3);
    const start = hourOf(day, 18);
    await booked(await book(page.pageId, table, start, { name: 'One', email: 'one@example.test' }));
    expect(await slots(page.pageId, day)).toContain(start);
    await booked(await book(page.pageId, table, start, { name: 'Two', email: 'two@example.test' }));
    expect(await slots(page.pageId, day)).not.toContain(start);
    const full = await book(page.pageId, table, start, { name: 'Three', email: 'three@example.test' });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json()).toEqual({
      status: 'taken',
      next: [19, 20, 21, 22, 23].map((hour) => ({ start: hourOf(day, hour), end: hourOf(day, hour + 1) })),
    });
    expect(await records(table.tableId)).toHaveLength(2);
  });

  it('gives the last place to one of two people booking at once, and tells the other it was just taken', async () => {
    const table = await bookingTable();
    const page = await makePage(table);
    const start = hourOf(dayAhead(5), 9);
    const [first, second] = await Promise.all([
      book(page.pageId, table, start, { name: 'Racer one', email: 'one@example.test' }),
      book(page.pageId, table, start, { name: 'Racer two', email: 'two@example.test' }),
    ]);
    const results = [first, second].map((response) => {
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PublicBookingResult>();
    });
    expect(results.map((result) => result.status).sort()).toEqual(['booked', 'taken']);
    const taken = results.find((result) => result.status === 'taken') as Extract<
      PublicBookingResult,
      { status: 'taken' }
    >;
    expect(taken.next[0]).toEqual({ start: hourOf(dayAhead(5), 10), end: hourOf(dayAhead(5), 11) });
    expect(await records(table.tableId)).toHaveLength(1);
  });

  it('refuses a time outside the hours or too soon as no longer open', async () => {
    const table = await bookingTable();
    const page = await makePage(table, {
      minNoticeMinutes: 48 * 60,
      hours: Array.from({ length: 7 }, () => [{ start: '09:00', end: '17:00' }]),
    });
    for (const start of [hourOf(dayAhead(5), 20), hourOf(dayAhead(1), 10), `${dayAhead(5)}T09:30:00.000Z`]) {
      const response = await book(page.pageId, table, start);
      expect(response.json<PublicBookingResult>().status, start).toBe('taken');
    }
    expect(await records(table.tableId)).toHaveLength(0);
  });
});

describe('what keeps bookings honest', () => {
  it('drops what bots send, and refuses stale tickets and missing answers', async () => {
    const table = await bookingTable();
    const page = await makePage(table);
    const start = hourOf(dayAhead(3), 8);
    const trapped = await book(page.pageId, table, start, undefined, { website: 'https://spam.example' });
    expect(trapped.json<PublicBookingResult>().status).toBe('booked');
    expect(await records(table.tableId)).toHaveLength(0);
    const young = await book(page.pageId, table, start, undefined, { ticket: ticket(page.pageId, 100) });
    expect(young.json()).toMatchObject({ error: { messageKey: 'bookings.public.ticket' } });
    const nameless = await book(page.pageId, table, start, { name: ' ', email: 'ada@example.test' });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.json()).toMatchObject({
      error: { messageKey: 'bookings.public.required', params: { fieldId: table.f.name } },
    });
    const sneaky = await book(page.pageId, table, start, undefined, {
      values: { [table.f.name]: 'Ada', [table.f.email]: 'ada@example.test', [table.f.room]: table.oak },
    });
    expect(sneaky.json()).toMatchObject({ error: { messageKey: 'bookings.public.unknownQuestion' } });
    expect(await records(table.tableId)).toHaveLength(0);
  });

  it('limits bookings per email address a day, and attempts per address an hour', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { dailyPerEmail: 2 });
    const day = dayAhead(6);
    const who = { name: 'Eager', email: 'eager@example.test' };
    await booked(await book(page.pageId, table, hourOf(day, 1), who));
    await booked(await book(page.pageId, table, hourOf(day, 2), { ...who, email: 'EAGER@example.test ' }));
    const third = await book(page.pageId, table, hourOf(day, 3), who);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { messageKey: 'bookings.public.dailyLimit' } });

    const address = '203.0.113.77';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await book(page.pageId, table, hourOf(day, 4), { name: '', email: '' }, {}, address);
      expect(response.statusCode).toBe(422);
    }
    const limited = await book(page.pageId, table, hourOf(day, 4), undefined, {}, address);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never shows a visitor anything about someone else’s booking', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { resourceFieldId: table.f.room });
    const day = dayAhead(4);
    const grace = { name: 'Grace Hopper', email: 'grace.secret@example.test', notes: 'Grace’s private note' };
    sent.length = 0;
    await booked(await book(page.pageId, table, hourOf(day, 9), grace, { resource: table.oak }));
    const graceToken = cancelTokenFor(grace.email);
    const [graceRecord] = await records(table.tableId);
    const secrets = [
      grace.name,
      grace.email,
      grace.notes,
      String(graceRecord!.__id),
      graceToken.split('.')[0]!,
    ];

    const bodies: string[] = [];
    bodies.push((await definition(page.pageId)).body);
    for (const resource of [table.oak, table.pine]) {
      const search = new URLSearchParams({
        from: `${day}T00:00:00.000Z`,
        to: `${dayAhead(5)}T00:00:00.000Z`,
        resource,
      });
      bodies.push(
        (await server.app.inject({ url: `/api/public/bookings/${page.pageId}/slots?${search}` })).body,
      );
    }
    const alan = { name: 'Alan Turing', email: 'alan@example.test' };
    bodies.push((await book(page.pageId, table, hourOf(day, 9), alan, { resource: table.oak })).body);
    bodies.push((await book(page.pageId, table, hourOf(day, 10), alan, { resource: table.oak })).body);
    const alanToken = cancelTokenFor(alan.email);
    bodies.push((await preview(alanToken)).body);
    bodies.push((await cancel(alanToken)).body);
    for (const body of bodies) for (const secret of secrets) expect(body).not.toContain(secret);
    // The taken time came back as taken, with nothing but other open times.
    expect(JSON.parse(bodies[3]!)).toMatchObject({ status: 'taken' });
  });
});

describe('canceling with the link in the email', () => {
  it('previews without changing anything, cancels once, and frees the time', async () => {
    const table = await bookingTable();
    const page = await makePage(table, { resourceFieldId: table.f.room });
    const day = dayAhead(7);
    const start = hourOf(day, 11);
    sent.length = 0;
    await booked(
      await book(
        page.pageId,
        table,
        start,
        { name: 'Kay', email: 'kay@example.test' },
        { resource: table.pine },
      ),
    );
    const token = cancelTokenFor('kay@example.test');
    const looked = await preview(token);
    expect(looked.statusCode, looked.body).toBe(200);
    expect(looked.json<BookingCancelPreview>()).toEqual({
      title: 'Office hours',
      start,
      end: hourOf(day, 12),
      resource: 'Pine',
      state: 'booked',
    });
    expect(await records(table.tableId)).toHaveLength(1);

    const first = await cancel(token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<BookingCancelPreview>().state).toBe('canceled');
    expect(await records(table.tableId)).toHaveLength(0);
    expect(await slots(page.pageId, day, table.pine)).toContain(start);
    const trashed = await query<{ actor_id: string | null }>(
      server.pool,
      sql`SELECT actor_id FROM ${ident(server.schemas.app, 'changes')}
        WHERE database_id = ${table.databaseId} AND kind = 'record.trashed'`,
    );
    expect(trashed.rows).toEqual([{ actor_id: server.owner.userId }]);

    // Used again, it says the booking is canceled and changes nothing more.
    const again = await cancel(token);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<BookingCancelPreview>().state).toBe('canceled');
    expect((await preview(token)).json<BookingCancelPreview>().state).toBe('canceled');
    const after = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'changes')}
        WHERE database_id = ${table.databaseId} AND kind = 'record.trashed'`,
    );
    expect(after.rowCount).toBe(1);
  });

  it('refuses a link that was tampered with', async () => {
    const table = await bookingTable();
    const page = await makePage(table);
    sent.length = 0;
    await booked(
      await book(page.pageId, table, hourOf(dayAhead(7), 13), { name: 'Lee', email: 'lee@example.test' }),
    );
    const token = cancelTokenFor('lee@example.test');
    const [id, signature] = token.split('.') as [string, string];
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    const otherId = `bkg${'A'.repeat(14)}`;
    for (const forged of [`${id}.${flipped}`, `${otherId}.${signature}`, id, 'not a token']) {
      for (const response of [await preview(forged), await cancel(forged)]) {
        expect(response.statusCode, forged).toBe(404);
        expect(response.json()).toMatchObject({ error: { messageKey: 'bookings.cancel.invalid' } });
      }
    }
    expect(await records(table.tableId)).toHaveLength(1);
  });
});

describe('turning a page off, and who it runs as', () => {
  it('stops taking bookings at once when turned off, and keeps cancel links working', async () => {
    const table = await bookingTable();
    const page = await makePage(table);
    const day = dayAhead(8);
    sent.length = 0;
    await booked(await book(page.pageId, table, hourOf(day, 9), { name: 'Max', email: 'max@example.test' }));
    const turn = (enabled: boolean) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/booking-pages/${page.pageId}`,
        headers: server.owner.headers,
        payload: { settings: page.settings, enabled },
      });
    const off = await turn(false);
    expect(off.json<BookingPage>()).toMatchObject({ enabled: false, owner: { id: server.owner.userId } });
    for (const response of [
      await definition(page.pageId),
      await server.app.inject({
        url: `/api/public/bookings/${page.pageId}/slots?${new URLSearchParams({
          from: `${day}T00:00:00.000Z`,
          to: `${dayAhead(9)}T00:00:00.000Z`,
        })}`,
      }),
      await book(page.pageId, table, hourOf(day, 10)),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { messageKey: 'bookings.public.off' } });
    }
    expect((await cancel(cancelTokenFor('max@example.test'))).json<BookingCancelPreview>().state).toBe(
      'canceled',
    );
    await turn(true);
    expect((await definition(page.pageId)).statusCode).toBe(200);
  });

  it('runs as whoever last saved its settings, and stops when they can’t add records', async () => {
    const table = await bookingTable();
    const page = await makePage(table);
    const edith = await server.addMember({ name: 'Edith Editor' });
    await grant(table.databaseId, edith, 'creator');
    const saved = await server.app.inject({
      method: 'PUT',
      url: `/api/booking-pages/${page.pageId}`,
      headers: edith.headers,
      payload: { settings: { ...page.settings, title: 'Edith’s hours' }, enabled: true },
    });
    expect(saved.json<BookingPage>()).toMatchObject({ owner: { id: edith.userId, name: 'Edith Editor' } });
    await booked(await book(page.pageId, table, hourOf(dayAhead(9), 9)));
    expect((await records(table.tableId))[0]).toMatchObject({ __created_by: edith.userId });

    await grant(table.databaseId, edith, 'commenter');
    const gone = await definition(page.pageId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: { messageKey: 'bookings.public.notFound' } });
    const listed = await server.app.inject({
      url: `/api/tables/${table.tableId}/booking-pages`,
      headers: server.owner.headers,
    });
    expect(listed.json<TableBookingPages>().pages[0]).toMatchObject({ problem: 'bookings.problem.owner' });

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/booking-pages/${page.pageId}`,
      headers: server.owner.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await definition(page.pageId)).statusCode).toBe(404);
  });
});

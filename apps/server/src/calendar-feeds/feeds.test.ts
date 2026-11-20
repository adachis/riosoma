import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  sourceChoiceId,
  type CalendarFeedCreated,
  type CalendarFeedPolicy,
  type CalendarFeedState,
  type CommandBatchResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { loggerOptions } from '../logger.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { addDays, dayInZone } from './ical.js';
import { parseCalendar, type ParsedCalendar, type ParsedEvent } from './ical.test-helpers.js';

/**
 * Calendar feeds end to end: making an address, what it reads and as whom, and when it stops.
 * Every document is read with the strict, hand-written reader in `ical.test-helpers.ts`.
 */

const ORIGIN = 'https://riosoma.example';
const ZONE = 'America/Chicago';
let kit: TestPostgres;
let server: ServerFixture;
let edith: SignedIn;
let rey: SignedIn;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'calfeeds', { baseUrl: ORIGIN });
  edith = await server.addMember({ name: 'Edith Editor' });
  rey = await server.addMember({ name: 'Rey Reader' });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const clientId = newId('client');

async function run(databaseId: string, ...commands: Array<Record<string, unknown>>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId,
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
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function put(url: string, payload: Record<string, unknown>) {
  const response = await server.app.inject({ method: 'PUT', url, headers: server.owner.headers, payload });
  expect(response.statusCode, response.body).toBe(200);
}

/** Today as the feed reads it for a date field that follows each viewer: in the zone it was made in. */
const today = () => dayInZone(new Date(), ZONE);

async function newDatabase(name: string, fields: Array<Record<string, unknown>>) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name,
      table: { id: tableId, name, fields, view: { id: newId('view'), name: 'Grid' }, records: [] },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, gridId: response.json<{ views: Array<{ id: string }> }>().views[0]!.id };
}

/**
 * Launches, with a calendar that keeps only records tagged Keep and hides one field, and a
 * timeline by a start time in New York.  Edith, an editor, sees only West records, and nobody but
 * the owner sees Secret.  Charlie is tagged Drop and Delta has no date, so neither is an event.
 */
async function launches() {
  const f = {
    name: newId('field'),
    when: newId('field'),
    ends: newId('field'),
    starts: newId('field'),
    region: newId('field'),
    notes: newId('field'),
    secret: newId('field'),
    hidden: newId('field'),
    tag: newId('field'),
  };
  const west = newId('choice');
  const east = newId('choice');
  const { databaseId, tableId, gridId } = await newDatabase('Launches', [
    { id: f.name, name: 'Name', type: 'text' },
    { id: f.when, name: 'When', type: 'date' },
    { id: f.ends, name: 'Ends', type: 'date' },
    {
      id: f.starts,
      name: 'Starts',
      type: 'date',
      options: { includeTime: true, timeZone: 'America/New_York' },
    },
    {
      id: f.region,
      name: 'Region',
      type: 'singleSelect',
      options: {
        choices: [
          { id: west, name: 'West', color: 'blue' },
          { id: east, name: 'East', color: 'green' },
        ],
      },
    },
    { id: f.notes, name: 'Notes', type: 'longText' },
    { id: f.secret, name: 'Secret', type: 'text' },
    { id: f.hidden, name: 'Backstage', type: 'text' },
    { id: f.tag, name: 'Tag', type: 'text' },
  ]);
  const day = today();
  const records = {
    alpha: newId('record'),
    bravo: newId('record'),
    charlie: newId('record'),
    delta: newId('record'),
  };
  const alphaStart = `${addDays(day, 2)}T18:30:00.000Z`;
  await run(databaseId, {
    kind: 'record.create',
    tableId,
    records: [
      {
        id: records.alpha,
        values: {
          [f.name]: 'Alpha, the first; launch',
          [f.when]: addDays(day, 2),
          [f.ends]: addDays(day, 4),
          [f.starts]: alphaStart,
          [f.region]: west,
          [f.notes]: 'Line one\nLine two, with a comma',
          [f.secret]: 'classified-alpha',
          [f.hidden]: 'backstage-alpha',
          [f.tag]: 'Keep',
        },
      },
      {
        id: records.bravo,
        values: {
          [f.name]: 'Bravo',
          [f.when]: addDays(day, 5),
          [f.region]: east,
          [f.secret]: 'classified-bravo',
          [f.tag]: 'Keep',
        },
      },
      {
        id: records.charlie,
        values: { [f.name]: 'Charlie', [f.when]: addDays(day, 1), [f.region]: west, [f.tag]: 'Drop' },
      },
      { id: records.delta, values: { [f.name]: 'Delta', [f.region]: west, [f.tag]: 'Keep' } },
    ],
  });
  const calendarId = newId('view');
  const timelineId = newId('view');
  await run(
    databaseId,
    {
      kind: 'view.create',
      view: {
        id: calendarId,
        tableId,
        name: 'Calendar',
        type: 'calendar',
        config: {
          calendar: { startFieldId: f.when, endFieldId: f.ends },
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'keep', fieldId: f.tag, operator: 'is', value: 'Keep' }],
          },
          hiddenFieldIds: [f.hidden],
        },
      },
    },
    {
      kind: 'view.create',
      view: {
        id: timelineId,
        tableId,
        name: 'Times',
        type: 'timeline',
        config: { timeline: { startFieldId: f.starts, endFieldId: null } },
      },
    },
  );
  await grant(databaseId, edith, 'editor');
  await grant(databaseId, rey, 'reader');
  await put(`/api/fields/${f.secret}/permissions`, { restricted: { roles: [], users: [] }, locked: null });
  await put(`/api/tables/${tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'west', fieldId: f.region, operator: 'is', value: west }],
        },
      },
    ],
  });
  return { databaseId, tableId, gridId, calendarId, timelineId, f, records, alphaStart, day };
}

const feedRoute = (viewId: string) => `/api/views/${viewId}/calendar-feed`;

function manage(method: 'GET' | 'POST' | 'DELETE', viewId: string, who: SignedIn = server.owner) {
  return server.app.inject({
    method,
    url: feedRoute(viewId),
    headers: who.headers,
    ...(method === 'POST' ? { payload: { timeZone: ZONE } } : {}),
  });
}

async function subscribe(viewId: string, who: SignedIn = server.owner): Promise<CalendarFeedCreated> {
  const response = await manage('POST', viewId, who);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CalendarFeedCreated>();
}

/** A calendar app's poll: no cookie, no session, only the address. */
function poll(path: string, headers: Record<string, string> = {}) {
  return server.app.inject({ method: 'GET', url: path, headers });
}

async function document(path: string): Promise<{ calendar: ParsedCalendar; body: string; etag: string }> {
  const response = await poll(path);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
  expect(response.headers['content-disposition']).toBe('attachment; filename="calendar.ics"');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cache-control']).toBe('private, no-cache');
  return {
    calendar: parseCalendar(response.rawPayload),
    body: response.body,
    etag: String(response.headers.etag),
  };
}

const byName = (calendar: ParsedCalendar) =>
  new Map(calendar.events.map((event) => [event.summary ?? '', event] as const));

const tokenOf = (path: string) => /^\/feeds\/([A-Za-z0-9_-]{43})\.ics$/.exec(path)?.[1] ?? '';

let data: Awaited<ReturnType<typeof launches>>;
beforeAll(async () => {
  data = await launches();
}, 60_000);

describe('making a feed', () => {
  it('gives a private address once, and keeps only its hash', async () => {
    const made = await subscribe(data.calendarId);
    const token = tokenOf(made.path);
    expect(token).toHaveLength(43);
    expect(made.feed).toMatchObject({ viewId: data.calendarId, lastReadAt: null });

    const state = await manage('GET', data.calendarId);
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json<CalendarFeedState>()).toEqual({ allowed: true, feed: made.feed });
    expect(state.body).not.toContain(token);

    const stored = await query<Record<string, unknown>>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, 'calendar_feeds')}`,
    );
    const audit = await query<Record<string, unknown>>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'data.calendarFeed.%'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify([stored.rows, audit.rows])).not.toContain(token);
  });

  it('is offered only on calendars, timelines, and Gantt charts', async () => {
    const response = await manage('POST', data.gridId);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.messageKey).toBe('data.view.badSetting');
  });

  it('needs the person to be able to open the view', async () => {
    const outsider = await server.addMember({ name: 'Otto Outsider' });
    expect((await manage('POST', data.calendarId, outsider)).statusCode).toBe(404);
    expect((await manage('GET', data.calendarId, outsider)).statusCode).toBe(404);
  });
});

describe('the document', () => {
  it('holds one all-day event per record the view shows, worded for a calendar app', async () => {
    const { path } = await subscribe(data.calendarId);
    const { calendar, body } = await document(path);
    expect(calendar.properties.get('X-WR-CALNAME')).toBe('Launches: Calendar');
    // The dates follow each viewer, so the zone is the one the feed was made in.
    expect(calendar.properties.get('X-WR-TIMEZONE')).toBe(ZONE);
    const events = byName(calendar);
    // Charlie fails the view's filter, and Delta has no date.
    expect([...events.keys()].sort()).toEqual(['Alpha, the first; launch', 'Bravo']);
    const alpha = events.get('Alpha, the first; launch')!;
    expect(alpha.start).toEqual({ date: addDays(data.day, 2) });
    expect(alpha.end).toEqual({ date: addDays(data.day, 5) });
    expect(alpha.uid).toBe(`${data.records.alpha}.${data.calendarId}@riosoma`);
    expect(alpha.url).toBe(
      `${ORIGIN}/${data.databaseId}/${data.tableId}/${data.calendarId}/${data.records.alpha}`,
    );
    expect(alpha.lastModified).toBeInstanceOf(Date);
    expect(alpha.description?.split('\n')).toEqual(
      expect.arrayContaining([
        'Notes: Line one',
        'Line two, with a comma',
        'Secret: classified-alpha',
        'Tag: Keep',
      ]),
    );
    // A field the view hides stays out, even for its owner.
    expect(body).not.toContain('backstage-alpha');
    expect(body).not.toContain('Backstage');
    // An event with no end lasts its one day.
    expect(events.get('Bravo')).toMatchObject({
      start: { date: addDays(data.day, 5) },
      end: { date: addDays(data.day, 6) },
    });
  });

  it('writes timed events in UTC with the view’s zone named', async () => {
    const { path } = await subscribe(data.timelineId);
    const { calendar } = await document(path);
    expect(calendar.properties.get('X-WR-TIMEZONE')).toBe('America/New_York');
    const events = byName(calendar);
    // Only Alpha has a start time, and it has no end.
    expect([...events.keys()]).toEqual(['Alpha, the first; launch']);
    expect(events.get('Alpha, the first; launch')).toMatchObject({
      start: { instant: new Date(data.alphaStart) },
      end: null,
    });
  });

  it('reads through the person’s record rules and leaves out fields restricted from them', async () => {
    const { path } = await subscribe(data.calendarId, edith);
    const { calendar, body } = await document(path);
    // Edith sees West records only, so Bravo, in the East, never reaches her calendar.
    expect([...byName(calendar).keys()]).toEqual(['Alpha, the first; launch']);
    expect(body).not.toContain('Bravo');
    expect(body).not.toContain('classified');
    expect(body).not.toContain('Secret');
    expect(calendar.events[0]!.description).toContain('Tag: Keep');
  });

  it('keeps each event’s UID across polls and new addresses', async () => {
    const first = await subscribe(data.calendarId);
    const before = (await document(first.path)).calendar.events.map((event: ParsedEvent) => event.uid);
    const again = (await document(first.path)).calendar.events.map((event: ParsedEvent) => event.uid);
    const second = await subscribe(data.calendarId);
    const after = (await document(second.path)).calendar.events.map((event: ParsedEvent) => event.uid);
    expect(before.length).toBe(2);
    expect(again).toEqual(before);
    expect(after).toEqual(before);
  });

  it('answers a matching If-None-Match with 304, and a change with a new tag', async () => {
    const { path } = await subscribe(data.calendarId);
    const { etag } = await document(path);
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const same = await poll(path, { 'if-none-match': etag });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    expect((await poll(path, { 'if-none-match': `W/${etag}` })).statusCode).toBe(304);
    expect((await poll(path, { 'if-none-match': '"something-else"' })).statusCode).toBe(200);
    await run(data.databaseId, {
      kind: 'record.update',
      tableId: data.tableId,
      records: [{ id: data.records.bravo, values: { [data.f.name]: 'Bravo, renamed' } }],
    });
    const changed = await poll(path, { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(byName(parseCalendar(changed.rawPayload)).has('Bravo, renamed')).toBe(true);
    await run(data.databaseId, {
      kind: 'record.update',
      tableId: data.tableId,
      records: [{ id: data.records.bravo, values: { [data.f.name]: 'Bravo' } }],
    });
  });

  it('notes when a calendar app last read it', async () => {
    const { path } = await subscribe(data.calendarId, rey);
    expect((await manage('GET', data.calendarId, rey)).json<CalendarFeedState>().feed?.lastReadAt).toBeNull();
    await document(path);
    const read = (await manage('GET', data.calendarId, rey)).json<CalendarFeedState>().feed?.lastReadAt;
    expect(read && Number.isFinite(Date.parse(read))).toBe(true);
  });
});

describe('when a feed stops', () => {
  it('stops the old address when a new one is made', async () => {
    const old = await subscribe(data.calendarId);
    await document(old.path);
    const current = await subscribe(data.calendarId);
    expect(current.path).not.toBe(old.path);
    expect((await poll(old.path)).statusCode).toBe(410);
    expect((await poll(current.path)).statusCode).toBe(200);
  });

  it('answers 410 once it is turned off, and 404 for an address that never was', async () => {
    const { path } = await subscribe(data.calendarId, edith);
    const off = await manage('DELETE', data.calendarId, edith);
    expect(off.statusCode).toBe(204);
    expect((await poll(path)).statusCode).toBe(410);
    expect((await manage('GET', data.calendarId, edith)).json<CalendarFeedState>().feed).toBeNull();
    const never = `/feeds/${'A'.repeat(43)}.ics`;
    expect((await poll(never)).statusCode).toBe(404);
    expect((await poll('/feeds/not-a-token.ics')).statusCode).toBe(404);
  });

  it('answers 410 once its person loses access to the view', async () => {
    const { path } = await subscribe(data.calendarId, rey);
    expect((await poll(path)).statusCode).toBe(200);
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')}
      WHERE resource_id = ${data.databaseId} AND principal_id = ${rey.userId}`,
    );
    expect((await poll(path)).statusCode).toBe(410);
    await grant(data.databaseId, rey, 'reader');
    expect((await poll(path)).statusCode).toBe(200);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${rey.userId}`,
    );
    expect((await poll(path)).statusCode).toBe(410);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = NULL WHERE id = ${rey.userId}`,
    );
  });

  it('answers 410 while the view is in the trash, and after it is deleted for good', async () => {
    const own = await launches();
    const { path } = await subscribe(own.calendarId);
    expect((await poll(path)).statusCode).toBe(200);
    await run(own.databaseId, { kind: 'view.trash', viewId: own.calendarId });
    expect((await poll(path)).statusCode).toBe(410);
    await run(own.databaseId, { kind: 'view.restore', viewId: own.calendarId });
    expect((await poll(path)).statusCode).toBe(200);
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'views')} WHERE id = ${own.calendarId}`,
    );
    expect((await poll(path)).statusCode).toBe(410);
  });

  it('stops every feed when an admin turns feeds off, and keeps them stopped when they come back on', async () => {
    const own = await launches();
    const { path } = await subscribe(own.calendarId);
    const policy = (method: 'GET' | 'PUT', who: SignedIn, enabled?: boolean) =>
      server.app.inject({
        method,
        url: '/api/admin/calendar-feeds/policy',
        headers: who.headers,
        ...(enabled === undefined ? {} : { payload: { enabled } }),
      });
    expect((await policy('PUT', edith, false)).statusCode).toBe(403);
    const off = await policy('PUT', server.owner, false);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<CalendarFeedPolicy>()).toEqual({ enabled: false });
    expect((await poll(path)).statusCode).toBe(410);
    expect((await manage('GET', own.calendarId)).json<CalendarFeedState>()).toEqual({
      allowed: false,
      feed: null,
    });
    const refused = await manage('POST', own.calendarId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.messageKey).toBe('calendarFeeds.off');

    expect((await policy('PUT', server.owner, true)).json<CalendarFeedPolicy>()).toEqual({ enabled: true });
    expect((await policy('GET', server.owner)).json<CalendarFeedPolicy>()).toEqual({ enabled: true });
    expect((await poll(path)).statusCode).toBe(410);
    const fresh = await subscribe(own.calendarId);
    expect((await poll(fresh.path)).statusCode).toBe(200);
  });

  it('limits how often one address is read', async () => {
    const { path } = await subscribe(data.timelineId, edith);
    await manage('DELETE', data.timelineId, edith);
    // Stopped addresses count too, so a stopped one can't be hammered either.
    for (let index = 0; index < 30; index += 1) expect((await poll(path)).statusCode).toBe(410);
    const limited = await poll(path);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another address has a count of its own.
    const other = await subscribe(data.timelineId, edith);
    expect((await poll(other.path)).statusCode).toBe(200);
  });
});

describe('a view with more events than a calendar holds', () => {
  it('keeps the 5,000 nearest to today, with anything spanning today among them', async () => {
    const when = newId('field');
    const ends = newId('field');
    const name = newId('field');
    const { databaseId, tableId } = await newDatabase('Crowded', [
      { id: name, name: 'Name', type: 'text' },
      { id: when, name: 'When', type: 'date' },
      { id: ends, name: 'Ends', type: 'date' },
    ]);
    const day = today();
    // Offsets from today, 5,010 of them, and one long record that started long ago and runs past today.
    const offsets = Array.from({ length: 5_010 }, (_, index) => index - 2_505);
    const rows = offsets.map((offset) => ({
      id: newId('record'),
      values: { [name]: `Day ${offset}`, [when]: addDays(day, offset) },
    }));
    rows.push({
      id: newId('record'),
      values: { [name]: 'Long haul', [when]: addDays(day, -4_000), [ends]: addDays(day, 3) },
    });
    for (let index = 0; index < rows.length; index += 1_000)
      await run(databaseId, { kind: 'record.create', tableId, records: rows.slice(index, index + 1_000) });
    const viewId = newId('view');
    await run(databaseId, {
      kind: 'view.create',
      view: {
        id: viewId,
        tableId,
        name: 'Calendar',
        type: 'calendar',
        config: { calendar: { startFieldId: when, endFieldId: ends } },
      },
    });
    const { path } = await subscribe(viewId);
    const { calendar } = await document(path);
    expect(calendar.events).toHaveLength(5_000);
    const names = new Set(calendar.events.map((event) => event.summary));
    expect(names.has('Long haul')).toBe(true);
    // The nearest are all there and the farthest are not, with a day to spare either way.
    for (const offset of offsets) {
      if (Math.abs(offset) <= 2_490) expect(names.has(`Day ${offset}`), `Day ${offset}`).toBe(true);
      if (Math.abs(offset) >= 2_502) expect(names.has(`Day ${offset}`), `Day ${offset}`).toBe(false);
    }
    // Calendar apps get them in order by day.
    const starts = calendar.events.map((event) => ('date' in event.start ? event.start.date : ''));
    expect(starts).toEqual([...starts].sort());
  });
});

describe('logs', () => {
  it('never hold a feed’s token', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const options = loggerOptions('info', true);
    const logger = pino({ ...options }, sink);
    const token = ['Tk', 'x'.repeat(20), 'Yz', '0'.repeat(19)].join('');
    const url = `/feeds/${token}.ics`;
    // Fastify logs each request under `req`, which the logger's own serializer words.
    logger.info({ req: { method: 'GET', url, id: 'request' } }, 'incoming request');
    logger.warn({ path: url, err: new Error(`could not read ${url}`) }, `feed ${url} failed`);
    await new Promise((resolve) => setImmediate(resolve));
    const text = lines.join('');
    expect(text).toContain('/feeds/[redacted]');
    expect(text).not.toContain(token);
  });
});

it('labels source selections in calendar descriptions', async () => {
  const own = await launches();
  const sourceTable = newId('table');
  const label = newId('field');
  const selected = newId('field');
  const sourceRecord = newId('record');
  await run(
    own.databaseId,
    {
      kind: 'table.create',
      table: {
        id: sourceTable,
        name: 'Labels',
        fields: [{ id: label, name: 'Label', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
    {
      kind: 'record.create',
      tableId: sourceTable,
      records: [{ id: sourceRecord, values: { [label]: 'Calendar source label' } }],
    },
    {
      kind: 'field.create',
      tableId: own.tableId,
      field: {
        id: selected,
        name: 'Source label',
        type: 'singleSelect',
        options: { source: { tableId: sourceTable } },
      },
    },
    {
      kind: 'record.update',
      tableId: own.tableId,
      records: [{ id: own.records.alpha, values: { [selected]: await sourceChoiceId(sourceRecord) } }],
    },
  );
  const { path } = await subscribe(own.calendarId);
  const { calendar } = await document(path);
  expect(byName(calendar).get('Alpha, the first; launch')?.description).toContain(
    'Source label: Calendar source label',
  );
});

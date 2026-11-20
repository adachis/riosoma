import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AirtableImport,
  DatabaseSchema,
  type AirtableReportItem,
  type FieldMeta,
  type RowData,
  type RowsPage,
  type TableMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../../../logger.js';
import {
  airtableId,
  BASE_ID,
  CATALOG_ID,
  catalogBase,
  launchBase,
  LOG_RECORDS,
  logName,
  PIXEL,
  TABLE_IDS,
} from '../../../test/airtable-base.js';
import { startFakeAirtable, type FakeAirtable } from '../../../test/fake-airtable.js';
import { startServer, type ServerFixture } from '../../../test/fixture.js';
import type { Clock } from './api.js';
import type { AirtableImporter } from './importer.js';

/**
 * Imports against a stand-in for Airtable's API.  Nothing here reaches the real Airtable.  Every
 * line the server logs is kept, to show the token never reaches the logs.
 */
const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

const TOKEN = 'test-airtable-token-not-a-secret-0001';
const STRANGER = 'stranger@example.com';
const MB = 1024 * 1024;

let kit: TestPostgres;
let server: ServerFixture;
let fake: FakeAirtable;
let importer: AirtableImporter;
const time = { now: 0 };
const clock: Clock = {
  now: () => time.now,
  sleep: async (ms) => {
    time.now += ms;
  },
};

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'airtable', { logLevel: 'trace' });
  fake = await startFakeAirtable({ token: TOKEN, bases: [], now: () => time.now });
  fake.bases.push(
    launchBase({ filesUrl: fake.url, owner: server.owner.email, stranger: STRANGER, echo: TOKEN }),
  );
  fake.files.set('pixel.png', PIXEL);
  fake.files.set('liar.bin', Buffer.alloc(2 * MB, 1));
  importer = server.ctx.airtableImports!;
  importer.apiUrl = fake.url;
  importer.clock = clock;
  // A name that points inside a private network, the way a hostile address might.
  importer.resolve = async (hostname) => [
    { address: hostname === 'files.internal.test' ? '10.0.0.7' : '127.0.0.1', family: 4 },
  ];
  // The stand-in is on this machine, and nothing else private is allowed.
  importer.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(fake.port);
  importer.limits = { fileBytes: MB, totalFileBytes: 100 * MB, inferenceRecords: 5_000 };
}, 60_000);
afterEach(() => {
  fake.reset();
  importer.limits = { fileBytes: MB, totalFileBytes: 100 * MB, inferenceRecords: 5_000 };
});
afterAll(async () => {
  await server?.close();
  await fake?.close();
  await kit?.stop();
});

async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  status = 200,
) {
  const response = await server.app.inject({
    method,
    url,
    headers: server.owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json<T>();
}

async function start(payload: Record<string, unknown> = {}) {
  return AirtableImport.parse(
    await request('POST', '/api/imports/airtable', {
      token: TOKEN,
      baseId: BASE_ID,
      name: 'Launch',
      viewName: 'Grid',
      ...payload,
    }),
  );
}

async function finished(id: string) {
  await importer.settled(id);
  return AirtableImport.parse(await request('GET', `/api/imports/airtable/${id}`));
}

async function row(id: string) {
  const result = await server.pool.query<{ sealed_token: string | null; state: string; version: number }>(
    `SELECT sealed_token, state, version FROM "${server.schemas.app}".airtable_imports WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

/** Every table in every schema, searched for some text. */
async function tablesHolding(text: string): Promise<string[]> {
  const tables = await server.pool.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`,
    [[server.schemas.app, server.schemas.data, server.schemas.audit]],
  );
  expect(tables.rows.length).toBeGreaterThan(20);
  const holding: string[] = [];
  for (const table of tables.rows) {
    const found = await query<{ count: number }>(
      server.pool,
      sql`SELECT count(*)::int AS count FROM ${ident(table.schema, table.name)} AS t WHERE t::text LIKE ${`%${text}%`}`,
    );
    if (found.rows[0]!.count) holding.push(`${table.schema}.${table.name}`);
  }
  return holding;
}

describe('listing bases', () => {
  it('lists the bases a token can see, and says when Airtable refuses the token', async () => {
    expect(await request('POST', '/api/imports/airtable/bases', { token: TOKEN })).toEqual({
      bases: [{ id: BASE_ID, name: 'Launch plan', permissionLevel: 'create' }],
    });
    const refused = await request<{ error: { messageKey: string; fields: Record<string, string> } }>(
      'POST',
      '/api/imports/airtable/bases',
      { token: 'not-the-token' },
      422,
    );
    expect(refused.error).toMatchObject({
      messageKey: 'import.airtable.tokenInvalid',
      fields: { token: 'import.airtable.tokenInvalid' },
    });
    fake.refuseWith(403);
    const scopes = await request<{ error: { messageKey: string } }>(
      'POST',
      '/api/imports/airtable/bases',
      { token: TOKEN },
      422,
    );
    expect(scopes.error.messageKey).toBe('import.airtable.scopes');
  });

  it('needs a session and a well-formed token', async () => {
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/api/imports/airtable/bases',
      payload: { token: TOKEN },
    });
    expect(anonymous.statusCode).toBe(401);
    await request('POST', '/api/imports/airtable/bases', { token: 'has spaces' }, 422);
    await request('POST', '/api/imports/airtable', { token: TOKEN, baseId: 'not-a-base' }, 422);
  });
});

describe('importing a base', () => {
  let job: AirtableImport;
  let schema: DatabaseSchema;
  let tables: Record<string, TableMeta>;
  const fieldsOf = (table: string) => schema.fields.filter((field) => field.tableId === tables[table]!.id);
  const field = (table: string, name: string): FieldMeta => {
    const found = fieldsOf(table).find((item) => item.name === name);
    if (!found) throw new Error(`No field ${table}.${name}`);
    return found;
  };
  const view = (table: string, name: string) => {
    const found = schema.views.find((item) => item.tableId === tables[table]!.id && item.name === name);
    if (!found) throw new Error(`No view ${table}.${name}`);
    return found;
  };
  const rows = (table: string, name: string, limit = 500) =>
    request<RowsPage>('GET', `/api/views/${view(table, name).id}/rows?limit=${limit}`);
  const item = (table: string | null, name: string | null, key: string): AirtableReportItem => {
    const found = job.report!.items.find(
      (entry) => entry.table === table && entry.name === name && entry.messageKey === key,
    );
    if (!found) throw new Error(`No report line for ${table}.${name} ${key}`);
    return found;
  };

  beforeAll(async () => {
    fake.requests.length = 0;
    const log = fake.hold(`/v0/${BASE_ID}/${TABLE_IDS.log}`);
    const started = await start();
    expect(started.state === 'queued' || started.state === 'running').toBe(true);
    // While it runs, the token waits in its row inside an envelope protected by the instance key.
    await log.reached;
    const running = await row(started.id);
    expect(running.state).toBe('running');
    expect(running.sealed_token).toMatch(/^rio2\./);
    expect(running.sealed_token).not.toContain(TOKEN);
    log.release();
    job = await finished(started.id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    schema = DatabaseSchema.parse(await request('GET', `/api/databases/${job.databaseId}/schema`));
    tables = Object.fromEntries(schema.tables.map((table) => [table.name, table]));
  }, 120_000);

  it('makes one database with every table, named after the base’s tables', () => {
    expect(schema.database).toMatchObject({ name: 'Launch', role: 'owner' });
    expect(schema.tables.map((table) => table.name)).toEqual(['Projects', 'Tasks', 'People', 'Log']);
    expect(tables.Projects!.description).toBe('Imported with [redacted]');
    expect(job.report).toMatchObject({ tables: 4, records: 3 + 3 + 2 + LOG_RECORDS, files: 1, views: 12 });
    expect(job.progress).toMatchObject({
      phase: null,
      tables: 4,
      tablesDone: 4,
      records: 3 + 3 + 2 + LOG_RECORDS,
    });
  });

  it('maps every field type to the closest one here', () => {
    expect(Object.fromEntries(fieldsOf('Projects').map((item) => [item.name, item.type]))).toEqual({
      Name: 'text',
      Notes: 'longText',
      Status: 'singleSelect',
      Tags: 'multipleSelect',
      Budget: 'currency',
      Share: 'percent',
      Estimate: 'duration',
      Score: 'rating',
      Active: 'checkbox',
      Start: 'date',
      Due: 'date',
      Contact: 'email',
      Site: 'url',
      Phone: 'phone',
      Owner: 'user',
      Watchers: 'text',
      Files: 'attachment',
      Tasks: 'link',
      'Task count': 'count',
      'Task names': 'lookup',
      Hours: 'rollup',
      Label: 'formula',
      Days: 'formula',
      Double: 'formula',
      Ago: 'text',
      Brief: 'longText',
      Code: 'text',
      Open: 'url',
      Number: 'autoNumber',
      Created: 'date',
      Edited: 'date',
      Author: 'user',
      Summary: 'longText',
    });
    expect(field('Projects', 'Name').description).toBe('What the project is called');
    expect(field('Projects', 'Notes').description).toBe('Notes [redacted]');
    const status = field('Projects', 'Status');
    expect(
      status.type === 'singleSelect' && status.options.choices.map(({ name, color }) => `${name}:${color}`),
    ).toEqual(['Todo:blue', 'Doing:teal', 'Done:green']);
    expect(field('Projects', 'Budget').options).toMatchObject({ code: 'USD', precision: 2 });
    expect(field('Projects', 'Share').options).toMatchObject({ precision: 1 });
    expect(field('Projects', 'Estimate').options).toEqual({ format: 'h:mm:ss' });
    expect(field('Projects', 'Score').options).toEqual({ max: 5, icon: 'heart', color: 'red' });
    expect(field('Projects', 'Active').options).toEqual({ color: 'green' });
    expect(field('Projects', 'Start').options).toMatchObject({ includeTime: false, dateFormat: 'iso' });
    expect(field('Projects', 'Due').options).toEqual({
      includeTime: true,
      dateFormat: 'us',
      timeFormat: '24h',
      timeZone: 'UTC',
    });
    expect(field('Projects', 'Owner').options).toMatchObject({ allowMultiple: false });
    expect(field('Projects', 'Hours').options).toMatchObject({ fn: 'sum', resultType: 'number' });
    expect(field('Projects', 'Days').options).toMatchObject({ resultType: 'number', precision: 0 });
    expect(Object.fromEntries(fieldsOf('Tasks').map((item) => [item.name, item.type]))).toEqual({
      Name: 'text',
      Hours: 'number',
      Project: 'link',
      Blocks: 'link',
      'Blocked by': 'link',
      Person: 'link',
    });
    expect(fieldsOf('People').map((item) => `${item.name}:${item.type}`)).toEqual([
      'Name:text',
      'Email:email',
      'Tasks:link',
    ]);
  });

  it('links records both ways, pairing each link with the field that shows its other side', async () => {
    const project = field('Tasks', 'Project');
    const tasks = field('Projects', 'Tasks');
    expect(project.options).toMatchObject({
      linkedTableId: tables.Projects!.id,
      inverseFieldId: tasks.id,
      prefersSingle: true,
    });
    expect(tasks.options).toMatchObject({
      linkedTableId: tables.Tasks!.id,
      inverseFieldId: project.id,
      prefersSingle: false,
    });
    expect(field('Tasks', 'Blocks').options).toMatchObject({
      linkedTableId: tables.Tasks!.id,
      inverseFieldId: field('Tasks', 'Blocked by').id,
    });
    const projectRows = await rows('Projects', 'Grid view');
    const taskRows = await rows('Tasks', 'All tasks');
    const name = (page: RowsPage, id: unknown) => page.linked?.[id as string];
    const website = projectRows.rows[0]!;
    expect((website.values[tasks.id] as string[]).map((id) => name(projectRows, id))).toEqual([
      'Design',
      'Build',
    ]);
    const [design, build, plan] = taskRows.rows as RowData[];
    expect(name(taskRows, (design!.values[project.id] as string[])[0])).toBe('Website');
    expect(plan!.values[project.id]).toEqual([projectRows.rows[1]!.id]);
    expect(design!.values[field('Tasks', 'Blocks').id]).toEqual([build!.id]);
    expect(build!.values[field('Tasks', 'Blocked by').id]).toEqual([design!.id]);
    const people = await rows('People', 'Everyone');
    expect(people.rows[0]!.values[field('People', 'Tasks').id]).toEqual([design!.id]);
  });

  it('brings every record across with its values', async () => {
    const page = await rows('Projects', 'Grid view');
    expect(page.total).toBe(3);
    const [website, app, docs] = page.rows as RowData[];
    const value = (record: RowData, name: string) => record.values[field('Projects', name).id];
    const status = field('Projects', 'Status');
    const choice = (name: string) =>
      status.type === 'singleSelect' ? status.options.choices.find((item) => item.name === name)!.id : '';
    expect(value(website!, 'Name')).toBe('Website');
    expect(value(website!, 'Notes')).toBe('Line one\nLine two [redacted]');
    expect(value(website!, 'Status')).toBe(choice('Doing'));
    expect(value(website!, 'Tags')).toHaveLength(2);
    expect(value(website!, 'Budget')).toBe(800);
    expect(value(website!, 'Share')).toBe(0.5);
    expect(value(website!, 'Estimate')).toBe(5400);
    expect(value(website!, 'Score')).toBe(2);
    expect(value(website!, 'Active')).toBe(true);
    expect(value(website!, 'Start')).toBe('2026-01-05');
    expect(value(website!, 'Due')).toBe('2026-01-20T15:30:00.000Z');
    expect(value(website!, 'Contact')).toBe('ada@example.com');
    expect(value(website!, 'Phone')).toBe('555-0100');
    expect(value(website!, 'Owner')).toEqual([server.owner.userId]);
    expect(value(website!, 'Author')).toEqual([server.owner.userId]);
    expect(value(website!, 'Watchers')).toBe(`${server.owner.email}, ${STRANGER}`);
    expect(value(website!, 'Task count')).toBe(2);
    expect(value(website!, 'Task names')).toEqual(['Design', 'Build']);
    expect(value(website!, 'Hours')).toBe(5.5);
    expect(value(website!, 'Label')).toBe('Website (Doing)');
    expect(value(website!, 'Days')).toBe(15);
    expect(value(website!, 'Ago')).toBe('9 months ago');
    expect(value(website!, 'Brief')).toBe('**Bold** start');
    expect(value(website!, 'Code')).toBe('12345');
    expect(value(website!, 'Open')).toBe('https://example.com/website');
    expect(value(website!, 'Number')).toBe(1);
    expect(value(website!, 'Created')).toBe('2026-01-01T09:00:00.000Z');
    expect(value(website!, 'Summary')).toBe('A new site');
    expect([value(app!, 'Number'), value(docs!, 'Number')]).toEqual([2, 3]);
    expect(value(app!, 'Label')).toBe('App (Todo)');
    // Values that don't fit are left empty and counted in the report.
    expect(value(docs!, 'Estimate') ?? null).toBeNull();
    expect(value(docs!, 'Contact') ?? null).toBeNull();
    expect(value(docs!, 'Hours')).toBe(0);
    const log = await rows('Log', 'Grid view');
    expect(log.total).toBe(LOG_RECORDS);
    expect(log.rows.at(-1)!.values[field('Log', 'Entry').id]).toBe(logName(LOG_RECORDS));
  });

  it('stores attachments as files here, within the limits and past the address guard', async () => {
    const page = await rows('Projects', 'Grid view');
    const [website, app, docs] = page.rows as RowData[];
    const files = field('Projects', 'Files');
    const [id] = website!.values[files.id] as string[];
    expect(website!.values[files.id]).toHaveLength(1);
    expect(page.attachments?.[id!]).toMatchObject({
      name: 'pixel.png',
      type: 'image/png',
      size: PIXEL.length,
      width: 1,
    });
    expect(app!.values[files.id] ?? null).toBeNull();
    expect(docs!.values[files.id] ?? null).toBeNull();
    const download = await server.app.inject({
      url: page.attachments![id!]!.url,
      headers: server.owner.headers,
    });
    expect(download.rawPayload.equals(PIXEL)).toBe(true);
    // The blocked addresses were never fetched: one is a literal private address, and the other
    // resolves to one.
    expect(
      fake.requests
        .filter((entry) => entry.path.startsWith('/files/'))
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(['/files/liar.bin', '/files/pixel.png']);
    expect(item('Projects', 'Files', 'import.airtable.report.filesTooLarge')).toMatchObject({
      status: 'omitted',
      subject: 'files',
      params: { count: 2, megabytes: 1 },
    });
    expect(item('Projects', 'Files', 'import.airtable.report.filesBlocked')).toMatchObject({
      status: 'omitted',
      params: { count: 2 },
    });
  });

  it('translates formulas where the functions match, and keeps the rest as text with a note', () => {
    const name = field('Projects', 'Name').id;
    const status = field('Projects', 'Status').id;
    expect(field('Projects', 'Label').options).toMatchObject({
      expression: `((({${name}} & " (") & {${status}}) & ")")`,
      resultType: 'text',
    });
    expect(item('Projects', 'Label', 'import.airtable.report.formulaTranslated').status).toBe('exact');
    // Each translated formula is checked against the results Airtable gave.
    expect(item('Projects', 'Double', 'import.airtable.report.formulaDiffers')).toMatchObject({
      status: 'changed',
      params: { count: 1, checked: 3, airtable: '999', here: '600', formula: '{Budget} * 2' },
    });
    expect(item('Projects', 'Ago', 'import.airtable.report.formulaFunctions')).toMatchObject({
      status: 'changed',
      params: { functions: 'FROMNOW', formula: 'FROMNOW({Start})' },
    });
  });

  it('turns lookups, rollups, and counts on, working out each rollup from its values', () => {
    expect(field('Projects', 'Task names').options).toMatchObject({
      linkFieldId: field('Projects', 'Tasks').id,
      targetFieldId: field('Tasks', 'Name').id,
    });
    expect(field('Projects', 'Task count').options).toEqual({ linkFieldId: field('Projects', 'Tasks').id });
    expect(item('Projects', 'Hours', 'import.airtable.report.rollupMatched')).toMatchObject({
      status: 'changed',
      params: { fn: 'sum', count: 2 },
    });
    expect(item('Projects', 'Task count', 'import.airtable.report.exact').status).toBe('exact');
  });

  it('matches people to members by email, and keeps the rest as email addresses', () => {
    expect(item('Projects', 'Owner', 'import.airtable.report.exact').status).toBe('exact');
    expect(item('Projects', 'Watchers', 'import.airtable.report.peopleText')).toMatchObject({
      status: 'changed',
      params: { count: 1 },
    });
    expect(item('Projects', 'Author', 'import.airtable.report.peopleFixed').status).toBe('changed');
  });

  it('brings views across with their fields, and filters and sorts worked out from their records', async () => {
    const names = schema.views
      .filter((item) => item.tableId === tables.Projects!.id)
      .map((item) => `${item.name}:${item.type}`);
    expect(names).toEqual([
      'Grid view:grid',
      'Doing:grid',
      'By budget:grid',
      'Board:kanban',
      'Pictures:gallery',
      'Calendar:calendar',
      'Intake:form',
      'Plan:timeline',
    ]);
    const grid = view('Projects', 'Grid view');
    expect(grid.config.hiddenFieldIds).toContain(field('Projects', 'Notes').id);
    expect(grid.config.fieldOrder.slice(0, 3)).toEqual([
      field('Projects', 'Name').id,
      field('Projects', 'Status').id,
      field('Projects', 'Tags').id,
    ]);
    const status = field('Projects', 'Status');
    expect(view('Projects', 'Doing').config.filter?.conditions).toEqual([
      {
        id: 'imported',
        fieldId: status.id,
        operator: 'is',
        value: status.type === 'singleSelect' ? status.options.choices[1]!.id : '',
      },
    ]);
    expect(
      (await rows('Projects', 'Doing')).rows.map((record) => record!.values[field('Projects', 'Name').id]),
    ).toEqual(['Website', 'Docs']);
    expect(view('Projects', 'By budget').config.sorts).toEqual([
      { fieldId: field('Projects', 'Budget').id, direction: 'desc' },
    ]);
    expect(
      (await rows('Projects', 'By budget')).rows.map(
        (record) => record!.values[field('Projects', 'Name').id],
      ),
    ).toEqual(['Docs', 'Website', 'App']);
    expect(view('Projects', 'Board').config.kanban.stackFieldId).toBe(status.id);
    expect(view('Projects', 'Pictures').config.gallery.coverFieldId).toBe(field('Projects', 'Files').id);
    expect(view('Projects', 'Calendar').config.calendar.startFieldId).toBe(field('Projects', 'Start').id);
    expect(view('Projects', 'Plan').config.timeline).toMatchObject({
      startFieldId: field('Projects', 'Start').id,
      endFieldId: field('Projects', 'Due').id,
    });
    expect(view('Projects', 'Intake').config.form.questions.map((question) => question.fieldId)).toContain(
      field('Projects', 'Status').id,
    );
    expect(view('Log', 'Recent').config.sorts).toEqual([
      { fieldId: field('Log', 'Value').id, direction: 'desc' },
    ]);
    // The field the one-way link needed stays out of People's view, since Airtable didn't have it.
    expect(view('People', 'Everyone').config.hiddenFieldIds).toEqual([field('People', 'Tasks').id]);
    expect(item('Projects', 'Doing', 'import.airtable.report.viewFilter').status).toBe('changed');
    expect(item('Projects', 'By budget', 'import.airtable.report.viewSort').status).toBe('changed');
    expect(item('Projects', 'Board', 'import.airtable.report.viewStack').params).toEqual({ field: 'Status' });
    expect(item('Projects', 'Chart', 'import.airtable.report.viewUnsupported')).toMatchObject({
      status: 'omitted',
      params: { type: 'block' },
    });
    expect(item('Projects', 'Grid view', 'import.airtable.report.exact').status).toBe('exact');
  });

  it('reports what came across exactly, what changed, and what was left out', () => {
    const statuses = job.report!.items.map((entry) => entry.status);
    // Left out first, then changed, then exact.
    expect(statuses).toEqual(
      [...statuses].sort(
        (a, b) => ['omitted', 'changed', 'exact'].indexOf(a) - ['omitted', 'changed', 'exact'].indexOf(b),
      ),
    );
    expect(item('Projects', 'Future', 'import.airtable.report.typeUnsupported')).toMatchObject({
      status: 'omitted',
      params: { type: 'someNewType' },
    });
    expect(item('Projects', 'Estimate', 'import.airtable.report.valuesDropped').params).toEqual({
      count: 1,
      example: '-60',
    });
    expect(item('Projects', 'Contact', 'import.airtable.report.valuesDropped').params).toEqual({
      count: 1,
      example: 'not an email',
    });
    expect(item('Projects', 'Created', 'import.airtable.report.timeFixed').status).toBe('changed');
    expect(item('Projects', 'Number', 'import.airtable.report.exact').status).toBe('exact');
    expect(item('Tasks', 'Person', 'import.airtable.report.linkBothWays').params).toEqual({
      table: 'People',
      field: 'Tasks',
    });
    expect(item('Projects', null, 'import.airtable.report.records').params).toEqual({ count: 3 });
    expect(item(null, null, 'import.airtable.report.viewSettings').status).toBe('omitted');
    expect(
      job.report!.items.filter((entry) => entry.status === 'exact').map((entry) => entry.name),
    ).toContain('Status');
  });

  it('keeps the report with the database, for anyone who can read it', async () => {
    const kept = await request<{ imports: AirtableImport[] }>(
      'GET',
      `/api/databases/${job.databaseId}/imports/airtable`,
    );
    expect(kept.imports.map((entry) => entry.id)).toEqual([job.id]);
    expect(kept.imports[0]!.report).toEqual(job.report);
    const stranger = await server.addMember();
    const hidden = await server.app.inject({
      url: `/api/databases/${job.databaseId}/imports/airtable`,
      headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
    const other = await server.app.inject({
      url: `/api/imports/airtable/${job.id}`,
      headers: stranger.headers,
    });
    expect(other.statusCode).toBe(404);
  });

  it('does it all as the person, audited, as one action', async () => {
    const actions = await server.pool.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id FROM "${server.schemas.audit}".events WHERE action LIKE 'imports.airtable.%' OR action LIKE 'data.%'`,
    );
    expect(actions.rows.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'imports.airtable.started',
        'imports.airtable.finished',
        'data.table.created',
        'data.records.created',
      ]),
    );
    expect(new Set(actions.rows.map((entry) => entry.actor_id))).toEqual(new Set([server.owner.userId]));
    const groups = await server.pool.query<{ count: number }>(
      `SELECT count(DISTINCT group_id)::int AS count FROM "${server.schemas.app}".changes WHERE database_id = $1`,
      [job.databaseId],
    );
    expect(groups.rows[0]!.count).toBe(1);
  });

  it('never keeps or logs the token', async () => {
    expect((await row(job.id)).sealed_token).toBeNull();
    expect(await tablesHolding(TOKEN)).toEqual([]);
    expect(logs.lines.length).toBeGreaterThan(10);
    expect(logs.lines.filter((line) => line.includes(TOKEN))).toEqual([]);
    expect(fake.requests.every((entry) => !entry.query.toString().includes(TOKEN))).toBe(true);
  });

  it('keeps to five requests a second for the base', () => {
    const times = fake.requests
      .filter((entry) => entry.path.startsWith(`/v0/${BASE_ID}`) || entry.path.includes(BASE_ID))
      .map((entry) => entry.at);
    expect(times.length).toBeGreaterThan(10);
    for (let index = 5; index < times.length; index++)
      expect(times[index]! - times[index - 5]!).toBeGreaterThanOrEqual(1_000);
  });
});

describe('importing a product catalog', () => {
  let job: AirtableImport;
  let schema: DatabaseSchema;
  const field = (table: string, name: string): FieldMeta => {
    const tableId = schema.tables.find((item) => item.name === table)!.id;
    const found = schema.fields.find((item) => item.tableId === tableId && item.name === name);
    if (!found) throw new Error(`No field ${table}.${name}`);
    return found;
  };
  const item = (table: string, name: string, key: string): AirtableReportItem => {
    const found = job.report!.items.find(
      (entry) => entry.table === table && entry.name === name && entry.messageKey === key,
    );
    if (!found) throw new Error(`No report line for ${table}.${name} ${key}: ${JSON.stringify(job.report)}`);
    return found;
  };

  beforeAll(async () => {
    fake.bases.push(catalogBase());
    job = await finished((await start({ baseId: CATALOG_ID, name: 'Catalog' })).id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    schema = DatabaseSchema.parse(await request('GET', `/api/databases/${job.databaseId}/schema`));
  }, 120_000);
  afterAll(() => {
    fake.bases.splice(
      fake.bases.findIndex((base) => base.id === CATALOG_ID),
      1,
    );
  });

  it('brings a price lookup times a quantity across as a formula, and its total as a sum rollup', async () => {
    const unit = field('Line items', 'Unit price');
    const total = field('Line items', 'Line total');
    expect(unit).toMatchObject({ type: 'lookup', options: { resultType: 'number' } });
    expect(total).toMatchObject({ type: 'formula', options: { resultType: 'number', sortable: true } });
    expect(field('Orders', 'Order total')).toMatchObject({
      type: 'rollup',
      options: { fn: 'sum', targetFieldId: total.id, resultType: 'number' },
    });
    // Both give what Airtable gave, record for record.
    expect(item('Line items', 'Line total', 'import.airtable.report.formulaTranslated').status).toBe('exact');
    expect(item('Orders', 'Order total', 'import.airtable.report.rollupMatched')).toMatchObject({
      params: { fn: 'sum', count: 2 },
    });
    const orders = schema.views.find((view) => view.tableId === field('Orders', 'Name').tableId)!;
    const page = await request<RowsPage>('GET', `/api/views/${orders.id}/rows`);
    const totals = Object.fromEntries(
      page.rows.map((row) => [
        row!.values[field('Orders', 'Name').id],
        row!.values[field('Orders', 'Order total').id],
      ]),
    );
    expect(totals).toEqual({ First: 21, Second: 13.5 });
  });

  it('brings formulas over a link, a single select, and a lookup of one across, reading names as Airtable does', async () => {
    const values = async (table: string, key: string, value: string) => {
      const view = schema.views.find((item) => item.tableId === field(table, key).tableId)!;
      const page = await request<RowsPage>('GET', `/api/views/${view.id}/rows`);
      return Object.fromEntries(
        page.rows.map((row) => [row!.values[field(table, key).id], row!.values[field(table, value).id]]),
      );
    };
    for (const [table, name] of [
      ['Orders', 'Label'],
      ['Products', 'Aisle'],
      ['Line items', 'Shelf'],
    ] as const) {
      expect(field(table, name)).toMatchObject({ type: 'formula', options: { resultType: 'text' } });
      expect(item(table, name, 'import.airtable.report.formulaTranslated').status, name).toBe('exact');
    }
    expect(field('Orders', 'Client')).toMatchObject({ type: 'link' });
    expect(field('Line items', 'Category')).toMatchObject({ type: 'lookup' });
    expect(await values('Orders', 'Name', 'Label')).toEqual({
      First: 'Forrester Legal Partners Order #420',
      Second: 'Smith, Jones & Co. Order #421',
    });
    expect(await values('Products', 'Name', 'Aisle')).toEqual({
      Tea: 'Aisle: Tea & Coffee',
      Mug: 'Aisle: Kitchen, Dining',
    });
    expect(await values('Line items', 'Name', 'Shelf')).toEqual({
      Teas: 'Tea & Coffee: Teas',
      Mugs: 'Kitchen, Dining: Mugs',
      'More tea': 'Tea & Coffee: More tea',
    });
  });
});

describe('importing records that name each other', () => {
  it('brings a same-table link across with its loops, since no view reads it as parents', async () => {
    const id = airtableId('app', 'Related');
    const table = airtableId('tbl', 'Topics');
    const name = airtableId('fld', 'TopicName');
    const related = airtableId('fld', 'Related');
    const relatedFrom = airtableId('fld', 'RelatedFrom');
    const [first, second] = [airtableId('rec', 'Weather'), airtableId('rec', 'Climate')];
    const link = (inverse: string) => ({
      type: 'multipleRecordLinks',
      options: { linkedTableId: table, inverseLinkFieldId: inverse, prefersSingleRecordLink: false },
    });
    fake.bases.push({
      id,
      name: 'Topics',
      permissionLevel: 'create',
      tables: [
        {
          id: table,
          name: 'Topics',
          primaryFieldId: name,
          fields: [
            { id: name, name: 'Name', type: 'singleLineText' },
            { id: related, name: 'Related', ...link(relatedFrom) },
            { id: relatedFrom, name: 'Related from', ...link(related) },
          ],
          views: [{ id: airtableId('viw', 'Topics'), name: 'Grid view', type: 'grid' }],
          records: [
            { id: first, fields: { [name]: 'Weather', [related]: [second], [relatedFrom]: [second] } },
            { id: second, fields: { [name]: 'Climate', [related]: [first], [relatedFrom]: [first] } },
          ],
        },
      ],
    });
    try {
      const job = await finished((await start({ baseId: id, name: 'Topics' })).id);
      expect(job.state, JSON.stringify(job.error)).toBe('finished');
      const schema = DatabaseSchema.parse(await request('GET', `/api/databases/${job.databaseId}/schema`));
      const field = schema.fields.find((item) => item.name === 'Related')!;
      const page = await request<RowsPage>('GET', `/api/views/${schema.views[0]!.id}/rows`);
      const [weather, climate] = page.rows as RowData[];
      expect(weather!.values[field.id]).toEqual([climate!.id]);
      expect(climate!.values[field.id]).toEqual([weather!.id]);
    } finally {
      fake.bases.splice(
        fake.bases.findIndex((base) => base.id === id),
        1,
      );
    }
  });
});

describe('running imports', () => {
  it('waits out 429 answers, and works views out only for smaller tables', async () => {
    importer.limits = { ...importer.limits, inferenceRecords: 100 };
    fake.throttle(`/v0/${BASE_ID}/${TABLE_IDS.log}`, 2);
    const before = time.now;
    const job = await finished((await start({ name: 'Throttled' })).id);
    expect(job.state, JSON.stringify(job.error)).toBe('finished');
    expect(time.now - before).toBeGreaterThanOrEqual(60_000);
    expect(job.report!.records).toBe(3 + 3 + 2 + LOG_RECORDS);
    expect(
      job.report!.items.find(
        (entry) =>
          entry.table === 'Log' &&
          entry.name === 'Recent' &&
          entry.messageKey === 'import.airtable.report.viewTooLarge',
      ),
    ).toMatchObject({ status: 'omitted', params: { max: 100 } });
  });

  it('stops when asked, puts what it made in the trash, and forgets the token', async () => {
    const held = fake.hold(`/v0/${BASE_ID}/${TABLE_IDS.tasks}`);
    const job = await start({ name: 'Stopped' });
    await held.reached;
    const busy = await request<{ error: { messageKey: string } }>(
      'POST',
      '/api/imports/airtable',
      { token: TOKEN, baseId: BASE_ID, name: 'Second' },
      409,
    );
    expect(busy.error.messageKey).toBe('import.airtable.busy');
    // Someone watching waits for the next change rather than asking over and over.
    const { version } = await row(job.id);
    const waiting = request<AirtableImport>('GET', `/api/imports/airtable/${job.id}?since=${version}`);
    const canceled = await request<AirtableImport>('POST', `/api/imports/airtable/${job.id}/cancel`);
    expect(['running', 'canceled']).toContain(canceled.state);
    expect((await waiting).version).toBeGreaterThan(version);
    held.release();
    const ended = await finished(job.id);
    expect(ended.state).toBe('canceled');
    expect((await row(job.id)).sealed_token).toBeNull();
    const database = await server.pool.query<{ trashed_at: Date | null }>(
      `SELECT trashed_at FROM "${server.schemas.app}".databases WHERE id = $1`,
      [ended.databaseId],
    );
    expect(database.rows[0]!.trashed_at).not.toBeNull();
    // Asking again changes nothing.
    expect((await request<AirtableImport>('POST', `/api/imports/airtable/${job.id}/cancel`)).state).toBe(
      'canceled',
    );
  });

  it('fails with a reason when Airtable refuses the base, and trashes what it made when it stops partway', async () => {
    fake.refuseWith(404);
    const refused = await finished((await start({ name: 'Refused' })).id);
    expect(refused).toMatchObject({
      state: 'failed',
      databaseId: null,
      error: { messageKey: 'import.airtable.baseUnavailable' },
    });
    fake.refuseWith(null);
    fake.throttle(`/v0/${BASE_ID}/${TABLE_IDS.people}`, 50);
    const partway = await finished((await start({ name: 'Partway' })).id);
    expect(partway).toMatchObject({ state: 'failed', error: { messageKey: 'import.airtable.rateLimited' } });
    const database = await server.pool.query<{ trashed_at: Date | null }>(
      `SELECT trashed_at FROM "${server.schemas.app}".databases WHERE id = $1`,
      [partway.databaseId],
    );
    expect(database.rows[0]!.trashed_at).not.toBeNull();
    fake.reset();
    const recent = await request<{ imports: AirtableImport[] }>('GET', '/api/imports/airtable');
    expect(recent.imports[0]!.id).toBe(partway.id);
    expect(recent.imports.every((entry) => !JSON.stringify(entry).includes(TOKEN))).toBe(true);
  });

  it('ends imports a stopped server left behind', async () => {
    const id = airtableId('rec', 'Left').replace(/^rec/, 'job');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".airtable_imports (id, org_id, user_id, base_id, name, state, progress, sealed_token, updated_at)
       VALUES ($1, $2, $3, $4, 'Left behind', 'running', '{}', 'rio1.sealed', now() - interval '1 hour')`,
      [id, server.owner.info.org.id, server.owner.userId, BASE_ID],
    );
    const recent = await request<{ imports: AirtableImport[] }>('GET', '/api/imports/airtable');
    expect(recent.imports.find((entry) => entry.id === id)).toMatchObject({
      state: 'failed',
      error: { messageKey: 'import.airtable.interrupted' },
    });
    expect((await row(id)).sealed_token).toBeNull();
  });
});

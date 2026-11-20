import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  DatabaseCreate,
  newId,
  type MyReports,
  type Notification,
  type NotificationsPage,
  type ReportPolicy,
  type ReportRun,
  type ReportRunsPage,
  type ReportSchedule,
  type ReportUnsubscribePreview,
  type ViewReports,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { LightMyRequestResponse } from 'fastify';
import { apply, grant } from '../automations/automations.test-helpers.js';
import { AccessScope } from '../data/access.js';
import type * as Logger from '../logger.js';
import type { Mailer, MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { unsubscribeToken } from './unsubscribe.js';
import { REPORT_RETRY_DELAYS_MS, ReportWorker } from './worker.js';
import { readReportPdf } from './pdf.test-support.js';

/**
 * Scheduled reports through the API and the worker, with mail kept in memory.  Every line the
 * server logs is kept too, to show no record's values ever reach the logs.
 */
const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../logger.js', async (original) => {
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

const BASE_URL = 'https://riosoma.example.test';
const RECORDS = 25;
const sent: MailMessage[] = [];
const failures = { left: 0 };
const memory: Mailer = {
  async send(message) {
    if (failures.left > 0) {
      failures.left -= 1;
      // A provider's error quotes what it refused, which must never be kept or logged.
      throw Object.assign(new Error(`refused ${message.to}: ${message.text.slice(0, 400)}`), {
        code: 'EENVELOPE',
      });
    }
    sent.push(message);
  },
};

let kit: TestPostgres;
let server: ServerFixture;
let worker: ReportWorker;
let editor: SignedIn;
let reader: SignedIn;
let restricted: SignedIn;
let stranger: SignedIn;
const base = {
  databaseId: newId('database'),
  tableId: newId('table'),
  viewId: newId('view'),
  f: {
    name: newId('field'),
    amount: newId('field'),
    secret: newId('field'),
    stage: newId('field'),
    note: newId('field'),
    extra: newId('field'),
  },
};
/** Every text value the records hold, each distinctive enough to find anywhere it leaks */
const values: string[] = [];
const recordIds: string[] = [];

const name = (n: number) => `Deal-${String(n).padStart(2, '0')}-qx`;
const secret = (n: number) => `SECRET-${n}-vz`;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'reports', {
    baseUrl: `${BASE_URL}/`,
    reportsPollMs: 0,
    automationsPollMs: 0,
    logLevel: 'trace',
  });
  server.ctx.mailer = memory;
  worker = server.ctx.reports!;
  worker.pause();
  server.ctx.notifications?.pause();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: DatabaseCreate.parse({
      id: base.databaseId,
      name: 'Pipeline',
      table: {
        id: base.tableId,
        name: 'Deals',
        fields: [
          { id: base.f.name, name: 'Name', type: 'text' },
          { id: base.f.amount, name: 'Amount', type: 'number' },
          { id: base.f.secret, name: 'Secret', type: 'text' },
          { id: base.f.stage, name: 'Stage', type: 'text' },
          { id: base.f.note, name: 'Note', type: 'text' },
          { id: base.f.extra, name: 'Extra', type: 'text' },
        ],
        view: { id: base.viewId, name: 'Open deals' },
      },
    }),
  });
  expect(created.statusCode, created.body).toBe(200);
  const rows = Array.from({ length: RECORDS }, (_, index) => {
    const n = index + 1;
    const row = {
      [base.f.name]: name(n),
      [base.f.amount]: 7000 + n,
      [base.f.secret]: secret(n),
      [base.f.stage]: `STAGE-${n}-kw`,
      [base.f.note]: `NOTE-${n}-jp`,
      [base.f.extra]: `EXTRA-${n}-fb`,
    };
    values.push(...Object.values(row).filter((value): value is string => typeof value === 'string'));
    return { id: newId('record'), values: row };
  });
  recordIds.push(...rows.map((row) => row.id));
  await apply(server, base.databaseId, [{ kind: 'record.create', tableId: base.tableId, records: rows }]);
  editor = await server.addMember({ name: 'Casey Creator' });
  reader = await server.addMember({ name: 'Riley Reader' });
  restricted = await server.addMember({ name: 'Sam Restricted' });
  stranger = await server.addMember({ name: 'Olive Outside' });
  await grant(server, base.databaseId, editor, 'creator');
  await grant(server, base.databaseId, reader, 'reader');
  await grant(server, base.databaseId, restricted, 'reader');
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  sent.length = 0;
  failures.left = 0;
  worker.attachmentLimit = 20 * 1024 * 1024;
  await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'report_schedules')}`);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET report_outside_recipients = false`,
  );
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

function call(
  who: SignedIn | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method,
    url,
    headers: who?.headers ?? {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Weekly deals',
    format: 'csv',
    recipients: [{ kind: 'member', userId: server.owner.userId }],
    frequency: { kind: 'weekly', days: [1], at: '09:00' },
    timeZone: 'America/Chicago',
    enabled: true,
    ...overrides,
  };
}

async function create(
  who: SignedIn,
  overrides: Record<string, unknown> = {},
  viewId = base.viewId,
): Promise<ReportSchedule> {
  const response = await call(who, 'POST', `/api/views/${viewId}/reports`, input(overrides));
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ReportSchedule>();
}

const member = (who: SignedIn) => ({ kind: 'member' as const, userId: who.userId });
const address = (value: string) => ({ kind: 'address' as const, address: value });

/** Makes a schedule due a minute ago, then lets the worker send everything that's due at `now`. */
async function sendDue(reportIds: readonly string[], now = new Date()): Promise<void> {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'report_schedules')}
    SET next_run_at = ${new Date(now.getTime() - 60_000)} WHERE id = ANY(${reportIds}::text[])`,
  );
  await worker.drain(now);
}

async function runs(reportId: string, who: SignedIn = server.owner): Promise<ReportRun[]> {
  const response = await call(who, 'GET', `/api/reports/${reportId}/runs`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ReportRunsPage>().runs;
}

async function schedule(reportId: string) {
  const result = await query<{ enabled: boolean; stopped_because: string | null; next_run_at: Date | null }>(
    server.pool,
    sql`SELECT enabled, stopped_because, next_run_at FROM ${ident(server.schemas.app, 'report_schedules')}
    WHERE id = ${reportId}`,
  );
  return result.rows[0];
}

async function auditEvents(action: string) {
  const result = await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = ${action} AND org_id = ${server.owner.info.org.id}
    ORDER BY id`,
  );
  return result.rows;
}

const mailTo = (who: SignedIn | string) =>
  sent.filter((message) => message.to === (typeof who === 'string' ? who : who.email));

/** A CSV attachment's lines, without the byte-order mark. */
function csv(message: MailMessage): string[] {
  const file = message.attachments?.[0];
  expect(file?.contentType).toBe('text/csv; charset=utf-8');
  return file!.content
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');
}

function footerToken(message: MailMessage): string {
  const found = /\/reports\/unsubscribe\?token=([A-Za-z0-9_.%-]+)/.exec(message.text);
  expect(found).not.toBeNull();
  return decodeURIComponent(found![1]!);
}

describe('report schedules', () => {
  it('allows self-service PDF reports for every database role and a guest, while denying strangers', async () => {
    const databaseId = newId('database'),
      tableId = newId('table'),
      viewId = newId('view'),
      fieldId = newId('field');
    const created = await call(server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Role reports',
      table: {
        id: tableId,
        name: 'Orders',
        fields: [{ id: fieldId, name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'Grid' },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await apply(server, databaseId, [
      {
        kind: 'record.create',
        tableId,
        records: [{ id: newId('record'), values: { [fieldId]: 'Role report record' } }],
      },
    ]);
    for (const role of ['owner', 'creator', 'editor', 'commenter', 'reader'] as const) {
      const person = await server.addMember({ name: `Report ${role}` });
      await grant(server, databaseId, person, role);
      const report = await create(
        person,
        { format: 'pdf', recipients: [member(person)], enabled: false },
        viewId,
      );
      const download = await call(person, 'GET', `/api/reports/${report.id}/download`);
      expect(download.statusCode, download.body).toBe(200);
      const pages = await readReportPdf(download.rawPayload);
      expect(pages.map((page) => page.text).join(' ')).toContain('Role report record');
      expect((await call(stranger, 'GET', `/api/reports/${report.id}/download`)).statusCode).toBe(404);
    }
    const guest = await server.addMember({ name: 'Report guest', kind: 'guest' });
    await grant(server, databaseId, guest, 'reader');
    const report = await create(
      guest,
      { format: 'pdf', recipients: [member(guest)], enabled: false },
      viewId,
    );
    const download = await call(guest, 'GET', `/api/reports/${report.id}/download`);
    expect(download.statusCode, download.body).toBe(200);
    expect((await readReportPdf(download.rawPayload)).map((page) => page.text).join(' ')).toContain(
      'Role report record',
    );
    expect((await call(null, 'GET', `/api/reports/${report.id}/download`)).statusCode).toBe(401);
  });

  it('keeps a due send when editing content, and recalculates it when its timing changes', async () => {
    const report = await create(server.owner);
    const due = new Date(Date.now() - 60_000);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'report_schedules')} SET next_run_at = ${due}
      WHERE id = ${report.id}`,
    );
    const renamed = await call(server.owner, 'PUT', `/api/reports/${report.id}`, input({ name: 'Renamed' }));
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<ReportSchedule>().nextRunAt).toBe(due.toISOString());
    await worker.drain();
    expect(await runs(report.id)).toHaveLength(1);
    expect(mailTo(server.owner)[0]!.subject).toContain('Renamed');

    const changed = await call(
      server.owner,
      'PUT',
      `/api/reports/${report.id}`,
      input({
        frequency: { kind: 'daily', at: '08:15' },
        timeZone: 'Asia/Tokyo',
      }),
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<ReportSchedule>().nextRunAt).not.toBe(due.toISOString());
    const paused = await call(server.owner, 'PUT', `/api/reports/${report.id}`, input({ enabled: false }));
    expect(paused.json<ReportSchedule>().nextRunAt).toBeNull();
    const resumed = await call(server.owner, 'PUT', `/api/reports/${report.id}`, input());
    expect(Date.parse(resumed.json<ReportSchedule>().nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it('let readers send one to themselves and people who can change the view add members', async () => {
    const mine = await create(reader, { recipients: [member(reader)] });
    expect(mine).toMatchObject({
      name: 'Weekly deals',
      viewName: 'Open deals',
      tableName: 'Deals',
      databaseName: 'Pipeline',
      owner: { id: reader.userId, name: 'Riley Reader' },
      recipients: [{ kind: 'member', userId: reader.userId, name: 'Riley Reader' }],
      canEdit: true,
      canDelete: true,
      receiving: true,
      stoppedBecause: null,
    });
    // The next Monday at 9:00 in Chicago, whatever day this runs.
    const next = new Date(mine.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCDay()).toBe(1);
    expect([14, 15]).toContain(next.getUTCHours());

    const others = await call(
      reader,
      'POST',
      `/api/views/${base.viewId}/reports`,
      input({
        recipients: [member(reader), member(editor)],
      }),
    );
    expect(others.statusCode).toBe(403);
    expect(others.json()).toMatchObject({ error: { messageKey: 'reports.recipients.onlyYou' } });

    // Someone outside the database can't be added, and a member's address is that member.
    const outsider = await call(
      editor,
      'POST',
      `/api/views/${base.viewId}/reports`,
      input({
        recipients: [member(stranger)],
      }),
    );
    expect(outsider.statusCode).toBe(422);
    expect(outsider.json()).toMatchObject({ error: { messageKey: 'reports.recipients.notMember' } });
    const team = await create(editor, {
      recipients: [member(editor), address(reader.email.toUpperCase()), member(reader)],
    });
    expect(team.recipients).toEqual([
      { kind: 'member', userId: editor.userId, name: 'Casey Creator' },
      { kind: 'member', userId: reader.userId, name: 'Riley Reader' },
    ]);

    const nobody = await call(stranger, 'GET', `/api/views/${base.viewId}/reports`);
    expect(nobody.statusCode).toBe(404);
    // A reader sees what they set up or receive, and not who else gets it.
    const seen = (await call(reader, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>();
    expect(seen).toMatchObject({ canAddMembers: false, outsideAllowed: false, emailAvailable: true });
    expect(seen.reports.map((report) => [report.id, report.canEdit, report.recipients.length])).toEqual([
      [mine.id, true, 1],
      [team.id, false, 0],
    ]);
    expect(seen.members).toEqual([]);
    const all = (await call(editor, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>();
    expect(all.canAddMembers).toBe(true);
    // Only people who can open the database are offered.
    expect(all.members.map((person) => person.name)).toEqual([
      'Casey Creator',
      'Owner',
      'Riley Reader',
      'Sam Restricted',
    ]);
    expect(all.reports.map((report) => report.id)).toEqual([mine.id, team.id]);

    const listed = (await call(reader, 'GET', '/api/reports')).json<MyReports>();
    expect(listed.owned.map((report) => report.id)).toEqual([mine.id]);
    expect(listed.receiving.map((report) => report.id)).toEqual([team.id]);

    // Only the owner changes one, and a manager of the database can delete it.
    const change = input({ name: 'Daily deals', frequency: { kind: 'daily', at: '07:30' }, enabled: false });
    const refused = await call(editor, 'PUT', `/api/reports/${mine.id}`, change);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'reports.schedule.ownerOnly' } });
    const changed = await call(reader, 'PUT', `/api/reports/${mine.id}`, {
      ...change,
      recipients: [member(reader)],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<ReportSchedule>()).toMatchObject({
      name: 'Daily deals',
      enabled: false,
      nextRunAt: null,
      frequency: { kind: 'daily', at: '07:30' },
    });
    expect((await call(editor, 'DELETE', `/api/reports/${mine.id}`)).statusCode).toBe(403);
    expect((await call(server.owner, 'DELETE', `/api/reports/${mine.id}`)).statusCode).toBe(204);

    // Stopping one from settings takes the person off it.
    expect((await call(reader, 'POST', `/api/reports/${team.id}/leave`)).statusCode).toBe(204);
    expect((await call(reader, 'POST', `/api/reports/${team.id}/leave`)).statusCode).toBe(409);
    expect((await call(reader, 'GET', '/api/reports')).json<MyReports>()).toEqual({
      owned: [],
      receiving: [],
    });

    const created = await auditEvents('data.report.created');
    expect(created.at(-1)).toMatchObject({
      actor_id: editor.userId,
      metadata: { reportId: team.id, members: 2, outside: 0, format: 'csv' },
    });
    expect((await auditEvents('data.report.updated')).at(-1)?.metadata).toMatchObject({ reportId: mine.id });
    expect((await auditEvents('data.report.deleted')).at(-1)?.metadata).toMatchObject({ reportId: mine.id });
    expect((await auditEvents('data.report.unsubscribed')).at(-1)).toMatchObject({
      actor_id: reader.userId,
      metadata: { reportId: team.id, recipient: 'member', via: 'settings' },
    });
  });

  it('send outside the organization only when it allows that, and never with restricted fields', async () => {
    const outside = { recipients: [member(editor), address('partner@elsewhere.example')] };
    const off = await call(editor, 'POST', `/api/views/${base.viewId}/reports`, input(outside));
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ error: { messageKey: 'reports.recipients.outsideOff' } });

    // Only an owner or a security admin changes the setting.
    expect(
      (await call(editor, 'PUT', '/api/admin/reports/policy', { outsideRecipients: true })).statusCode,
    ).toBe(403);
    expect((await call(server.owner, 'GET', '/api/admin/reports/policy')).json<ReportPolicy>()).toEqual({
      outsideRecipients: false,
    });
    const on = await call(server.owner, 'PUT', '/api/admin/reports/policy', { outsideRecipients: true });
    expect(on.json<ReportPolicy>()).toEqual({ outsideRecipients: true });
    expect((await auditEvents('org.report_policy.updated')).at(-1)?.metadata).toEqual({
      outsideRecipients: { from: false, to: true },
    });

    const allowed = await create(editor, outside);
    expect(allowed.recipients.at(-1)).toEqual({ kind: 'address', address: 'partner@elsewhere.example' });
    expect(
      (await call(editor, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>().outsideAllowed,
    ).toBe(true);
    // Someone who can only read still sends only to themselves.
    const fromReader = await call(
      reader,
      'POST',
      `/api/views/${base.viewId}/reports`,
      input({
        recipients: [member(reader), address('partner@elsewhere.example')],
      }),
    );
    expect(fromReader.statusCode).toBe(403);

    vi.spyOn(AccessScope.prototype, 'restrictsFields').mockResolvedValue(true);
    const restrictedFields = await call(editor, 'POST', `/api/views/${base.viewId}/reports`, input(outside));
    expect(restrictedFields.statusCode).toBe(403);
    expect(restrictedFields.json()).toMatchObject({
      error: { messageKey: 'reports.recipients.outsideRestricted' },
    });
    expect(
      (await call(editor, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>().outsideAllowed,
    ).toBe(false);
    // A database that gained restricted fields since sends nothing outside, and members still get theirs.
    await sendDue([allowed.id]);
    expect(mailTo('partner@elsewhere.example')).toEqual([]);
    expect(mailTo(editor)).toHaveLength(1);
    const [run] = await runs(allowed.id, editor);
    expect(run!.state).toBe('sent');
    expect(run!.deliveries.map((delivery) => [delivery.state, delivery.error?.messageKey ?? null])).toEqual([
      ['sent', null],
      ['skipped', 'reports.delivery.outsideNotAllowed'],
    ]);

    // Without restricted fields, the outside address gets what the owner sees.
    vi.restoreAllMocks();
    await sendDue([allowed.id]);
    expect(mailTo('partner@elsewhere.example')).toHaveLength(1);
    expect(csv(mailTo('partner@elsewhere.example')[0]!)).toHaveLength(RECORDS + 1);
  });
});

describe('sending a report', () => {
  it('retains task completion in downloaded PDFs, emailed PDFs, and HTML summaries', async () => {
    const databaseId = newId('database'),
      tableId = newId('table'),
      viewId = newId('view'),
      nameField = newId('field'),
      richField = newId('field'),
      recordId = newId('record');
    const created = await call(server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Task reports',
      table: {
        id: tableId,
        name: 'Orders',
        fields: [
          { id: nameField, name: 'Name', type: 'text' },
          { id: richField, name: 'Notes', type: 'longText', options: { richText: true } },
        ],
        view: { id: viewId, name: 'Grid' },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await apply(server, databaseId, [
      {
        kind: 'record.create',
        tableId,
        records: [{ id: recordId, values: { [nameField]: 'Task order' } }],
      },
    ]);
    const report = await create(server.owner, { format: 'pdf', enabled: false }, viewId);
    for (const checked of [true, false]) {
      const marker = checked ? '[x]' : '[ ]';
      const otherMarker = checked ? '[ ]' : '[x]';
      await apply(server, databaseId, [
        {
          kind: 'record.update',
          tableId,
          records: [
            {
              id: recordId,
              values: {
                [richField]: `- ${marker} **Pay invoice**\n  - ${otherMarker} Review receipt`,
              },
            },
          ],
        },
      ]);
      const download = await call(server.owner, 'GET', `/api/reports/${report.id}/download`);
      expect(download.statusCode, download.body).toBe(200);
      const text = (await readReportPdf(download.rawPayload)).map((page) => page.text).join(' ');
      expect(text).toContain(`${marker} Pay invoice`);
      expect(text).toContain(`${otherMarker} Review receipt`);
      const response = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
      expect(response.statusCode, response.body).toBe(200);
      const mail = mailTo(server.owner).at(-1)!;
      const attachment = (await readReportPdf(mail.attachments![0]!.content))
        .map((page) => page.text)
        .join(' ');
      for (const content of [attachment, mail.html]) {
        expect(content).toContain(`${marker} Pay invoice`);
        expect(content).toContain(`${otherMarker} Review receipt`);
      }
    }
  });

  it('exports rich text as readable words in a PDF and its email summary', async () => {
    const databaseId = newId('database'),
      tableId = newId('table'),
      viewId = newId('view');
    const nameField = newId('field'),
      richField = newId('field');
    const created = await call(server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Rich reports',
      table: {
        id: tableId,
        name: 'Orders',
        fields: [
          { id: nameField, name: 'Name', type: 'text' },
          { id: richField, name: 'Notes', type: 'longText', options: { richText: true } },
        ],
        view: { id: viewId, name: 'Grid' },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await apply(server, databaseId, [
      {
        kind: 'record.create',
        tableId,
        records: [
          {
            id: newId('record'),
            values: {
              [nameField]: 'Rich order',
              [richField]:
                '**Important** [instructions](https://example.test/private-link)\n\nSecond paragraph',
            },
          },
        ],
      },
    ]);
    const report = await create(server.owner, { format: 'pdf', enabled: false }, viewId);
    const response = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
    expect(response.statusCode, response.body).toBe(200);
    const mail = mailTo(server.owner)[0]!;
    const text = (await readReportPdf(mail.attachments![0]!.content)).map((page) => page.text).join(' ');
    expect(text).toContain('Important instructions');
    expect(text).toContain('Second paragraph');
    expect(text).not.toContain('**Important**');
    expect(text).not.toContain('https://example.test/private-link');
    expect(mail.html).not.toContain('**Important**');
  });

  it('reads grouped rows, totals, and conditional colors from the saved view in PDF and email', async () => {
    const report = await create(server.owner, { format: 'pdf' });
    await apply(server, base.databaseId, [
      {
        kind: 'view.update',
        viewId: base.viewId,
        config: {
          groups: [{ fieldId: base.f.stage, direction: 'asc' }],
          hiddenFieldIds: [base.f.stage],
          summaries: { [base.f.amount]: 'sum' },
          colorRules: [
            {
              id: 'high',
              target: 'cell',
              color: 'green',
              condition: { id: 'high-filter', fieldId: base.f.amount, operator: 'gt', value: 7000 },
            },
          ],
        },
      },
    ]);
    try {
      await sendDue([report.id]);
      const mail = mailTo(server.owner)[0]!;
      const pages = await readReportPdf(mail.attachments![0]!.content);
      expect(pages.length).toBeGreaterThan(1);
      const text = pages.map((page) => page.text).join(' ');
      expect(text).toContain('Stage: STAGE-1-kw');
      expect(text).toContain('Total');
      expect(text).toContain('175,325');
      expect(text).toContain(name(25));
      for (const page of pages) {
        expect(page.text).toContain('Name');
        expect(page.text).toContain('Amount');
      }
      expect(mail.html).toContain('Stage: STAGE-1-kw');
      expect(mail.html).toContain('background-color:#DDEFE1');
      expect(mail.html).toContain('175,325');
    } finally {
      await apply(server, base.databaseId, [
        {
          kind: 'view.update',
          viewId: base.viewId,
          config: { groups: [], hiddenFieldIds: [], summaries: {}, colorRules: [] },
        },
      ]);
    }
  });
  it('retains the first visible column’s group and grand totals with color scale fills', async () => {
    const report = await create(server.owner, { format: 'pdf' });
    await apply(server, base.databaseId, [
      {
        kind: 'view.update',
        viewId: base.viewId,
        config: {
          groups: [{ fieldId: base.f.stage, direction: 'asc' }],
          hiddenFieldIds: [base.f.secret, base.f.stage, base.f.note, base.f.extra],
          summaries: { [base.f.name]: 'count', [base.f.amount]: 'sum' },
          colorScales: [
            {
              fieldId: base.f.amount,
              stops: [
                { color: 'red', value: null },
                { color: 'green', value: null },
              ],
            },
          ],
        },
      },
    ]);
    try {
      await sendDue([report.id]);
      const mail = mailTo(server.owner)[0]!;
      const pages = await readReportPdf(mail.attachments![0]!.content);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) expect(page.text).toContain('Amount');
      const text = pages.map((page) => page.text).join(' ');
      expect(text).toContain('Stage: STAGE-25-kw');
      expect(text).toContain('7,025');
      expect(text).toContain('Total 25');
      expect(text).toContain('175,325');
      expect(mail.html).toContain('STAGE-1-kw<br>1');
      expect(mail.html).toContain('Total<br>25');
      expect(mail.html).toContain('background-color:#FCE1E2');
      expect(mail.html).toContain('background-color:#DDEFE1');
      expect((await runs(report.id))[0]!.deliveries[0]!.notes ?? []).not.toContain(
        'reports.pdf.visualSimplified',
      );
    } finally {
      await apply(server, base.databaseId, [
        {
          kind: 'view.update',
          viewId: base.viewId,
          config: { groups: [], hiddenFieldIds: [], summaries: {}, colorScales: [] },
        },
      ]);
    }
  });
  it('schedules and sends PDFs through each recipient’s access and downloads through the caller’s access', async () => {
    const report = await create(server.owner, {
      format: 'pdf',
      recipients: [member(server.owner), member(restricted)],
    });
    const hidden = recordIds[0]!;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      this: AccessScope,
      _tableId: string,
      fields: readonly F[],
    ) {
      return this.actor.userId === restricted.userId
        ? fields.filter((field) => field.id !== base.f.secret)
        : [...fields];
    });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(function (this: AccessScope) {
      return this.actor.userId === restricted.userId ? sql`__id <> ${hidden}` : sql`TRUE`;
    });
    await sendDue([report.id]);
    expect(sent).toHaveLength(2);
    for (const who of [server.owner, restricted]) {
      const mail = mailTo(who)[0]!;
      const file = mail.attachments?.[0];
      expect(file).toMatchObject({ filename: 'Deals - Open deals.pdf', contentType: 'application/pdf' });
      const pages = await readReportPdf(file!.content);
      expect(pages).toHaveLength(1);
      for (const page of pages) expect(page.text).toContain('Name');
      const text = pages.map((page) => page.text).join(' ');
      expect(text).toContain(name(25));
      if (who === restricted) {
        expect(text).not.toContain('Secret');
        expect(text).not.toContain(name(1));
        for (let index = 1; index <= RECORDS; index++) expect(text).not.toContain(secret(index));
        expect(mail.html).not.toContain('Secret');
      } else expect(text).toContain(secret(1));
    }
    const history = (await runs(report.id))[0]!;
    expect(history.trigger).toBe('schedule');
    expect(history.deliveries.map((delivery) => [delivery.records, delivery.attachment])).toEqual([
      [25, 'attached'],
      [24, 'attached'],
    ]);
    const downloaded = await call(restricted, 'GET', `/api/reports/${report.id}/download`);
    expect(downloaded.statusCode).toBe(200);
    const pages = await readReportPdf(downloaded.rawPayload);
    expect(pages).toHaveLength(1);
    const text = pages.map((page) => page.text).join(' ');
    expect(text).toContain('Name');
    expect(text).not.toContain('Secret');
    expect(text).not.toContain(name(1));
    expect(text).toContain(name(25));
    const downloads = await auditEvents('databases.view.downloaded');
    expect(downloads.at(-1)).toEqual({
      actor_id: restricted.userId,
      metadata: {
        databaseId: base.databaseId,
        tableId: base.tableId,
        viewId: base.viewId,
        format: 'pdf',
        records: 24,
      },
    });
    expect((await call(stranger, 'GET', `/api/reports/${report.id}/download`)).statusCode).toBe(404);
    expect(await auditEvents('databases.view.downloaded')).toEqual(downloads);
    sent.length = 0;
    const manual = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
    expect(manual.statusCode).toBe(200);
    expect(manual.json<ReportRun>().trigger).toBe('manual');
    for (const mail of sent) {
      const pages = await readReportPdf(mail.attachments![0]!.content);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.text).toContain('Name');
      expect(pages[0]!.text).toContain(name(25));
    }
  });

  it('keeps PDF fidelity notes in history without record values', async () => {
    const report = await create(server.owner, { format: 'pdf' });
    await apply(server, base.databaseId, [
      {
        kind: 'view.update',
        viewId: base.viewId,
        config: {
          dataBars: [{ fieldId: base.f.amount, color: 'blue' }],
        },
      },
    ]);
    try {
      await sendDue([report.id]);
      const pages = await readReportPdf(mailTo(server.owner)[0]!.attachments![0]!.content);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.text).toContain('Name');
      expect(pages[0]!.text).toContain(name(25));
      expect((await runs(report.id))[0]!.deliveries[0]!.notes).toContain('reports.pdf.visualSimplified');
    } finally {
      await apply(server, base.databaseId, [
        { kind: 'view.update', viewId: base.viewId, config: { dataBars: [] } },
      ]);
    }
  });
  it('keeps missing-glyph notes in PDF delivery history and retains Japanese and Korean text', async () => {
    const report = await create(server.owner, { format: 'pdf' });
    const value = '東京 山田 고객 주문 \u{10FFFF}';
    await apply(server, base.databaseId, [
      {
        kind: 'record.update',
        tableId: base.tableId,
        records: [{ id: recordIds[0]!, values: { [base.f.name]: value } }],
      },
    ]);
    try {
      await sendDue([report.id]);
      const pages = await readReportPdf(mailTo(server.owner)[0]!.attachments![0]!.content);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.text.replaceAll(' ', '')).toContain('東京山田고객주문�');
      expect(pages[0]!.text).toContain('Name');
      const history = await runs(report.id);
      expect(history[0]!.deliveries[0]!.notes).toContain('reports.pdf.missingGlyphs');
      expect(JSON.stringify(history)).not.toContain(value);
      expect(JSON.stringify(await auditEvents('data.report.sent'))).not.toContain(value);
    } finally {
      await apply(server, base.databaseId, [
        {
          kind: 'record.update',
          tableId: base.tableId,
          records: [{ id: recordIds[0]!, values: { [base.f.name]: name(1) } }],
        },
      ]);
    }
  });
  it('sends each member the records and fields they could see themselves', async () => {
    const report = await create(server.owner, {
      name: 'Pipeline review',
      recipients: [member(server.owner), member(restricted), member(reader)],
    });
    const hidden = recordIds[0]!;
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      this: AccessScope,
      _tableId: string,
      fields: readonly F[],
    ) {
      return this.actor.userId === restricted.userId
        ? fields.filter((field) => field.id !== base.f.secret)
        : [...fields];
    });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(function (this: AccessScope) {
      return this.actor.userId === restricted.userId ? sql`__id <> ${hidden}` : sql`TRUE`;
    });
    const now = new Date('2026-10-05T14:00:00Z');
    await sendDue([report.id], now);
    expect(sent).toHaveLength(3);

    const full = mailTo(server.owner)[0]!;
    expect(full.subject).toBe('Pipeline review: Open deals');
    expect(full.text).toContain(
      'Pipeline review, from the Open deals view of Deals, as of Oct 5, 2026, 9:00 AM.',
    );
    expect(full.text).toContain('25 records are in the view.');
    expect(full.text).toContain('The first 20 are below.');
    expect(full.text).toContain('Name | Amount | Secret | Stage | Note');
    expect(full.text).toContain(`${name(1)} | 7,001 | ${secret(1)} | STAGE-1-kw | NOTE-1-jp`);
    expect(full.text).not.toContain(name(21));
    expect(full.text).toContain('Every record is in the attached file, Deals - Open deals.csv.');
    expect(full.text).toContain(
      `Open the view in Riosoma: ${BASE_URL}/${base.databaseId}/${base.tableId}/${base.viewId}`,
    );
    expect(full.text).toContain(
      'You’re getting this because Owner set up the scheduled report Pipeline review.',
    );
    expect(full.html).toContain(`<th align="left">Secret</th>`);
    expect(full.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(full.headers?.['List-Unsubscribe']).toMatch(
      new RegExp(`^<${BASE_URL}/api/reports/unsubscribe\\?token=[^>]+>$`),
    );
    const lines = csv(full);
    expect(lines[0]).toBe('Name,Amount,Secret,Stage,Note,Extra');
    expect(lines).toHaveLength(RECORDS + 1);

    // The restricted field is neither in the summary nor a column of the file, and the record
    // this person can't see is in neither.
    const partial = mailTo(restricted)[0]!;
    expect(partial.text).toContain('24 records are in the view.');
    expect(partial.text).toContain('Name | Amount | Stage | Note | Extra');
    expect(partial.html).not.toContain('Secret');
    for (const n of [1, 2, 25]) {
      expect(partial.text).not.toContain(secret(n));
      expect(partial.html).not.toContain(secret(n));
    }
    expect(partial.text).not.toContain(name(1));
    const restrictedLines = csv(partial);
    expect(restrictedLines[0]).toBe('Name,Amount,Stage,Note,Extra');
    expect(restrictedLines).toHaveLength(RECORDS);
    expect(restrictedLines.join('\n')).not.toMatch(/SECRET-/);
    expect(restrictedLines.join('\n')).not.toContain(name(1));
    expect(csv(mailTo(reader)[0]!)[0]).toBe('Name,Amount,Secret,Stage,Note,Extra');

    const [run] = await runs(report.id);
    expect(run).toMatchObject({ trigger: 'schedule', state: 'sent', attempts: 1, error: null });
    expect(run!.deliveries).toEqual([
      {
        recipient: { kind: 'member', userId: server.owner.userId, name: 'Owner' },
        state: 'sent',
        records: 25,
        attachment: 'attached',
        attempts: 1,
        error: null,
      },
      {
        recipient: { kind: 'member', userId: restricted.userId, name: 'Sam Restricted' },
        state: 'sent',
        records: 24,
        attachment: 'attached',
        attempts: 1,
        error: null,
      },
      {
        recipient: { kind: 'member', userId: reader.userId, name: 'Riley Reader' },
        state: 'sent',
        records: 25,
        attachment: 'attached',
        attempts: 1,
        error: null,
      },
    ]);
    expect((await auditEvents('data.report.sent')).at(-1)?.metadata).toMatchObject({
      reportId: report.id,
      state: 'sent',
      recipients: 3,
      sent: 3,
      failed: 0,
    });
    // The next send moved on from the one that went.
    expect((await schedule(report.id))!.next_run_at!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('links to the view instead of attaching a file over the size cap', async () => {
    // Timestamp compression must not change the workbook's size between boundary checks.
    const addCore = ExcelJS.stream.xlsx.WorkbookWriter.prototype.addCore;
    vi.spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, 'addCore').mockImplementation(function (
      this: ExcelJS.stream.xlsx.WorkbookWriter,
    ) {
      this.created = new Date('2026-01-01T00:00:00.000Z');
      this.modified = this.created;
      return addCore.call(this);
    });
    const report = await create(server.owner, { format: 'xlsx' });
    await sendDue([report.id]);
    const workbook = mailTo(server.owner)[0]!;
    expect(workbook.attachments?.[0]).toMatchObject({
      filename: 'Deals - Open deals.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const size = workbook.attachments![0]!.content.length;
    sent.length = 0;

    worker.attachmentLimit = size - 1;
    await sendDue([report.id]);
    const linked = mailTo(server.owner)[0]!;
    expect(linked.attachments).toBeUndefined();
    expect(linked.text).toContain(
      `The file came to more than 20 MB, which is too large to attach.  Open the view to see every record: ${BASE_URL}/${base.databaseId}/${base.tableId}/${base.viewId}`,
    );
    expect(linked.text).toContain('The first 20 are below.');
    expect((await runs(report.id))[0]!.deliveries[0]).toMatchObject({ attachment: 'linked', records: 25 });

    // Just the summary, and no file at all.
    sent.length = 0;
    const summary = await create(server.owner, { format: 'none' });
    await sendDue([summary.id]);
    const plain = mailTo(server.owner)[0]!;
    expect(plain.attachments).toBeUndefined();
    expect(plain.text).toContain('Open the view in Riosoma:');
    expect((await runs(summary.id))[0]!.deliveries[0]!.attachment).toBe('none');
  });

  it('is queued and claimed once when two servers look at the same moment', async () => {
    const reports = await Promise.all(
      Array.from({ length: 8 }, (_, index) => create(server.owner, { name: `Report ${index}` })),
    );
    const ids = reports.map((report) => report.id);
    const now = new Date();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'report_schedules')}
      SET next_run_at = ${new Date(now.getTime() - 60_000)} WHERE id = ANY(${ids}::text[])`,
    );
    const other = new ReportWorker(server.app);
    const queued = await Promise.all([worker.queueDue(now), other.queueDue(now), worker.queueDue(now)]);
    expect(queued.reduce((sum, count) => sum + count, 0)).toBe(8);
    const rows = await query<{ report_id: string; count: string }>(
      server.pool,
      sql`SELECT report_id, count(*) AS count FROM ${ident(server.schemas.app, 'report_runs')}
      WHERE report_id = ANY(${ids}::text[]) GROUP BY report_id`,
    );
    expect(rows.rows.map((row) => Number(row.count))).toEqual(Array(8).fill(1));

    const claimed = await Promise.all([worker.claim(8, now), other.claim(8, now), worker.claim(8, now)]);
    const runIds = claimed.flat().map((row) => row.id);
    expect(runIds).toHaveLength(8);
    expect(new Set(runIds).size).toBe(8);
    for (const row of claimed.flat()) await worker.run(row, now);
    expect(sent).toHaveLength(8);
    await other.close();
  });

  it('tries again with a growing wait when mail fails, and only the ones that failed', async () => {
    const report = await create(server.owner, { recipients: [member(server.owner), member(reader)] });
    const now = new Date();
    failures.left = 1;
    await sendDue([report.id], now);
    let [run] = await runs(report.id);
    expect(run).toMatchObject({ state: 'retrying', attempts: 1 });
    expect(run!.retryAt).toBe(new Date(now.getTime() + REPORT_RETRY_DELAYS_MS[0]).toISOString());
    expect(run!.deliveries.map((delivery) => [delivery.state, delivery.error])).toEqual([
      ['failed', { messageKey: 'reports.delivery.mailFailed', code: 'EENVELOPE' }],
      ['sent', null],
    ]);
    // Not before its wait is over.
    await worker.drain(new Date(now.getTime() + 30_000));
    expect(sent).toHaveLength(1);
    await worker.drain(new Date(now.getTime() + 61_000));
    [run] = await runs(report.id);
    expect(run).toMatchObject({ state: 'sent', attempts: 2, retryAt: null });
    expect(run!.deliveries.map((delivery) => [delivery.state, delivery.attempts])).toEqual([
      ['sent', 2],
      ['sent', 1],
    ]);
    expect(mailTo(server.owner)).toHaveLength(1);
    expect(mailTo(reader)).toHaveLength(1);

    // After four tries it gives up, and says so.
    sent.length = 0;
    failures.left = 100;
    let at = Date.now();
    await sendDue([report.id], new Date(at));
    // The retries move the clock 31 minutes ahead.  The report is due on Mondays at nine in Chicago,
    // so in the half hour before that the schedule's own next run came due on the way and was the
    // run read back.  Keep the schedule out of the window.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'report_schedules')}
      SET next_run_at = ${new Date(at + 30 * 86_400_000)} WHERE id = ${report.id}`,
    );
    for (const wait of REPORT_RETRY_DELAYS_MS) {
      at += wait + 1_000;
      await worker.drain(new Date(at));
    }
    [run] = await runs(report.id);
    expect(run).toMatchObject({ state: 'failed', attempts: 4 });
    expect(run!.deliveries.map((delivery) => delivery.attempts)).toEqual([4, 4]);
    expect((await auditEvents('data.report.sent')).at(-1)?.metadata).toMatchObject({
      reportId: report.id,
      state: 'failed',
      failed: 2,
    });
  });

  it('turns off and tells its owner when the owner loses access or the view is deleted', async () => {
    const leaving = await server.addMember({ name: 'Lee Leaving' });
    await grant(server, base.databaseId, leaving, 'reader');
    const theirs = await create(leaving, { name: 'Leaving report', recipients: [member(leaving)] });
    await grant(server, base.databaseId, leaving, null);
    await sendDue([theirs.id]);
    expect(sent).toEqual([]);
    expect(await schedule(theirs.id)).toMatchObject({
      enabled: false,
      stopped_because: 'reports.stopped.ownerLostAccess',
      next_run_at: null,
    });
    expect((await runs(theirs.id, leaving))[0]).toMatchObject({
      state: 'skipped',
      error: { messageKey: 'reports.stopped.ownerLostAccess' },
    });
    const told = await notifications(leaving);
    expect(told).toEqual([
      expect.objectContaining({
        kind: 'reportStopped',
        actor: null,
        target: expect.objectContaining({
          reportId: theirs.id,
          reportName: 'Leaving report',
          viewId: base.viewId,
          reason: { messageKey: 'reports.stopped.ownerLostAccess' },
        }),
      }),
    ]);

    const temporary = newId('view');
    await apply(server, base.databaseId, [
      {
        kind: 'view.create',
        view: { id: temporary, tableId: base.tableId, name: 'Temporary', type: 'grid' },
      },
    ]);
    const onView = await create(server.owner, { name: 'Temporary report' }, temporary);
    await apply(server, base.databaseId, [{ kind: 'view.trash', viewId: temporary }]);
    await sendDue([onView.id]);
    expect(sent).toEqual([]);
    expect(await schedule(onView.id)).toMatchObject({
      enabled: false,
      stopped_because: 'reports.stopped.viewDeleted',
    });
    expect((await notifications(server.owner)).filter((item) => item.kind === 'reportStopped')).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          reportId: onView.id,
          reason: { messageKey: 'reports.stopped.viewDeleted' },
        }),
      }),
    ]);
    expect((await auditEvents('data.report.stopped')).map((event) => event.metadata.reason)).toEqual([
      'reports.stopped.ownerLostAccess',
      'reports.stopped.viewDeleted',
    ]);
  });

  it('sends now for its owner, when the server can send email', async () => {
    const report = await create(server.owner, {
      enabled: false,
      recipients: [member(server.owner), member(editor)],
    });
    expect((await call(editor, 'POST', `/api/reports/${report.id}/send`)).statusCode).toBe(403);
    const now = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json<ReportRun>()).toMatchObject({ trigger: 'manual', state: 'sent', attempts: 1 });
    expect(sent.map((message) => message.to).sort()).toEqual([editor.email, server.owner.email].sort());
    expect((await auditEvents('data.report.sent')).at(-1)).toMatchObject({
      actor_id: server.owner.userId,
      metadata: { trigger: 'manual', sent: 2 },
    });
    const mailer = server.ctx.mailer;
    server.ctx.mailer = null;
    try {
      const unavailable = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ error: { messageKey: 'reports.email.unavailable' } });
    } finally {
      server.ctx.mailer = mailer;
    }
  });
});

async function notifications(who: SignedIn): Promise<Notification[]> {
  const response = await call(who, 'GET', '/api/notifications');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationsPage>().notifications;
}

describe('the link to stop receiving a report', () => {
  it('works without signing in, once, for the one recipient it names', async () => {
    await call(server.owner, 'PUT', '/api/admin/reports/policy', { outsideRecipients: true });
    const report = await create(server.owner, {
      recipients: [member(server.owner), member(reader), address('partner@elsewhere.example')],
    });
    await sendDue([report.id]);
    const token = footerToken(mailTo(reader)[0]!);
    const url = `/api/reports/unsubscribe?token=${encodeURIComponent(token)}`;
    const preview = await call(null, 'GET', url);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<ReportUnsubscribePreview>()).toEqual({
      reportName: 'Weekly deals',
      viewName: 'Open deals',
      receiving: true,
    });
    expect((await call(null, 'POST', url)).statusCode).toBe(204);
    expect((await call(null, 'GET', url)).json<ReportUnsubscribePreview>().receiving).toBe(false);
    // A second click finds it already done.
    expect((await call(null, 'POST', url)).statusCode).toBe(204);
    const kept = (await call(server.owner, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>();
    expect(kept.reports[0]!.recipients.map((recipient) => recipient.kind)).toEqual(['member', 'address']);

    // A mail app's own button posts a form body to the address in the header.
    const header = mailTo('partner@elsewhere.example')[0]!.headers!['List-Unsubscribe']!;
    const oneClick = await server.app.inject({
      method: 'POST',
      url: header.slice(1, -1).replace(BASE_URL, ''),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.statusCode, oneClick.body).toBe(204);
    const left = (await call(server.owner, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>();
    expect(left.reports[0]!.recipients).toEqual([
      { kind: 'member', userId: server.owner.userId, name: 'Owner' },
    ]);
    expect((await auditEvents('data.report.unsubscribed')).slice(-2)).toEqual([
      expect.objectContaining({
        actor_id: reader.userId,
        metadata: expect.objectContaining({ recipient: 'member', via: 'link' }),
      }),
      expect.objectContaining({
        actor_id: null,
        metadata: { reportId: report.id, databaseId: base.databaseId, recipient: 'address', via: 'link' },
      }),
    ]);
    // An address travels in the link only as a digest.
    expect(JSON.stringify(logs.lines)).not.toContain('partner@elsewhere.example');
  });

  it('refuses a link that has expired or been changed', async () => {
    const report = await create(server.owner);
    const secret = server.config.secretKey;
    const expect404 = async (token: string, messageKey: string) => {
      for (const method of ['GET', 'POST'] as const) {
        const response = await call(
          null,
          method,
          `/api/reports/unsubscribe?token=${encodeURIComponent(token)}`,
        );
        expect(response.statusCode, `${method} ${token}`).toBe(404);
        expect(response.json()).toMatchObject({ error: { messageKey } });
      }
    };
    const old = new Date(Date.now() - 91 * 86_400_000);
    await expect404(
      unsubscribeToken(secret, report.id, member(server.owner), old),
      'reports.unsubscribe.expired',
    );

    const valid = unsubscribeToken(secret, report.id, { kind: 'member', userId: server.owner.userId });
    const [payload, signature] = valid.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), u: reader.userId }),
    ).toString('base64url');
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect404(`${forged}.${signature}`, 'reports.unsubscribe.invalid');
    await expect404(`${payload}.${flipped}`, 'reports.unsubscribe.invalid');
    await expect404(`${payload}.${signature}.extra`, 'reports.unsubscribe.invalid');
    // A link cut short in an email doesn't work, and says so the same way.
    await expect404(valid.slice(0, 12), 'reports.unsubscribe.invalid');
    await expect404('', 'reports.unsubscribe.invalid');
    await expect404(
      unsubscribeToken(Buffer.alloc(32, 7), report.id, member(server.owner)),
      'reports.unsubscribe.invalid',
    );
    // None of that took anyone off it.
    const still = (await call(server.owner, 'GET', `/api/views/${base.viewId}/reports`)).json<ViewReports>();
    expect(still.reports[0]!.recipients).toHaveLength(1);

    expect(
      (await call(null, 'GET', `/api/reports/unsubscribe?token=${encodeURIComponent(valid)}`)).statusCode,
    ).toBe(200);
    await call(server.owner, 'DELETE', `/api/reports/${report.id}`);
    await expect404(valid, 'reports.unsubscribe.gone');
  });
});

describe('what reports keep', () => {
  it('never keeps or logs a record’s values', async () => {
    await call(server.owner, 'PUT', '/api/admin/reports/policy', { outsideRecipients: true });
    const report = await create(server.owner, {
      recipients: [member(server.owner), member(reader), address('partner@elsewhere.example')],
    });
    const now = new Date();
    failures.left = 2;
    await sendDue([report.id], now);
    await worker.drain(new Date(now.getTime() + 61_000));
    expect(sent.length).toBe(3);
    expect(sent.some((message) => message.text.includes(name(1)))).toBe(true);

    const stored = await query<{ deliveries: unknown; error: string | null }>(
      server.pool,
      sql`SELECT deliveries, error FROM ${ident(server.schemas.app, 'report_runs')}`,
    );
    const audit = await query<{ metadata: unknown }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'data.report.%'`,
    );
    const history = JSON.stringify(await runs(report.id));
    const kept = [JSON.stringify(stored.rows), JSON.stringify(audit.rows), history, logs.lines.join('\n')];
    expect(logs.lines.some((line) => line.includes('report delivery failed'))).toBe(true);
    for (const text of kept)
      for (const value of values)
        expect(text.includes(value), `${value} in ${text.slice(0, 200)}`).toBe(false);
  });
});

it('withholds guest-masked values from outside recipients after a label changes', async () => {
  await call(server.owner, 'PUT', '/api/admin/reports/policy', { outsideRecipients: true });
  const report = await create(server.owner, {
    recipients: [member(server.owner), address('partner@elsewhere.example')],
  });
  const govern = async (action: object) => {
    const response = await call(server.owner, 'POST', '/api/admin/governance/commands', {
      kind: 'governance.apply',
      id: newId('command'),
      action,
    });
    expect(response.json().status, response.body).toBe('applied');
  };
  await govern({
    kind: 'classification.labels',
    labels: [{ id: 'guests', name: 'Guests', color: 'blue', description: '', rules: { maskGuests: true } }],
  });
  await govern({
    kind: 'classification.assign',
    target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
    labelId: 'guests',
  });
  try {
    await sendDue([report.id]);
    expect(mailTo(server.owner)).toHaveLength(1);
    expect(mailTo('partner@elsewhere.example')).toEqual([]);
    const [run] = await runs(report.id);
    expect(run!.deliveries[1]).toMatchObject({
      state: 'skipped',
      error: { messageKey: 'reports.delivery.outsideNotAllowed' },
    });
  } finally {
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: base.databaseId, fieldId: base.f.name },
      labelId: null,
    });
  }
});

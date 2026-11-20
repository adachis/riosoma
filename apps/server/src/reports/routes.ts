import {
  AppError,
  REPORT_ATTACHMENT_LIMIT,
  newId,
  ReportParams,
  ReportPolicy,
  ReportRunsQuery,
  ReportScheduleInput,
  ReportUnsubscribeQuery,
  ReportViewParams,
  roleAllows,
  type DatabaseRole,
  type MyReports,
  type ReportMember,
  type ReportRecipient,
  type ReportRun,
  type ReportRunsPage,
  type ReportSchedule,
  type ReportUnsubscribePreview,
  type ViewReports,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadView } from '../data/metadata.js';
import { disposition } from '../data/files/detect.js';
import { SnapshotCache } from '../data/snapshots.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { activeMember } from '../notifications/store.js';
import { nextSendAfter } from './schedule.js';
import { renderReport } from './render.js';
import {
  loadSchedule,
  memberNames,
  outsideRecipientsAllowed,
  personSchedules,
  runOf,
  saveRecipients,
  tables,
  toSchedule,
  viewSchedules,
  type RunRow,
  type StoredSchedule,
} from './store.js';
import { addressDigest, checkUnsubscribeToken } from './unsubscribe.js';

/**
 * Scheduled reports in the app, the link in each email's footer, and the organization's choice
 * about outside addresses.  See `packages/contracts/src/reports.ts` for the routes.
 *
 * Only a schedule's owner changes it.  People who can read its view see the ones they set up or
 * receive, and people who can change the view see every schedule on it, so they know what leaves
 * it and to whom.  A person who can't read the database gets `not_found`.
 */

const PAGE = 20;
const Cursor = z.object({ reportId: z.string(), seq: z.number().int().positive().safe() });
const notFound = () => new AppError('not_found', 'errors.notFound');

/** Where the schedule's view is, if it's still there to be read. */
async function readableView(db: Queryable, schemas: DataSchemas, scope: AccessScope, viewId: string) {
  const loaded = await loadView(db, schemas, viewId);
  if (!loaded || loaded.trashed) throw notFound();
  const role = await scope.require(loaded.databaseId, 'read');
  return { ...loaded, role };
}

/** A schedule the person can see, with their role in its database. */
async function visible(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  reportId: string,
  options: { lock?: boolean } = {},
): Promise<{ schedule: StoredSchedule; role: DatabaseRole | null }> {
  const schedule = await loadSchedule(db, schemas, reportId, options);
  if (!schedule || schedule.orgId !== scope.actor.orgId) throw notFound();
  const role = await scope.databaseRole(schedule.databaseId);
  const owner = schedule.ownerId === scope.actor.userId;
  const receiving = schedule.recipients.some(
    (recipient) => recipient.kind === 'member' && recipient.userId === scope.actor.userId,
  );
  // An owner who lost access still sees their own, so they can tidy it away.
  if (!owner && !(role && (receiving || roleAllows(role, 'editSchema')))) throw notFound();
  return { schedule, role };
}

function viewer(scope: AccessScope, role: DatabaseRole | null) {
  return {
    userId: scope.actor.userId,
    canChangeView: roleAllows(role, 'editSchema'),
    canManage: roleAllows(role, 'manage'),
  };
}

/**
 * The recipients as they'll be kept.  An address that belongs to someone in the organization
 * becomes that person, so they get what they could see and nothing more.  Only people who can
 * change the view may send to anyone but themselves, members must be able to open the database,
 * and outside addresses need the organization's leave and a database without restricted fields.
 */
async function checkRecipients(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  input: {
    databaseId: string;
    role: DatabaseRole;
    recipients: readonly ReportRecipient[];
    before: readonly ReportRecipient[];
  },
): Promise<ReportRecipient[]> {
  const { actor } = scope;
  const addresses = input.recipients.flatMap((recipient) =>
    recipient.kind === 'address' ? [recipient.address] : [],
  );
  const known = addresses.length
    ? await query<{ id: string; email: string }>(
        db,
        sql`SELECT u.id, lower(u.email) AS email FROM ${ident(schemas.app, 'users')} u
        JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id AND m.org_id = ${actor.orgId}
        WHERE lower(u.email) = ANY(${addresses}::text[])`,
      )
    : { rows: [] };
  const members = new Map(known.rows.map((row) => [row.email, row.id]));
  const kept: ReportRecipient[] = [];
  const seen = new Set<string>();
  for (const recipient of input.recipients) {
    const memberId = recipient.kind === 'address' ? members.get(recipient.address) : undefined;
    const normal: ReportRecipient = memberId ? { kind: 'member', userId: memberId } : recipient;
    const key = normal.kind === 'member' ? `u:${normal.userId}` : `a:${normal.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(normal);
  }
  const already = new Set(
    input.before.map((recipient) =>
      recipient.kind === 'member' ? `u:${recipient.userId}` : `a:${recipient.address}`,
    ),
  );
  const added = kept.filter((recipient) =>
    recipient.kind === 'member'
      ? recipient.userId !== actor.userId && !already.has(`u:${recipient.userId}`)
      : !already.has(`a:${recipient.address}`),
  );
  if (added.length && !roleAllows(input.role, 'editSchema'))
    throw new AppError('forbidden', 'reports.recipients.onlyYou');
  for (const recipient of kept) {
    if (recipient.kind !== 'member' || recipient.userId === actor.userId) continue;
    const person = await activeMember(db, schemas, actor.orgId, recipient.userId);
    if (!person || !(await new AccessScope(db, schemas, person).databaseRole(input.databaseId)))
      throw new AppError('validation_failed', 'reports.recipients.notMember');
  }
  if (kept.some((recipient) => recipient.kind === 'address')) {
    if (!(await outsideRecipientsAllowed(db, schemas, actor.orgId, actor)))
      throw new AppError('forbidden', 'reports.recipients.outsideOff');
    if (await scope.restrictsFields(input.databaseId))
      throw new AppError('forbidden', 'reports.recipients.outsideRestricted');
  }
  return kept;
}

/**
 * The people in the organization who can open a database, by the rule `AccessScope` applies: a
 * grant of their own, or one to the organization or to a group they're in for anyone but a guest,
 * on the database itself or on the folder it's in.
 */
async function databaseMembers(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  databaseId: string,
): Promise<ReportMember[]> {
  const result = await query<ReportMember & { kind: Actor['kind'] }>(
    db,
    sql`
    SELECT u.id, u.name, u.email, m.kind FROM ${ident(schemas.app, 'memberships')} m
    JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND u.deactivated_at IS NULL ORDER BY u.name, u.id`,
  );
  const visible: ReportMember[] = [];
  for (const person of result.rows) {
    const scope = new AccessScope(db, schemas, {
      userId: person.id,
      orgId,
      kind: person.kind,
      sessionId: '',
      csrfToken: '',
      adminRoles: [],
    });
    if (await scope.databaseRole(databaseId))
      visible.push({ id: person.id, name: person.name, email: person.email });
  }
  return visible;
}

function recipientsOf(schedule: StoredSchedule): ReportRecipient[] {
  return schedule.recipients.map((recipient) =>
    recipient.kind === 'member'
      ? { kind: 'member', userId: recipient.userId }
      : { kind: 'address', address: recipient.address },
  );
}

/** What an audit event says about a schedule: its shape, never where its records go. */
function auditFacts(schedule: {
  id: string;
  databaseId: string;
  viewId: string;
  format: string;
  enabled: boolean;
  recipients: readonly ReportRecipient[];
}) {
  return {
    reportId: schedule.id,
    databaseId: schedule.databaseId,
    viewId: schedule.viewId,
    format: schedule.format,
    enabled: schedule.enabled,
    members: schedule.recipients.filter((recipient) => recipient.kind === 'member').length,
    outside: schedule.recipients.filter((recipient) => recipient.kind === 'address').length,
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const security = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  const open = { config: { policy: { kind: 'public' as const } } };

  // A mail app's one-click unsubscribe posts a form body, which only these routes need to read.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_request, body, done) => done(null, String(body)),
  );
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const emailAvailable = () => Boolean(ctx.mailer && ctx.config.baseUrl);
  const snapshots = new SnapshotCache(() => dataStore(ctx), 32, app.log);

  app.get('/api/reports/:reportId/download', session, async (request, reply) => {
    const { reportId } = parse(ReportParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const { schedule } = await visible(pool, schemas, scope, reportId);
    await readableView(pool, schemas, scope, schedule.viewId);
    if (schedule.format !== 'pdf') throw new AppError('validation_failed', 'errors.validationFailed');
    const person = await query<{ locale: string }>(
      pool,
      sql`SELECT locale FROM ${tables(schemas).users} WHERE id = ${scope.actor.userId}`,
    );
    const content = await renderReport({
      pool,
      schemas,
      snapshots,
      scope,
      viewId: schedule.viewId,
      format: schedule.format,
      locale: person.rows[0]?.locale ?? schedule.locale,
      timeZone: schedule.timeZone,
      limit: REPORT_ATTACHMENT_LIMIT,
      files: ctx.config,
      reportName: schedule.name,
      pdf: ctx.config,
    });
    if (!content) throw notFound();
    if (!content.attachment) throw new AppError('validation_failed', 'reports.pdf.downloadTooLarge');
    await auditEvent(pool, authDatabase(ctx).audit, 'databases.view.downloaded', scope.actor, {
      databaseId: schedule.databaseId,
      tableId: schedule.tableId,
      viewId: schedule.viewId,
      format: 'pdf',
      records: content.count,
    });
    reply.header('content-type', content.attachment.contentType);
    reply.header(
      'content-disposition',
      disposition(content.attachment.contentType, content.attachment.filename),
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header(
      'content-security-policy',
      "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    );
    // A generated PDF, spreadsheet, document, or CSV: never HTML, sent with a safe disposition, nosniff, and a sandboxed CSP.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(content.attachment.content);
  });

  app.get('/api/views/:viewId/reports', session, async (request): Promise<ViewReports> => {
    const { viewId } = parse(ReportViewParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const view = await readableView(pool, schemas, scope, viewId);
    const who = viewer(scope, view.role);
    const schedules = (await viewSchedules(pool, schemas, viewId))
      .map((schedule) => toSchedule(schedule, who))
      .filter((schedule) => who.canChangeView || schedule.canEdit || schedule.receiving);
    return {
      reports: schedules,
      canAddMembers: who.canChangeView,
      members: who.canChangeView
        ? await databaseMembers(pool, schemas, scope.actor.orgId, view.databaseId)
        : [],
      outsideAllowed:
        who.canChangeView &&
        (await outsideRecipientsAllowed(pool, schemas, scope.actor.orgId, scope.actor)) &&
        !(await scope.restrictsFields(view.databaseId)),
      emailAvailable: emailAvailable(),
    };
  });

  app.post('/api/views/:viewId/reports', session, async (request): Promise<ReportSchedule> => {
    const { viewId } = parse(ReportViewParams, request.params);
    const input = parse(ReportScheduleInput, request.body);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const view = await readableView(pool, schemas, scope, viewId);
    const recipients = await checkRecipients(pool, schemas, scope, {
      databaseId: view.databaseId,
      role: view.role,
      recipients: input.recipients,
      before: [],
    });
    const id = newId('report');
    const t = tables(schemas);
    const { audit } = authDatabase(ctx);
    const next = input.enabled ? nextSendAfter(input.frequency, input.timeZone, new Date()) : null;
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`INSERT INTO ${t.schedules}
        (id, org_id, database_id, table_id, view_id, owner_id, name, format, frequency, time_zone, locale,
          enabled, next_run_at)
        SELECT ${id}, ${actor.orgId}, ${view.databaseId}, ${view.view.tableId}, ${viewId}, ${actor.userId},
          ${input.name}, ${input.format}, ${JSON.stringify(input.frequency)}::jsonb, ${input.timeZone},
          u.locale, ${input.enabled}, ${next}
        FROM ${t.users} u WHERE u.id = ${actor.userId}`,
      );
      await saveRecipients(db, schemas, id, recipients);
      await auditEvent(
        db,
        audit,
        'data.report.created',
        actor,
        auditFacts({ id, databaseId: view.databaseId, viewId, ...input, recipients }),
      );
    });
    const stored = (await loadSchedule(pool, schemas, id))!;
    return toSchedule(stored, viewer(scope, view.role));
  });

  app.get('/api/reports', session, async (request): Promise<MyReports> => {
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const owned: ReportSchedule[] = [];
    const receiving: ReportSchedule[] = [];
    for (const schedule of await personSchedules(pool, schemas, actor.orgId, actor.userId)) {
      const role = await scope.databaseRole(schedule.databaseId);
      if (schedule.ownerId === actor.userId) owned.push(toSchedule(schedule, viewer(scope, role)));
      // Someone who can no longer open the database gets nothing from it, so it isn't listed.
      else if (role) receiving.push(toSchedule(schedule, viewer(scope, role)));
    }
    return { owned, receiving };
  });

  app.put('/api/reports/:reportId', session, async (request): Promise<ReportSchedule> => {
    const { reportId } = parse(ReportParams, request.params);
    const input = parse(ReportScheduleInput, request.body);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const { audit } = authDatabase(ctx);
    const role = await withTransaction(pool, async (db) => {
      const { schedule, role } = await visible(db, schemas, scope, reportId, { lock: true });
      if (schedule.ownerId !== actor.userId) throw new AppError('forbidden', 'reports.schedule.ownerOnly');
      const view = await readableView(db, schemas, scope, schedule.viewId);
      const recipients = await checkRecipients(db, schemas, scope, {
        databaseId: schedule.databaseId,
        role: view.role,
        recipients: input.recipients,
        before: recipientsOf(schedule),
      });
      // Content edits must retain a due send that the worker has not claimed yet.
      const timingChanged =
        !schedule.enabled ||
        schedule.timeZone !== input.timeZone ||
        JSON.stringify(schedule.frequency) !== JSON.stringify(input.frequency);
      const next = input.enabled
        ? timingChanged || !schedule.nextRunAt
          ? nextSendAfter(input.frequency, input.timeZone, new Date())
          : new Date(schedule.nextRunAt)
        : null;
      await query(
        db,
        sql`UPDATE ${tables(schemas).schedules} SET name = ${input.name}, format = ${input.format},
        frequency = ${JSON.stringify(input.frequency)}::jsonb, time_zone = ${input.timeZone},
        enabled = ${input.enabled}, next_run_at = ${next},
        stopped_because = ${input.enabled ? null : schedule.stoppedBecause}, updated_at = statement_timestamp()
        WHERE id = ${reportId}`,
      );
      await saveRecipients(db, schemas, reportId, recipients);
      await auditEvent(
        db,
        audit,
        'data.report.updated',
        actor,
        auditFacts({ ...schedule, ...input, recipients }),
      );
      return role;
    });
    return toSchedule((await loadSchedule(pool, schemas, reportId))!, viewer(scope, role));
  });

  app.delete('/api/reports/:reportId', session, async (request, reply) => {
    const { reportId } = parse(ReportParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const { audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      const { schedule, role } = await visible(db, schemas, scope, reportId, { lock: true });
      if (schedule.ownerId !== actor.userId && !roleAllows(role, 'manage'))
        throw new AppError('forbidden', 'reports.schedule.ownerOnly');
      await query(db, sql`DELETE FROM ${tables(schemas).schedules} WHERE id = ${reportId}`);
      await auditEvent(db, audit, 'data.report.deleted', actor, {
        reportId,
        databaseId: schedule.databaseId,
        viewId: schedule.viewId,
      });
    });
    return reply.status(204).send();
  });

  app.post('/api/reports/:reportId/send', session, async (request): Promise<ReportRun> => {
    const { reportId } = parse(ReportParams, request.params);
    const worker = ctx.reports;
    if (!worker) throw new AppError('unavailable', 'errors.unavailable');
    if (!emailAvailable()) throw new AppError('unavailable', 'reports.email.unavailable');
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const { schedule } = await visible(pool, schemas, scope, reportId);
    if (schedule.ownerId !== actor.userId) throw new AppError('forbidden', 'reports.schedule.ownerOnly');
    await readableView(pool, schemas, scope, schedule.viewId);
    const finished = await worker.sendNow(schedule, actor.userId);
    if (!finished) throw new AppError('unavailable', 'errors.unavailable');
    return runOf(finished, await memberNames(pool, schemas, [finished]));
  });

  app.post('/api/reports/:reportId/leave', session, async (request, reply) => {
    const { reportId } = parse(ReportParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    await withTransaction(pool, async (db) => {
      const schedule = await loadSchedule(db, schemas, reportId, { lock: true });
      if (!schedule || schedule.orgId !== actor.orgId) throw notFound();
      const receiving = schedule.recipients.some(
        (recipient) => recipient.kind === 'member' && recipient.userId === actor.userId,
      );
      if (!receiving && schedule.ownerId !== actor.userId && !(await scope.databaseRole(schedule.databaseId)))
        throw notFound();
      if (!receiving) throw new AppError('conflict', 'reports.recipients.notReceiving');
      await removeRecipient(
        db,
        schemas,
        schedule,
        { kind: 'member', userId: actor.userId },
        actor,
        'settings',
      );
    });
    return reply.status(204).send();
  });

  app.get('/api/reports/:reportId/runs', session, async (request): Promise<ReportRunsPage> => {
    const { reportId } = parse(ReportParams, request.params);
    const input = parse(ReportRunsQuery, request.query);
    let before: number | undefined;
    if (input.cursor !== undefined) {
      try {
        const cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (cursor.reportId !== reportId) throw new Error();
        before = cursor.seq;
      } catch {
        throw new AppError('validation_failed', 'errors.validationFailed');
      }
    }
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const { schedule, role } = await visible(pool, schemas, scope, reportId);
    // Runs name everyone a report went to, so they're for the people who see that already.
    if (schedule.ownerId !== actor.userId && !roleAllows(role, 'editSchema'))
      throw new AppError('forbidden', 'reports.schedule.ownerOnly');
    const result = await query<RunRow>(
      pool,
      sql`SELECT * FROM ${tables(schemas).runs} WHERE report_id = ${reportId}
      AND ${before === undefined ? sql`TRUE` : sql`seq < ${before}`} ORDER BY seq DESC LIMIT ${PAGE + 1}`,
    );
    const page = result.rows.slice(0, PAGE);
    const last = page.at(-1);
    const names = await memberNames(pool, schemas, page);
    return {
      runs: page.map((row) => runOf(row, names)),
      next:
        result.rows.length > PAGE && last
          ? Buffer.from(JSON.stringify({ reportId, seq: Number(last.seq) })).toString('base64url')
          : null,
    };
  });

  /** The schedule and recipient a footer link names, or an error saying why the link won't do. */
  async function fromToken(db: Queryable, token: string, lock = false) {
    const { schemas } = dataStore(ctx);
    const check = checkUnsubscribeToken(ctx.config.secretKey, token);
    if (!check.ok)
      throw new AppError(
        'not_found',
        check.reason === 'expired' ? 'reports.unsubscribe.expired' : 'reports.unsubscribe.invalid',
      );
    const schedule = await loadSchedule(db, schemas, check.reportId, { lock });
    if (!schedule) throw new AppError('not_found', 'reports.unsubscribe.gone');
    const recipient = schedule.recipients.find((candidate) =>
      check.recipient.kind === 'member'
        ? candidate.kind === 'member' && candidate.userId === check.recipient.userId
        : candidate.kind === 'address' &&
          addressDigest(ctx.config.secretKey, candidate.address) === check.recipient.digest,
    );
    return { schedule, check, recipient };
  }

  app.get('/api/reports/unsubscribe', open, async (request): Promise<ReportUnsubscribePreview> => {
    const { token } = parse(ReportUnsubscribeQuery, request.query);
    const { pool } = dataStore(ctx);
    const { schedule, recipient } = await fromToken(pool, token);
    return { reportName: schedule.name, viewName: schedule.viewName, receiving: Boolean(recipient) };
  });

  app.post('/api/reports/unsubscribe', open, async (request, reply) => {
    const { token } = parse(ReportUnsubscribeQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    await withTransaction(pool, async (db) => {
      const { schedule, check, recipient } = await fromToken(db, token, true);
      // A second click, or a mail app posting after the page did, finds it already done.
      if (!recipient) return;
      const who =
        check.recipient.kind === 'member' ? { userId: check.recipient.userId, orgId: schedule.orgId } : null;
      await removeRecipient(
        db,
        schemas,
        schedule,
        recipient.kind === 'member'
          ? { kind: 'member', userId: recipient.userId }
          : { kind: 'address', address: recipient.address },
        who,
        'link',
      );
    });
    return reply.status(204).send();
  });

  /** Takes one recipient off a schedule, turning it off when nobody's left, and audits it. */
  async function removeRecipient(
    db: Queryable,
    schemas: DataSchemas,
    schedule: StoredSchedule,
    recipient: ReportRecipient,
    who: Pick<Actor, 'userId' | 'orgId'> | null,
    via: 'link' | 'settings',
  ): Promise<void> {
    const t = tables(schemas);
    await query(
      db,
      recipient.kind === 'member'
        ? sql`DELETE FROM ${t.recipients} WHERE report_id = ${schedule.id} AND user_id = ${recipient.userId}`
        : sql`DELETE FROM ${t.recipients} WHERE report_id = ${schedule.id} AND address = ${recipient.address}`,
    );
    if (schedule.recipients.length <= 1)
      await query(
        db,
        sql`UPDATE ${t.schedules} SET enabled = false, next_run_at = NULL, updated_at = statement_timestamp()
        WHERE id = ${schedule.id}`,
      );
    await auditEvent(
      db,
      authDatabase(ctx).audit,
      'data.report.unsubscribed',
      who ?? { orgId: schedule.orgId },
      {
        reportId: schedule.id,
        databaseId: schedule.databaseId,
        recipient: recipient.kind,
        ...(recipient.kind === 'member' ? { userId: recipient.userId } : {}),
        via,
      },
    );
  }

  app.get('/api/admin/reports/policy', security, async (request): Promise<ReportPolicy> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return { outsideRecipients: await outsideRecipientsAllowed(pool, schemas, actor.orgId) };
  });

  app.put('/api/admin/reports/policy', security, async (request): Promise<ReportPolicy> => {
    const actor = requireActor(request);
    const { outsideRecipients } = parse(ReportPolicy, request.body);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const found = await query<{ allowed: boolean }>(
        db,
        sql`SELECT report_outside_recipients AS allowed FROM ${tables(schemas).orgs}
        WHERE id = ${actor.orgId} FOR UPDATE`,
      );
      const before = found.rows[0]?.allowed;
      if (before === undefined) throw notFound();
      if (before !== outsideRecipients) {
        await query(
          db,
          sql`UPDATE ${tables(schemas).orgs} SET report_outside_recipients = ${outsideRecipients}
          WHERE id = ${actor.orgId}`,
        );
        await auditEvent(db, audit, 'org.report_policy.updated', actor, {
          outsideRecipients: { from: before, to: outsideRecipients },
        });
      }
      return { outsideRecipients };
    });
  });
}

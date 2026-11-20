import { requirePolicy } from '../org-units/policy.js';
import {
  AppError,
  FEEDBACK_LIMITS,
  FeedbackCreate,
  FeedbackGithubUpdate,
  FeedbackIssueRequest,
  FeedbackIssueSend,
  FeedbackListQuery,
  FeedbackParams,
  FeedbackReplyCreate,
  FeedbackStatusUpdate,
  newId,
  type FeedbackCount,
  type FeedbackCreated,
  type FeedbackGithubSettings,
  type FeedbackHubSettings,
  type FeedbackHubPreview,
  type FeedbackIssuePreview,
  type FeedbackItem,
  type FeedbackPage,
  type SentFeedbackList,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { notifyFeedbackReply } from '../notifications/produce.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import { hubPayload, hubUrl, refreshHubReport, sendHubReport } from './hub.js';
import {
  GithubClient,
  issueBody,
  issueTitle,
  screenshotPath,
  similarIssues,
  SCREENSHOT_LINK_PLACEHOLDER,
  type GithubTarget,
} from './github.js';
import {
  githubSettings,
  loadFeedback,
  newCount,
  recordHubResult,
  selectFeedback,
  tables,
  toItem,
  toSent,
  type FeedbackRow,
} from './store.js';

/**
 * Feedback through the API: anyone signed in sends it and reads the replies to what they sent,
 * and the organization's owners and feedback admins read, answer, sort, and delete it.  See
 * `packages/contracts/src/feedback.ts` for the routes.
 *
 * The audit log records each piece sent, each reply, each change of status, each deletion, and
 * each bug report sent to GitHub, by ID and kind and never with anyone's words.
 */

const Cursor = z.object({ at: z.iso.datetime(), id: z.string().max(40) });
const notFound = () => new AppError('not_found', 'errors.notFound');
const HOUR_MS = 3_600_000;
/** How many of their own pieces a sender sees afterward */
const SENT_SHOWN = 50;

function cursorOf(row: FeedbackRow): string {
  return Buffer.from(JSON.stringify({ at: row.created_at.toISOString(), id: row.id })).toString('base64url');
}

function readCursor(value: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('validation_failed', 'errors.validationFailed');
  }
}

/** The screenshot's bytes, once they're shown to be the image type they claim. */
function screenshotOf(dataUrl: string): { bytes: Buffer; type: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new AppError('validation_failed', 'feedback.screenshot.invalid');
  const type = match[1]!;
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > FEEDBACK_LIMITS.screenshotBytes)
    throw new AppError('payload_too_large', 'feedback.screenshot.tooLarge');
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const fits =
    type === 'image/png'
      ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : type === 'image/jpeg'
        ? starts(0xff, 0xd8, 0xff)
        : bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
          bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!fits) throw new AppError('validation_failed', 'feedback.screenshot.invalid');
  return { bytes, type };
}

async function audit(
  db: Queryable,
  schema: string,
  action: string,
  actor: Actor,
  metadata: Record<string, unknown>,
): Promise<void> {
  await auditEvent(db, schema, action, actor, metadata);
}

/** Whether this person may change where bug reports go: owners, and admins for integrations. */
function canChangeGithub(actor: Actor): boolean {
  return actor.kind === 'owner' || actor.adminRoles.includes('integrations');
}

const TOKEN_CONTEXT = (orgId: string) => `feedback.github:${orgId}`;

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const admin = {
    config: { policy: { kind: 'admin' as const, area: 'feedback' as const, scope: 'organization' as const } },
  };
  const integrations = {
    config: {
      policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
    },
  };
  const github = new GithubClient(ctx.config);

  async function hubSettings(
    db: Queryable,
    schemas: DataSchemas,
    actor: Actor,
  ): Promise<FeedbackHubSettings> {
    const row = await query<{ enabled: boolean; install_id: string }>(
      db,
      sql`SELECT o.feedback_hub_enabled AS enabled, t.hub_install_id::text AS install_id
        FROM ${tables(schemas).orgs} o CROSS JOIN ${ident(schemas.app, 'telemetry')} t WHERE o.id = ${actor.orgId}`,
    );
    if (!row.rows[0]) throw notFound();
    return {
      enabled: row.rows[0].enabled,
      canChange: canChangeGithub(actor),
      url: hubUrl(ctx.config),
      preview: hubPayload(row.rows[0].install_id, '[…]', {
        path: '/',
        appVersion: 'custom',
        browser: '',
        platform: 'Linux',
        theme: '',
        language: '',
        errors: [],
      }),
    };
  }

  app.get('/api/admin/feedback/hub', admin, async (request): Promise<FeedbackHubSettings> => {
    const { pool, schemas } = dataStore(ctx);
    return hubSettings(pool, schemas, requireActor(request));
  });
  app.put('/api/admin/feedback/hub', integrations, async (request): Promise<FeedbackHubSettings> => {
    const actor = requireActor(request);
    const { enabled } = parse(z.strictObject({ enabled: z.boolean() }), request.body);
    if (enabled && !hubUrl(ctx.config)) throw new AppError('conflict', 'feedback.hub.off');
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      if (enabled) await refuseWhileInReview(db, schemas.app, actor.orgId, 'feedback', actor.orgId);
      await query(
        db,
        sql`UPDATE ${tables(schemas).orgs} SET feedback_hub_enabled = ${enabled} WHERE id = ${actor.orgId}`,
      );
      await audit(db, authDatabase(ctx).audit, 'org.feedback_hub.updated', actor, { enabled });
      return hubSettings(db, schemas, actor);
    });
  });

  async function hubReport(
    db: Queryable,
    schemas: DataSchemas,
    actor: Actor,
    feedbackId: string,
    lock = false,
  ) {
    const settings = await hubSettings(db, schemas, actor);
    if (!settings.enabled || !settings.url) throw new AppError('conflict', 'feedback.hub.off');
    const row = await loadFeedback(db, schemas, actor.orgId, feedbackId, { lock });
    if (!row) throw notFound();
    if (row.kind !== 'broken') throw new AppError('bad_request', 'feedback.hub.brokenOnly');
    await requirePolicy(db, `"${schemas.app}"`, actor, 'feedbackPublishing');
    return {
      row,
      url: settings.url,
      payload: hubPayload(settings.preview.installId, row.message, toItem(row).context),
    };
  }
  app.post(
    '/api/admin/feedback/:feedbackId/hub/preview',
    admin,
    async (request): Promise<FeedbackHubPreview> => {
      const { pool, schemas } = dataStore(ctx);
      const { feedbackId } = parse(FeedbackParams, request.params);
      const report = await hubReport(pool, schemas, requireActor(request), feedbackId);
      return { url: report.url, payload: report.payload };
    },
  );
  app.post('/api/admin/feedback/:feedbackId/hub', admin, async (request): Promise<FeedbackItem> => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    parse(z.strictObject({ softwareBug: z.literal(true) }), request.body);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      const report = await hubReport(db, schemas, actor, feedbackId, true);
      if (!report.row.upstream_issue_url) {
        const pending = report.row.upstream_pending_fingerprint;
        const issueUrl = pending
          ? await refreshHubReport(ctx.config, pending)
          : await sendHubReport(ctx.config, report.payload);
        if (!pending || issueUrl) {
          await recordHubResult(
            db,
            schemas,
            actor.orgId,
            feedbackId,
            pending ?? report.payload.fingerprint,
            issueUrl,
          );
          await audit(
            db,
            authDatabase(ctx).audit,
            issueUrl ? 'feedback.upstreamSent' : 'feedback.upstreamPending',
            actor,
            { feedbackId, issueUrl },
          );
        }
      }
      return item(db, schemas, actor.orgId, feedbackId);
    });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** A piece of the organization's feedback, reloaded, for answering with. */
  async function item(db: Queryable, schemas: DataSchemas, orgId: string, feedbackId: string) {
    const row = await loadFeedback(db, schemas, orgId, feedbackId);
    if (!row) throw notFound();
    return toItem(row);
  }

  app.post('/api/feedback', session, async (request): Promise<FeedbackCreated> => {
    const actor = requireActor(request);
    const input = parse(FeedbackCreate, request.body);
    const screenshot = input.screenshot ? screenshotOf(input.screenshot) : null;
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    const t = tables(schemas);
    const id = newId('feedback');
    await withTransaction(pool, async (db) => {
      // One send at a time per person decides the limit, so two at once can't both slip under it.
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:feedback:${actor.userId}`}, 0))`,
      );
      const recent = await query<{ count: string; oldest: Date | null }>(
        db,
        sql`SELECT count(*) AS count, min(created_at) AS oldest FROM ${t.feedback}
        WHERE user_id = ${actor.userId}
          AND created_at > statement_timestamp() - ${HOUR_MS} * interval '1 millisecond'`,
      );
      const { count, oldest } = recent.rows[0]!;
      if (Number(count) >= FEEDBACK_LIMITS.perHour) {
        const wait = oldest ? oldest.getTime() + HOUR_MS - Date.now() : HOUR_MS;
        throw new AppError('rate_limited', 'feedback.rateLimited', {
          params: { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) },
        });
      }
      await query(
        db,
        sql`INSERT INTO ${t.feedback} (id, org_id, user_id, kind, message, context, screenshot, screenshot_type)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${input.kind}, ${input.message},
          ${JSON.stringify(input.context)}::jsonb, ${screenshot?.bytes ?? null}, ${screenshot?.type ?? null})`,
      );
      await audit(db, auditSchema, 'feedback.sent', actor, {
        feedbackId: id,
        kind: input.kind,
        screenshotBytes: screenshot?.bytes.length ?? 0,
        errors: input.context.errors.length,
      });
    });
    return { id };
  });

  app.get('/api/feedback/mine', session, async (request): Promise<SentFeedbackList> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const result = await query<FeedbackRow>(
      pool,
      selectFeedback(
        schemas,
        sql`f.org_id = ${actor.orgId} AND f.user_id = ${actor.userId}`,
        sql`ORDER BY f.created_at DESC, f.id DESC LIMIT ${SENT_SHOWN}`,
      ),
    );
    return { items: result.rows.map(toSent) };
  });

  app.get('/api/admin/feedback', admin, async (request): Promise<FeedbackPage> => {
    const actor = requireActor(request);
    const input = parse(FeedbackListQuery, request.query);
    const cursor = input.before === undefined ? null : readCursor(input.before);
    const { pool, schemas } = dataStore(ctx);
    const conditions = [
      sql`f.org_id = ${actor.orgId}`,
      input.kind ? sql`f.kind = ${input.kind}` : sql`TRUE`,
      input.status ? sql`f.status = ${input.status}` : sql`TRUE`,
      cursor ? sql`(f.created_at, f.id) < (${cursor.at}::timestamptz, ${cursor.id})` : sql`TRUE`,
    ];
    const result = await query<FeedbackRow>(
      pool,
      selectFeedback(
        schemas,
        sql`${conditions[0]!} AND ${conditions[1]!} AND ${conditions[2]!} AND ${conditions[3]!}`,
        sql`ORDER BY f.created_at DESC, f.id DESC LIMIT ${FEEDBACK_LIMITS.page + 1}`,
      ),
    );
    const page = result.rows.slice(0, FEEDBACK_LIMITS.page);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      next: result.rows.length > FEEDBACK_LIMITS.page && last ? cursorOf(last) : null,
    };
  });

  app.get('/api/admin/feedback/count', admin, async (request): Promise<FeedbackCount> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return { new: await newCount(pool, schemas, actor.orgId) };
  });

  app.get('/api/admin/feedback/:feedbackId/screenshot', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const result = await query<{ screenshot: Buffer | null; screenshot_type: string | null }>(
      pool,
      sql`SELECT screenshot, screenshot_type FROM ${tables(schemas).feedback}
      WHERE id = ${feedbackId} AND org_id = ${actor.orgId}`,
    );
    const row = result.rows[0];
    if (!row?.screenshot || !row.screenshot_type) throw notFound();
    return reply
      .type(row.screenshot_type)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(row.screenshot);
  });

  app.put('/api/admin/feedback/:feedbackId/status', admin, async (request): Promise<FeedbackItem> => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    const { status } = parse(FeedbackStatusUpdate, request.body);
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const row = await loadFeedback(db, schemas, actor.orgId, feedbackId, { lock: true });
      if (!row) throw notFound();
      if (row.status !== status) {
        await query(
          db,
          sql`UPDATE ${tables(schemas).feedback} SET status = ${status}, updated_at = statement_timestamp()
          WHERE id = ${feedbackId}`,
        );
        await audit(db, auditSchema, 'feedback.statusChanged', actor, {
          feedbackId,
          kind: row.kind,
          status: { from: row.status, to: status },
        });
      }
      return item(db, schemas, actor.orgId, feedbackId);
    });
  });

  app.post('/api/admin/feedback/:feedbackId/replies', admin, async (request): Promise<FeedbackItem> => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    const { body } = parse(FeedbackReplyCreate, request.body);
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    const t = tables(schemas);
    return withTransaction(pool, async (db) => {
      const row = await loadFeedback(db, schemas, actor.orgId, feedbackId, { lock: true });
      if (!row) throw notFound();
      const replyId = newId('feedbackReply');
      await query(
        db,
        sql`INSERT INTO ${t.replies} (id, feedback_id, author_id, body)
        VALUES (${replyId}, ${feedbackId}, ${actor.userId}, ${body})`,
      );
      // Answering something new means someone has read it.
      const status = row.status === 'new' ? 'seen' : row.status;
      await query(
        db,
        sql`UPDATE ${t.feedback} SET status = ${status}, updated_at = statement_timestamp() WHERE id = ${feedbackId}`,
      );
      const notified = await notifyFeedbackReply(db, schemas, {
        orgId: actor.orgId,
        feedbackId,
        senderId: row.user_id,
        authorId: actor.userId,
        body,
      });
      await audit(db, auditSchema, 'feedback.replied', actor, { feedbackId, replyId, notified });
      if (status !== row.status)
        await audit(db, auditSchema, 'feedback.statusChanged', actor, {
          feedbackId,
          kind: row.kind,
          status: { from: row.status, to: status },
        });
      return item(db, schemas, actor.orgId, feedbackId);
    });
  });

  app.delete('/api/admin/feedback/:feedbackId', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    const t = tables(schemas);
    await withTransaction(pool, async (db) => {
      const row = await loadFeedback(db, schemas, actor.orgId, feedbackId, { lock: true });
      if (!row) throw notFound();
      // The sender's notifications quote the replies, so they go with it.
      await query(
        db,
        sql`DELETE FROM ${t.notifications}
        WHERE subject_id = ${feedbackId} AND kind = 'feedbackReply' AND org_id = ${actor.orgId}`,
      );
      await query(db, sql`DELETE FROM ${t.feedback} WHERE id = ${feedbackId}`);
      await audit(db, auditSchema, 'feedback.deleted', actor, {
        feedbackId,
        kind: row.kind,
        status: row.status,
      });
    });
    return reply.status(204).send();
  });

  function settingsView(
    row: { enabled: boolean; repository: string | null; token: string | null },
    actor: Actor,
  ): FeedbackGithubSettings {
    return {
      enabled: row.enabled,
      repository: row.repository,
      hasToken: Boolean(row.token),
      canChange: canChangeGithub(actor),
    };
  }

  app.get('/api/admin/feedback/github', admin, async (request): Promise<FeedbackGithubSettings> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const row = await githubSettings(pool, schemas, actor.orgId);
    if (!row) throw notFound();
    return settingsView(row, actor);
  });

  app.put('/api/admin/feedback/github', integrations, async (request): Promise<FeedbackGithubSettings> => {
    const actor = requireActor(request);
    const input = parse(FeedbackGithubUpdate, request.body);
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const before = await githubSettings(db, schemas, actor.orgId, { lock: true });
      if (!before) throw notFound();
      if (input.enabled && !before.enabled)
        await refuseWhileInReview(db, schemas.app, actor.orgId, 'feedback', actor.orgId);
      const token =
        input.token === undefined
          ? before.token
          : input.token === null
            ? null
            : await sealCredential(
                ctx.config.secretKey,
                input.token,
                TOKEN_CONTEXT(actor.orgId),
                actor.orgId,
                db,
              );
      if (input.enabled && (!input.repository || !token)) {
        const fields: Record<string, string> = {};
        if (!input.repository) fields.repository = 'feedback.github.repositoryRequired';
        if (!token) fields.token = 'feedback.github.tokenRequired';
        throw new AppError('validation_failed', 'feedback.github.incomplete', { fields });
      }
      await query(
        db,
        sql`UPDATE ${tables(schemas).orgs} SET feedback_github_enabled = ${input.enabled},
          feedback_github_repository = ${input.repository}, feedback_github_token = ${token}
        WHERE id = ${actor.orgId}`,
      );
      const tokenChange = input.token === undefined ? 'kept' : input.token === null ? 'removed' : 'replaced';
      if (
        before.enabled !== input.enabled ||
        before.repository !== input.repository ||
        tokenChange !== 'kept'
      )
        await audit(db, auditSchema, 'org.feedback_github.updated', actor, {
          enabled: { from: before.enabled, to: input.enabled },
          repository: { from: before.repository, to: input.repository },
          token: tokenChange,
        });
      return settingsView({ enabled: input.enabled, repository: input.repository, token }, actor);
    });
  });

  /**
   * The broken thing an admin wants to report, and where it would go.  Only something broken is
   * a bug report, and only while the organization has GitHub turned on.
   */
  async function reportable(
    actor: Actor,
    feedbackId: string,
    includeScreenshot: boolean,
  ): Promise<{ row: FeedbackRow; target: GithubTarget }> {
    const { pool, schemas } = dataStore(ctx);
    const row = await loadFeedback(pool, schemas, actor.orgId, feedbackId);
    if (!row) throw notFound();
    if (row.kind !== 'broken') throw new AppError('bad_request', 'feedback.github.brokenOnly');
    if (includeScreenshot && row.screenshot_bytes === null)
      throw new AppError('bad_request', 'feedback.github.noScreenshot');
    const settings = await githubSettings(pool, schemas, actor.orgId);
    if (!settings?.enabled || !settings.repository || !settings.token)
      throw new AppError('conflict', 'feedback.github.off');
    await requirePolicy(pool, `"${schemas.app}"`, actor, 'feedbackPublishing');
    let token: string;
    try {
      token = await unsealCredential(
        ctx.config.secretKey,
        settings.token,
        TOKEN_CONTEXT(actor.orgId),
        actor.orgId,
        pool,
      );
    } catch {
      throw new AppError('conflict', 'feedback.github.tokenUnreadable');
    }
    return { row, target: { repository: settings.repository, token } };
  }

  app.post(
    '/api/admin/feedback/:feedbackId/github/preview',
    admin,
    async (request): Promise<FeedbackIssuePreview> => {
      const actor = requireActor(request);
      const { feedbackId } = parse(FeedbackParams, request.params);
      const { includeScreenshot } = parse(FeedbackIssueRequest, request.body ?? {});
      const { row, target } = await reportable(actor, feedbackId, includeScreenshot);
      const feedback = toItem(row);
      const title = issueTitle(feedback.message);
      const open = await github.openIssues(target);
      return {
        repository: target.repository,
        title,
        body: issueBody(feedback, includeScreenshot ? SCREENSHOT_LINK_PLACEHOLDER : null),
        screenshot:
          includeScreenshot && feedback.screenshot
            ? {
                path: screenshotPath(feedback.id, feedback.screenshot.type),
                bytes: feedback.screenshot.bytes,
              }
            : null,
        similar: similarIssues(title, open),
      };
    },
  );

  app.post('/api/admin/feedback/:feedbackId/github', admin, async (request): Promise<FeedbackItem> => {
    const actor = requireActor(request);
    const { feedbackId } = parse(FeedbackParams, request.params);
    const input = parse(FeedbackIssueSend, request.body);
    const { row, target } = await reportable(actor, feedbackId, input.includeScreenshot);
    const { pool, schemas } = dataStore(ctx);
    const { audit: auditSchema } = authDatabase(ctx);
    const feedback = toItem(row);
    let screenshotUrl: string | null = null;
    if (input.includeScreenshot && feedback.screenshot) {
      const stored = await query<{ screenshot: Buffer }>(
        pool,
        sql`SELECT screenshot FROM ${tables(schemas).feedback} WHERE id = ${feedbackId}`,
      );
      const bytes = stored.rows[0]?.screenshot;
      if (!bytes) throw new AppError('bad_request', 'feedback.github.noScreenshot');
      screenshotUrl = await github.addScreenshot(
        target,
        screenshotPath(feedback.id, feedback.screenshot.type),
        bytes,
        feedback.id,
      );
    }
    const body = issueBody(feedback, screenshotUrl);
    const issue =
      input.mode === 'create'
        ? await github.createIssue(target, issueTitle(feedback.message), body)
        : {
            number: input.issueNumber,
            url: (await github.comment(target, input.issueNumber, body)).url,
          };
    const answered = await withTransaction(pool, async (db) => {
      const updated = await query(
        db,
        sql`UPDATE ${tables(schemas).feedback}
        SET issue_number = ${issue.number}, issue_url = ${issue.url}, updated_at = statement_timestamp()
        WHERE id = ${feedbackId} AND org_id = ${actor.orgId}`,
      );
      await audit(
        db,
        auditSchema,
        input.mode === 'create' ? 'feedback.issueCreated' : 'feedback.issueCommented',
        actor,
        {
          feedbackId,
          repository: target.repository,
          issueNumber: issue.number,
          screenshot: screenshotUrl !== null,
        },
      );
      return updated.rowCount ? item(db, schemas, actor.orgId, feedbackId) : null;
    });
    // Deleted while GitHub was answering: what was sent stays sent, and the audit log says so.
    if (!answered) throw notFound();
    return answered;
  });
}

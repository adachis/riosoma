import {
  FeedbackContext,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackReply,
  type FeedbackStatus,
  type SentFeedback,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../data/context.js';

/**
 * Reads feedback for the inbox and for its sender.  Screenshots stay in the database until an
 * admin opens one, so a page of the inbox never carries their bytes.
 */

export interface FeedbackRow {
  id: string;
  org_id: string;
  user_id: string;
  sender_name: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  context: unknown;
  screenshot_bytes: number | null;
  screenshot_type: string | null;
  issue_number: number | null;
  issue_url: string | null;
  upstream_issue_url: string | null;
  upstream_sent_at: Date | null;
  upstream_pending_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
  replies: unknown;
}

export function tables(schemas: DataSchemas) {
  return {
    feedback: ident(schemas.app, 'feedback'),
    replies: ident(schemas.app, 'feedback_replies'),
    users: ident(schemas.app, 'users'),
    orgs: ident(schemas.app, 'orgs'),
    notifications: ident(schemas.app, 'notifications'),
  };
}

/** Every column the inbox shows, with the replies oldest first, for rows matching `where`. */
export function selectFeedback(schemas: DataSchemas, where: Sql, tail: Sql = sql``): Sql {
  const t = tables(schemas);
  return sql`SELECT f.id, f.org_id, f.user_id, u.name AS sender_name, f.kind, f.status, f.message, f.context,
      octet_length(f.screenshot) AS screenshot_bytes, f.screenshot_type, f.issue_number, f.issue_url,
      f.created_at, f.updated_at, f.upstream_issue_url, f.upstream_sent_at, f.upstream_pending_fingerprint,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', r.id, 'body', r.body, 'authorId', r.author_id, 'authorName', a.name,
          'createdAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY r.created_at, r.id)
        FROM ${t.replies} r LEFT JOIN ${t.users} a ON a.id = r.author_id WHERE r.feedback_id = f.id
      ), '[]'::json) AS replies
    FROM ${t.feedback} f JOIN ${t.users} u ON u.id = f.user_id
    WHERE ${where} ${tail}`;
}

function repliesOf(value: unknown): FeedbackReply[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const reply = entry as Record<string, unknown>;
    if (typeof reply.id !== 'string' || typeof reply.body !== 'string' || typeof reply.createdAt !== 'string')
      return [];
    return [
      {
        id: reply.id,
        body: reply.body,
        author:
          typeof reply.authorId === 'string'
            ? { id: reply.authorId, name: typeof reply.authorName === 'string' ? reply.authorName : '' }
            : null,
        createdAt: reply.createdAt,
      },
    ];
  });
}

/** A context as it was checked when sent.  One that no longer fits the contract shows as blank. */
function contextOf(value: unknown): FeedbackContext {
  const parsed = FeedbackContext.safeParse(value);
  return parsed.success
    ? parsed.data
    : { path: '/', appVersion: '', browser: '', platform: '', theme: '', language: '', errors: [] };
}

export function toItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    context: contextOf(row.context),
    screenshot:
      row.screenshot_bytes !== null && row.screenshot_type
        ? { bytes: Number(row.screenshot_bytes), type: row.screenshot_type }
        : null,
    sender: { id: row.user_id, name: row.sender_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    replies: repliesOf(row.replies),
    issue:
      row.issue_number !== null && row.issue_url ? { number: row.issue_number, url: row.issue_url } : null,
    upstreamIssueUrl: row.upstream_issue_url,
    upstreamPending: row.upstream_pending_fingerprint !== null,
  };
}

/** Preserve the accepted fingerprint so a refresh never submits or counts the report again. */
export async function recordHubResult(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  feedbackId: string,
  fingerprint: string,
  issueUrl: string | null,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${tables(schemas).feedback} SET upstream_issue_url = ${issueUrl},
      upstream_sent_at = CASE WHEN ${issueUrl}::text IS NOT NULL THEN statement_timestamp() ELSE NULL END,
      upstream_pending_fingerprint = ${issueUrl ? null : fingerprint}, updated_at = statement_timestamp()
      WHERE id = ${feedbackId} AND org_id = ${orgId}`,
  );
}

export function toSent(row: FeedbackRow): SentFeedback {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    replies: repliesOf(row.replies),
  };
}

/** One piece of the organization's feedback, or null. */
export async function loadFeedback(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  feedbackId: string,
  options: { lock?: boolean } = {},
): Promise<FeedbackRow | null> {
  const result = await query<FeedbackRow>(
    db,
    selectFeedback(
      schemas,
      sql`f.id = ${feedbackId} AND f.org_id = ${orgId}`,
      options.lock ? sql`FOR UPDATE OF f` : sql``,
    ),
  );
  return result.rows[0] ?? null;
}

/** How many of the organization's pieces are new. */
export async function newCount(db: Queryable, schemas: DataSchemas, orgId: string): Promise<number> {
  const result = await query<{ count: string }>(
    db,
    sql`SELECT count(*) AS count FROM ${tables(schemas).feedback} WHERE org_id = ${orgId} AND status = 'new'`,
  );
  return Number(result.rows[0]!.count);
}

export interface GithubSettingsRow {
  enabled: boolean;
  repository: string | null;
  token: string | null;
}

export async function githubSettings(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  options: { lock?: boolean } = {},
): Promise<GithubSettingsRow | null> {
  const result = await query<GithubSettingsRow>(
    db,
    sql`SELECT feedback_github_enabled AS enabled, feedback_github_repository AS repository,
      feedback_github_token AS token
    FROM ${tables(schemas).orgs} WHERE id = ${orgId} ${options.lock ? sql`FOR UPDATE` : sql``}`,
  );
  return result.rows[0] ?? null;
}

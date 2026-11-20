import { AccessScope } from '../data/access.js';
import { policyAllows, policyRelevant, requirePolicy, type PolicyPerson } from '../org-units/policy.js';
import { newId, type CalendarFeed } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { randomToken, tokenHash } from '../auth/database.js';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from '../data/context.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';

/**
 * Calendar feeds as rows: making one, making a new address, turning one off, and the
 * organization's choice.  A feed's token is never stored, only its hash.
 */

export interface FeedRow {
  id: string;
  org_id: string;
  view_id: string | null;
  user_id: string;
  time_zone: string;
  created_at: Date;
  last_read_at: Date | null;
  stopped_at: Date | null;
}

export interface FeedTarget {
  databaseId: string;
  tableId: string;
  viewId: string;
}

const COLUMNS = sql`id, org_id, view_id, user_id, time_zone, created_at, last_read_at, stopped_at`;
/** A read counts toward "last read" only this long after the one before, so polls rarely write. */
const READ_EVERY = sql`interval '5 minutes'`;

const feeds = (schemas: DataSchemas) => ident(schemas.app, 'calendar_feeds');
const orgs = (schemas: DataSchemas) => ident(schemas.app, 'orgs');

/** The hash a token is looked up by. */
export function feedTokenHash(token: string): string {
  return tokenHash(token);
}

export function feedOf(row: FeedRow): CalendarFeed {
  return {
    viewId: row.view_id ?? '',
    createdAt: row.created_at.toISOString(),
    lastReadAt: row.last_read_at?.toISOString() ?? null,
  };
}

/**
 * The feed an address belongs to, live or not, with whether its organization allows feeds and
 * whether it has units or a unit policy that could turn them off for the feed's owner.
 */
export async function feedByToken(
  db: Queryable,
  schemas: DataSchemas,
  hash: string,
): Promise<(FeedRow & { org_allows: boolean; policy_relevant: boolean }) | undefined> {
  const result = await query<FeedRow & { org_allows: boolean; policy_relevant: boolean }>(
    db,
    sql`SELECT f.id, f.org_id, f.view_id, f.user_id, f.time_zone, f.created_at, f.last_read_at,
        f.stopped_at, o.calendar_feeds AS org_allows,
        ${policyRelevant(schemas.app, sql`f.org_id`)} AS policy_relevant
      FROM ${feeds(schemas)} f JOIN ${orgs(schemas)} o ON o.id = f.org_id
      WHERE f.token_hash = ${hash}`,
  );
  return result.rows[0];
}

/** A person's live feed for a view. */
export async function liveFeed(
  db: Queryable,
  schemas: DataSchemas,
  userId: string,
  viewId: string,
): Promise<FeedRow | undefined> {
  const result = await query<FeedRow>(
    db,
    sql`SELECT ${COLUMNS} FROM ${feeds(schemas)}
      WHERE view_id = ${viewId} AND user_id = ${userId} AND stopped_at IS NULL`,
  );
  return result.rows[0];
}

export async function feedsAllowed(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  person?: string | PolicyPerson,
): Promise<boolean> {
  // For a person, their unit's policy decides, which starts from the organization's switch.
  const who = typeof person === 'string' ? { orgId, userId: person } : person;
  if (who) return policyAllows(db, `"${schemas.app}"`, who, 'calendarFeeds', 'publicLinks');
  const result = await query<{ allowed: boolean }>(
    db,
    sql`SELECT calendar_feeds AS allowed FROM ${orgs(schemas)} WHERE id = ${orgId}`,
  );
  return result.rows[0]?.allowed ?? false;
}

/**
 * A new feed for the person and view, stopping the one they had.  The token comes back once, here,
 * and is never stored.  Two requests at once meet at the unique index, and the later one fails.
 */
export async function makeFeed(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: FeedTarget,
  timeZone: string,
): Promise<{ row: FeedRow; token: string }> {
  await requirePolicy(db, `"${schemas.app}"`, actor, 'publicLinks', 'calendarFeeds');
  await new AccessScope(db, schemas, actor).requireUse(target.databaseId, 'public', {
    tableId: target.tableId,
  });
  const stopped = await query<{ id: string }>(
    db,
    sql`UPDATE ${feeds(schemas)} SET stopped_at = statement_timestamp()
      WHERE view_id = ${target.viewId} AND user_id = ${actor.userId} AND stopped_at IS NULL
      RETURNING id`,
  );
  const token = randomToken();
  const created = await query<FeedRow>(
    db,
    sql`INSERT INTO ${feeds(schemas)} (id, org_id, view_id, user_id, token_hash, time_zone)
      VALUES (${newId('calendarFeed')}, ${actor.orgId}, ${target.viewId}, ${actor.userId}, ${feedTokenHash(token)},
        ${timeZone})
      RETURNING ${COLUMNS}`,
  );
  const row = created.rows[0]!;
  await audit(db, schemas, actor, 'data.calendarFeed.created', {
    ...target,
    feedId: row.id,
    ...(stopped.rows[0] ? { replaced: stopped.rows[0].id } : {}),
  });
  return { row, token };
}

/** Turns the person's feed for a view off.  Its address answers "gone" from then on. */
export async function stopFeed(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  viewId: string,
): Promise<void> {
  const stopped = await query<{ id: string }>(
    db,
    sql`UPDATE ${feeds(schemas)} SET stopped_at = statement_timestamp()
      WHERE view_id = ${viewId} AND user_id = ${actor.userId} AND stopped_at IS NULL
      RETURNING id`,
  );
  for (const row of stopped.rows)
    await audit(db, schemas, actor, 'data.calendarFeed.stopped', { viewId, feedId: row.id });
}

/** Notes that a calendar app read the feed, at most once every few minutes. */
export async function markRead(db: Queryable, schemas: DataSchemas, feedId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${feeds(schemas)} SET last_read_at = statement_timestamp()
      WHERE id = ${feedId} AND (last_read_at IS NULL OR last_read_at < statement_timestamp() - ${READ_EVERY})`,
  );
}

/**
 * Changes whether the organization allows feeds.  Turning them off stops every live feed for good,
 * so an address that got out never comes back when feeds are turned on again.
 */
export async function setFeedsAllowed(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  enabled: boolean,
): Promise<boolean | undefined> {
  const found = await query<{ allowed: boolean }>(
    db,
    sql`SELECT calendar_feeds AS allowed FROM ${orgs(schemas)} WHERE id = ${actor.orgId} FOR UPDATE`,
  );
  const before = found.rows[0]?.allowed;
  if (before === undefined || before === enabled) return before;
  if (enabled) await refuseWhileInReview(db, schemas.app, actor.orgId, 'calendarFeeds', actor.orgId);
  await query(db, sql`UPDATE ${orgs(schemas)} SET calendar_feeds = ${enabled} WHERE id = ${actor.orgId}`);
  const stopped = enabled
    ? { rowCount: 0 }
    : await query(
        db,
        sql`UPDATE ${feeds(schemas)} SET stopped_at = statement_timestamp()
          WHERE org_id = ${actor.orgId} AND stopped_at IS NULL`,
      );
  await audit(db, schemas, actor, 'org.calendar_feed_policy.updated', {
    enabled: { from: before, to: enabled },
    stopped: stopped.rowCount ?? 0,
  });
  return enabled;
}

async function audit(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${actor.orgId}, ${actor.userId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

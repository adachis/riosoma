import { AppError } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';

/** The imported things that settings elsewhere could also turn on */
export type ReviewedKind =
  'webhook' | 'automation' | 'calendarFeeds' | 'feedback' | 'oauthApp' | 'bookingPage';

/**
 * Refuses to turn on something an import brought in while it still waits in the owner's import
 * review.  Only that list turns it on, so what the list says stays true: nothing on it talks to
 * anyone until the owner acts.  Once the owner has turned it on there, it's ordinary again.
 */
export async function refuseWhileInReview(
  db: Queryable,
  schema: string,
  orgId: string,
  kind: ReviewedKind,
  targetId: string,
): Promise<void> {
  const waiting = await query(
    db,
    sql`SELECT 1 FROM ${ident(schema, 'organization_import_review')}
    WHERE org_id = ${orgId} AND kind = ${kind} AND target_id = ${targetId} AND done_at IS NULL LIMIT 1`,
  );
  if (waiting.rowCount) throw new AppError('conflict', 'organizationArchive.review.turnOnFromReview');
}

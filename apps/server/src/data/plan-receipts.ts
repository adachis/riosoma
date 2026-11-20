import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from './context.js';

/** Receipt state belongs to the saved action, including undo outside the conversation. */
export async function undonePlanIds(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  planIds: readonly string[],
): Promise<Set<string>> {
  if (!planIds.length) return new Set();
  const result = await query<{ id: string }>(
    db,
    sql`SELECT plans.id FROM ${ident(schemas.app, 'rio_plans')} plans
      LEFT JOIN ${ident(schemas.app, 'undo_groups')} groups
        ON groups.group_id = plans.group_id AND groups.database_id = plans.database_id
        AND groups.actor_id = plans.user_id
      WHERE plans.id = ANY(${planIds}::text[]) AND plans.org_id = ${actor.orgId}
        AND plans.user_id = ${actor.userId} AND plans.status = 'applied'
        AND (groups.state = 'undone' OR (plans.database_id IS NULL AND EXISTS (
          SELECT 1 FROM ${ident(schemas.audit, 'events')} event
          WHERE event.org_id = plans.org_id AND event.actor_id = plans.user_id
            AND event.action LIKE 'data.%' AND event.metadata->>'undoOf' = plans.group_id
        )))`,
  );
  return new Set(result.rows.map((row) => row.id));
}

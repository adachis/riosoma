import { AccessScope } from '../data/access.js';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  roleAllows,
  type RioConversation,
  type RioMessage,
  type RioUsage,
  type RioBlock,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import type { PlanRow } from './plans.js';
import { mentionsAny } from '../data/permissions/redact.js';
import { auditEvent } from '../auth/database.js';
import { recordAiUse } from './footprint.js';
import { undonePlanIds } from '../data/plan-receipts.js';
import { databaseCreation } from './create-database.js';

interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  context_usage: RioConversation['contextUsage'] | null;
}
const conversation = (row: ConversationRow): RioConversation => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  ...(row.context_usage ? { contextUsage: row.context_usage } : {}),
});
export async function ownConversation(ctx: AppContext, actor: Actor, id: string) {
  const { pool, schemas } = dataStore(ctx);
  const found = await query<ConversationRow>(
    pool,
    sql`SELECT * FROM ${ident(schemas.app, 'rio_conversations')} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  if (!found.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return conversation(found.rows[0]);
}
export async function listConversations(ctx: AppContext, actor: Actor) {
  const { pool, schemas } = dataStore(ctx);
  return (
    await query<ConversationRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'rio_conversations')} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} ORDER BY updated_at DESC, id`,
    )
  ).rows.map(conversation);
}
async function activate(db: Queryable, schemas: DataSchemas, actor: Actor, id: string) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'rio_active_conversations')}
    (org_id, user_id, session_id, conversation_id)
    VALUES (${actor.orgId}, ${actor.userId}, ${actor.sessionId}, ${id})
    ON CONFLICT (org_id, user_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
  );
}

export async function createConversation(ctx: AppContext, actor: Actor) {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SELECT id FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId} FOR UPDATE`);
    const created = (
      await query<ConversationRow>(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'rio_conversations')} (id, org_id, user_id)
        VALUES (${randomUUID()}, ${actor.orgId}, ${actor.userId}) RETURNING *`,
      )
    ).rows[0]!;
    await activate(db, schemas, actor, created.id);
    return conversation(created);
  });
}

export async function activeConversation(ctx: AppContext, actor: Actor) {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SELECT id FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId} FOR UPDATE`);
    const found = await query<ConversationRow>(
      db,
      sql`SELECT c.* FROM ${ident(schemas.app, 'rio_conversations')} c
      JOIN ${ident(schemas.app, 'rio_active_conversations')} a ON a.conversation_id = c.id
      WHERE a.org_id = ${actor.orgId} AND a.user_id = ${actor.userId}`,
    );
    if (found.rows[0]) return conversation(found.rows[0]);
    const created = (
      await query<ConversationRow>(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'rio_conversations')} (id, org_id, user_id)
        VALUES (${randomUUID()}, ${actor.orgId}, ${actor.userId}) RETURNING *`,
      )
    ).rows[0]!;
    await activate(db, schemas, actor, created.id);
    return conversation(created);
  });
}

export async function selectConversation(ctx: AppContext, actor: Actor, id: string) {
  await ownConversation(ctx, actor, id);
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    await query(db, sql`SELECT id FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId} FOR UPDATE`);
    await activate(db, schemas, actor, id);
  });
  return ownConversation(ctx, actor, id);
}

/** Summaries retain the same database and classification boundary as the history they replace. */
export async function summaryFor(ctx: AppContext, actor: Actor, id: string, databaseId: string | null) {
  const { pool, schemas } = dataStore(ctx);
  const found = await query<{ summary: string }>(
    pool,
    sql`SELECT summary
    FROM ${ident(schemas.app, 'rio_conversation_summaries')}
    WHERE conversation_id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}
      AND database_id = ${databaseId ?? ''}
      AND classification_revision = (SELECT classification_revision FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId})`,
  );
  return found.rows[0]?.summary;
}

export async function contextUsage(
  ctx: AppContext,
  actor: Actor,
  id: string,
  usage: NonNullable<RioConversation['contextUsage']>,
) {
  const { pool, schemas } = dataStore(ctx);
  await query(
    pool,
    sql`UPDATE ${ident(schemas.app, 'rio_conversations')} SET context_usage = ${JSON.stringify(usage)}::jsonb
    WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
}
export async function deleteConversation(ctx: AppContext, actor: Actor, id: string) {
  await ownConversation(ctx, actor, id);
  const { pool, schemas } = dataStore(ctx);
  await query(
    pool,
    sql`DELETE FROM ${ident(schemas.app, 'rio_conversations')} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
}
export async function messagesFor(
  ctx: AppContext,
  actor: Actor,
  id: string,
  databaseId?: string | null,
): Promise<RioMessage[]> {
  await ownConversation(ctx, actor, id);
  const { pool, schemas } = dataStore(ctx);
  const rows = await query<{
    id: string;
    role: RioMessage['role'];
    context_database_id: string | null;
    blocks: RioBlock[];
    usage: RioUsage | null;
    created_at: Date;
    summarized: boolean;
    compaction: boolean;
    screen_context: RioMessage['context'] | null;
  }>(
    pool,
    sql`SELECT m.*, EXISTS (SELECT 1 FROM ${ident(schemas.app, 'rio_conversation_summaries')} s
        WHERE s.conversation_id = m.conversation_id AND s.database_id = COALESCE(m.context_database_id, '')
        AND s.through_position >= m.position AND s.classification_revision = m.classification_revision
        AND s.classification_revision = (SELECT classification_revision FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId})) AS summarized
      FROM ${ident(schemas.app, 'rio_messages')} m WHERE conversation_id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}
      AND (${actor.dataUse !== 'provider'} OR classification_revision = (SELECT classification_revision FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId}))
      AND (${databaseId === undefined} OR context_database_id IS NOT DISTINCT FROM ${databaseId ?? null}::text) ORDER BY position`,
  );
  const plans = (
    await query<PlanRow & { copy_job_id: string | null }>(
      pool,
      sql`SELECT plans.*, copy.id AS copy_job_id FROM ${ident(schemas.app, 'rio_plans')} plans
        LEFT JOIN LATERAL (
          SELECT id FROM ${ident(schemas.app, 'table_copies')}
          WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}
          AND command_id IN (
            SELECT command->>'id' FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(plans.commands) = 'array' THEN plans.commands
              ELSE COALESCE(plans.commands->'commands', '[]'::jsonb) END
            ) command
          ) LIMIT 1
        ) copy ON plans.status = 'applied'
        WHERE plans.conversation_id = ${id} AND plans.org_id = ${actor.orgId} AND plans.user_id = ${actor.userId}`,
    )
  ).rows;
  const undone = await undonePlanIds(
    pool,
    schemas,
    actor,
    plans.map((plan) => plan.id),
  );
  const scope = new AccessScope(pool, schemas, actor);
  const accessible = new Set<string>();
  for (const databaseId of new Set(
    rows.rows.flatMap((row) => (row.context_database_id ? [row.context_database_id] : [])),
  ))
    if (await scope.databaseRole(databaseId)) accessible.add(databaseId);
  const reviewable = new Set<string>();
  for (const plan of plans) {
    if (!plan.database_id) continue;
    const role = await scope.databaseRole(plan.database_id);
    if (!role || !roleAllows(role, 'editSchema')) continue;
    await scope.prepare(plan.database_id);
    if (!mentionsAny(plan.commands, scope.hiddenFieldIds(plan.database_id))) reviewable.add(plan.id);
  }
  return rows.rows
    .filter((row) => !row.context_database_id || accessible.has(row.context_database_id))
    .map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.created_at.toISOString(),
      ...(row.usage ? { usage: row.usage } : {}),
      ...(row.summarized ? { summarized: true } : {}),
      ...(row.compaction ? { compaction: true } : {}),
      ...(row.screen_context ? { context: row.screen_context } : {}),
      blocks: row.blocks.map((block) => {
        if (block.kind !== 'plan' && block.kind !== 'receipt') return block;
        const plan = plans.find((p) => p.id === block.planId);
        // Approval replaces the plan in memory.  Reopening restores the receipt and its saved undo state.
        if (plan?.status === 'applied' && plan.group_id)
          return {
            kind: 'receipt' as const,
            planId: plan.id,
            databaseId: plan.database_id,
            groupId: plan.group_id,
            summary: plan.summary,
            ...(plan.copy_job_id ? { jobId: plan.copy_job_id } : {}),
            ...(databaseCreation(plan.commands) ? { createdDatabase: true } : {}),
            ...(undone.has(plan.id) ? { undone: true } : {}),
          };
        if (block.kind === 'receipt') return block;
        return plan
          ? {
              ...block,
              details:
                reviewable.has(plan.id) &&
                plan.database_id &&
                !mentionsAny(block.details, scope.hiddenFieldIds(plan.database_id))
                  ? block.details
                  : undefined,
              status: plan.status,
              ...(plan.status === 'failed'
                ? { messageKey: 'rio.plan.stale' }
                : plan.status === 'pending' && plan.expires_at.getTime() <= Date.now()
                  ? { messageKey: 'rio.plan.expired' }
                  : {}),
            }
          : { ...block, details: undefined };
      }),
    }));
}
export async function saveMessage(
  ctx: AppContext,
  actor: Actor,
  conversationId: string,
  message: RioMessage,
  title?: string,
  databaseId?: string,
  policyRevision?: string,
  summary?: { text: string; throughMessageId: string | null },
) {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    // A deleted conversation must not erase the cost of a reply already in flight.
    const parent = await query(
      db,
      sql`SELECT id FROM ${ident(schemas.app, 'rio_conversations')} WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} FOR KEY SHARE`,
    );
    if (parent.rowCount)
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'rio_messages')} (id, conversation_id, org_id, user_id, role, blocks, usage, created_at, context_database_id, classification_revision, compaction, screen_context)
      VALUES (${message.id}, ${conversationId}, ${actor.orgId}, ${actor.userId}, ${message.role}, ${JSON.stringify(message.blocks)}::jsonb, ${message.usage ? JSON.stringify(message.usage) : null}::jsonb, ${message.createdAt}, ${databaseId ?? null}, COALESCE(${policyRevision ?? null}::bigint, (SELECT classification_revision FROM ${ident(schemas.app, 'orgs')} WHERE id = ${actor.orgId})), ${message.compaction ?? false}, ${message.context ? JSON.stringify(message.context) : null}::jsonb)`,
      );
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'rio_conversations')} SET updated_at = clock_timestamp(), title = CASE WHEN title = '' THEN ${title?.trim().slice(0, 60) ?? ''} ELSE title END WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    if (summary && parent.rowCount) {
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'rio_conversation_summaries')}
        (conversation_id, org_id, user_id, database_id, classification_revision, through_position, summary)
        VALUES (${conversationId}, ${actor.orgId}, ${actor.userId}, ${databaseId ?? ''}, ${policyRevision}::bigint,
          COALESCE((SELECT position FROM ${ident(schemas.app, 'rio_messages')} WHERE id = ${summary.throughMessageId} AND conversation_id = ${conversationId}), 0), ${summary.text})
        ON CONFLICT (conversation_id, database_id) DO UPDATE SET summary = EXCLUDED.summary,
          through_position = EXCLUDED.through_position, classification_revision = EXCLUDED.classification_revision`,
      );
      await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, 'rio.compact', actor, {
        conversationId,
        databaseId,
      });
    }
    await recordSpend(db, schemas, actor.orgId, message.usage?.costUsd);
    if (message.usage)
      await recordAiUse(db, schemas, {
        orgId: actor.orgId,
        userId: actor.userId,
        feature: 'rio',
        usage: message.usage,
      });
  });
}

/** Adds what a reply cost to the organization's spend this month, when the price is known. */
export async function recordSpend(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  cost: number | null | undefined,
): Promise<void> {
  if (cost === null || cost === undefined) return;
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'ai_spend')} AS spend (org_id, month, cost_usd)
    VALUES (${orgId}, date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, ${cost})
    ON CONFLICT (org_id, month) DO UPDATE SET cost_usd = spend.cost_usd + EXCLUDED.cost_usd`,
  );
}

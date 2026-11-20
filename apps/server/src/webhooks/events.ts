import type { ChangeBody, ChangeKind, WebhookEvent, WebhookEventType } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import type { CommandContext } from '../data/commands/context.js';
import { routineOwn } from '../http/policy.js';

/**
 * What a change means to webhooks.  `recordChange` calls `queueWebhookEvents` for every change
 * inside its command's transaction, so events wait to be sent exactly when the change commits,
 * and vanish with it when it rolls back.
 */

type Draft = Pick<WebhookEvent, 'event' | 'tableId' | 'recordId' | 'fieldIds'>;

/** The change kinds webhooks hear about.  Anything else is skipped before any query. */
const HEARD = new Set<ChangeKind>([
  'record.created',
  'record.restored',
  'record.updated',
  'record.linksChanged',
  'record.trashed',
  'field.created',
  'field.updated',
  'field.converted',
  'field.trashed',
  'field.restored',
  'field.primarySet',
  'table.created',
  'table.updated',
  'table.synced',
  'table.trashed',
  'table.restored',
]);

const filled = (value: unknown) =>
  !(
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );

function record(event: WebhookEventType, tableId: string, recordId: string, fieldIds: string[]): Draft {
  return { event, tableId, recordId, fieldIds: [...fieldIds].sort() };
}

function schema(event: WebhookEventType, tableId: string, fieldIds: string[] = []): Draft {
  return { event, tableId, recordId: null, fieldIds };
}

/**
 * One event per record for record changes, and one for a field or a table.  A restored record
 * counts as created, and a link edit that changes the records on its other side counts as an update
 * to each of them.  A sync changes records in bulk without naming them, so it's a table change.
 */
export function webhookEvents(body: ChangeBody): Draft[] {
  switch (body.kind) {
    case 'record.created':
    case 'record.restored':
      return body.records.map((row) =>
        record(
          'record.created',
          body.tableId,
          row.id,
          Object.keys(row.values).filter((id) => filled(row.values[id])),
        ),
      );
    case 'record.updated':
      return body.records.map((row) =>
        record('record.updated', body.tableId, row.id, Object.keys(row.values)),
      );
    case 'record.linksChanged':
      return body.records.map((row) => record('record.updated', body.tableId, row.id, [body.fieldId]));
    case 'record.trashed':
      return body.recordIds.map((id) => record('record.deleted', body.tableId, id, []));
    case 'field.created':
    case 'field.updated':
    case 'field.converted':
    case 'field.restored':
      return [schema('field.changed', body.field.tableId, [body.field.id])];
    case 'field.trashed':
      return [schema('field.changed', body.tableId, [body.fieldId])];
    case 'field.primarySet':
      return [schema('table.changed', body.table.id, [body.table.primaryFieldId])];
    case 'table.created':
      return [
        schema('table.changed', body.table.id),
        ...body.records.map((row) =>
          record(
            'record.created',
            body.table.id,
            row.id,
            Object.keys(row.values).filter((id) => filled(row.values[id])),
          ),
        ),
      ];
    case 'table.updated':
    case 'table.synced':
    case 'table.restored':
      return [schema('table.changed', body.table.id)];
    case 'table.trashed':
      return [schema('table.changed', body.tableId)];
    default:
      return [];
  }
}

/**
 * The record fields each command has reported so far.  A link edit also lists the edited records'
 * own links as changed, which would report the same field of the same record twice.
 */
const reported = new WeakMap<CommandContext, Set<string>>();

function unreported(c: CommandContext, body: ChangeBody, drafts: Draft[]): Draft[] {
  let seen = reported.get(c);
  if (!seen) {
    seen = new Set();
    reported.set(c, seen);
  }
  const known = seen;
  return drafts.filter((draft) => {
    if (!draft.recordId) return true;
    const keys = draft.fieldIds.map((fieldId) => `${draft.recordId}:${fieldId}`);
    if (body.kind === 'record.linksChanged' && keys.every((key) => known.has(key))) return false;
    for (const key of keys) known.add(key);
    return true;
  });
}

/** Queues this change's events for each webhook that's on and listening.  Called by `recordChange`. */
export async function queueWebhookEvents(c: CommandContext, body: ChangeBody, seq: number): Promise<void> {
  if (!HEARD.has(body.kind)) return;
  // A routine run's own change goes out to no webhook, so none can carry what the model wrote to
  // an address outside.  A plan its owner approved goes out as their own change would.
  if (routineOwn(c.actor)) return;
  const listening = await query<{
    id: string;
    events: WebhookEventType[];
    table_ids: string[] | null;
    created_by: string | null;
  }>(
    c.db,
    sql`SELECT id, events, table_ids, created_by FROM ${ident(c.schemas.app, 'webhooks')}
    WHERE database_id = ${c.databaseId} AND enabled ORDER BY id`,
  );
  if (!listening.rowCount) return;
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  await scope.prepare(c.databaseId);
  if (!scope.allowsUse(c.databaseId, 'external') || !scope.allowsUse(c.databaseId, 'export')) return;
  const drafts = unreported(c, body, webhookEvents(body));
  const at = new Date();
  const webhookIds: string[] = [];
  const types: string[] = [];
  const events: string[] = [];
  // In a database with field or record rules, or one linked to another database, each webhook
  // hears only what the person who made it could see: no field they can't see, and no record a
  // rule keeps from them.
  const rules = (await scope.hasRules(c.databaseId)) || scope.readsOtherDatabases(c.databaseId);
  for (const webhook of listening.rows) {
    const heard = rules ? await creatorView(c, webhook.created_by, drafts) : drafts;
    for (const draft of heard) {
      if (!webhook.events.includes(draft.event)) continue;
      if (webhook.table_ids && !webhook.table_ids.includes(draft.tableId)) continue;
      const event: WebhookEvent = {
        event: draft.event,
        databaseId: c.databaseId,
        tableId: draft.tableId,
        recordId: draft.recordId,
        fieldIds: draft.fieldIds,
        seq,
        at: at.toISOString(),
      };
      webhookIds.push(webhook.id);
      types.push(draft.event);
      events.push(JSON.stringify(event));
    }
  }
  if (!events.length) return;
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'webhook_events')} (webhook_id, event, event_type, queued_at)
    SELECT e.webhook_id, e.event, e.event_type, ${at}
    FROM unnest(${webhookIds}::text[], ${events}::text[], ${types}::text[])
      WITH ORDINALITY AS e(webhook_id, event, event_type, position)
    ORDER BY e.position`,
  );
}

/** The events as a webhook's maker could see them, or none when they no longer can. */
async function creatorView(c: CommandContext, creatorId: string | null, drafts: Draft[]): Promise<Draft[]> {
  const creator = creatorId ? await actorFor(c.db, c.schemas, creatorId, c.actor.orgId) : null;
  if (!creator) return [];
  const scope = new AccessScope(c.db, c.schemas, creator);
  if (!(await scope.databaseRole(c.databaseId))) return [];
  await scope.prepare(c.databaseId);
  const hidden = scope.hiddenFieldIds(c.databaseId);
  const out: Draft[] = [];
  const visibleRecords = new Map<string, Set<string>>();
  for (const draft of drafts) {
    const fieldIds = draft.fieldIds.filter((id) => !hidden.has(id));
    if (!draft.recordId) {
      if (draft.fieldIds.length && !fieldIds.length) continue;
      out.push({ ...draft, fieldIds });
      continue;
    }
    await scope.ensureTable(draft.tableId);
    if (scope.limitsRecords(draft.tableId)) {
      let seen = visibleRecords.get(draft.tableId);
      if (!seen) {
        const ids = drafts
          .filter((item) => item.tableId === draft.tableId && item.recordId)
          .map((item) => item.recordId!);
        const result = await query<{ __id: string }>(
          c.db,
          sql`SELECT __id FROM ${ident(c.schemas.data, draft.tableId)} WHERE __id = ANY(${ids}::text[])
            AND (${scope.recordPredicate(draft.tableId)})`,
        );
        seen = new Set(result.rows.map((row) => row.__id));
        visibleRecords.set(draft.tableId, seen);
      }
      if (!seen.has(draft.recordId)) continue;
    }
    if (draft.event === 'record.updated' && draft.fieldIds.length && !fieldIds.length) continue;
    out.push({ ...draft, fieldIds });
  }
  return out;
}

import {
  AutomationConfig,
  newId,
  type AutomationTrigger,
  type ChangeBody,
  type FilterGroup,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext, Mutation } from '../data/commands/context.js';
import { loadFields, loadView } from '../data/metadata.js';
import { matchingIds } from '../data/physical/order.js';
import type { StoredField } from '../data/types.js';
import { routineOwn } from '../http/policy.js';

/**
 * Record triggers.  Every committed record change passes through `queueTriggeredRuns` inside its
 * command's transaction, so runs are queued exactly when the change commits.  Watching records
 * start to match needs to know what matched before the change, which `matchedBefore` reads just
 * before a command changes records.
 */

/**
 * A chain of automations, and AI field runs among them, each set off by the one before stops after
 * this many.
 */
export const MAX_DEPTH = 5;

type RecordMatches = Extract<AutomationTrigger, { kind: 'recordMatches' }>;

interface Watching {
  id: string;
  config: AutomationConfig;
}

/** Automations that are on and watch this table's records, or submissions to this form. */
async function watching(c: CommandContext, tableId: string, formViewId?: string): Promise<Watching[]> {
  const result = await query<{ id: string; config: unknown }>(
    c.db,
    sql`SELECT id, config FROM ${ident(c.schemas.app, 'automations')}
    WHERE database_id = ${c.databaseId} AND enabled AND trashed_at IS NULL
      AND (config -> 'trigger' ->> 'tableId' = ${tableId}
        OR (config -> 'trigger' ->> 'kind' = 'formSubmitted' AND config -> 'trigger' ->> 'viewId' = ${formViewId ?? null}::text))
    ORDER BY position, id`,
  );
  return result.rows.map((row) => ({ id: row.id, config: AutomationConfig.parse(row.config) }));
}

class Fields {
  private readonly tables = new Map<string, Promise<StoredField[]>>();
  constructor(private readonly c: CommandContext) {}
  of(tableId: string): Promise<StoredField[]> {
    let fields = this.tables.get(tableId);
    if (!fields) {
      fields = loadFields(this.c.db, this.c.schemas, [tableId]);
      this.tables.set(tableId, fields);
    }
    return fields;
  }
}

/** Which of these records match the view's filter and the trigger's own, as the table is now. */
async function matching(
  c: CommandContext,
  fields: Fields,
  trigger: RecordMatches,
  recordIds: readonly string[],
): Promise<Set<string>> {
  if (!recordIds.length) return new Set();
  const conditions: FilterGroup['conditions'] = [];
  if (trigger.viewId) {
    const view = await loadView(c.db, c.schemas, trigger.viewId);
    // With its view gone, nothing can start to match.
    if (!view || view.trashed || view.view.tableId !== trigger.tableId) return new Set();
    if (view.view.config.filter) conditions.push(view.view.config.filter);
  }
  if (trigger.filter) conditions.push(trigger.filter);
  const byId = new Map((await fields.of(trigger.tableId)).map((field) => [field.id, field]));
  return matchingIds(
    c.db,
    c.schemas,
    trigger.tableId,
    byId,
    { conjunction: 'and', conditions },
    sql`TRUE`,
    recordIds,
    { timeZone: 'UTC', now: new Date(), natural: false },
  );
}

/**
 * Before records change: for each automation watching them start to match, which already do.
 * Undefined when no automation is watching, which keeps ordinary edits to one query.
 */
export async function matchedBefore(
  c: CommandContext,
  tableId: string,
  recordIds: readonly string[],
): Promise<Map<string, Set<string>> | undefined> {
  const automations = (await watching(c, tableId)).filter(
    (automation) => automation.config.trigger.kind === 'recordMatches',
  );
  if (!automations.length) return undefined;
  const fields = new Fields(c);
  const result = new Map<string, Set<string>>();
  for (const automation of automations)
    result.set(
      automation.id,
      await matching(c, fields, automation.config.trigger as RecordMatches, recordIds),
    );
  return result;
}

/** The fields each changed record changed. */
function changedFields(body: ChangeBody): Map<string, Set<string>> {
  const changed = new Map<string, Set<string>>();
  if (body.kind === 'record.created' || body.kind === 'record.updated')
    for (const record of body.records) changed.set(record.id, new Set(Object.keys(record.values)));
  if (body.kind === 'record.linksChanged')
    for (const record of body.records) changed.set(record.id, new Set([body.fieldId]));
  return changed;
}

/** A watched computed field changes when what it's computed from does. */
function watchedWithSources(fields: readonly StoredField[], watched: readonly string[]): Set<string> {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id)) return;
    result.add(id);
    const field = byId.get(id);
    if (field?.type === 'formula') for (const source of field.formula?.fields ?? []) visit(source.id);
    if (field?.type === 'lookup' || field?.type === 'rollup' || field?.type === 'count')
      visit(field.options.linkFieldId);
  };
  for (const id of watched) visit(id);
  return result;
}

/** Queues a run for each record change an automation is watching.  Called by `recordChange`. */
export async function queueTriggeredRuns(c: CommandContext, mutation: Mutation): Promise<void> {
  const body = mutation.body;
  if (body.kind !== 'record.created' && body.kind !== 'record.updated' && body.kind !== 'record.linksChanged')
    return;
  const origin = c.actor.automation;
  if (origin?.testStep) return;
  // What a routine's run changes on its own, with nobody watching, sets off no automation, so none
  // can carry what the model wrote somewhere it couldn't send it itself.  A plan its owner approved
  // sets them off as the owner's own change would.
  if (routineOwn(c.actor)) return;
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'automation_runs')}
    SET wake_at = clock_timestamp() WHERE database_id = ${c.databaseId}
    AND wait_table_id = ${body.tableId} AND record_id = ANY(${body.records.map((record) => record.id)}::text[])
    AND state = 'waiting'`,
  );
  // An AI field's run counts toward the depth too, so an automation and an AI field that set each
  // other off stop at the same limit.
  const depth = (origin?.depth ?? c.actor.aiField?.depth ?? 0) + 1;
  if (depth > MAX_DEPTH) return;
  const formViewId = body.kind === 'record.created' ? mutation.triggers?.formViewId : undefined;
  // An automation's own changes never set it off again.
  const automations = (await watching(c, body.tableId, formViewId)).filter(
    (automation) => automation.id !== origin?.id,
  );
  if (!automations.length) return;
  const changed = changedFields(body);
  const recordIds = [...changed.keys()];
  const fields = new Fields(c);
  const runs: Array<{ automationId: string; kind: AutomationTrigger['kind']; recordId: string }> = [];
  const queue = (automation: Watching, ids: Iterable<string>) => {
    for (const recordId of ids)
      runs.push({ automationId: automation.id, kind: automation.config.trigger.kind, recordId });
  };
  for (const automation of automations) {
    const trigger = automation.config.trigger;
    switch (trigger.kind) {
      case 'recordCreated':
        if (body.kind === 'record.created' && trigger.tableId === body.tableId) queue(automation, recordIds);
        break;
      case 'recordUpdated': {
        if (body.kind === 'record.created' || trigger.tableId !== body.tableId) break;
        const watched = trigger.fieldIds.length
          ? watchedWithSources(await fields.of(trigger.tableId), trigger.fieldIds)
          : null;
        queue(
          automation,
          recordIds.filter((id) => !watched || [...changed.get(id)!].some((fieldId) => watched.has(fieldId))),
        );
        break;
      }
      case 'recordMatches': {
        if (body.kind === 'record.linksChanged' || trigger.tableId !== body.tableId) break;
        // A new record matched nothing before.  Without a reading from before the change, a
        // record may already have matched, so it doesn't count as starting to.
        const before =
          body.kind === 'record.created'
            ? new Set<string>()
            : mutation.triggers?.matchedBefore?.get(automation.id);
        if (!before) break;
        const now = await matching(c, fields, trigger, recordIds);
        queue(
          automation,
          recordIds.filter((id) => now.has(id) && !before.has(id)),
        );
        break;
      }
      case 'formSubmitted':
        if (body.kind === 'record.created' && formViewId === trigger.viewId) queue(automation, recordIds);
        break;
      case 'schedule':
      case 'webhook':
        break;
    }
  }
  if (!runs.length) return;
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'automation_runs')}
    (id, automation_id, org_id, database_id, state, trigger_kind, record_id, depth)
    SELECT r.id, r.automation_id, ${c.actor.orgId}, ${c.databaseId}, 'queued', r.kind, r.record_id, ${depth}
    FROM unnest(${runs.map(() => newId('job'))}::text[], ${runs.map((run) => run.automationId)}::text[],
      ${runs.map((run) => run.kind)}::text[], ${runs.map((run) => run.recordId)}::text[])
      WITH ORDINALITY AS r(id, automation_id, kind, record_id, position)
    ORDER BY r.position`,
  );
}

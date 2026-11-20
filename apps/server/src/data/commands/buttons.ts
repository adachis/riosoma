import { AppError, checkCondition, isGroup, newId, type FilterGroup, type Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { loadAutomation } from '../../automations/store.js';
import { triggerTable } from '../../automations/routes.js';
import { loadFields, loadView } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import { requireRecord } from '../comments.js';
import { field, invalid, missing, scopeOf, type CommandContext, type Mutation } from './context.js';

/** Manual automation runs are queued once by the bus and undo by canceling the queued run. */
export async function runButton(
  c: CommandContext,
  command: Extract<Command, { kind: 'button.run' }>,
): Promise<Mutation> {
  const button = await field(c, command.fieldId);
  const scope = await scopeOf(c, button.tableId);
  await scope.require(c.databaseId, 'editSchema');
  if (!scope.visibleFields(button.tableId, [button]).length) return missing();
  await requireRecord(c.db, c.schemas, scope, button.tableId, command.recordId, true);
  if (button.type !== 'button' || button.options.action.kind !== 'runAutomation')
    return invalid('data.value.button');
  const automation = await loadAutomation(c.db, c.schemas, button.options.action.automationId);
  if (!automation || automation.trashed || automation.databaseId !== c.databaseId || !automation.enabled)
    return missing();
  const source = await triggerTable(c.db, c.schemas, automation);
  if (source.record && source.table?.id !== button.tableId) return invalid('errors.validationFailed');
  if (automation.runAsId !== c.actor.userId && (await scope.databaseRole(c.databaseId)) !== 'owner')
    throw new AppError('forbidden', 'data.access.denied');
  const trigger = automation.config.trigger;
  if (trigger.kind === 'recordMatches' || trigger.kind === 'formSubmitted') {
    if (!button.options.action.allowConditionalTriggers) return invalid('errors.validationFailed');
    if (trigger.kind === 'recordMatches') {
      const filters: FilterGroup['conditions'] = [];
      if (trigger.viewId) {
        const view = await loadView(c.db, c.schemas, trigger.viewId);
        if (!view || view.trashed || view.view.tableId !== button.tableId) return missing();
        if (view.view.config.filter) filters.push(view.view.config.filter);
      }
      if (trigger.filter) filters.push(trigger.filter);
      const fields = new Map(
        (await loadFields(c.db, c.schemas, [button.tableId])).map((field) => [field.id, field]),
      );
      const usable = (filter: FilterGroup): boolean =>
        filter.conditions.every((condition) =>
          isGroup(condition)
            ? usable(condition)
            : checkCondition(fields.get(condition.fieldId), condition).usable,
        );
      const filter: FilterGroup = { conjunction: 'and', conditions: filters };
      if (!usable(filter)) return invalid('errors.validationFailed');
      const matched = await query(
        c.db,
        sql`SELECT __id FROM ${ident(c.schemas.data, button.tableId)}
        WHERE __id = ${command.recordId} AND __deleted_at IS NULL AND NOT __source_gone
        AND (${scope.recordPredicate(button.tableId)})
        AND ${compileFilter(filter, fields, { now: new Date(), timeZone: 'UTC', natural: false }, c.schemas.app)}`,
      );
      if (!matched.rows.length) return invalid('errors.validationFailed');
    } else {
      // A form button may replay a recorded submission, never invent one for an unrelated row.
      const submitted = await query(
        c.db,
        sql`SELECT id FROM ${ident(c.schemas.app, 'automation_runs')}
        WHERE automation_id = ${automation.id} AND record_id = ${command.recordId}
        AND trigger_kind = 'formSubmitted' AND body IS NULL AND NOT test
        AND config_snapshot -> 'trigger' ->> 'viewId' = ${trigger.viewId} LIMIT 1`,
      );
      if (!submitted.rows.length) return invalid('errors.validationFailed');
    }
  }
  const runId = newId('job');
  // The run keeps what's published now, and names the automation's person along with it, so it
  // never starts as anyone else.
  if (!c.preview)
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'automation_runs')}
    (id, automation_id, org_id, database_id, state, trigger_kind, record_id, body, version, config_snapshot,
      actor_id)
    VALUES (${runId}, ${automation.id}, ${c.actor.orgId}, ${c.databaseId}, 'queued',
      ${automation.config.trigger.kind}, ${source.record ? command.recordId : null},
      ${JSON.stringify({ recordId: command.recordId, tableId: button.tableId })}::jsonb,
      ${automation.version ?? 1}, ${JSON.stringify(automation.config)}::jsonb, ${automation.runAsId})`,
    );
  return {
    body: {
      kind: 'button.ran',
      fieldId: button.id,
      tableId: button.tableId,
      recordId: command.recordId,
      automationId: automation.id,
      runId,
    },
    prev: {},
  };
}

import { flattenAutomationSteps } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import type { StoredAutomation } from './store.js';
import { triggerTableId } from './validate.js';

/**
 * Whether a rule limits someone on a table the given steps read.  Those are the trigger's table,
 * the tables record steps made or changed records in, and the tables their links reach, since a
 * record's values name its linked records.  A script can read any table, so after one, any rule
 * in the database counts.  What those steps did was worked out with their person's access, and a
 * resumed run carries it on to steps that can send it anywhere.
 */
export async function readsLimited(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  automation: StoredAutomation,
  config: StoredAutomation['config'],
  stepIds: readonly string[],
): Promise<boolean> {
  const earlier = flattenAutomationSteps(config.steps).filter((step) => stepIds.includes(step.id));
  if (!earlier.length) return false;
  if (earlier.some((step) => step.kind === 'script')) return scope.limited(automation.databaseId);
  const trigger = config.trigger;
  const view = trigger.kind === 'formSubmitted' ? await loadView(db, schemas, trigger.viewId) : null;
  const source = triggerTableId(config, () =>
    view && !view.trashed && view.databaseId === automation.databaseId ? view.view.tableId : null,
  );
  const waiting = [
    ...(source ? [source] : []),
    ...earlier.flatMap((step) => ('tableId' in step ? [step.tableId] : [])),
  ];
  const seen = new Set<string>();
  while (waiting.length) {
    const tableId = waiting.pop()!;
    if (seen.has(tableId)) continue;
    seen.add(tableId);
    const table = await loadTable(db, schemas, tableId);
    if (!table || table.databaseId !== automation.databaseId) continue;
    await scope.ensureTable(tableId);
    const fields = await loadFields(db, schemas, [tableId]);
    if (!scope.readsEverything(tableId, fields)) return true;
    for (const field of fields) if (field.type === 'link') waiting.push(field.options.linkedTableId);
  }
  return false;
}

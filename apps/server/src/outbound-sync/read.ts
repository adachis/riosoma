import type { SyncOutMessage, SyncOutWithheldField } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { FilterCondition, FilterGroup } from '@riosoma/contracts';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { exportFields } from '../data/export/source.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import { resolveSelectOptions } from '../data/select-options.js';
import type { SnapshotCache, SnapshotRead } from '../data/snapshots.js';
import { readsLive } from '../sources/live.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import type { StoredField } from '../data/types.js';

/**
 * Reading a view as the person who set a sync up, the one way the preview and a run both do it.
 * Nothing is read into memory until it returns `ok: true`.  The view's own visible fields are
 * used, so its filter conditions on a classified field still apply and no more rows than the view
 * shows are read; the classified fields are then withheld from what is sent, not from the read.
 */

export type SyncRead =
  | {
      ok: true;
      scope: AccessScope;
      read: SnapshotRead;
      /** The fields that may leave, in view order */
      fields: StoredField[];
      withheld: SyncOutWithheldField[];
      locale: string;
    }
  // A `syncOut.stopped.*` key: the sync turns itself off.
  | { ok: false; stop: string }
  // The run fails, and the sync stays on.
  | { ok: false; fail: SyncOutMessage };

function fail(messageKey: string): SyncRead {
  return { ok: false, fail: { messageKey } };
}

/** The field IDs a view's filter and sorts name. */
function referencedFields(config: {
  filter: FilterGroup | null;
  sorts: ReadonlyArray<{ fieldId: string }>;
}): Set<string> {
  const ids = new Set<string>();
  const walk = (group: FilterGroup) => {
    for (const member of group.conditions) {
      if ('conditions' in member) walk(member as FilterGroup);
      else ids.add((member as FilterCondition).fieldId);
    }
  };
  if (config.filter) walk(config.filter);
  for (const sort of config.sorts) ids.add(sort.fieldId);
  return ids;
}

export async function syncRead(
  ctx: AppContext,
  snapshots: SnapshotCache,
  actor: Actor & { locale?: string },
  viewId: string,
  timeZone: string,
): Promise<SyncRead> {
  const { pool, schemas } = dataStore(ctx);
  const loaded = await loadView(pool, schemas, viewId);
  if (!loaded || loaded.trashed) return { ok: false, stop: 'syncOut.stopped.viewDeleted' };
  const { view, databaseId } = loaded;
  const table = await loadTable(pool, schemas, view.tableId);
  if (!table) return { ok: false, stop: 'syncOut.stopped.viewDeleted' };
  const trashed = await query<{ trashed: boolean }>(
    pool,
    sql`SELECT trashed_at IS NOT NULL AS trashed FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  if (trashed.rows[0]?.trashed !== false) return { ok: false, stop: 'syncOut.stopped.viewDeleted' };

  const scope = new AccessScope(pool, schemas, actor);
  if (!(await scope.databaseRole(databaseId)))
    return { ok: false, stop: 'syncOut.stopped.creatorLostAccess' };
  await scope.prepare(databaseId);

  if (view.type === 'form' || view.type === 'chart' || view.type === 'pivot')
    return fail('syncOut.unavailable.viewType');
  if (readsLive(table)) return fail('syncOut.unavailable.live');

  await prepareJoinedRead(ctx, scope, table);
  const loadedFields = await loadFields(pool, schemas, [table.id]);
  const visibleBase = scope.visibleFields(table.id, loadedFields);
  const visible = await resolveSelectOptions(pool, schemas, scope, visibleBase);

  const read: SnapshotRead = {
    scope,
    table,
    view: { ...view, config: { ...view.config, groups: [] } },
    fields: visible,
    predicate: scope.recordPredicate(table.id),
    access: scope.accessKey(table.id),
    context: await snapshots.readContext(timeZone),
  };

  const withheld: SyncOutWithheldField[] = [];
  const fields = exportFields(read).filter((field) => {
    const mayLeave = (['export', 'external'] as const).every((use) =>
      scope.allowsUse(databaseId, use, { fieldIds: [field.id] }),
    );
    if (!mayLeave)
      withheld.push({ fieldId: field.id, fieldName: field.name, reason: 'governance.classificationDenied' });
    return mayLeave;
  });

  // A view that decides which rows go, or their order, by a field that may not leave sends nothing,
  // so the value can't shape what leaves without ever being sent.
  if (withheld.length) {
    const referenced = referencedFields(view.config);
    if (withheld.some((field) => referenced.has(field.fieldId))) return fail('syncOut.view.filtersWithheld');
  }

  if (!fields.length) return fail('syncOut.view.nothingToSend');
  return { ok: true, scope, read, fields, withheld, locale: actor.locale ?? 'en-US' };
}

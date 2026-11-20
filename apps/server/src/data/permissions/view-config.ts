import type { ViewMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { redactConfig } from './redact.js';

/** A bounded lookup keeps record references subject to the same rules as record values. */
export async function visiblePins(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  view: ViewMeta,
): Promise<Set<string>> {
  const ids = view.config.pinnedRecordIds;
  await scope.ensureTable(view.tableId);
  if (!ids.length) return new Set();
  const rows = await query<{ __id: string }>(
    db,
    sql`SELECT __id FROM ${ident(schemas.data, view.tableId)}
    WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
      AND (${scope.recordPredicate(view.tableId)})`,
  );
  return new Set(rows.rows.map((row) => row.__id));
}

export async function readableView(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  view: ViewMeta,
  hidden: ReadonlySet<string>,
): Promise<ViewMeta> {
  const pins = await visiblePins(db, schemas, scope, view);
  const config = redactConfig(view.config, hidden);
  return {
    ...view,
    config: {
      ...config,
      sparklines: config.sparklines.filter(
        (setting) => !hidden.has(setting.fieldId) && (!setting.order || !hidden.has(setting.order.fieldId)),
      ),
      iconSets: config.iconSets.filter((set) => !hidden.has(set.fieldId)),
      pinnedRecordIds: config.pinnedRecordIds.filter((id) => pins.has(id)),
      columnGroups: config.columnGroups.flatMap((group) => {
        const fieldIds = group.fieldIds.filter((id) => !hidden.has(id));
        return fieldIds.length ? [{ ...group, fieldIds }] : [];
      }),
    },
  };
}

/** Only saved references are checked when a pin write clears records that no longer exist. */
export async function existingPins(
  db: Queryable,
  schemas: DataSchemas,
  view: ViewMeta,
): Promise<Set<string>> {
  if (!view.config.pinnedRecordIds.length) return new Set();
  const rows = await query<{ __id: string }>(
    db,
    sql`SELECT __id FROM ${ident(schemas.data, view.tableId)}
    WHERE __id = ANY(${view.config.pinnedRecordIds}::text[]) AND __deleted_at IS NULL AND NOT __source_gone`,
  );
  return new Set(rows.rows.map((row) => row.__id));
}

import { readableView } from '../data/permissions/view-config.js';
import type { Change, CellValue, RowData, TableMeta } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields } from '../data/metadata.js';
import { limitTable, redactConfig } from '../data/permissions/redact.js';
import { fetchRowsById } from '../data/physical/records.js';
import type { StoredField } from '../data/types.js';

/**
 * Realtime changes as one person may see them, for a person some field or record rule limits.
 * The hub filters each change per connection here: records they can't see are left out, values
 * are read again through their own scope, so a field they can't see never goes out, links list
 * only records they may see (with a count of the rest), and lookups and rollups are computed over
 * those alone, and settings lose the values of hidden fields.  Returns null when nothing of the
 * change is theirs to see.
 *
 * Reading values again means a replayed change carries the record's values as they are now,
 * which is what a client applying it in order ends up showing anyway.
 */
export async function changeFor(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  change: Change,
): Promise<Change | null> {
  const hidden = scope.hiddenFieldIds(databaseId);
  const fieldsOf = async (tableId: string): Promise<StoredField[]> => {
    await scope.ensureTable(tableId);
    return scope.visibleFields(tableId, await loadFields(db, schemas, [tableId]));
  };
  const visibleIds = async (
    tableId: string,
    ids: readonly string[],
    trashed = false,
  ): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    await scope.ensureTable(tableId);
    const result = await query<{ __id: string }>(
      db,
      sql`SELECT __id FROM ${ident(schemas.data, tableId)} WHERE __id = ANY(${[...ids]}::text[])
        AND ${trashed ? sql`TRUE` : sql`__deleted_at IS NULL AND NOT __source_gone`}
        AND (${scope.recordPredicate(tableId)})`,
    );
    return new Set(result.rows.map((row) => row.__id));
  };
  /** Rows read again as the person sees them, in the order given, for the fields named or all. */
  const reread = async (tableId: string, ids: readonly string[], only?: ReadonlySet<string>) => {
    const fields = (await fieldsOf(tableId)).filter(
      (field) => field.type !== 'formula' && (!only || only.has(field.id)),
    );
    const seen = await visibleIds(tableId, ids);
    return fetchRowsById(
      db,
      schemas.data,
      tableId,
      fields,
      ids.filter((id) => seen.has(id)),
    );
  };

  const limitedTable = <T extends TableMeta>(table: T): T =>
    limitTable(table, scope.limitsRecords(table.id), hidden, scope.hiddenFieldIds(databaseId, table.id));
  switch (change.kind) {
    case 'namedFunction.changed':
      return { ...change, fields: change.fields.filter((field) => !hidden.has(field.id)) };
    case 'access.changed':
      return null;
    case 'table.synced': {
      const table = limitedTable(change.table);
      return scope.limitsRecords(change.table.id)
        ? {
            ...change,
            table,
            stats: {
              added: 0,
              changed: 0,
              removed: 0,
              unchanged: 0,
              overridesCleared: 0,
              ms: change.stats.ms,
            },
          }
        : table === change.table
          ? change
          : { ...change, table };
    }
    case 'table.updated':
    case 'field.primarySet':
      await scope.ensureTable(change.table.id);
      return { ...change, table: limitedTable(change.table) };
    case 'button.ran': {
      if (hidden.has(change.fieldId)) return null;
      return (await reread(change.tableId, [change.recordId])).length ? change : null;
    }
    case 'record.created':
    case 'record.restored': {
      const records = await reread(
        change.tableId,
        change.records.map((row) => row.id),
      );
      return records.length ? { ...change, records } : null;
    }
    case 'record.updated': {
      const changed = new Set(change.records.flatMap((row) => Object.keys(row.values)));
      const rows = new Map(
        (
          await reread(
            change.tableId,
            change.records.map((row) => row.id),
            changed,
          )
        ).map((row) => [row.id, row]),
      );
      const records = change.records.flatMap((record) => {
        const row = rows.get(record.id);
        if (!row) return [];
        const values: Record<string, CellValue> = {};
        for (const id of Object.keys(record.values))
          if (Object.hasOwn(row.values, id)) values[id] = row.values[id]!;
        if (!Object.keys(values).length) return [];
        const overrides = record.overrides
          ? Object.fromEntries(
              Object.keys(record.overrides)
                .filter((id) => Object.hasOwn(values, id))
                .map((id) => [id, row.overrides?.[id] ?? null]),
            )
          : undefined;
        return [
          {
            id: record.id,
            values,
            updatedAt: record.updatedAt,
            updatedBy: record.updatedBy,
            ...(overrides && Object.keys(overrides).length ? { overrides } : {}),
            ...(row.hiddenLinks ? { hiddenLinks: row.hiddenLinks } : {}),
          },
        ];
      });
      return records.length ? { ...change, records } : null;
    }
    case 'record.linksChanged': {
      if (hidden.has(change.fieldId)) return null;
      const rows = new Map(
        (
          await reread(
            change.tableId,
            change.records.map((row) => row.id),
            new Set([change.fieldId]),
          )
        ).map((row: RowData) => [row.id, row]),
      );
      const records = change.records.flatMap((record) => {
        const row = rows.get(record.id);
        if (!row || !Object.hasOwn(row.values, change.fieldId)) return [];
        const ids = row.values[change.fieldId];
        const count = row.hiddenLinks?.[change.fieldId];
        return [
          {
            id: record.id,
            ids: Array.isArray(ids) ? (ids as string[]) : [],
            ...(count ? { hidden: count } : {}),
          },
        ];
      });
      return records.length ? { ...change, records } : null;
    }
    case 'record.locksChanged':
    case 'record.trashed':
    case 'record.moved': {
      const seen = await visibleIds(change.tableId, change.recordIds, true);
      const recordIds = change.recordIds.filter((id) => seen.has(id));
      return recordIds.length ? { ...change, recordIds } : null;
    }
    case 'comment.created':
    case 'comment.updated':
      if (
        change.comment.fieldId &&
        !(await fieldsOf(change.comment.tableId)).some((field) => field.id === change.comment.fieldId)
      )
        return null;
      return (await visibleIds(change.comment.tableId, [change.comment.recordId], true)).size ? change : null;
    case 'comment.deleted':
      return (await visibleIds(change.tableId, [change.recordId], true)).size ? change : null;
    case 'comment.moved': {
      const seen = await visibleIds(
        change.tableId,
        change.comments.map((comment) => comment.recordId),
        true,
      );
      const fields = new Set((await fieldsOf(change.tableId)).map((field) => field.id));
      const comments = change.comments.filter(
        (comment) => seen.has(comment.recordId) && (!comment.fieldId || fields.has(comment.fieldId)),
      );
      if (!comments.length) return null;
      const from = Object.fromEntries(
        Object.entries(change.from).filter(([id]) => comments.some((comment) => comment.id === id)),
      );
      return { ...change, comments, from };
    }
    case 'table.created': {
      const fields = await fieldsOf(change.table.id);
      const shown = new Set(fields.map((field) => field.id));
      const records = await reread(
        change.table.id,
        change.records.map((row) => row.id),
      );
      return {
        ...change,
        table: limitedTable(change.table),
        fields: change.fields.filter((field) => shown.has(field.id)),
        views: await Promise.all(change.views.map((view) => readableView(db, schemas, scope, view, hidden))),
        records,
      };
    }
    case 'table.restored': {
      const shown = new Set((await fieldsOf(change.table.id)).map((field) => field.id));
      return {
        ...change,
        table: limitedTable(change.table),
        fields: change.fields.filter((field) => shown.has(field.id)),
        views: await Promise.all(change.views.map((view) => readableView(db, schemas, scope, view, hidden))),
      };
    }
    case 'field.created':
      if (hidden.has(change.field.id)) return null;
      return {
        ...change,
        views: await Promise.all(change.views.map((view) => readableView(db, schemas, scope, view, hidden))),
      };
    case 'field.updated':
    case 'field.converted':
    case 'field.restored':
      return hidden.has(change.field.id) ? null : change;
    case 'field.trashed':
      return hidden.has(change.fieldId) ? null : change;
    case 'view.created':
    case 'view.updated':
    case 'view.restored':
      return { ...change, view: await readableView(db, schemas, scope, change.view, hidden) };
    case 'dashboard.created':
    case 'dashboard.updated':
    case 'dashboard.restored':
      return {
        ...change,
        dashboard: { ...change.dashboard, config: redactConfig(change.dashboard.config, hidden) },
      };
    case 'automation.created':
    case 'automation.updated':
    case 'automation.restored': {
      const draft = change.automation.draft;
      return {
        ...change,
        automation: {
          ...change.automation,
          config: redactConfig(change.automation.config, hidden),
          ...(draft ? { draft: { ...draft, config: redactConfig(draft.config, hidden) } } : {}),
        },
      };
    }
    case 'interface.created':
    case 'interface.updated':
    case 'interface.restored':
      return {
        ...change,
        interface: { ...change.interface, pages: redactConfig(change.interface.pages, hidden) },
      };
    default:
      return change;
  }
}

/** Whether a change can alter which fields a person sees, so their connection reads its rules again. */
export function changesSchema(change: Change): boolean {
  return (
    change.kind === 'namedFunction.changed' ||
    change.kind.startsWith('field.') ||
    change.kind.startsWith('table.')
  );
}

import { AppError, sameValue, type ChangeBody, type Command, type RowData } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import { loadFields, loadTables } from '../metadata.js';
import { fetchPageByRid } from '../physical/records.js';
import type { StoredField } from '../types.js';
import type { CommandContext } from './context.js';

const COMPUTED = new Set(['lookup', 'rollup', 'count', 'formula']);
const LIMIT = 200;
const incomplete = () => new AppError('validation_failed', 'routines.changes.incomplete');

/**
 * Reads computed values that depend on proposed edits before and after validation.  These values
 * have no stored-cell mutation, but their changes still belong in an exact approval.  A bounded
 * preview refuses dependencies it cannot inspect completely through the owner's access.
 */
export async function computedPreview(c: CommandContext, commands: readonly Command[]) {
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  await scope.require(c.databaseId, 'read');
  const tables = await loadTables(c.db, c.schemas, c.databaseId);
  const fields = await loadFields(
    c.db,
    c.schemas,
    tables.map((table) => table.id),
  );
  const touched = new Set<string>();
  for (const command of commands) {
    if (!('tableId' in command)) throw incomplete();
    if (command.kind === 'record.update') {
      for (const record of command.records) for (const id of Object.keys(record.values)) touched.add(id);
    } else {
      for (const field of fields) if (field.tableId === command.tableId) touched.add(field.id);
    }
  }
  const modifiedTables = new Set(
    commands.flatMap((command) => ('tableId' in command ? [command.tableId] : [])),
  );
  let size = -1;
  while (size !== touched.size) {
    size = touched.size;
    for (const field of fields) {
      // Stored edits and inverse-link upkeep also change the record's modification metadata.
      if (modifiedTables.has(field.tableId) && ['lastModifiedTime', 'lastModifiedBy'].includes(field.type))
        touched.add(field.id);
      if (field.type === 'link') {
        const match = field.options.match;
        if (
          touched.has(field.id) ||
          (match && (touched.has(match.fieldId) || touched.has(match.linkedFieldId)))
        ) {
          touched.add(field.id);
          if (field.options.inverseFieldId) touched.add(field.options.inverseFieldId);
          modifiedTables.add(field.tableId).add(field.options.linkedTableId);
        }
      } else if (COMPUTED.has(field.type)) {
        const dependencies = [
          ...('linkFieldId' in field.options ? [field.options.linkFieldId] : []),
          ...('targetFieldId' in field.options ? [field.options.targetFieldId] : []),
          ...(field.formula?.fields.map((dependency) => dependency.id) ?? []),
        ];
        if (dependencies.some((id) => touched.has(id))) touched.add(field.id);
      }
    }
  }
  const computed = fields.filter((field) => COMPUTED.has(field.type) && touched.has(field.id));
  const selected = new Map<string, StoredField[]>();
  for (const field of computed) {
    // Values that depend on the moment of execution cannot be promised before that moment.
    const unstable = (value: StoredField, seen = new Set<string>()): boolean => {
      if (seen.has(value.id)) return false;
      seen.add(value.id);
      return (
        ['createdTime', 'lastModifiedTime'].includes(value.type) ||
        (value.type === 'formula' && /\b(NOW|TODAY|RAND|RANDBETWEEN)\s*\(/i.test(value.options.expression)) ||
        (value.formula?.fields.some((dependency) => unstable(dependency, seen)) ?? false) ||
        Boolean(value.relation?.target && unstable(value.relation.target, seen))
      );
    };
    if (unstable(field) || !scope.visibleFields(field.tableId, [field]).length) throw incomplete();
    selected.set(field.tableId, [...(selected.get(field.tableId) ?? []), field]);
  }
  async function read() {
    const result = new Map<string, Map<string, RowData>>();
    for (const [tableId, columns] of selected) {
      const found = await query<{ rid: string; visible: boolean }>(
        c.db,
        sql`
        SELECT __rid AS rid, (${scope.recordPredicate(tableId)}) AS visible
        FROM ${ident(c.schemas.data, tableId)}
        WHERE __deleted_at IS NULL AND NOT __source_gone ORDER BY __id LIMIT ${LIMIT + 1}`,
      );
      if (found.rows.length > LIMIT || found.rows.some((row) => !row.visible)) throw incomplete();
      const rows = await fetchPageByRid(
        c.db,
        c.schemas.data,
        tableId,
        scope.visibleFields(tableId, columns),
        found.rows.map((row) => Number(row.rid)),
        scope.recordPredicate(tableId),
      );
      if (
        rows.some(
          (row) => !row || Object.keys(row.errors ?? {}).length || Object.keys(row.hiddenLinks ?? {}).length,
        )
      )
        throw incomplete();
      result.set(tableId, new Map(rows.flatMap((row) => (row ? [[row.id, row] as const] : []))));
    }
    return result;
  }
  const before = await read();
  return async (): Promise<ChangeBody[]> => {
    const effects: ChangeBody[] = [];
    for (const [tableId, rows] of await read()) {
      const records: Extract<ChangeBody, { kind: 'record.updated' }>['records'] = [];
      for (const row of rows.values()) {
        const old = before.get(tableId)?.get(row.id);
        const values = Object.fromEntries(
          Object.entries(row.values).filter(([id, value]) => !sameValue(old?.values[id] ?? null, value)),
        );
        if (Object.keys(values).length)
          records.push({ id: row.id, values, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
      }
      if (records.length) effects.push({ kind: 'record.updated', tableId, records });
    }
    return effects;
  };
}

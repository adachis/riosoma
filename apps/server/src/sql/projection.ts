import { AppError, type SqlCatalogTable } from '@riosoma/contracts';
import { compile, ident, join, sql, Sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import type { ClassificationUse } from '../data/governance.js';
import { loadFields, loadTables } from '../data/metadata.js';
import { limitHistoryFields } from '../data/physical/change-log.js';
import { columnRef } from '../data/physical/columns.js';
import { hiddenLinkCount } from '../data/physical/relations.js';
import { quoteName, reserved, type ScopedTable } from './guard.js';

/** What a value in a SQL view is used for: a download, and a read outside the organization. */
const SQL_USES: readonly ClassificationUse[] = ['export', 'external'];

/** A duplicate, reserved, or overlong name gets its full stable ID, independent of list order. */
export function friendlyNames(items: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    let name = item.name;
    if (
      !name ||
      reserved(name) ||
      Buffer.byteLength(name) > 63 ||
      counts.get(name)! > 1 ||
      items.some((other) => other.id !== item.id && other.id === name)
    )
      name = item.id;
    if (used.has(name)) throw new AppError('validation_failed', 'sql.guard.table');
    used.add(name);
    result.set(item.id, name);
  }
  return result;
}

export const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite SQL value');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value))
    return value.length ? `ARRAY[${value.map(literal).join(',')}]` : 'ARRAY[]::text[]';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};

/** Compiles trusted scope fragments, preserving parameter boundaries before SQL is embedded. */
export function embedded(fragment: Sql): string {
  // Compile each value separately so a dollar sign inside an identifier or literal is never replaced.
  let text = fragment.strings[0] ?? '';
  fragment.values.forEach((value, index) => {
    text +=
      value instanceof Sql
        ? embedded(value)
        : (() => {
            const compiled = compile(new Sql(['', ''], [value]));
            return compiled.values.length ? literal(compiled.values[0]) : compiled.text;
          })();
    text += fragment.strings[index + 1] ?? '';
  });
  return text;
}

export async function projections(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
) {
  await scope.require(databaseId, 'read');
  // Outside reporting tools read the views these projections build, and the runner in the app reads
  // the same ones, so a label that keeps values inside the organization leaves them out of both.
  // A table none of whose fields may leave has no view at all.
  const leaves = (fieldId: string) =>
    SQL_USES.every((use) => scope.allowsUse(databaseId, use, { fieldIds: [fieldId] }));
  const tables = await loadTables(db, schemas, databaseId);
  const tableNames = friendlyNames(tables);
  const fields = await loadFields(
    db,
    schemas,
    tables.map((table) => table.id),
  );
  const catalog: SqlCatalogTable[] = [];
  const sources = new Map<string, ScopedTable>();
  for (const table of tables) {
    // Live sources cannot be represented by their incomplete local mirror.
    if (table.source?.freshness === 'live' || table.source?.status.switchingToCopy) continue;
    const own = fields.filter((field) => field.tableId === table.id);
    // The query role has no access to record history or its private metadata, so no projected field
    // names any of it, and every change log reads as an empty value here.  Stripping reaches a change
    // log a lookup, a rollup, a formula, or a lookup's own sort reads too, since history at any depth
    // would fail the query the same way.
    const visible = limitHistoryFields(
      scope.visibleFields(table.id, own).filter((field) => leaves(field.id)),
      new Set(),
    );
    if (!visible.length) continue;
    const fieldNames = friendlyNames(visible);
    const columns = visible.map((field) => {
      const ref = columnRef(field, 'record');
      const hidden = hiddenLinkCount(field, 'record');
      const value =
        field.type === 'link'
          ? sql`jsonb_build_object('records', ${ref}, 'hiddenCount', ${hidden ?? sql`0`})`
          : ref;
      return new Sql(['', ` AS ${quoteName(fieldNames.get(field.id)!)}`], [value]);
    });
    const name = tableNames.get(table.id)!;
    const select = sql`SELECT ${join(columns, ', ')} FROM ${ident(schemas.data, table.id)} AS record
      WHERE record.__deleted_at IS NULL AND NOT record.__source_gone
      AND (${scope.recordPredicate(table.id, 'record')}) OFFSET 0`;
    sources.set(name, {
      select: embedded(select),
      columns: visible.map((field) => fieldNames.get(field.id)!),
    });
    catalog.push({
      id: table.id,
      name,
      fields: visible.map((field) => ({ id: field.id, name: fieldNames.get(field.id)! })),
    });
  }
  return { catalog, sources };
}

import { ident, query, sql, type Sql } from '@riosoma/db';
import { requireUnlockedRecords } from '../record-locks.js';
import { AppError } from '@riosoma/contracts';
import { scopeOf, type CommandContext } from './context.js';
import type { StoredField } from '../types.js';

/** Schema changes that rewrite cells must honor the same locks as record edits. */
export async function requireUnlockedTable(
  c: CommandContext,
  tableId: string,
  predicate: Sql = sql`TRUE`,
  joinedField?: StoredField,
): Promise<void> {
  const scope = await scopeOf(c, tableId);
  if (
    scope.limitsRecords(tableId) &&
    !(joinedField?.source?.sourceType === 'joined' && scope.readsEverything(tableId, [joinedField]))
  )
    throw new AppError('forbidden', 'data.access.recordHidden');
  let after = 0;
  for (;;) {
    const rows = await query<{ id: string; rid: string }>(
      c.db,
      sql`SELECT __id AS id, __rid::text AS rid FROM ${ident(c.schemas.data, tableId)}
      WHERE __deleted_at IS NULL AND __rid > ${after} AND (${predicate}) ORDER BY __rid LIMIT 1000`,
    );
    if (!rows.rows.length) return;
    await requireUnlockedRecords(
      c,
      tableId,
      rows.rows.map((row) => row.id),
    );
    after = Number(rows.rows.at(-1)!.rid);
  }
}

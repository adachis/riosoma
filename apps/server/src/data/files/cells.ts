import { idsOf } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { scopeOf, type CommandContext } from '../commands/context.js';
import type { RecordInput } from '../physical/records.js';
import type { StoredField } from '../types.js';
import { cellError } from '../value-errors.js';
import { routineOwn } from '../../http/policy.js';
import { cancelDetached } from '../../signatures/store.js';

/**
 * Files go only into cells of the field they were uploaded for.  The same file may sit in several
 * records of that field, so copying, pasting, and restoring attachments from history work.
 *
 * Someone a record rule limits places only a file they could already open: one in a record they
 * see, or their own upload that no record holds yet.  Anything else reads as unknown, so placing
 * a file never opens it.  `restoring` is for undo, which puts back what its own change took out of
 * a record the person still sees.
 */
export async function attachFiles(
  c: CommandContext,
  tableId: string,
  fields: readonly StoredField[],
  rows: readonly RecordInput[],
  options: { restoring?: boolean } = {},
): Promise<void> {
  const attachments = fields.filter((field) => field.type === 'attachment');
  // Later entries for the same record replace earlier ones, so only the final values count.
  const final = new Map<string, RecordInput>();
  for (const row of rows) {
    final.set(row.id, { id: row.id, values: { ...final.get(row.id)?.values, ...row.values } });
  }
  const wanted = new Map<string, string>();
  // A routine run's own change never cancels a signature request, which undo couldn't bring back.
  await cancelDetached(c.db, c.schemas, tableId, [...final.values()], routineOwn(c.actor));
  for (const row of final.values()) {
    for (const field of attachments) {
      for (const id of idsOf(row.values[field.id] ?? null)) {
        if (wanted.has(id) && wanted.get(id) !== field.id)
          throw cellError(
            'data.file.unknown',
            field,
            row.id,
            rows.findIndex((item) => item.id === row.id && idsOf(item.values[field.id] ?? null).includes(id)),
          );
        wanted.set(id, field.id);
      }
    }
  }
  if (!wanted.size) return;
  const loaded = await query<{ id: string; field_id: string; created_by: string | null }>(
    c.db,
    sql`SELECT id, field_id, created_by FROM ${ident(c.schemas.app, 'files')}
      WHERE id = ANY(${[...wanted.keys()]}::text[]) AND table_id = ${tableId} AND org_id = ${c.actor.orgId}
      ORDER BY id FOR UPDATE`,
  );
  const files = new Map(loaded.rows.map((file) => [file.id, file]));
  const unknown = (id: string, fieldId: string) => {
    const index = rows.findIndex((row) => idsOf(row.values[fieldId] ?? null).includes(id));
    return cellError(
      'data.file.unknown',
      attachments.find((field) => field.id === fieldId)!,
      rows[index]!.id,
      index,
    );
  };
  for (const [id, fieldId] of wanted) if (files.get(id)?.field_id !== fieldId) throw unknown(id, fieldId);
  const scope = await scopeOf(c, tableId);
  if (!options.restoring && scope.limitsRecords(tableId)) {
    for (const field of attachments) {
      const ids = [...wanted].filter(([, fieldId]) => fieldId === field.id).map(([id]) => id);
      if (!ids.length) continue;
      // The same test a download makes: whether any record holding the file is one they see.  A
      // rule that comes out unknown for a record hides it, so that record still holds the file.
      const held = await query<{ id: string; seen: boolean }>(
        c.db,
        sql`SELECT w.id, COALESCE(bool_or(${scope.recordPredicate(tableId, 'r')}), false) AS seen
          FROM unnest(${ids}::text[]) AS w(id)
          JOIN ${ident(c.schemas.data, tableId)} r ON ${ident('r', field.columnName)} @> ARRAY[w.id]
          GROUP BY w.id`,
      );
      const seen = new Map(held.rows.map((row) => [row.id, row.seen === true]));
      for (const id of ids) {
        // Being their own upload counts only for a file no record holds.
        const open = seen.has(id) ? seen.get(id) : files.get(id)!.created_by === c.actor.userId;
        if (!open) throw unknown(id, field.id);
      }
    }
  }
  const claimed = new Map(wanted);
  if (claimed.size)
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'files')}
    SET attached_at = COALESCE(attached_at, statement_timestamp()) WHERE id = ANY(${[...claimed.keys()]}::text[])`,
    );
}

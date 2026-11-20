import { isOverrideType, sameValue, type CellValue, type Override } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext, Mutation } from '../commands/context.js';
import { loadFields, loadTables } from '../metadata.js';
import { fetchRowsById } from './records.js';

/** Recalculate beneath pins after mutations, including changes to linked records. */
export async function* refreshComputedOverrides(c: CommandContext): AsyncGenerator<Mutation> {
  // A computed pin is made only while the table's owner allows them, so a table that never did
  // holds none to refresh, and the scan stays away from it however many records it has.
  const tables = (await loadTables(c.db, c.schemas, c.databaseId)).filter(
    (table) => table.allowComputedOverrides,
  );
  if (!tables.length) return;
  const computed = (
    await loadFields(
      c.db,
      c.schemas,
      tables.map((table) => table.id),
    )
  ).filter((field) => isOverrideType(field.type));
  for (const table of tables) {
    const fields = computed.filter((field) => field.tableId === table.id);
    for (const field of fields) {
      const rows = await query<{ id: string; pin: Override }>(
        c.db,
        sql`SELECT __id AS id, __overrides -> ${field.id} AS pin
        FROM ${ident(c.schemas.data, table.id)} WHERE __overrides -> ${field.id} ? 'value'
          AND __deleted_at IS NULL AND NOT __source_gone`,
      );
      const sources = new Map(
        (
          await fetchRowsById(
            c.db,
            c.schemas.data,
            table.id,
            [{ ...field, ignoreOverride: true }],
            rows.rows.map((row) => row.id),
          )
        ).map((row) => [row.id, row.values[field.id] ?? null]),
      );
      for (const row of rows.rows) {
        const source = sources.get(row.id) ?? null;
        const equal = sameValue(row.pin.value, source);
        if (!equal && sameValue(row.pin.source, source)) continue;
        const pin = equal ? null : { ...row.pin, source };
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.data, table.id)}
          SET __overrides = ${pin ? sql`jsonb_set(__overrides, ARRAY[${field.id}], ${JSON.stringify(pin)}::jsonb)` : sql`NULLIF(__overrides - ${field.id}, '{}'::jsonb)`}
          WHERE __id = ${row.id}`,
        );
        const value: CellValue = equal ? source : (row.pin.value ?? null);
        yield {
          body: {
            kind: 'record.updated',
            tableId: table.id,
            records: [
              {
                id: row.id,
                values: { [field.id]: value },
                overrides: { [field.id]: pin },
                updatedAt: new Date().toISOString(),
                updatedBy: null,
              },
            ],
          },
          prev: {
            records: [
              {
                id: row.id,
                values: { [field.id]: row.pin.value ?? null },
                overrides: { [field.id]: row.pin },
              },
            ],
          },
        };
      }
    }
  }
}

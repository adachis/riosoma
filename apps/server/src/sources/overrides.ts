import { AppError, sameValue, isOverrideType, type Command, type Override } from '@riosoma/contracts';
import type { CommandContext } from '../data/commands/context.js';
import { fetchRowsById, type RecordInput } from '../data/physical/records.js';
import type { StoredField } from '../data/types.js';
import { ARRAY_CELL_ERROR, sourceCellError, sourceErrorValues } from '../data/source-cell-errors.js';

/**
 * Which pins a table takes.  A synced column follows its source's setting, and a computed value
 * follows the table's own, so one switch never answers for the other kind of field.
 */
export interface OverrideSwitches {
  /** A synced column, or any field of a joined table, takes a pin */
  synced: boolean;
  /** A formula, lookup, or rollup takes a pin */
  computed: boolean;
}

export async function overrideEdits(
  c: CommandContext,
  tableId: string,
  fields: StoredField[],
  rows: RecordInput[],
  switches: OverrideSwitches,
): Promise<RecordInput[]> {
  const sourceFields = fields.filter((field) => field.source || isOverrideType(field.type));
  const current = new Map(
    (
      await fetchRowsById(
        c.db,
        c.schemas.data,
        tableId,
        sourceFields,
        rows.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  );
  const refused = await sourceErrorValues(
    c.db,
    c.schemas.data,
    tableId,
    [...current.values()]
      .filter((row) => Object.values(row.errors ?? {}).includes(ARRAY_CELL_ERROR))
      .map((row) => row.id),
  );
  return rows.map((row) => {
    const before = current.get(row.id);
    if (!before) return row;
    const overrides: Record<string, Override | null> = {};
    for (const field of sourceFields) {
      if (!Object.hasOwn(row.values, field.id)) continue;
      if (!(field.source ? switches.synced : switches.computed))
        throw new AppError('forbidden', 'sources.overridesOff');
      const previous = before.overrides?.[field.id];
      const source =
        refused.get(row.id)?.[field.id]?.source ??
        (previous ? previous.source : (before.values[field.id] ?? null));
      overrides[field.id] = sameValue(row.values[field.id], source)
        ? null
        : {
            source,
            ...(isOverrideType(field.type) ? { value: row.values[field.id] ?? null } : {}),
            by: c.actor.userId,
            at: new Date().toISOString(),
          };
    }
    return { ...row, overrides };
  });
}

export async function clearOverrideEdits(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.clearOverrides' }>,
  fields: StoredField[],
): Promise<RecordInput[]> {
  const current = new Map(
    (
      await fetchRowsById(
        c.db,
        c.schemas.data,
        command.tableId,
        fields,
        command.records.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  );
  return command.records.map(({ id, fieldIds }) => {
    const row: RecordInput = { id, values: {}, overrides: {} };
    for (const fieldId of fieldIds) {
      if (!fields.some((field) => field.id === fieldId && (field.source || isOverrideType(field.type))))
        throw new AppError('validation_failed', 'sources.sourceField');
      const override = current.get(id)?.overrides?.[fieldId];
      if (override) {
        const field = fields.find((field) => field.id === fieldId)!;
        row.values[fieldId] = sourceCellError(field, override.source) ? null : override.source;
        row.overrides![fieldId] = null;
      }
    }
    return row;
  });
}

/**
 * A webhook's post changing its own records.  Its values are the source's, so where a person has
 * overridden a field, the override stays and the source's value behind it changes, as a sync does.
 * An override the post now agrees with clears itself.
 */
export async function inboundEdits(
  c: CommandContext,
  tableId: string,
  fields: StoredField[],
  rows: RecordInput[],
): Promise<RecordInput[]> {
  const sourceFields = fields.filter((field) => field.source);
  const current = new Map(
    (
      await fetchRowsById(
        c.db,
        c.schemas.data,
        tableId,
        sourceFields,
        rows.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  );
  return rows.map((row) => {
    const before = current.get(row.id);
    if (!before?.overrides) return row;
    const values = { ...row.values };
    const overrides: Record<string, Override | null> = {};
    for (const field of sourceFields) {
      const override = before.overrides[field.id];
      if (!override || !Object.hasOwn(values, field.id)) continue;
      const incoming = values[field.id] ?? null;
      if (sameValue(incoming, before.values[field.id] ?? null)) overrides[field.id] = null;
      else {
        delete values[field.id];
        overrides[field.id] = { ...override, source: incoming };
      }
    }
    return { ...row, values, overrides };
  });
}

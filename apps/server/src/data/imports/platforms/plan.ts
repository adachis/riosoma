import { isPrimaryType, LIMITS, newId } from '@riosoma/contracts';
import { uniqueName } from '../core/names.js';
import type { Note } from '../core/report.js';
import { textOf } from '../core/values.js';
import type { FieldPlan, LinkPlan, SourceSchema, SourceTable, ValuePlan } from './model.js';

/**
 * The whole import worked out before anything is made: a table here for each table there, with
 * names made unique the way Riosoma needs them, the field that names each record first and of a
 * type that can, and each link paired with the field that shows its other side.
 */

export interface TablePlan {
  source: SourceTable;
  id: string;
  name: string;
  /** The grid view the table starts with */
  viewId: string;
  /** Every field, the primary first, then in the tool's order */
  fields: FieldPlan[];
  primary: ValuePlan;
  notes: Note[];
}

export interface Placed {
  table: TablePlan;
  plan: FieldPlan;
}

export interface BasePlan {
  tables: TablePlan[];
  /** Every field, by `fieldKey` of its table's and its own ID there */
  fields: Map<string, Placed>;
  /** Links whose other side is also a field there, first of each pair to the second */
  pairs: Map<LinkPlan, LinkPlan>;
}

/** A field's key, since some tools reuse field IDs from one table to the next. */
export function fieldKey(tableId: string, fieldId: string): string {
  return `${tableId}\u0000${fieldId}`;
}

function renamed(plan: { name: string; notes: Note[] }, original: string): void {
  if (
    plan.name !== original.trim() &&
    !plan.notes.some(
      (note) => note.key === 'import.platform.report.renamed' && note.params?.from === original,
    )
  )
    plan.notes.push({ status: 'changed', key: 'import.platform.report.renamed', params: { from: original } });
}

/** A primary field Riosoma can keep: one that holds values of a type that can name records. */
function primaryPlan(plan: FieldPlan | undefined): ValuePlan {
  if (plan?.kind === 'value' && isPrimaryType(plan.spec.type)) return plan;
  const source = plan?.source ?? { id: newId('field'), name: 'Name' };
  const read = plan?.kind === 'value' ? plan.read : (value: unknown) => value;
  return {
    kind: 'value',
    source,
    id: plan?.id ?? newId('field'),
    name: source.name,
    spec: { type: 'text', options: {} },
    read: (value) => {
      const got = read(value);
      return typeof got === 'string' ? got : textOf(got ?? value);
    },
    notes: [
      ...(plan?.notes ?? []).filter((note) => note.status !== 'exact'),
      { status: 'changed', key: 'import.platform.report.primaryText' },
    ],
  };
}

export function planBase(schema: SourceSchema): BasePlan {
  const tableNames = new Set<string>();
  const fields = new Map<string, Placed>();
  const tables = schema.tables.map((source, index): TablePlan => {
    const found = source.fields.find((field) => field.source.id === source.primary);
    const usable = found ?? source.fields.find((field) => field.kind === 'value') ?? source.fields[0];
    const primary = primaryPlan(usable);
    const planned = [primary, ...source.fields.filter((field) => field !== usable)];
    const table: TablePlan = {
      source,
      id: newId('table'),
      name: '',
      viewId: newId('view'),
      fields: planned,
      primary,
      notes: [...source.notes],
    };
    table.name = uniqueName(tableNames, source.name, `Table ${index + 1}`);
    renamed(table, source.name);
    const names = new Set<string>();
    let kept = 0;
    for (const [position, planned_] of planned.entries()) {
      let plan = planned_;
      if (plan.kind !== 'omitted' && plan.kind !== 'deferredLink' && kept >= LIMITS.fieldsPerTable) {
        plan = {
          kind: 'omitted',
          source: plan.source,
          id: plan.id,
          name: plan.name,
          notes: [
            {
              status: 'omitted',
              key: 'import.platform.report.tooManyFields',
              params: { max: LIMITS.fieldsPerTable },
            },
          ],
        };
        planned[position] = plan;
      }
      if (plan.kind === 'omitted' || plan.kind === 'deferredLink')
        plan.name = plan.source.name.trim().slice(0, LIMITS.nameLength);
      else {
        kept++;
        plan.name = uniqueName(names, plan.source.name, 'Field');
        renamed(plan, plan.source.name);
      }
      fields.set(fieldKey(source.id, plan.source.id), { table, plan });
    }
    return table;
  });

  // A link's other side is a field there too, unless it was made one way.  Both sides have to
  // agree before they're treated as a pair.
  const pairs = new Map<LinkPlan, LinkPlan>();
  const paired = new Set<LinkPlan>();
  const tableIds = new Set(tables.map((table) => table.source.id));
  for (const table of tables)
    for (const plan of table.fields) {
      if (plan.kind !== 'link' || paired.has(plan) || !plan.inverse || !tableIds.has(plan.linkedTable))
        continue;
      const other = fields.get(fieldKey(plan.linkedTable, plan.inverse));
      if (
        other?.plan.kind === 'link' &&
        other.plan !== plan &&
        !paired.has(other.plan) &&
        other.plan.inverse === plan.source.id &&
        other.plan.linkedTable === table.source.id
      ) {
        // The side whose cells name the linked records is made first, so its cells are the ones read.
        if (plan.read === null && other.plan.read !== null) pairs.set(other.plan, plan);
        else pairs.set(plan, other.plan);
        paired.add(plan);
        paired.add(other.plan);
      }
    }
  const occupied = new Map(
    tables.map((table) => [
      table.source.id,
      table.fields.filter((field) => field.kind !== 'omitted' && field.kind !== 'deferredLink').length,
    ]),
  );
  for (const table of tables)
    for (const [position, plan] of table.fields.entries()) {
      if (plan.kind !== 'link' || paired.has(plan) || !tableIds.has(plan.linkedTable)) continue;
      // An unpaired link creates another field on the target, including for a self link.
      if (occupied.get(plan.linkedTable)! < LIMITS.fieldsPerTable) {
        occupied.set(plan.linkedTable, occupied.get(plan.linkedTable)! + 1);
        continue;
      }
      const omitted: FieldPlan = {
        kind: 'omitted',
        source: plan.source,
        id: plan.id,
        name: plan.name,
        notes: [
          ...plan.notes,
          {
            status: 'omitted',
            key: 'import.platform.report.tooManyFields',
            params: { max: LIMITS.fieldsPerTable },
          },
        ],
      };
      table.fields[position] = omitted;
      fields.set(fieldKey(table.source.id, plan.source.id), { table, plan: omitted });
      occupied.set(table.source.id, occupied.get(table.source.id)! - 1);
    }
  return { tables, fields, pairs };
}

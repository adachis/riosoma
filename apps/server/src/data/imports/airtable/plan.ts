import { LIMITS, newId } from '@riosoma/contracts';
import { uniqueName } from '../core/names.js';
import type { AirtableSchema, AirtableTable } from './api.js';
import { planField, textOf, type FieldPlan, type LinkPlan, type Note, type ValuePlan } from './fields.js';

export { uniqueName } from '../core/names.js';

/**
 * The whole import worked out before anything is made: a table here for each table there, with
 * names made unique the way Riosoma needs them, a plan for each field, and each link paired with
 * the field that shows its other side.
 */

export interface TablePlan {
  source: AirtableTable;
  id: string;
  name: string;
  /** The grid view the table starts with */
  viewId: string;
  /** Every field, the primary first, then in Airtable's order */
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
  /** Every field, by its Airtable ID */
  fields: Map<string, Placed>;
  /** Links whose other side is also a field there, first of each pair to the second */
  pairs: Map<LinkPlan, LinkPlan>;
}

function renamed(plan: FieldPlan | TablePlan, original: string): void {
  if (plan.name !== original.trim())
    plan.notes.push({ status: 'changed', key: 'import.airtable.report.renamed', params: { from: original } });
}

export function planBase(schema: AirtableSchema): BasePlan {
  const tableIds = new Set(schema.tables.map((table) => table.id));
  const tableNames = new Set<string>();
  const fields = new Map<string, Placed>();
  const tables = schema.tables.map((source, index): TablePlan => {
    const primarySource =
      source.fields.find((field) => field.id === source.primaryFieldId) ?? source.fields[0];
    const others = source.fields.filter((field) => field !== primarySource);
    const planned = [
      ...(primarySource ? [planField(primarySource, { tables: tableIds, primary: true })] : []),
      ...others.map((field) => planField(field, { tables: tableIds, primary: false })),
    ];
    let primary = planned[0];
    if (!primary || primary.kind !== 'value') {
      // A primary Riosoma can't keep still names each record, as text.
      primary = {
        kind: 'value',
        source: primarySource ?? { id: newId('field'), name: 'Name', type: 'singleLineText' },
        id: newId('field'),
        name: primarySource?.name ?? 'Name',
        spec: { type: 'text', options: {} },
        read: textOf,
        notes: [{ status: 'changed', key: 'import.airtable.report.primaryText' }],
      };
      planned[0] = primary;
    }
    const table: TablePlan = {
      source,
      id: newId('table'),
      name: '',
      viewId: newId('view'),
      fields: planned,
      primary: primary as ValuePlan,
      notes: [],
    };
    table.name = uniqueName(tableNames, source.name, `Table ${index + 1}`);
    renamed(table, source.name);
    const names = new Set<string>();
    let kept = 0;
    for (const [index, planned_] of planned.entries()) {
      let plan = planned_;
      if (plan.kind !== 'omitted' && kept >= LIMITS.fieldsPerTable) {
        plan = {
          kind: 'omitted',
          source: plan.source,
          id: plan.id,
          name: plan.name,
          notes: [
            {
              status: 'omitted',
              key: 'import.airtable.report.tooManyFields',
              params: { max: LIMITS.fieldsPerTable },
            },
          ],
        };
        planned[index] = plan;
      }
      if (plan.kind === 'omitted') plan.name = plan.source.name.trim().slice(0, LIMITS.nameLength);
      else {
        kept++;
        plan.name = uniqueName(names, plan.source.name, 'Field');
        renamed(plan, plan.source.name);
      }
      fields.set(plan.source.id, { table, plan });
    }
    return table;
  });

  // A link's other side is a field there too, unless it was made one way.  Both sides have to
  // agree before they're treated as a pair.
  const pairs = new Map<LinkPlan, LinkPlan>();
  const paired = new Set<LinkPlan>();
  for (const table of tables)
    for (const plan of table.fields) {
      if (plan.kind !== 'link' || paired.has(plan) || !plan.inverse) continue;
      const other = fields.get(plan.inverse);
      if (
        other?.plan.kind === 'link' &&
        other.plan !== plan &&
        !paired.has(other.plan) &&
        other.plan.inverse === plan.source.id &&
        other.plan.linkedTable === table.source.id &&
        other.table.source.id === plan.linkedTable
      ) {
        pairs.set(plan, other.plan);
        paired.add(plan);
        paired.add(other.plan);
      }
    }
  return { tables, fields, pairs };
}

import { AppError } from '@riosoma/contracts';
import type { StoredField } from './types.js';

/**
 * Fields whose values only Riosoma writes.  A payment result field (its status, amount paid, and
 * reference) holds what Stripe reported, so it's marked `managed` in its stored definition, and
 * no person, visitor, import, merge, undo, or automation may change its values or its definition.
 *
 * The rule is checked in one place: the physical writers, `insertRecords` and `updateRecords`,
 * which every change to record values reaches, call `refuseManagedValues`.  Writers that restore
 * whole rows from an archive leave managed values out with `managedColumns`.  The payment service
 * alone makes a `ManagedGrant`, naming the exact records and fields it writes, and nothing else
 * gets through.
 */
export type Managed = 'payment';

/** Permission to write managed fields: these fields, in these records, and no others */
export interface ManagedGrant {
  readonly recordIds: ReadonlySet<string>;
  readonly fieldIds: ReadonlySet<string>;
}

export const managedRefused = () => new AppError('forbidden', 'payments.protected');

export function managedGrant(recordIds: Iterable<string>, fieldIds: Iterable<string>): ManagedGrant {
  return { recordIds: new Set(recordIds), fieldIds: new Set(fieldIds) };
}

/** Whether a grant covers this field in this record, when the field is managed */
export function granted(grant: ManagedGrant | undefined, recordId: string, field: StoredField): boolean {
  return Boolean(field.managed && grant?.fieldIds.has(field.id) && grant.recordIds.has(recordId));
}

/** Throws unless every value these rows give a managed field is one the grant covers. */
export function refuseManagedValues(
  fields: readonly StoredField[],
  rows: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
  grant?: ManagedGrant,
): void {
  const managed = new Map(fields.filter((field) => field.managed).map((field) => [field.id, field]));
  if (!managed.size) return;
  for (const row of rows)
    for (const id of Object.keys(row.values)) {
      const field = managed.get(id);
      if (field && !granted(grant, row.id, field)) throw managedRefused();
    }
}

/** The physical columns of a table's managed fields, which a restore from an archive leaves empty */
export function managedColumns(fields: readonly StoredField[]): Set<string> {
  return new Set(fields.filter((field) => field.managed).map((field) => field.columnName));
}

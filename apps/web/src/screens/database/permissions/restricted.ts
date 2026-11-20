import { createContext, useContext } from 'react';
import { msg } from '@lingui/core/macro';
import type { FieldMeta } from '@riosoma/contracts';

/**
 * Fields the person can't see still have IDs in settings they can read, such as a view's sorts or
 * a filter someone else made.  Wherever one turns up, the app names it "Restricted field" and
 * nothing more.  The database screen provides the IDs from the schema's access.
 */
export const RestrictedFields = createContext<ReadonlySet<string>>(new Set());

export function useRestrictedFields(): ReadonlySet<string> {
  return useContext(RestrictedFields);
}

/**
 * The fields a setting names, once each, that count for the person: their own fields, and the
 * ones they can't see, which show as "Restricted field".  One that no longer exists isn't counted.
 */
export function namedFields(
  ids: readonly string[],
  fields: readonly FieldMeta[],
  restricted: ReadonlySet<string>,
): string[] {
  const own = new Set(fields.map((field) => field.id));
  return [...new Set(ids)].filter((id) => own.has(id) || restricted.has(id));
}

export const restrictedFieldLabel = msg({ id: 'permissions.restrictedField', message: 'Restricted field' });
export const hiddenRecordLabel = msg({ id: 'permissions.hiddenRecord', message: 'Hidden record' });
export const restrictedMark = msg({
  id: 'permissions.mark.restricted',
  message: 'Restricted: only some people can see this field',
});
export const lockedMark = msg({
  id: 'permissions.mark.locked',
  message: 'Locked: only some people can change this field',
});

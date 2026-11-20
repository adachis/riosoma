import { msg } from '@lingui/core/macro';
import type { FieldMeta, FieldType } from '@riosoma/contracts';

/** Field types whose values links can follow, as the server decides.  A JSON field follows each string in its array. */
export const MATCHABLE_TYPES: readonly FieldType[] = [
  'json',
  'text',
  'email',
  'url',
  'phone',
  'number',
  'autoNumber',
  'recordId',
];

export function isMatchable(field: FieldMeta): boolean {
  return MATCHABLE_TYPES.includes(field.type);
}

/** A link that follows matching values, on either side.  Nobody edits its links by hand. */
export function followsValues(field: FieldMeta): boolean {
  return field.type === 'link' && Boolean(field.options.match);
}

export const matchedTooltip = msg({
  id: 'field.link.matchedTooltip',
  message: 'These links follow matching values, so they change when the values do.',
});

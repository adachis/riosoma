import { z } from 'zod';
import { FieldId, TableId } from './fields.js';

/**
 * What a schema read says about the reader's own access to fields and records.  The rules
 * themselves are in `permissions.ts`.
 */

/** A field someone can't see, as a placeholder: nothing about it but where it is. */
export const HiddenField = z.object({ id: FieldId, tableId: TableId, position: z.number() });
export type HiddenField = z.infer<typeof HiddenField>;

/** A visible field with a rule, as the person reading the schema sees it. */
export const FieldAccess = z.object({
  fieldId: FieldId,
  restricted: z.boolean(),
  locked: z.boolean(),
  /** Whether this person may change the field's values, as far as its lock goes */
  editable: z.boolean(),
});
export type FieldAccess = z.infer<typeof FieldAccess>;

/** What the schema says about the reader's own access.  Absent reads as no rules at all. */
export const SchemaAccess = z.object({
  hiddenFields: z.array(HiddenField),
  fields: z.array(FieldAccess),
  /** Tables where a record rule limits which records this person sees */
  limitedTables: z.array(TableId),
  /** Tables with any record rule, for people who can change the schema */
  ruledTables: z.array(TableId),
});
export type SchemaAccess = z.infer<typeof SchemaAccess>;

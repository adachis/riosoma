import { z } from 'zod';
import { FieldId, TableId, UserId } from './fields.js';
import { FilterGroup, isGroup, type FilterCondition } from './filters.js';
import { DatabaseRole } from './schema.js';

/**
 * Field and record permissions, on top of each person's role in the database.
 *
 * A field can be **restricted**, so only the people a rule names see it, and separately **locked**,
 * so only the people a rule names change its values.  A table can have **record rules**, each
 * saying which records the roles and people it names see.  The database's owners always see and
 * change everything.  The server enforces all of it in the queries it runs, and what it sends a
 * client is already limited to what that person may see.
 */

export const LIMITS_PERMISSIONS = {
  /** People one rule can name */
  usersPerRule: 500,
  /** Record rules on one table */
  rulesPerTable: 50,
} as const;

/** The roles and people a rule names.  Anyone matching either is named. */
export const PermissionAudience = z.object({
  roles: z.array(DatabaseRole).max(5),
  users: z.array(UserId).max(LIMITS_PERMISSIONS.usersPerRule),
});
export type PermissionAudience = z.infer<typeof PermissionAudience>;

/** Whether an audience names someone with this role or ID. */
export function audienceNames(
  audience: PermissionAudience | null | undefined,
  person: { userId: string; role: DatabaseRole | null },
): boolean {
  if (!audience) return false;
  return (
    audience.users.includes(person.userId) || (person.role !== null && audience.roles.includes(person.role))
  );
}

/** One field's rules.  Null means the field has no such rule. */
export const FieldPermissions = z.object({
  fieldId: FieldId,
  /** Only these people, and the database's owners, see the field, anything computed from it, and its name */
  restricted: PermissionAudience.nullable(),
  /** Only these people, and the database's owners, change the field's values */
  locked: PermissionAudience.nullable(),
});
export type FieldPermissions = z.infer<typeof FieldPermissions>;

/** `PUT /api/fields/:fieldId/permissions` */
export const SetFieldPermissions = FieldPermissions.omit({ fieldId: true });
export type SetFieldPermissions = z.infer<typeof SetFieldPermissions>;

export const RecordRuleId = z.string().regex(/^rul[0-9A-Za-z]{14}$/);

/**
 * In a record rule's condition, a person or created-by field compared with this value compares
 * with whoever is reading.  It stands where a person's ID would go, alone or in a list.
 */
export const CURRENT_PERSON = 'currentPerson';

/**
 * "The roles and people named here see only records where the condition holds."  A person named by
 * several of a table's rules sees the records any of them allows.  Someone none of them names is
 * not limited by them.
 */
export const RecordRule = z
  .object({
    id: RecordRuleId,
    roles: z.array(DatabaseRole).max(5),
    users: z.array(UserId).max(LIMITS_PERMISSIONS.usersPerRule),
    condition: FilterGroup,
  })
  .refine((rule) => rule.roles.length + rule.users.length > 0, {
    message: 'a rule names at least one role or person',
  })
  .refine((rule) => countConditions(rule.condition) > 0, { message: 'a rule has a condition' });
export type RecordRule = z.infer<typeof RecordRule>;

function countConditions(group: FilterGroup): number {
  return group.conditions.reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);
}

/** `PUT /api/tables/:tableId/record-rules`: the table's whole list, in order */
export const SetRecordRules = z.object({
  rules: z.array(RecordRule).max(LIMITS_PERMISSIONS.rulesPerTable),
});
export type SetRecordRules = z.infer<typeof SetRecordRules>;

/** `GET /api/tables/:tableId/permissions`: every rule on a table, for the people who manage them */
export const TablePermissions = z.object({
  tableId: TableId,
  /** Only fields that have a rule */
  fields: z.array(FieldPermissions),
  records: z.array(RecordRule),
});
export type TablePermissions = z.infer<typeof TablePermissions>;

/** Whether a condition compares a person or created-by field with whoever is reading. */
export function usesCurrentPerson(condition: FilterCondition): boolean {
  const value = condition.value;
  return value === CURRENT_PERSON || (Array.isArray(value) && value.includes(CURRENT_PERSON));
}

import {
  FilterGroup,
  PermissionAudience,
  type DatabaseRole,
  type FieldPermissions,
  type RecordRule,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';

/**
 * Reads and writes the rows behind field and record permissions.  Who may change them, and what
 * a change means for everyone else, lives in `routes.ts`.  `AccessScope` reads them for every
 * question about access.
 */

export interface StoredFieldRules extends FieldPermissions {
  tableId: string;
}

export interface StoredRecordRule extends RecordRule {
  tableId: string;
}

export interface DatabaseRules {
  fields: StoredFieldRules[];
  records: StoredRecordRule[];
}

/**
 * A stored audience that no longer reads, as after a role was renamed, names nobody, so a
 * restriction keeps everyone but the owners out and a lock keeps everyone but them from editing.
 */
function audience(stored: unknown): PermissionAudience | null {
  if (stored === null || stored === undefined) return null;
  const parsed = PermissionAudience.safeParse(stored);
  return parsed.success ? parsed.data : { roles: [], users: [] };
}

/** Every field and record rule in a database, in two queries. */
export async function loadDatabaseRules(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<DatabaseRules> {
  const fields = await query<{ field_id: string; table_id: string; restricted: unknown; locked: unknown }>(
    db,
    sql`SELECT field_id, table_id, restricted, locked FROM ${ident(schemas.app, 'field_permissions')}
         WHERE database_id = ${databaseId} ORDER BY field_id`,
  );
  const records = await query<{
    id: string;
    table_id: string;
    roles: DatabaseRole[];
    users: string[];
    condition: unknown;
  }>(
    db,
    sql`SELECT id, table_id, roles, users, condition FROM ${ident(schemas.app, 'record_rules')}
         WHERE database_id = ${databaseId} ORDER BY table_id, position, id`,
  );
  return {
    fields: fields.rows.map((row) => {
      const restricted = audience(row.restricted);
      const locked = audience(row.locked);
      return { fieldId: row.field_id, tableId: row.table_id, restricted, locked };
    }),
    records: records.rows.map((row) => {
      // A condition that no longer reads matches nothing, so the rule shows its people no records.
      const condition = FilterGroup.safeParse(row.condition);
      return {
        id: row.id,
        tableId: row.table_id,
        roles: row.roles,
        users: row.users,
        condition: condition.success ? condition.data : { conjunction: 'and', conditions: [] },
      };
    }),
  };
}

/** Sets or clears one field's rules.  Both null removes the row. */
export async function saveFieldRules(
  db: Queryable,
  schemas: DataSchemas,
  target: { orgId: string; databaseId: string; tableId: string; fieldId: string },
  rules: Pick<FieldPermissions, 'restricted' | 'locked'>,
  actorId: string,
): Promise<void> {
  if (!rules.restricted && !rules.locked) {
    await query(
      db,
      sql`DELETE FROM ${ident(schemas.app, 'field_permissions')} WHERE field_id = ${target.fieldId}`,
    );
    return;
  }
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'field_permissions')}
        (field_id, org_id, database_id, table_id, restricted, locked, updated_by)
      VALUES (${target.fieldId}, ${target.orgId}, ${target.databaseId}, ${target.tableId},
        ${rules.restricted ? JSON.stringify(rules.restricted) : null}::jsonb,
        ${rules.locked ? JSON.stringify(rules.locked) : null}::jsonb, ${actorId})
      ON CONFLICT (field_id) DO UPDATE SET restricted = EXCLUDED.restricted, locked = EXCLUDED.locked,
        updated_by = EXCLUDED.updated_by, updated_at = statement_timestamp()`,
  );
}

/** Replaces a table's record rules with this list, in its order. */
export async function saveRecordRules(
  db: Queryable,
  schemas: DataSchemas,
  target: { orgId: string; databaseId: string; tableId: string },
  rules: readonly RecordRule[],
  actorId: string,
): Promise<void> {
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'record_rules')} WHERE table_id = ${target.tableId}`);
  for (const [position, rule] of rules.entries()) {
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'record_rules')}
          (id, org_id, database_id, table_id, position, roles, users, condition, updated_by)
        VALUES (${rule.id}, ${target.orgId}, ${target.databaseId}, ${target.tableId}, ${position},
          ${rule.roles}::text[], ${rule.users}::text[], ${JSON.stringify(rule.condition)}::jsonb, ${actorId})`,
    );
  }
}

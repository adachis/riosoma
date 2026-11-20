import {
  AppError,
  ClassificationLabels,
  ClassificationRules,
  RETENTION_DEFAULTS,
  RetentionPolicy,
  type ClassificationLabel,
  type GovernanceView,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from './context.js';
import type { AccessScope } from './access.js';

export type ClassificationUse =
  'public' | 'export' | 'provider' | 'external' | 'guest' | 'guestSharing' | 'recipient';
const RULE_FOR_USE = {
  public: 'noPublicLinks',
  export: 'noExport',
  provider: 'noProviders',
  external: 'noExternalSharing',
  guest: 'maskGuests',
  guestSharing: 'noExternalSharing',
  recipient: 'noExternalSharing',
} as const;

/** Every destination uses the same decision, including access granted before a label changed. */
export function classificationAllows(rules: ClassificationRules, use: ClassificationUse): boolean {
  return (
    !rules[RULE_FOR_USE[use]] &&
    (use !== 'public' || !rules.noExternalSharing) &&
    ((use !== 'public' && use !== 'recipient') || !rules.maskGuests)
  );
}

export const EMPTY_CLASSIFICATION = ClassificationRules.parse({});
const CLOSED_CLASSIFICATION = ClassificationRules.parse({
  noPublicLinks: true,
  noExport: true,
  noProviders: true,
  noExternalSharing: true,
  maskGuests: true,
});

export interface ClassificationTree {
  database: ClassificationRules;
  tables: Map<string, ClassificationRules>;
  fields: Map<string, ClassificationRules>;
}

/** Missing or malformed labels fail closed until an administrator repairs the assignment. */
export async function loadClassification(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  databaseId: string,
): Promise<ClassificationTree> {
  const parent = await query<{ classification_labels: unknown; classification_label: string | null }>(
    db,
    sql`SELECT o.classification_labels, d.classification_label FROM ${ident(schemas.app, 'databases')} d
    JOIN ${ident(schemas.app, 'orgs')} o ON o.id = d.org_id WHERE d.id = ${databaseId} AND d.org_id = ${orgId}`,
  );
  const row = parent.rows[0];
  const parsed = ClassificationLabels.safeParse(row?.classification_labels ?? []);
  const labels = new Map<string, ClassificationLabel>(
    (parsed.success ? parsed.data : []).map((label) => [label.id, label]),
  );
  const resolve = (id: string | null, inherited: ClassificationRules) =>
    id === null ? inherited : (labels.get(id)?.rules ?? CLOSED_CLASSIFICATION);
  const database = resolve(row?.classification_label ?? null, EMPTY_CLASSIFICATION);
  const tables = await query<{ id: string; classification_label: string | null }>(
    db,
    sql`SELECT id, classification_label FROM ${ident(schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const tableRules = new Map(
    tables.rows.map((table) => [table.id, { ...resolve(table.classification_label, database) }]),
  );
  const fields = await query<{ id: string; table_id: string; classification_label: string | null }>(
    db,
    sql`SELECT f.id, f.table_id, f.classification_label FROM ${ident(schemas.app, 'fields')} f
    JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id WHERE t.database_id = ${databaseId}`,
  );
  return {
    database,
    tables: tableRules,
    fields: new Map(
      fields.rows.map((field) => [
        field.id,
        { ...resolve(field.classification_label, tableRules.get(field.table_id) ?? database) },
      ]),
    ),
  };
}

export async function retentionFor(db: Queryable, schemas: DataSchemas, orgId: string, databaseId?: string) {
  const result = await query<{ organization: unknown; database: unknown; legal_hold: boolean }>(
    db,
    sql`SELECT o.retention_policy AS organization,
      COALESCE(d.retention_policy, o.retired_database_retention->${databaseId ?? ''}) AS database,
      COALESCE(d.legal_hold, false) AS legal_hold
    FROM ${ident(schemas.app, 'orgs')} o LEFT JOIN ${ident(schemas.app, 'databases')} d
    ON d.org_id = o.id AND d.id = ${databaseId ?? null} WHERE o.id = ${orgId}`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  const organization = RetentionPolicy.parse(row.organization);
  const policy = databaseId ? RetentionPolicy.parse(row.database ?? {}) : organization;
  const effective = { ...RETENTION_DEFAULTS, ...organization, ...policy };
  // A database can extend the organization's audit window, including keeping events indefinitely.
  const organizationAudit = organization.auditDays ?? RETENTION_DEFAULTS.auditDays;
  if (databaseId && organizationAudit === null) effective.auditDays = null;
  else if (databaseId && effective.auditDays !== null && organizationAudit !== null)
    effective.auditDays = Math.max(effective.auditDays, organizationAudit);
  if (effective.auditDays !== null) {
    const floors = await query<{ days: number }>(
      db,
      sql`SELECT GREATEST(365,
      COALESCE((o.settings->'unitPolicy'->'values'->>'auditRetentionDays')::integer, 365),
      COALESCE((SELECT max((u.policy->>'auditRetentionDays')::integer) FROM ${ident(schemas.app, 'org_units')} u
        WHERE u.org_id = o.id AND o.settings->'unitPolicy'->'overridable' ? 'auditRetentionDays'), 365)) AS days
      FROM ${ident(schemas.app, 'orgs')} o WHERE o.id = ${orgId}`,
    );
    effective.auditDays = Math.max(effective.auditDays, floors.rows[0]?.days ?? 365);
  }
  return { policy, effective, legalHold: row.legal_hold };
}

export async function governanceView(
  scope: AccessScope,
  db: Queryable,
  schemas: DataSchemas,
  databaseId?: string,
): Promise<GovernanceView> {
  await scope.requireOrganizationAdmin('security');
  if (databaseId) await scope.requireGovernanceDatabase(databaseId);
  const org = await query<{ classification_labels: unknown }>(
    db,
    sql`SELECT classification_labels FROM ${ident(schemas.app, 'orgs')} WHERE id = ${scope.actor.orgId}`,
  );
  const catalog = await query<{ id: string; name: string }>(
    db,
    sql`SELECT id, name FROM ${ident(schemas.app, 'databases')}
    WHERE org_id = ${scope.actor.orgId} ORDER BY name, id`,
  );
  const names = Object.fromEntries(catalog.rows.map(({ id, name }) => [id, name]));
  const assignments: GovernanceView['assignments'] = [];
  if (databaseId) {
    const databases = await query<{ classification_label: string | null }>(
      db,
      sql`SELECT classification_label FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId}`,
    );
    assignments.push({
      target: { kind: 'database', databaseId },
      labelId: databases.rows[0]!.classification_label,
    });
    const tables = await query<{ id: string; name: string; classification_label: string | null }>(
      db,
      sql`SELECT id, name, classification_label FROM ${ident(schemas.app, 'tables')} WHERE database_id = ${databaseId} AND trashed_at IS NULL`,
    );
    for (const table of tables.rows) {
      names[table.id] = table.name;
      assignments.push({
        target: { kind: 'table', databaseId, tableId: table.id },
        labelId: table.classification_label,
      });
    }
    const fields = await query<{
      id: string;
      name: string;
      table_id: string;
      classification_label: string | null;
    }>(
      db,
      sql`SELECT f.id, f.name, f.table_id, f.classification_label FROM ${ident(schemas.app, 'fields')} f
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id WHERE t.database_id = ${databaseId} AND t.trashed_at IS NULL AND f.trashed_at IS NULL`,
    );
    for (const field of fields.rows) {
      names[field.id] = field.name;
      assignments.push({
        target: { kind: 'field', databaseId, fieldId: field.id },
        labelId: field.classification_label,
      });
    }
  }
  return {
    databases: catalog.rows,
    names,
    labels: ClassificationLabels.parse(org.rows[0]?.classification_labels ?? []),
    assignments,
    ...(await retentionFor(db, schemas, scope.actor.orgId, databaseId)),
  };
}

/** A changed policy invalidates already assembled provider input before its next call. */
export async function classificationRevision(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
): Promise<string> {
  const result = await query<{ classification_revision: string }>(
    db,
    sql`SELECT classification_revision FROM ${ident(schemas.app, 'orgs')} WHERE id = ${orgId}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return String(result.rows[0].classification_revision);
}

export async function requireClassificationRevision(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  revision: string,
): Promise<void> {
  if ((await classificationRevision(db, schemas, orgId)) !== revision)
    throw new AppError('forbidden', 'governance.classificationDenied');
}

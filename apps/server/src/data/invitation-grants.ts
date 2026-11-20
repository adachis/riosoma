import {
  AppError,
  DATABASE_ROLES,
  type DatabaseRole,
  type SharingAction,
  type SharingInvitations,
  type UnitPolicyValues,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { auditEvent } from '../auth/database.js';
import type { Actor } from '../http/policy.js';
import { effectivePolicy } from '../org-units/policy.js';
import { organizationAdmin } from '../org-units/store.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { accessChannel, homeChannel } from './notify.js';

export type ShareResource = SharingAction['resource'];

export async function requireShareAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  resource: ShareResource,
) {
  const scope = new AccessScope(db, schemas, actor);
  if (resource.kind === 'database') await scope.require(resource.id, 'manage');
  else await scope.requireFolder(resource.id, 'manage');
  return scope;
}

export async function requireInvitationDomain(
  db: Queryable,
  schema: string,
  actor: { orgId: string; userId: string },
  email: string,
  policy?: UnitPolicyValues,
) {
  const values =
    policy ?? (await effectivePolicy(db, `"${schema}"`, actor.orgId, { userId: actor.userId })).values;
  const domains = values.allowedEmailDomains;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (domains?.length && !domains.includes(domain))
    throw new AppError('forbidden', 'share.invite.domains', { params: { domains: domains.join(', ') } });
  return values;
}

export async function requireSharingInvitation(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  resource: ShareResource,
  email: string,
) {
  const scope = await requireShareAccess(db, schemas, actor, resource);
  const { values: policy } = await effectivePolicy(db, `"${schemas.app}"`, actor.orgId, {
    userId: actor.userId,
  });
  if (
    !policy.newPeopleSharing ||
    !policy.externalSharing ||
    (policy.newPeopleRole === 'guest' && !policy.guestInvitations)
  )
    throw new AppError('forbidden', 'share.invite.membersOnly');
  if (policy.newPeopleAdministratorsOnly && !organizationAdmin(actor, 'people'))
    throw new AppError('forbidden', 'share.invite.administratorsOnly');
  await requireInvitationDomain(db, schemas.app, actor, email, policy);
  if (policy.newPeopleRole === 'guest' && resource.kind === 'database')
    await scope.requireUse(resource.id, 'guestSharing');
  else if (policy.newPeopleRole === 'guest') {
    const databases = await query<{ database_id: string }>(
      db,
      sql`SELECT database_id FROM ${ident(schemas.app, 'folder_databases')} fd
      JOIN ${ident(schemas.app, 'folders')} f ON f.id = fd.folder_id AND f.org_id = fd.org_id
      WHERE fd.org_id = ${actor.orgId} AND (f.id = ${resource.id} OR f.path @> ARRAY[${resource.id}])`,
    );
    for (const row of databases.rows) await scope.requireUse(row.database_id, 'guestSharing');
  }
  return policy;
}

export async function pendingShares(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  resource: ShareResource,
) {
  await requireShareAccess(db, schemas, actor, resource);
  return (
    await query<{ id: string; email: string; role: DatabaseRole; expiresAt: Date }>(
      db,
      sql`
    SELECT i.id, i.email, g.role, i.expires_at AS "expiresAt"
    FROM ${ident(schemas.app, 'invitation_grants')} g JOIN ${ident(schemas.app, 'invitations')} i ON i.id = g.invitation_id AND i.org_id = g.org_id
    WHERE g.org_id = ${actor.orgId} AND g.resource_kind = ${resource.kind} AND g.resource_id = ${resource.id}
      AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp() ORDER BY i.email, i.id`,
    )
  ).rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString() }));
}

export async function sharingInvitations(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  resource: ShareResource,
  ctx: AppContext,
): Promise<SharingInvitations> {
  const pending = await pendingShares(db, schemas, actor, resource);
  const { values } = await effectivePolicy(db, `"${schemas.app}"`, actor.orgId, { userId: actor.userId });
  const enabled =
    values.newPeopleSharing &&
    values.externalSharing &&
    (values.newPeopleRole !== 'guest' || values.guestInvitations);
  const refusal = !enabled
    ? 'membersOnly'
    : values.newPeopleAdministratorsOnly && !organizationAdmin(actor, 'people')
      ? 'administratorsOnly'
      : null;
  return {
    allowed: refusal === null,
    refusal,
    administratorsOnly: values.newPeopleAdministratorsOnly,
    domains: values.allowedEmailDomains ?? [],
    kind: values.newPeopleRole,
    mailAvailable: Boolean(ctx.mailer && ctx.config.baseUrl),
    pending,
  };
}

/** Acceptance is the only step that converts pending shares into access. */
export async function acceptInvitationGrants(
  db: Queryable,
  schemas: DataSchemas,
  audit: string,
  actor: Pick<Actor, 'orgId' | 'userId'>,
  invitationId: string,
) {
  const grants = await query<{
    resource_kind: 'database' | 'folder';
    resource_id: string;
    role: DatabaseRole;
    created_by: string | null;
  }>(
    db,
    sql`
    DELETE FROM ${ident(schemas.app, 'invitation_grants')} WHERE org_id = ${actor.orgId} AND invitation_id = ${invitationId} RETURNING *`,
  );
  const available = new Set<string>();
  // Lock all items before auditing so concurrent sharing cannot wait on an audit lock we hold.
  for (const kind of ['database', 'folder'] as const) {
    const rows = await query<{ id: string }>(
      db,
      sql`SELECT id FROM ${ident(schemas.app, kind === 'database' ? 'databases' : 'folders')}
      WHERE org_id = ${actor.orgId} AND trashed_at IS NULL
        AND id = ANY(${grants.rows.filter((grant) => grant.resource_kind === kind).map((grant) => grant.resource_id)}::text[])
      ORDER BY id FOR UPDATE`,
    );
    for (const row of rows.rows) available.add(`${kind}:${row.id}`);
  }
  let destination: string | undefined;
  for (const grant of grants.rows) {
    if (!available.has(`${grant.resource_kind}:${grant.resource_id}`)) continue;
    const applied = await query<{ role: DatabaseRole }>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
      VALUES (${actor.orgId}, ${grant.resource_kind}, ${grant.resource_id}, 'user', ${actor.userId}, ${grant.role}, ${grant.created_by})
      ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE
      SET role = CASE WHEN array_position(${[...DATABASE_ROLES]}::text[], EXCLUDED.role) <
        array_position(${[...DATABASE_ROLES]}::text[], ${ident(schemas.app, 'grants')}.role)
        THEN EXCLUDED.role ELSE ${ident(schemas.app, 'grants')}.role END
      RETURNING role`,
    );
    await auditEvent(db, audit, 'data.share.accepted', actor, {
      invitationId,
      resourceKind: grant.resource_kind,
      resourceId: grant.resource_id,
      role: applied.rows[0]!.role,
      invitedBy: grant.created_by,
    });
    if (grant.resource_kind === 'database') {
      destination ??= `/${encodeURIComponent(grant.resource_id)}`;
      await query(db, sql`SELECT pg_notify(${accessChannel(schemas)}, ${grant.resource_id})`);
    } else destination ??= `/home/folders/${encodeURIComponent(grant.resource_id)}`;
  }
  if (grants.rowCount)
    await query(
      db,
      sql`SELECT pg_notify(${homeChannel(schemas)}, json_build_object('orgId', ${actor.orgId}::text, 'userId', ${actor.userId}::text)::text)`,
    );
  return destination;
}

export async function removeInvitationGrants(
  db: Queryable,
  schema: string,
  orgId: string,
  invitationId: string,
) {
  await query(
    db,
    sql`DELETE FROM ${ident(schema, 'invitation_grants')} WHERE org_id = ${orgId} AND invitation_id = ${invitationId}`,
  );
}

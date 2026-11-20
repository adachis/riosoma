import { createHash } from 'node:crypto';
import { AppError, type HomeItemAction, type SharingAction } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { auditEvent, authDatabase, lockKeys, randomToken, tokenHash } from '../../auth/database.js';
import { createInvitation } from '../../sharing/invitations.js';
import { invitationMessage } from '../../mail/messages.js';
import { pendingShares, requireShareAccess, requireSharingInvitation } from '../invitation-grants.js';
import type { CommandContext } from './context.js';

export function isSharingAction(action: HomeItemAction): action is SharingAction {
  return action.kind.startsWith('share.');
}

async function pending(c: CommandContext, action: Exclude<SharingAction, { kind: 'share.invite' }>) {
  const row = (await pendingShares(c.db, c.schemas, c.actor, action.resource)).find(
    (row) => row.id === action.invitationId,
  );
  if (!row) throw new AppError('not_found', 'errors.notFound');
  return row;
}

export async function authorizeSharing(c: CommandContext, action: SharingAction) {
  await requireShareAccess(c.db, c.schemas, c.actor, action.resource);
  if (action.kind === 'share.revoke') {
    await pending(c, action);
    return;
  }
  const email = action.kind === 'share.invite' ? action.email : (await pending(c, action)).email;
  await requireSharingInvitation(c.db, c.schemas, c.actor, action.resource, email);
}

export async function sharingGuard(c: CommandContext, action: SharingAction) {
  const rows = await pendingShares(c.db, c.schemas, c.actor, action.resource);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function applySharing(c: CommandContext, action: SharingAction): Promise<SharingAction> {
  await lockKeys(c.db, [`invitations:${c.actor.orgId}`]);
  // Check access after the resource lock so a waiting invitation cannot use a revoked owner grant.
  await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, action.resource.kind === 'database' ? 'databases' : 'folders')}
    WHERE org_id = ${c.actor.orgId} AND id = ${action.resource.id} FOR UPDATE`,
  );
  await requireShareAccess(c.db, c.schemas, c.actor, action.resource);
  if (action.kind === 'share.revoke') {
    const row = await pending(c, action);
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'invitation_grants')} WHERE org_id = ${c.actor.orgId}
      AND invitation_id = ${row.id} AND resource_kind = ${action.resource.kind} AND resource_id = ${action.resource.id}`,
    );
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'invitations')} SET expires_at = clock_timestamp()
      WHERE id = ${row.id} AND org_id = ${c.actor.orgId} AND NOT EXISTS (SELECT 1 FROM ${ident(c.schemas.app, 'invitation_grants')} WHERE invitation_id = ${row.id})`,
    );
    await auditEvent(c.db, authDatabase(c.appContext!).audit, 'org.invitation.share_revoked', c.actor, {
      invitationId: row.id,
      email: row.email,
      resource: action.resource,
      role: row.role,
    });
    return { kind: 'share.invite', resource: action.resource, email: row.email, role: row.role };
  }
  const resending = action.kind === 'share.resend' ? await pending(c, action) : undefined;
  const email = action.kind === 'share.invite' ? action.email : resending!.email;
  const policy = await requireSharingInvitation(c.db, c.schemas, c.actor, action.resource, email);
  // Lookup is confined to this organization, so another account elsewhere produces the same result.
  const member = await query(
    c.db,
    sql`SELECT m.user_id FROM ${ident(c.schemas.app, 'memberships')} m
    JOIN ${ident(c.schemas.app, 'users')} u ON u.id = m.user_id WHERE m.org_id = ${c.actor.orgId} AND lower(u.email) = ${email}`,
  );
  if (member.rowCount) throw new AppError('conflict', 'share.invite.alreadyMember');
  const ctx = c.appContext!;
  const { audit } = authDatabase(ctx);
  const attempt = `sharing:${c.actor.orgId}:${c.actor.userId}`;
  const { retryAfter, recordAttempts } = await import('../../auth/attempts.js');
  const wait = await retryAfter(c.db, `"${c.schemas.app}"`, attempt, 50, 900);
  if (wait)
    throw new AppError('rate_limited', 'share.invite.tooMany', { params: { retryAfterSeconds: wait } });
  await recordAttempts(c.db, `"${c.schemas.app}"`, [attempt]);
  let id: string;
  let token: string;
  const previous =
    action.kind === 'share.invite'
      ? (await pendingShares(c.db, c.schemas, c.actor, action.resource)).find((row) => row.email === email)
      : undefined;
  const mailAvailable = Boolean(ctx.mailer && ctx.config.baseUrl);
  if (action.kind === 'share.resend' && mailAvailable) {
    id = action.invitationId;
    token = randomToken();
    await query(
      c.db,
      // The replacement link reaches only the invited mailbox, whoever held the one before it.
      sql`UPDATE ${ident(c.schemas.app, 'invitations')} SET token_hash = ${tokenHash(token)}, copied = false, expires_at = clock_timestamp() + interval '168 hours'
      WHERE id = ${id} AND org_id = ${c.actor.orgId} AND accepted_at IS NULL AND expires_at > clock_timestamp()`,
    );
  } else {
    const created = await createInvitation(c.db, c.schemas.app, c.actor, {
      email,
      kind: policy.newPeopleRole,
      ...(!mailAvailable
        ? { shareScope: await requireShareAccess(c.db, c.schemas, c.actor, action.resource) }
        : {}),
    });
    id = created.invitation.id;
    token = created.token;
    await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'invitation_grants')} (org_id, invitation_id, resource_kind, resource_id, role, created_by)
      VALUES (${c.actor.orgId}, ${id}, ${action.resource.kind}, ${action.resource.id}, ${action.kind === 'share.invite' ? action.role : resending!.role}, ${c.actor.userId})
      ON CONFLICT (invitation_id, resource_kind, resource_id) DO UPDATE SET role = EXCLUDED.role, created_by = EXCLUDED.created_by`,
    );
  }
  const link = `${ctx.config.baseUrl?.replace(/\/+$/, '') ?? ''}/join#token=${token}`;
  if (ctx.mailer && ctx.config.baseUrl) {
    const identity = (
      await query<{ name: string; org: string }>(
        c.db,
        sql`SELECT u.name, o.name AS org FROM ${ident(c.schemas.app, 'users')} u
      JOIN ${ident(c.schemas.app, 'orgs')} o ON o.id = ${c.actor.orgId} WHERE u.id = ${c.actor.userId}`,
      )
    ).rows[0]!;
    const item = (
      await query<{ name: string }>(
        c.db,
        sql`SELECT name FROM ${ident(c.schemas.app, action.resource.kind === 'database' ? 'databases' : 'folders')}
      WHERE org_id = ${c.actor.orgId} AND id = ${action.resource.id}`,
      )
    ).rows[0]!;
    const message = invitationMessage(email, 'en-US', identity.org, identity.name, link, item.name);
    (c.invitationDeliveries ??= []).push(message);
  } else c.invitationLink = link;
  await auditEvent(
    c.db,
    audit,
    action.kind === 'share.resend' ? 'org.invitation.resent' : 'org.invitation.created',
    c.actor,
    {
      invitationId: id,
      email,
      resource: action.resource,
      ...(action.kind === 'share.invite' ? { role: action.role } : {}),
    },
  );
  if (action.kind === 'share.resend')
    return { kind: 'share.resend', resource: action.resource, invitationId: id };
  return previous
    ? { kind: 'share.invite', resource: action.resource, email, role: previous.role }
    : { kind: 'share.revoke', resource: action.resource, invitationId: id };
}

import { eraseExpiredLibraryReviews } from '../data/library-review-cleanup.js';
import { requirePolicy } from '../org-units/policy.js';
import type { FastifyInstance } from 'fastify';
import {
  AcceptInvitation,
  AppError,
  InvitePeople,
  levelsFor,
  newId,
  type Invitation,
  type OrgSettings,
  type InvitationPreview,
  type InviteResult,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import { attemptKey, pruneAttempts, recordAttempts, retryAfter } from '../auth/attempts.js';
import { auditEvent, authDatabase, lockKeys, randomToken, tokenHash } from '../auth/database.js';
import { allowedLevel } from '../auth/levels.js';
import { afterFirstStep, sendFirstStep } from '../auth/mfa/pending.js';
import { findIdentity, requireActor, sessionInfo } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { restoreInvitationMembership } from '../data/invitation-membership.js';
import { parse } from '../http/validate.js';
import { AccessScope } from '../data/access.js';
import { mailFailureFields, type MailMessage } from '../mail/index.js';
import { invitationMessage } from '../mail/messages.js';
import { INVITATION_COOKIE } from '../auth/invitation-cookie.js';
import { writeCookie } from '../auth/mfa/cookies.js';
import {
  acceptInvitationGrants,
  removeInvitationGrants,
  requireInvitationDomain,
  sharingInvitations,
} from '../data/invitation-grants.js';

const InvitationParams = z.object({ id: z.string().min(1).max(200) });
const PreviewParams = z.object({ token: AcceptInvitation.shape.token });

interface InvitationRow {
  reserved_user_id?: string | null;
  id: string;
  email: string;
  kind: Invitation['kind'];
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
}

function invitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    kind: row.kind,
    invitedBy: row.invited_by,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError('not_found', 'errors.notFound');
}

/**
 * Invites one address, replacing any invitation still waiting for it.  The kind is always the one
 * asked for.  Copyable sharing links fold only grants the caller can manage.  Other grants and
 * imported invitations retain their original credentials.  A person an import found keeps their
 * imported ID only through a live invitation.  One revoked or expired gives nothing to a new one.
 * No invitation ever takes a kind or admin roles from an imported one.  A link handed to its sharer
 * is recorded as copied, since holding it proves nothing about the address.  The caller holds the
 * organization's invitation lock.
 */
export async function createInvitation(
  db: Queryable,
  schema: string,
  actor: { orgId: string; userId: string },
  input: {
    email: string;
    kind: Invitation['kind'];
    reservedUserId?: string;
    displayName?: string;
    shareScope?: AccessScope;
  },
): Promise<{ invitation: Invitation; token: string }> {
  await requireInvitationDomain(db, schema, actor, input.email);
  const prior = await query<{ id: string; reserved_user_id: string | null; display_name: string }>(
    db,
    sql`SELECT id, reserved_user_id, display_name FROM ${ident(schema, 'invitations')} WHERE org_id = ${actor.orgId}
    AND lower(email) = ${input.email.toLowerCase()} AND accepted_at IS NULL AND expires_at > clock_timestamp()
    ORDER BY created_at DESC, id`,
  );
  if (input.kind === 'guest') {
    await requirePolicy(db, `"${schema}"`, actor, 'guestInvitations', 'externalSharing');
  }
  const email = input.email.toLowerCase();
  // Imported relationships require their original invitation, rather than an item owner's link.
  const foldable = prior.rows.filter((row) => !input.shareScope || !row.reserved_user_id);
  const managed = input.shareScope
    ? await input.shareScope.manageableInvitationGrants(foldable.map((row) => row.id))
    : undefined;
  const imported = input.reservedUserId
    ? { reserved_user_id: input.reservedUserId, display_name: input.displayName ?? '' }
    : foldable.find((row) => row.reserved_user_id);
  const token = randomToken();
  const inserted = await query<InvitationRow>(
    db,
    sql`
    INSERT INTO ${ident(schema, 'invitations')}
      (id, org_id, email, kind, token_hash, invited_by, expires_at, reserved_user_id, display_name, copied)
    VALUES (${newId('invitation')}, ${actor.orgId}, ${email}, ${input.kind},
      ${tokenHash(token)}, ${actor.userId}, clock_timestamp() + interval '168 hours',
      ${imported?.reserved_user_id ?? null}, ${imported?.display_name ?? ''}, ${Boolean(input.shareScope)})
    RETURNING id, email, kind, invited_by, created_at, expires_at`,
  );
  const created = invitation(inserted.rows[0]!);
  for (const previous of foldable) {
    const resources = managed?.filter((grant) => grant.invitation_id === previous.id);
    if (resources && !resources.length) continue;
    await query(
      db,
      sql`INSERT INTO ${ident(schema, 'invitation_grants')} (org_id, invitation_id, resource_kind, resource_id, role, created_by)
      SELECT org_id, ${created.id}, resource_kind, resource_id, role, created_by FROM ${ident(schema, 'invitation_grants')}
      WHERE org_id = ${actor.orgId} AND invitation_id = ${previous.id}
        ${resources ? sql`AND (resource_kind || ':' || resource_id) = ANY(${resources.map((grant) => `${grant.resource_kind}:${grant.resource_id}`)}::text[])` : sql``}
      ON CONFLICT (invitation_id, resource_kind, resource_id) DO NOTHING`,
    );
    await query(
      db,
      sql`DELETE FROM ${ident(schema, 'invitation_grants')}
      WHERE org_id = ${actor.orgId} AND invitation_id = ${previous.id}
        ${resources ? sql`AND (resource_kind || ':' || resource_id) = ANY(${resources.map((grant) => `${grant.resource_kind}:${grant.resource_id}`)}::text[])` : sql``}`,
    );
    // Unrelated shares keep their original credentials and expiry.
    await query(
      db,
      sql`UPDATE ${ident(schema, 'invitations')} SET expires_at = clock_timestamp()
      WHERE org_id = ${actor.orgId} AND id = ${previous.id} AND NOT EXISTS (
        SELECT 1 FROM ${ident(schema, 'invitation_grants')} WHERE invitation_id = ${previous.id})`,
    );
  }
  return { invitation: created, token };
}

export async function invitationRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const people = {
    config: { policy: { kind: 'admin' as const, area: 'people' as const, scope: 'organization' as const } },
  };
  const publicRoute = { config: { policy: { kind: 'public' as const } } };

  for (const kind of ['database', 'folder'] as const) {
    app.get(
      `/api/${kind === 'database' ? 'databases' : 'folders'}/:resourceId/invitations`,
      { config: { policy: { kind: 'session' as const } } },
      async (request) => {
        const { resourceId } = parse(z.object({ resourceId: z.string().min(1).max(100) }), request.params);
        const { pool, schemas } = dataStore(ctx);
        return withTransaction(pool, (db) =>
          sharingInvitations(db, schemas, requireActor(request), { kind, id: resourceId }, ctx),
        );
      },
    );
  }

  app.post('/api/org/invitations', people, async (request): Promise<InviteResult> => {
    const actor = requireActor(request);
    const input = parse(InvitePeople, request.body);
    const mailer = ctx.mailer;
    const base = ctx.config.baseUrl?.replace(/\/+$/, '');
    if (!mailer || !base) throw new AppError('unavailable', 'org.invite.noMail');
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const result = await withTransaction(pool, async (db) => {
      // The same lock covers creation, replacement, revocation, and acceptance in this organization.
      await lockKeys(db, [`invitations:${actor.orgId}`]);
      const identity = await findIdentity(db, authDatabase(ctx).app, actor.userId);
      if (!identity || identity.orgId !== actor.orgId) throw notFound();
      const invited: Invitation[] = [];
      const alreadyMembers: string[] = [];
      const deliveries: MailMessage[] = [];
      for (const email of new Set(input.emails)) {
        const users = await query<{ locale: string; member: boolean }>(
          db,
          sql`
          SELECT u.locale, EXISTS (
            SELECT 1 FROM ${ident(schemas.app, 'memberships')} m
            WHERE m.user_id = u.id AND m.org_id = ${actor.orgId}
          ) AS member FROM ${ident(schemas.app, 'users')} u WHERE lower(u.email) = ${email}`,
        );
        const user = users.rows[0];
        if (user?.member) {
          alreadyMembers.push(email);
          continue;
        }
        const { invitation: created, token } = await createInvitation(db, schemas.app, actor, {
          email,
          kind: input.kind,
        });
        invited.push(created);
        deliveries.push(
          invitationMessage(
            email,
            user?.locale ?? 'en-US',
            identity.orgName,
            identity.name,
            `${base}/join#token=${token}`,
          ),
        );
      }
      if (invited.length)
        await auditEvent(db, audit, 'org.invitation.created', actor, { count: invited.length });
      return { invited, alreadyMembers, deliveries };
    });
    for (const delivery of result.deliveries) {
      // Delivery starts after commit, and provider errors must never expose a one-time credential.
      void Promise.resolve()
        .then(() => mailer.send(delivery))
        .catch((error: unknown) => {
          request.log.warn(
            { code: 'mail_delivery_failed', ...mailFailureFields(error) },
            'invitation email delivery failed',
          );
        });
    }
    return { invited: result.invited, alreadyMembers: result.alreadyMembers };
  });

  app.get('/api/org/invitations', people, async (request): Promise<Invitation[]> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const result = await query<InvitationRow>(
      pool,
      sql`
      SELECT id, email, kind, invited_by, created_at, expires_at
      FROM ${ident(schemas.app, 'invitations')}
      WHERE org_id = ${actor.orgId} AND accepted_at IS NULL AND expires_at > clock_timestamp()
      ORDER BY created_at, id`,
    );
    return result.rows.map(invitation);
  });

  app.delete('/api/org/invitations/:id', people, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(InvitationParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      await lockKeys(db, [`invitations:${actor.orgId}`]);
      const revoked = await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'invitations')}
        SET expires_at = clock_timestamp()
        WHERE id = ${id} AND org_id = ${actor.orgId}
          AND accepted_at IS NULL AND expires_at > clock_timestamp()
        RETURNING id`,
      );
      if (!revoked.rowCount) throw notFound();
      await removeInvitationGrants(db, schemas.app, actor.orgId, id);
      await eraseExpiredLibraryReviews(db, schemas.app, actor.orgId);
      await auditEvent(db, audit, 'org.invitation.revoked', actor, { invitationId: id });
    });
    return reply.status(204).send();
  });

  app.get(
    '/api/auth/invitations/:token',
    {
      ...publicRoute,
      childLoggerFactory(logger, bindings, options) {
        // The bearer token lives in this route's path, which ordinary request logging would retain.
        return logger.child(bindings, {
          ...options,
          serializers: {
            ...options.serializers,
            req: (request: { method: string; id: string }) => ({
              method: request.method,
              path: '/api/auth/invitations/:token',
              id: request.id,
            }),
          },
        });
      },
    },
    async (request, reply): Promise<InvitationPreview> => {
      const params = PreviewParams.safeParse(request.params);
      if (!params.success) throw notFound();
      const { pool, schemas } = dataStore(ctx);
      const result = await query<
        Omit<InvitationPreview, 'level'> & { kind: Invitation['kind']; settings: OrgSettings }
      >(
        pool,
        sql`
      SELECT o.name AS "orgName", i.email, u.name AS "invitedByName", i.kind, o.settings
      FROM ${ident(schemas.app, 'invitations')} i
      JOIN ${ident(schemas.app, 'orgs')} o ON o.id = i.org_id
      LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = i.invited_by
      WHERE i.token_hash = ${tokenHash(params.data.token)}
        AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp()`,
      );
      const row = result.rows[0];
      if (!row) throw notFound();
      writeCookie(
        ctx,
        request,
        reply,
        INVITATION_COOKIE,
        { token: params.data.token, expires: Date.now() + 600_000 },
        600,
      );
      // Enough for the invitee to choose a level while joining: where they'd start, and how far up
      // they can go.  Nothing else about the organization's settings leaves the server.
      const { start, highest } = levelsFor(row.kind, row.settings, undefined);
      const invite = (
        await query<{ id: string; org_id: string }>(
          pool,
          sql`SELECT id, org_id FROM ${ident(schemas.app, 'invitations')} WHERE token_hash = ${tokenHash(params.data.token)}`,
        )
      ).rows[0]!;
      const items = await AccessScope.invitationItems(pool, schemas, tokenHash(params.data.token));
      const provider = (
        await query<{ id: string; name: string; kind: string }>(
          pool,
          sql`SELECT id, name, kind FROM ${ident(schemas.app, 'sso_providers')}
        WHERE org_id = ${invite.org_id} AND enabled AND ${row.email.slice(row.email.lastIndexOf('@') + 1).toLowerCase()} = ANY(allowed_domains) ORDER BY created_at, id LIMIT 1`,
        )
      ).rows[0];
      return {
        orgName: row.orgName,
        email: row.email,
        invitedByName: row.invitedByName,
        level: { start, highest },
        ...(items.length
          ? {
              sharedItems: items.map((item) => item.name),
              destination:
                items[0]!.resource_kind === 'database'
                  ? `/${encodeURIComponent(items[0]!.resource_id)}`
                  : `/home/folders/${encodeURIComponent(items[0]!.resource_id)}`,
            }
          : {}),
        ...(provider ? { sso: provider } : {}),
      };
    },
  );

  app.post('/api/auth/invitations/accept', publicRoute, async (request, reply) => {
    const { pool, schemas } = dataStore(ctx);
    const { app: schema, audit } = authDatabase(ctx);
    const key = `invitation:${attemptKey('ip', request.ip)}`;
    // Commit the attempt separately so invalid bodies, unusable tokens, and rolled-back joins count.
    const seconds = await withTransaction(pool, async (db) => {
      await lockKeys(db, [key]);
      await pruneAttempts(db, schema);
      const wait = await retryAfter(db, schema, key, 10, 900);
      if (!wait) await recordAttempts(db, schema, [key]);
      return wait;
    });
    if (seconds) {
      reply.header('retry-after', seconds);
      throw new AppError('rate_limited', 'auth.link.tooMany', { params: { retryAfterSeconds: seconds } });
    }
    const input = parse(AcceptInvitation, request.body);
    // The session is read before the transaction, never inside it: every request waiting on the
    // organization's invitations holds a connection, and a second one for the holder of the lock
    // would leave a full pool waiting on itself.
    const session = await ctx.sessions.resolve(request);
    const outcome = await withTransaction(pool, async (db) => {
      const hash = tokenHash(input.token);
      const candidates = await query<{ org_id: string }>(
        db,
        sql`
        SELECT org_id FROM ${ident(schemas.app, 'invitations')}
        WHERE token_hash = ${hash} AND accepted_at IS NULL AND expires_at > clock_timestamp()`,
      );
      const candidate = candidates.rows[0];
      if (!candidate) throw notFound();
      await lockKeys(db, [`invitations:${candidate.org_id}`]);
      const used = await query<InvitationRow & { copied: boolean }>(
        db,
        sql`
        UPDATE ${ident(schemas.app, 'invitations')} SET accepted_at = clock_timestamp()
        WHERE token_hash = ${hash} AND org_id = ${candidate.org_id}
          AND accepted_at IS NULL AND expires_at > clock_timestamp()
        RETURNING id, email, kind, invited_by, created_at, expires_at, reserved_user_id, copied`,
      );
      const invite = used.rows[0];
      if (!invite) throw notFound();
      const sso = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'sso_providers')} WHERE org_id = ${candidate.org_id}
        AND enabled AND ${invite.email.slice(invite.email.lastIndexOf('@') + 1).toLowerCase()} = ANY(allowed_domains)`,
      );
      if (sso.rowCount) throw new AppError('forbidden', 'share.invite.useSso');
      const account = await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'users')} (id, email, name, locale)
        VALUES (${invite.reserved_user_id ?? newId('user')}, ${invite.email}, ${input.name}, ${input.locale ?? 'en-US'})
        ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
      );
      const users = await query<{ id: string }>(
        db,
        sql`
        SELECT id FROM ${ident(schemas.app, 'users')}
        WHERE lower(email) = ${invite.email.toLowerCase()} AND deactivated_at IS NULL`,
      );
      const user = users.rows[0];
      if (!user) throw notFound();
      const managed = await query(
        db,
        sql`SELECT user_id FROM ${ident(schemas.app, 'scim_users')}
        WHERE user_id = ${user.id} AND org_id <> ${candidate.org_id}`,
      );
      if (managed.rowCount) throw new AppError('forbidden', 'scim.errors.managed');
      await restoreInvitationMembership(db, schemas, audit, candidate.org_id, invite, user);
      // A level chosen while joining is the person's own choice, held to what their kind allows.
      if (input.level) {
        const level = await allowedLevel(db, schema, candidate.org_id, invite.kind, input.level, user.id);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'users')}
          SET preferences = preferences || jsonb_build_object('level', ${level}::text)
          WHERE id = ${user.id}`,
        );
      }
      const identity = await findIdentity(db, schema, user.id);
      if (!identity || identity.orgId !== candidate.org_id) throw notFound();
      // A copied link passed through its sharer, so it opens a session only for the account it
      // creates.  An account that already existed accepts from its own session, and the refusal
      // leaves the invitation waiting.
      const existing = invite.copied && !account.rowCount;
      if (existing && (session?.userId !== user.id || request.headers['x-csrf-token'] !== session.csrfToken))
        throw new AppError('forbidden', 'share.invite.signInFirst');
      await acceptInvitationGrants(db, schemas, audit, identity, invite.id);
      await auditEvent(db, audit, 'org.invitation.accepted', identity, { invitationId: invite.id });
      if (existing && session) return { info: sessionInfo(identity, session.csrfToken) };
      // An existing account keeps its second step, and a required one comes before anything else.
      return afterFirstStep(db, ctx, identity, request, 'invitation');
    });
    return 'info' in outcome ? outcome.info : sendFirstStep(ctx, request, reply, outcome);
  });
}

import type { FastifyRequest } from 'fastify';
import { newId, safeSignInNext } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import {
  attemptKey,
  clearEmailFailures,
  IP_LIMIT,
  pruneAttempts,
  recordAttempts,
  retryAfter,
} from '../attempts.js';
import {
  auditEvent,
  authDatabase,
  lockKeys,
  refuseDemoAuthentication,
  tokenHash,
  withSignInTransaction,
} from '../database.js';
import { createSession, findIdentity } from '../sessions.js';
import { afterFirstStep, type FirstStepOutcome } from '../mfa/pending.js';
import { effectivePolicy } from '../../org-units/policy.js';
import type { FlowFailure } from './oidc.js';
import { identitiesTable, type ProviderRow } from './store.js';
import { acceptInvitationGrants } from '../../data/invitation-grants.js';
import { restoreInvitationMembership } from '../../data/invitation-membership.js';

/**
 * What every kind of single sign-on shares once a provider has vouched for someone: finding or
 * making their account, opening the session, the attempt limit it shares with password sign-in,
 * and where the browser goes afterward.  OpenID Connect and SAML each check their own protocol and
 * then hand over a `Claimed` identity.
 */

/** Who a provider says someone is, after its protocol's checks. */
export interface Claimed {
  invitationToken?: string;
  /** The name the identity is kept under: an OpenID Connect issuer, or a SAML provider's key */
  issuer: string;
  subject: string;
  /** The address the provider sent, not yet checked */
  email: unknown;
  /** Whether the provider vouches for that address */
  emailVerified: boolean;
  /** The name for a new account, not yet checked */
  name: unknown;
}

export type Outcome = FirstStepOutcome | { failure: FlowFailure };

const Email = z.string().trim().toLowerCase().email().max(320);

/**
 * Only a path on this server may follow a sign-in, never another site, and never the API itself.
 * Anything else sends the person home.
 */
export const safeNext = safeSignInNext;

export function signInPath(failure: FlowFailure, next: string): string {
  const search = new URLSearchParams({ error: failure });
  if (next !== '/') search.set('next', next);
  return `/sign-in?${search.toString()}`;
}

/** Seconds until this address may try again, counted with password sign-in's failures. */
export async function lockedFor(ctx: AppContext, request: FastifyRequest): Promise<number> {
  const { pool, app: schema } = authDatabase(ctx);
  const key = attemptKey('ip', request.ip);
  return withTransaction(pool, async (db) => {
    await lockKeys(db, [key]);
    return retryAfter(db, schema, key, IP_LIMIT.attempts, IP_LIMIT.windowSeconds);
  });
}

/** Counts a failure against the address, unless the fault was the provider's, and audits it. */
export async function refuse(
  ctx: AppContext,
  request: FastifyRequest,
  failure: FlowFailure,
  providerId: string | undefined,
): Promise<void> {
  const { pool, app: schema, audit } = authDatabase(ctx);
  const key = attemptKey('ip', request.ip);
  await withTransaction(pool, async (db) => {
    await pruneAttempts(db, schema);
    if (failure !== 'sso.unavailable' && failure !== 'sso.locked') {
      await lockKeys(db, [key]);
      await recordAttempts(db, schema, [key]);
    }
    await auditEvent(db, audit, 'auth.sign_in_failed', null, {
      reason: failure,
      method: 'sso',
      ip: request.ip,
      ...(providerId ? { providerId } : {}),
    });
  });
}

class Refused extends Error {
  constructor(readonly failure: FlowFailure) {
    super(failure);
  }
}

/** Finds or makes the account for someone a provider vouched for, then opens a session for it. */
export async function signInClaimed(
  ctx: AppContext,
  request: FastifyRequest,
  provider: ProviderRow,
  claimed: Claimed,
): Promise<Outcome> {
  await refuseDemoAuthentication(ctx, { ...claimed, token: claimed.invitationToken });
  const { pool, schemas } = dataStore(ctx);
  const { app: schema, audit } = authDatabase(ctx);
  try {
    return await withSignInTransaction(pool, async (db) => {
      await pruneAttempts(db, schema);
      // Two tabs finishing the same first sign-in must not both link or create.
      await lockKeys(db, [`sso:${tokenHash(`${claimed.issuer}\n${claimed.subject}`)}`]);
      const account = await findAccount(db, schemas, provider, claimed);
      if ('failure' in account) throw new Refused(account.failure);
      const identity = await findIdentity(db, schema, account.userId);
      // A provider signs people into its own organization and no other.
      if (!identity || identity.orgId !== provider.org_id) throw new Refused('sso.noAccount');
      await clearEmailFailures(db, schema, identity.email);
      if (account.how !== 'known')
        await auditEvent(db, audit, `auth.sso.${account.how}`, identity, { providerId: provider.id });
      if (
        (identity.hasUnits || identity.settings.unitPolicy) &&
        (
          await effectivePolicy(db, schema, identity.orgId, identity, {
            ...ctx.config,
            existingSession: true,
          })
        ).values.requireMfa
      )
        return afterFirstStep(db, ctx, identity, request, 'sso', provider.id);
      const created = await createSession(db, ctx, identity, request, 'sso', provider.id);
      await auditEvent(db, audit, 'auth.sign_in', identity, {
        ip: request.ip,
        method: 'sso',
        providerId: provider.id,
      });
      return { session: created };
    });
  } catch (error) {
    // Thrown rather than returned, so a refusal takes back any link or account it made.
    if (error instanceof Refused) return { failure: error.failure };
    throw error;
  }
}

function claimText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

type Account = { userId: string; how: 'known' | 'linked' | 'created' } | { failure: FlowFailure };

/**
 * The person behind an issuer and subject.  A first sign-in links to the member with the same
 * email only when the provider verified it and the provider allows linking, and makes a new member
 * only for a verified address in an allowed domain when the provider allows that.
 */
async function findAccount(
  db: Queryable,
  schemas: DataSchemas,
  provider: ProviderRow,
  claimed: Claimed,
): Promise<Account> {
  const identities = identitiesTable(schemas);
  const users = ident(schemas.app, 'users');
  const memberships = ident(schemas.app, 'memberships');
  if (claimed.invitationToken) {
    const email = Email.safeParse(claimed.email);
    if (
      !email.success ||
      !claimed.emailVerified ||
      !provider.allowed_domains.includes(email.data.slice(email.data.lastIndexOf('@') + 1))
    )
      return { failure: 'sso.noAccount' };
    await lockKeys(db, [`invitations:${provider.org_id}`]);
    const invited = await query<{ id: string; kind: 'member' | 'guest'; reserved_user_id: string | null }>(
      db,
      sql`
      UPDATE ${ident(schemas.app, 'invitations')} SET accepted_at = clock_timestamp()
      WHERE org_id = ${provider.org_id} AND token_hash = ${tokenHash(claimed.invitationToken)} AND lower(email) = ${email.data}
        AND accepted_at IS NULL AND expires_at > clock_timestamp() RETURNING id, kind, reserved_user_id`,
    );
    const invite = invited.rows[0];
    if (!invite) return { failure: 'sso.noAccount' };
    await query(
      db,
      sql`INSERT INTO ${users} (id, email, name) VALUES (${invite.reserved_user_id ?? newId('user')}, ${email.data}, ${claimText(claimed.name, 120)})
      ON CONFLICT (lower(email)) DO NOTHING`,
    );
    const user = (
      await query<{ id: string }>(
        db,
        sql`SELECT id FROM ${users} WHERE lower(email) = ${email.data} AND deactivated_at IS NULL`,
      )
    ).rows[0];
    if (!user) return { failure: 'sso.deactivated' };
    const existing = await query(
      db,
      sql`SELECT user_id FROM ${memberships} WHERE user_id = ${user.id} AND org_id <> ${provider.org_id}`,
    );
    if (existing.rowCount) return { failure: 'sso.noAccount' };
    await restoreInvitationMembership(db, schemas, `"${schemas.audit}"`, provider.org_id, invite, user);
    const linked = await query(
      db,
      sql`INSERT INTO ${identities} (issuer, subject, user_id, provider_id, email, last_used_at)
      VALUES (${claimed.issuer}, ${claimed.subject}, ${user.id}, ${provider.id}, ${email.data}, clock_timestamp())
      ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = clock_timestamp()
      WHERE ${identities}.user_id = EXCLUDED.user_id RETURNING user_id`,
    );
    if (!linked.rowCount) return { failure: 'sso.noAccount' };
    const actor = { orgId: provider.org_id, userId: user.id, kind: invite.kind, adminRoles: [] };
    await acceptInvitationGrants(db, schemas, `"${schemas.audit}"`, actor, invite.id);
    await auditEvent(db, `"${schemas.audit}"`, 'org.invitation.accepted', actor, {
      invitationId: invite.id,
      providerId: provider.id,
    });
    return { userId: user.id, how: 'created' };
  }
  const known = await query<{ user_id: string; deactivated: boolean }>(
    db,
    sql`SELECT i.user_id, u.deactivated_at IS NOT NULL AS deactivated
    FROM ${identities} i JOIN ${users} u ON u.id = i.user_id
    WHERE i.issuer = ${claimed.issuer} AND i.subject = ${claimed.subject}`,
  );
  const identity = known.rows[0];
  if (identity) {
    if (identity.deactivated) return { failure: 'sso.deactivated' };
    await query(
      db,
      sql`UPDATE ${identities} SET last_used_at = clock_timestamp()
      WHERE issuer = ${claimed.issuer} AND subject = ${claimed.subject}`,
    );
    return { userId: identity.user_id, how: 'known' };
  }

  const email = Email.safeParse(claimed.email);
  const verified = email.success && claimed.emailVerified;
  // Distinct subjects can share an address, so serialize provisioning before the member lookup.
  if (verified && (provider.link_by_email || provider.auto_create))
    await lockKeys(db, [`sso-email:${tokenHash(email.data)}`]);
  const link = async (userId: string) =>
    query(
      db,
      sql`INSERT INTO ${identities} (issuer, subject, user_id, provider_id, email, last_used_at)
      VALUES (${claimed.issuer}, ${claimed.subject}, ${userId}, ${provider.id},
        ${email.success ? email.data : null}, clock_timestamp())`,
    );

  // An address the provider didn't verify never reaches the member lookup, so every such claim
  // gets the same answer, whoever holds the address and whatever state they're in.
  if (verified && provider.link_by_email) {
    const members = await query<{ id: string; deactivated: boolean; managed: boolean }>(
      db,
      sql`SELECT u.id, u.deactivated_at IS NOT NULL AS deactivated,
        EXISTS (SELECT 1 FROM ${ident(schemas.app, 'scim_users')} s
          WHERE s.org_id = ${provider.org_id} AND s.user_id = u.id) AS managed
      FROM ${users} u JOIN ${memberships} m ON m.user_id = u.id AND m.org_id = ${provider.org_id}
      WHERE lower(u.email) = ${email.data}`,
    );
    const member = members.rows[0];
    if (member?.deactivated) return { failure: 'sso.deactivated' };
    if (member?.managed) {
      const domain = email.data.slice(email.data.lastIndexOf('@') + 1);
      const ownership = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'sso_domain_verifications')}
        WHERE org_id = ${provider.org_id} AND provider_id = ${provider.id}
          AND domain = ${domain} AND verified_at IS NOT NULL`,
      );
      if (!provider.allowed_domains.includes(domain) || !ownership.rowCount)
        return { failure: 'sso.domainUnverified' };
    }
    if (member) {
      await link(member.id);
      return { userId: member.id, how: 'linked' };
    }
  }

  const domain = email.success ? email.data.slice(email.data.lastIndexOf('@') + 1) : '';
  if (verified && provider.auto_create && provider.allowed_domains.includes(domain)) {
    // An address someone already has never gets a second account.  Linking to it wasn't allowed
    // above, so a conflict here means there's no account to sign in to.
    const created = await query<{ id: string }>(
      db,
      sql`INSERT INTO ${users} (id, email, name)
      VALUES (${newId('user')}, ${email.data}, ${claimText(claimed.name, 120)})
      ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
    );
    const user = created.rows[0];
    if (!user) return { failure: 'sso.noAccount' };
    await query(
      db,
      sql`INSERT INTO ${memberships} (org_id, user_id, kind) VALUES (${provider.org_id}, ${user.id}, 'member')`,
    );
    await link(user.id);
    return { userId: user.id, how: 'created' };
  }
  return { failure: 'sso.noAccount' };
}

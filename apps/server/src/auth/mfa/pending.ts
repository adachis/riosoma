import { effectivePolicy } from '../../org-units/policy.js';
import { refuseDemoAccount } from '../../demo/boundary.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  type SecondStep,
  type SecondStepMethod,
  type SecondStepRequired,
  type SessionInfo,
} from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { clearEmailFailures } from '../attempts.js';
import { auditEvent, authDatabase, randomToken } from '../database.js';
import { createSession, sendSession, type CreatedSession, type Identity } from '../sessions.js';
import { clearCookie, readCookie, writeCookie, type SealedCookie } from './cookies.js';
import {
  hasSecondStep,
  mfaStore,
  orgPolicy,
  requiredBy,
  secondStepsOf,
  spend,
  type SecondSteps,
} from './store.js';
import { relyingParty } from './webauthn.js';

/** How long someone has for their second step after a password or an emailed link. */
export const PENDING_SECONDS = 10 * 60;

/**
 * Someone who got past the first step and still owes a second, or who has to add one first.  It
 * lives only in a sealed cookie, so it opens nothing but the second-step routes.
 */
const Pending = z.object({
  id: z.string().min(32).max(100),
  userId: z.string().min(1).max(100),
  stage: z.enum(['verify', 'setup']),
  method: z.enum(['password', 'link', 'invitation', 'sso']),
  /** The identity provider a single sign-on came through, which the session stays tied to */
  providerId: z.string().min(1).max(100).optional(),
  credentialVersion: z.number().int().default(0),
  expires: z.number().int(),
});
export type Pending = z.infer<typeof Pending>;
export type FirstStep = Pending['method'];

const PENDING_COOKIE: SealedCookie<Pending> = {
  name: 'rio_second_step',
  context: 'riosoma:second-step',
  schema: Pending,
};

export function readPending(ctx: AppContext, request: FastifyRequest): Pending | null {
  return readCookie(ctx, request, PENDING_COOKIE);
}

export function clearPending(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  clearCookie(ctx, request, reply, PENDING_COOKIE);
}

/** The key that marks a pending sign-in as finished or abandoned. */
export function pendingKey(pending: Pending): string {
  return `pending:${pending.id}`;
}

/** What the sign-in page offers: the person's own second steps, or the ones they can add. */
export function secondStepView(
  ctx: AppContext,
  pending: Pending,
  email: string,
  steps: SecondSteps,
): SecondStep {
  const passkeys = relyingParty(ctx) !== null;
  const methods: SecondStepMethod[] = [];
  if (pending.stage === 'setup') {
    if (passkeys) methods.push('passkey');
    methods.push('authenticator');
  } else {
    if (passkeys && steps.passkeys > 0) methods.push('passkey');
    if (steps.authenticator) methods.push('authenticator');
    if (steps.recoveryCodes > 0) methods.push('recovery');
  }
  return { stage: pending.stage, methods, email, expiresAt: new Date(pending.expires).toISOString() };
}

export type FirstStepOutcome = { session: CreatedSession } | { pending: Pending; secondStep: SecondStep };

/**
 * Where a password, an emailed link, or an invitation leads: straight to a session, or to a pending
 * state for someone with a second step or whose organization requires one.  Runs inside the
 * sign-in's own transaction.
 */
export async function afterFirstStep(
  db: Queryable,
  ctx: AppContext,
  identity: Identity,
  request: FastifyRequest,
  method: FirstStep,
  providerId?: string,
): Promise<FirstStepOutcome> {
  refuseDemoAccount(ctx.config, identity.email);
  const { app: schema, audit } = authDatabase(ctx);
  const { tables } = mfaStore(ctx);
  const steps = await secondStepsOf(db, tables, identity.userId);
  const has = hasSecondStep(steps);
  const effective =
    identity.hasUnits || identity.settings.unitPolicy
      ? await effectivePolicy(db, schema, identity.orgId, identity, ctx.config)
      : { values: { requireMfa: false, requireSso: false } };
  if (effective.values.requireSso && method !== 'sso') throw new AppError('forbidden', 'orgUnits.policy.sso');
  if (
    !has &&
    !effective.values.requireMfa &&
    !requiredBy(await orgPolicy(db, tables, identity.orgId), identity)
  ) {
    // Only a finished sign-in clears the failures.  A right password alone must not reset the
    // count that limits guessing at codes.
    await clearEmailFailures(db, schema, identity.email);
    return {
      session: await createSession(
        db,
        ctx,
        identity,
        request,
        method === 'sso' ? 'sso' : 'password',
        providerId,
        method,
      ),
    };
  }
  const pending: Pending = {
    id: randomToken(),
    userId: identity.userId,
    stage: has ? 'verify' : 'setup',
    method,
    ...(method === 'sso' && providerId ? { providerId } : {}),
    credentialVersion: identity.credentialVersion ?? 0,
    expires: Date.now() + PENDING_SECONDS * 1000,
  };
  await auditEvent(db, audit, 'auth.second_step.required', identity, {
    ip: request.ip,
    method,
    stage: pending.stage,
  });
  return { pending, secondStep: secondStepView(ctx, pending, identity.email, steps) };
}

/** Answers a first step with a session, or with the pending state and what it asks for. */
export function sendFirstStep(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: FirstStepOutcome,
): SessionInfo | SecondStepRequired {
  if ('session' in outcome) return sendSession(request, reply, outcome.session);
  writeCookie(ctx, request, reply, PENDING_COOKIE, outcome.pending, PENDING_SECONDS);
  return { secondStep: outcome.secondStep };
}

/**
 * Finishes a pending sign-in inside the transaction that checked its second step: the pending state
 * is spent, so it can't finish twice, and a session begins.
 */
export async function completeSignIn(
  db: Queryable,
  ctx: AppContext,
  request: FastifyRequest,
  pending: Pending,
  identity: Identity,
  secondStep: SecondStepMethod,
  details: Record<string, string> = {},
): Promise<CreatedSession> {
  const { app: schema, audit } = authDatabase(ctx);
  const { tables } = mfaStore(ctx);
  if ((identity.credentialVersion ?? 0) !== pending.credentialVersion)
    throw new AppError('unauthenticated', 'mfa.pending.expired');
  if (!(await spend(db, tables, pendingKey(pending), pending.expires)))
    throw new AppError('unauthenticated', 'mfa.pending.expired');
  await clearEmailFailures(db, schema, identity.email);
  const session = await createSession(
    db,
    ctx,
    identity,
    request,
    pending.method === 'sso' ? 'sso-second-step' : 'second-step',
    pending.providerId,
    pending.method,
  );
  await auditEvent(db, audit, 'auth.sign_in', identity, {
    ip: request.ip,
    method: pending.method,
    secondStep,
    ...details,
  });
  return session;
}

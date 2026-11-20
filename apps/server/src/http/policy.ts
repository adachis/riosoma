import { activeSession } from '../auth/account-store.js';
import { Readable } from 'node:stream';
import type { ClassificationUse } from '../data/governance.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  UnitAdminRole,
  type EffectiveUnitPolicy,
  type TokenScope,
  type UnitAdminGrant,
} from '@riosoma/contracts';
import { authDatabase } from '../auth/database.js';
import {
  organizationAdmin,
  requirePerson,
  requireSource,
  requireUnit,
  unitAdmin,
  unitResourceAdmin,
} from '../org-units/store.js';

/**
 * Every API route declares who may call it.  A route under `/api/`, or under `/v0/` where the
 * Airtable-compatible API answers, without a policy stops the server from starting, so nothing
 * ships open by accident.
 */
export const ADMIN_AREAS = [
  'people',
  'security',
  'data_sources',
  'ai',
  'integrations',
  'audit',
  'feedback',
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

/**
 * How far an admin route reaches for someone who administers units rather than the organization.
 * Every admin route declares one, wherever it's mounted, and a route without one, or with one the
 * server doesn't know, stops the server from starting.
 *
 * - `organization`: the organization's own settings.  Only its owner and organization admins.
 * - `subtree`: units and what's in them.  The handler checks each unit, person, or resource it
 *   touches, and a list shows only what the admin's units reach.  A `:unitId` in the address is
 *   checked before the handler runs.
 * - `person`: the person named by `:userId`, checked before the handler runs.
 * - `database`: the database named by `:databaseId`, when only people the admin's units reach own it.
 * - `source`: the data source named by `:sourceId`, or a new one made by an admin placed in their units.
 */
export const ADMIN_SCOPES = ['organization', 'subtree', 'person', 'database', 'source'] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

/** The address parameter each scope checks, when the route has it */
const SCOPE_PARAMS: Record<AdminScope, string | null> = {
  organization: null,
  subtree: 'unitId',
  person: 'userId',
  database: 'databaseId',
  source: 'sourceId',
};

export type AdminPolicy =
  /** Owners, and admins holding a role for this area in the organization or, by scope, in a unit */
  | { kind: 'admin'; area: AdminArea; scope: AdminScope; beforeBody?: true }
  /** Owners, and admins holding any of these roles.  The handler checks each one it acts on. */
  | { kind: 'admin'; area: readonly AdminArea[]; scope: 'organization' | 'subtree'; beforeBody?: true };

export type Policy =
  /** Anyone, signed in or not: health checks, sign-in, public setup status. */
  | { kind: 'public' }
  /** Only during first-run setup, with the setup token printed to the server log. */
  | { kind: 'setup' }
  /** Any signed-in person.  Finer checks happen in the handler through AccessScope. */
  | { kind: 'session'; beforeBody?: true }
  /** A personal access token, never a cookie.  With a list of scopes, any one of them will do. */
  | { kind: 'token'; scope: TokenScope | readonly TokenScope[]; beforeBody?: true }
  | AdminPolicy;

/*
 * `beforeBody` checks the session, its CSRF token, and the admin role and scope as the request
 * arrives, before a byte of its body is read, rather than after the body is parsed.  A route that
 * takes a large or streamed body sets it, so only someone it would admit can make the server read
 * that body.
 */

const POLICY_KINDS = new Set(['public', 'setup', 'session', 'token', 'admin']);

/** The areas an admin policy names */
export function policyAreas(policy: AdminPolicy): readonly AdminArea[] {
  return typeof policy.area === 'string' ? [policy.area] : policy.area;
}

export interface Actor {
  demo?: boolean;
  demoExpiresAt?: string;
  /** Data reads made for an outbound destination retain their classification restrictions. */
  dataUse?: ClassificationUse;
  /** Set for a personal access token or an OAuth app's token.  `grantId` names an OAuth installation. */
  token?: { id: string; databases: string[] | null; scopes: TokenScope[]; grantId?: string };
  /**
   * Set when an automation acts as this person.  Its changes are marked as coming from it, and
   * `depth` counts how many automations deep the chain that led here is.
   */
  automation?: { id: string; runId: string; depth: number; testStep?: boolean };
  /** Set while a script run from the script panel acts as this person, so its changes say so */
  script?: { id: string; runId: string; button?: { tableId: string; recordId: string; fieldId: string } };
  /**
   * Set while an AI field's run writes a value as the field's person, so the change says so.
   * `depth` counts the automation and AI field runs that led to this one, as `automation.depth`
   * does, so the two can't set each other off forever.
   */
  aiField?: { id: string; runId: string; depth: number };
  /**
   * Set while a routine acts as its owner, so its changes say which routine and run made them.
   * Changes a run makes on its own set nothing else off (see `routineOwn`).  `approved` marks a
   * plan its owner approved, which acts as if the owner made it.
   */
  routine?: { id: string; runId: string; approved?: boolean };
  /**
   * Set while a webhook source writes a post as this person.  Its records are the source's, so
   * they may be added to its synced tables, and the changes say which post they came from.
   */
  source?: { id: string; deliveryId: string };
  userId: string;
  orgId: string;
  sessionId: string;
  kind: 'owner' | 'member' | 'guest';
  adminRoles: string[];
  /** The units this person administers, read with the session once the organization has units */
  unitAdminGrants?: UnitAdminGrant[];
  /** The unit an admin route's change belongs to, which its audit entry records */
  auditUnitId?: string | null;
  /** Whether the organization has any units */
  hasUnits?: boolean;
  /** Whether the organization has a unit policy of its own */
  hasUnitPolicy?: boolean;
  /** The policy that applies to this person, worked out once per request when it's first needed */
  policy?: EffectiveUnitPolicy;
  csrfToken: string;
}

/** Resolves the signed-in person from a request.  The auth module supplies the real one. */
/**
 * Whether a change is a routine run's own, made without its owner watching.  Such a change is
 * inert: every consumer of record changes (automations, AI field runs, outgoing webhooks, and
 * canceling signature requests) skips it or refuses it, so a routine can't reach anything beyond
 * the records it changed.  Internal notices and live updates still go out.  A plan its owner
 * approved isn't one.
 */
export function routineOwn(actor: Pick<Actor, 'routine'>): boolean {
  return Boolean(actor.routine && !actor.routine.approved);
}

export interface SessionResolver {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: Policy;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export interface PolicyRoute {
  method: string;
  url: string;
  policy: Policy;
}
export interface AdministrationRoute extends PolicyRoute {
  policy: AdminPolicy;
}
const declared = new WeakMap<FastifyInstance, PolicyRoute[]>();
/** Every route that declared a policy, in the order they were added */
export function policyRoutes(app: FastifyInstance): readonly PolicyRoute[] {
  return declared.get(app) ?? [];
}
/** Every admin route, with the scope it declared for unit admins */
export function administrationRoutes(app: FastifyInstance): readonly AdministrationRoute[] {
  return policyRoutes(app).filter((route): route is AdministrationRoute => route.policy.kind === 'admin');
}

/**
 * Why a policy can't be installed, or null when it can: it's one the server knows, and an admin
 * policy names at least one area and a scope the server knows, with a list of areas only for
 * scopes whose handlers check each target themselves.
 */
export function undeclaredScope(policy: Policy): string | null {
  if (!POLICY_KINDS.has((policy as { kind?: string }).kind ?? ''))
    return 'has a policy the server doesn’t know';
  if (policy.kind !== 'admin') return null;
  const areas: readonly string[] = typeof policy.area === 'string' ? [policy.area] : (policy.area ?? []);
  if (!areas.length || areas.some((area) => !(ADMIN_AREAS as readonly string[]).includes(area)))
    return 'names no administration area';
  if (!(ADMIN_SCOPES as readonly string[]).includes((policy as { scope?: string }).scope ?? ''))
    return 'has no administration scope';
  if (typeof policy.area !== 'string' && policy.scope !== 'organization' && policy.scope !== 'subtree')
    return 'checks several areas for one target';
  return null;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Where the APIs answer, whose every route has to declare a policy */
const API_PREFIXES = ['/api/', '/v0/'];
/** The longest ID an address parameter a scope checks can hold */
const PARAM_LIMIT = 100;

/**
 * The address parameter a scope checks.  A route without it answers undefined, and a value that
 * can't be an ID is refused here, so no check is ever skipped for a value it didn't expect.
 */
function scopeParam(request: FastifyRequest, name: string | null): string | undefined {
  if (!name) return undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(params, name)) return undefined;
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > PARAM_LIMIT)
    throw new AppError('forbidden', 'errors.adminOnly');
  return value;
}

/**
 * Whether someone may call an admin route at all: the owner, an organization admin holding one
 * of its areas, or, for any known scope but `organization`, a unit admin holding one.  The scope's
 * own checks then decide what they may touch.  A policy the server doesn't know admits nobody.
 */
function mayAdminister(actor: Actor, policy: AdminPolicy): boolean {
  if (actor.kind === 'guest' || undeclaredScope(policy) !== null) return false;
  const areas = policyAreas(policy);
  if (areas.some((area) => organizationAdmin(actor, area))) return true;
  return policy.scope !== 'organization' && areas.some((area) => unitAdmin(actor, area));
}

/** A unit admin's checks for the scope an admin route declared */
async function checkScope(
  app: FastifyInstance,
  request: FastifyRequest,
  actor: Actor,
  policy: AdminPolicy,
): Promise<void> {
  const param = scopeParam(request, SCOPE_PARAMS[policy.scope] ?? null);
  const areas = policyAreas(policy).filter(
    (area) => UnitAdminRole.safeParse(area).success,
  ) as UnitAdminRole[];
  const organizationWide = policyAreas(policy).some((area) => organizationAdmin(actor, area));
  switch (policy.scope) {
    case 'organization':
      if (!organizationWide) throw new AppError('forbidden', 'errors.adminOnly');
      return;
    case 'subtree': {
      // Someone who holds one of the areas for the whole organization reaches every unit.
      if (param === undefined || organizationWide) return;
      const { pool, app: schema } = authDatabase(app.ctx);
      for (const area of areas) {
        try {
          await requireUnit(pool, schema, actor, param, area);
          return;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      throw new AppError('forbidden', 'errors.adminOnly');
    }
    case 'person': {
      const area = areas[0];
      if (!param || !area || areas.length !== 1) throw new AppError('forbidden', 'errors.adminOnly');
      const { pool, app: schema } = authDatabase(app.ctx);
      actor.auditUnitId = await requirePerson(pool, schema, actor, param, area);
      return;
    }
    case 'database': {
      const area = areas[0];
      if (!area || areas.length !== 1) throw new AppError('forbidden', 'errors.adminOnly');
      if (organizationWide) return;
      const { pool, app: schema } = authDatabase(app.ctx);
      if (!param || !(await unitResourceAdmin(pool, schema, actor, 'database', param, area)))
        throw new AppError('forbidden', 'errors.adminOnly');
      return;
    }
    case 'source': {
      if (areas.length !== 1 || areas[0] !== 'data_sources')
        throw new AppError('forbidden', 'errors.adminOnly');
      if (organizationWide) return;
      const { pool, app: schema } = authDatabase(app.ctx);
      // A new source belongs to the admin who makes it, who has to be placed inside their units.
      actor.auditUnitId = param
        ? await requireSource(pool, schema, actor, param)
        : await requirePerson(pool, schema, actor, actor.userId, 'data_sources');
      return;
    }
    default:
      throw new AppError('forbidden', 'errors.adminOnly');
  }
}

export function installPolicies(
  app: FastifyInstance,
  deps: {
    sessions: () => SessionResolver;
    verifySetupToken: (candidate: string | undefined) => boolean;
    token?: (request: FastifyRequest, scope: TokenScope | readonly TokenScope[]) => Promise<Actor>;
  },
): void {
  app.decorateRequest('actor', null);
  const routes: PolicyRoute[] = [];
  declared.set(app, routes);

  app.addHook('onRoute', (route) => {
    const policy = (route.config as { policy?: Policy } | undefined)?.policy;
    const api = API_PREFIXES.some((prefix) => route.url.startsWith(prefix));
    if (!policy) {
      if (api) throw new Error(`Route ${route.method} ${route.url} has no access policy`);
      return;
    }
    // Wherever a route is mounted, a policy it declares has to be one the server can enforce.
    const undeclared = undeclaredScope(policy);
    if (undeclared) throw new Error(`Route ${route.method} ${route.url} ${undeclared}`);
    if (route.url.startsWith('/api/admin/') && policy.kind !== 'admin')
      throw new Error(`Route ${route.method} ${route.url} is under /api/admin/ without an admin policy`);
    for (const method of [route.method].flat()) routes.push({ method, url: route.url, policy });
  });

  /** Admits a signed-in person as `policy` says, or refuses them. */
  async function admit(
    request: FastifyRequest,
    policy: Extract<Policy, { kind: 'session' | 'admin' }>,
  ): Promise<void> {
    const actor = await deps.sessions().resolve(request);
    if (!actor) throw new AppError('unauthenticated', 'errors.signInRequired');
    // Sessions ride on a cookie, so every state-changing request must also echo the session's
    // CSRF token in a header that a cross-site form can't set.
    if (UNSAFE_METHODS.has(request.method) && request.headers['x-csrf-token'] !== actor.csrfToken) {
      throw new AppError('forbidden', 'errors.csrfMismatch');
    }
    if (actor.demo && policy.kind === 'admin') throw new AppError('forbidden', 'demo.readOnly');
    if (policy.kind === 'admin') {
      if (!mayAdminister(actor, policy)) throw new AppError('forbidden', 'errors.adminOnly');
      await checkScope(app, request, actor, policy);
    }
    request.actor = actor;
  }

  // Runs after the custom domain and cookie hooks, which were added first.  A refused request's
  // connection ends with the refusal, so its body is never read, not even to be thrown away.
  app.addHook('onRequest', async (request, reply) => {
    const policy = request.routeOptions.config?.policy;
    if (
      !policy ||
      (policy.kind !== 'session' && policy.kind !== 'admin' && policy.kind !== 'token') ||
      !policy.beforeBody
    )
      return;
    try {
      if (request.customDomain) throw new AppError('not_found', 'errors.notFound');
      if (policy.kind === 'token') {
        if (!deps.token) throw new AppError('unauthenticated', 'errors.tokenInvalid');
        request.actor = await deps.token(request, policy.scope);
      } else await admit(request, policy);
    } catch (error) {
      reply.header('connection', 'close');
      throw error;
    }
  });

  // A read that was already running when a session ended must not return protected data.
  app.addHook('onSend', async (request, reply, payload) => {
    const actor = request.actor;
    // Empty acknowledgments still succeed when a sign-out command ended its own session.
    if (
      reply.statusCode !== 204 &&
      reply.statusCode < 400 &&
      actor &&
      !actor.token &&
      !actor.demo &&
      app.ctx?.pool &&
      app.ctx.config.database &&
      !(await activeSession(app.ctx.pool, app.ctx.config.database.schemas, actor.sessionId))
    )
      throw new AppError('unauthenticated', 'errors.signInRequired');
    if (reply.statusCode < 400 && actor && !actor.token && !actor.demo && payload instanceof Readable) {
      const unwatch = app.ctx?.watchSession?.(actor.sessionId, () => {
        payload.destroy();
        reply.raw.destroy();
      });
      if (unwatch) reply.raw.once('close', unwatch);
    }
    return payload;
  });

  app.addHook('preHandler', async (request) => {
    const policy = request.routeOptions.config.policy;
    if (!policy || policy.kind === 'public') return;
    if (request.customDomain) throw new AppError('not_found', 'errors.notFound');

    if (policy.kind === 'setup') {
      const header = request.headers['x-setup-token'];
      if (!deps.verifySetupToken(typeof header === 'string' ? header : undefined)) {
        throw new AppError('forbidden', 'errors.setupTokenInvalid');
      }
      return;
    }

    if (policy.kind === 'token') {
      if (!deps.token) throw new AppError('unauthenticated', 'errors.tokenInvalid');
      request.actor = await deps.token(request, policy.scope);
      return;
    }
    if (policy.kind !== 'session' && policy.kind !== 'admin')
      throw new AppError('forbidden', 'errors.adminOnly');
    // Every session route is checked here.  A `beforeBody` route was checked as it arrived too, and
    // this second look refuses one whose session ended in between.
    await admit(request, policy);
  });
}

/** The resolver used until someone can sign in: nobody is. */
export const NO_SESSIONS: SessionResolver = { resolve: async () => null };

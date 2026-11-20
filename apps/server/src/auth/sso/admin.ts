import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  SamlMetadataSource,
  SsoProviderCreate,
  SsoProviderId,
  SsoProviderUpdate,
  type OidcProviderCreate,
  type SamlDraft,
  type SamlMetadata,
  type SamlProviderCreate,
  type SsoProvider,
  type SsoTestResult,
} from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { dataStore } from '../../data/context.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { auditEvent, authDatabase } from '../database.js';
import { requireActor } from '../sessions.js';
import { testIssuer } from './oidc.js';
import { certificatesFrom, checkEntityId, checkSsoUrl, samlDetails, serviceProvider } from './saml.js';
import { fetchMetadata, readMetadata } from './saml-metadata.js';
import {
  checkIssuer,
  fieldError,
  identitiesTable,
  identityCount,
  microsoftIssuer,
  newProviderId,
  normalTenant,
  placement,
  providersTable,
  providerView,
  redirectUri,
  sealSecret,
  serverOrigin,
  type ProviderRow,
} from './store.js';
import { forgetProviderSessions, keepProviderWhileRequired } from '../../org-units/policy.js';
import { lockUnits } from '../../org-units/store.js';

const Params = z.object({ providerId: SsoProviderId });
const TestRequest = z.object({ issuer: z.string().url().max(500) });

function notFound(): AppError {
  return new AppError('not_found', 'errors.notFound');
}

function ownerOnly(): AppError {
  return new AppError('forbidden', 'sso.ownerOnly');
}

/** The names of the fields a change touched, for the audit trail: never their values. */
function changedFields(input: SsoProviderUpdate): string[] {
  const { saml, ...rest } = input;
  return [...Object.keys(rest), ...Object.keys(saml ?? {}).map((field) => `saml.${field}`)].sort();
}

/**
 * Owners and admins with the Security role manage their organization's providers.  What a provider
 * trusts decides who can sign in as whom, the owner included, so only an owner adds a provider,
 * changes its issuer, tenant, client, sign-in URL, or certificates, or turns on verified emails or
 * linking by email.  A client secret goes in and never comes back out: every answer says only
 * whether one is stored.  A SAML provider's certificates are public, so they come back with its
 * details and Riosoma's own.
 */
export async function ssoAdminRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const security = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  function view(request: FastifyRequest, row: ProviderRow, identities: number): SsoProvider {
    const saml = row.kind === 'saml' ? samlDetails(row, serverOrigin(ctx, request)) : undefined;
    return providerView(row, identities, redirectUri(ctx, request), saml);
  }

  app.get('/api/admin/sso', security, async (request): Promise<SsoProvider[]> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const result = await query<ProviderRow & { identities: number }>(
      pool,
      sql`SELECT p.*, (SELECT count(*)::int FROM ${identitiesTable(schemas)} i WHERE i.provider_id = p.id)
        AS identities
      FROM ${providersTable(schemas)} p WHERE p.org_id = ${actor.orgId} ORDER BY p.created_at, p.id`,
    );
    return result.rows.map((row) => view(request, row, row.identities));
  });

  async function createOidc(actor: Actor, input: OidcProviderCreate): Promise<ProviderRow> {
    const { issuer, tenant } = placement(input.kind, input);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const id = newProviderId();
    return withTransaction(pool, async (db) => {
      const created = await query<ProviderRow>(
        db,
        sql`INSERT INTO ${providersTable(schemas)}
        (id, org_id, kind, name, issuer, tenant, client_id, sealed_secret, allowed_domains, auto_create,
          link_by_email, enabled)
        VALUES (${id}, ${actor.orgId}, ${input.kind}, ${input.name}, ${issuer}, ${tenant}, ${input.clientId},
          ${await sealSecret(ctx.config.secretKey, id, input.clientSecret, actor.orgId, db)}, ${[...new Set(input.allowedDomains)]}::text[],
          ${input.autoCreate}, ${input.linkByEmail}, ${input.enabled})
        RETURNING *`,
      );
      await auditEvent(db, audit, 'org.sso.created', actor, { providerId: id, kind: input.kind });
      return created.rows[0]!;
    });
  }

  /** A SAML provider keeps no client or secret, only its identity provider's public details. */
  async function createSaml(actor: Actor, input: SamlProviderCreate): Promise<ProviderRow> {
    const entityId = checkEntityId(input.saml.entityId, 'saml.entityId');
    const ssoUrl = checkSsoUrl(input.saml.ssoUrl, 'saml.ssoUrl');
    const certificates = certificatesFrom(input.saml.certificates, 'saml.certificates');
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const id = input.id ?? newProviderId();
    return withTransaction(pool, async (db) => {
      const created = await query<ProviderRow>(
        db,
        sql`INSERT INTO ${providersTable(schemas)}
        (id, org_id, kind, name, issuer, tenant, client_id, sealed_secret, allowed_domains, auto_create,
          link_by_email, enabled, sso_url, certificates, verifies_emails)
        VALUES (${id}, ${actor.orgId}, 'saml', ${input.name}, ${entityId}, NULL, '', '',
          ${[...new Set(input.allowedDomains)]}::text[], ${input.autoCreate}, ${input.linkByEmail}, ${input.enabled},
          ${ssoUrl}, ${certificates}::text[], ${input.saml.verifiesEmails})
        ON CONFLICT (id) DO NOTHING RETURNING *`,
      );
      const row = created.rows[0];
      // Only a draft's ID can be taken, and only by saving the same draft twice.
      if (!row) throw new AppError('conflict', 'errors.conflict');
      await auditEvent(db, audit, 'org.sso.created', actor, { providerId: id, kind: 'saml' });
      return row;
    });
  }

  app.post('/api/admin/sso', security, async (request): Promise<SsoProvider> => {
    const actor = requireActor(request);
    if (actor.kind !== 'owner') throw ownerOnly();
    const input = parse(SsoProviderCreate, request.body);
    const row = input.kind === 'saml' ? await createSaml(actor, input) : await createOidc(actor, input);
    return view(request, row, 0);
  });

  app.patch('/api/admin/sso/:providerId', security, async (request): Promise<SsoProvider> => {
    const actor = requireActor(request);
    const { providerId } = parse(Params, request.params);
    const input = parse(SsoProviderUpdate, request.body);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      // Requiring single sign-on and turning providers off take turns, so neither misses the other.
      await lockUnits(db, actor.orgId);
      const found = await query<ProviderRow>(
        db,
        sql`SELECT * FROM ${providersTable(schemas)}
        WHERE id = ${providerId} AND org_id = ${actor.orgId} FOR UPDATE`,
      );
      const before = found.rows[0];
      if (!before) throw notFound();
      const turningOff = before.enabled && input.enabled === false;
      if (turningOff) await keepProviderWhileRequired(db, authDatabase(ctx).app, actor.orgId, providerId);
      const saml = before.kind === 'saml';
      let { issuer, tenant } = before;
      if (before.kind === 'microsoft' && input.tenant !== undefined) {
        tenant = normalTenant(input.tenant);
        issuer = microsoftIssuer(tenant);
      }
      if (before.kind === 'oidc' && input.issuer !== undefined) issuer = checkIssuer(input.issuer);
      // A stored secret never follows a provider to a new issuer: otherwise anyone allowed to edit
      // the issuer could collect the secret at a token endpoint of their own without ever seeing it.
      if (issuer !== before.issuer && before.kind === 'oidc' && input.clientSecret === undefined)
        throw fieldError('clientSecret', 'sso.secret.reenter');
      let { sso_url: ssoUrl, certificates, verifies_emails: verifiesEmails } = before;
      if (saml && input.saml) {
        if (input.saml.entityId !== undefined) issuer = checkEntityId(input.saml.entityId, 'saml.entityId');
        if (input.saml.ssoUrl !== undefined) ssoUrl = checkSsoUrl(input.saml.ssoUrl, 'saml.ssoUrl');
        if (input.saml.certificates !== undefined)
          certificates = certificatesFrom(input.saml.certificates, 'saml.certificates');
        verifiesEmails = input.saml.verifiesEmails ?? verifiesEmails;
      }
      // A client and its secret belong to OpenID Connect, and a SAML provider keeps neither.
      const clientId = saml ? before.client_id : (input.clientId ?? before.client_id);
      const linkByEmail = input.linkByEmail ?? before.link_by_email;
      // An edit that sends back what is stored changes nothing, and turning trust off only narrows it.
      const trust =
        issuer !== before.issuer ||
        tenant !== before.tenant ||
        clientId !== before.client_id ||
        (!saml && input.clientSecret !== undefined) ||
        ssoUrl !== before.sso_url ||
        [...certificates].sort().join() !== [...before.certificates].sort().join() ||
        (verifiesEmails && !before.verifies_emails) ||
        (linkByEmail && !before.link_by_email);
      if (trust && actor.kind !== 'owner') throw ownerOnly();
      const sealed =
        saml || input.clientSecret === undefined
          ? before.sealed_secret
          : await sealSecret(ctx.config.secretKey, providerId, input.clientSecret, actor.orgId, db);
      const domains = input.allowedDomains ? [...new Set(input.allowedDomains)] : before.allowed_domains;
      const updated = await query<ProviderRow>(
        db,
        sql`UPDATE ${providersTable(schemas)} SET
          name = ${input.name ?? before.name}, issuer = ${issuer}, tenant = ${tenant},
          client_id = ${clientId}, sealed_secret = ${sealed},
          allowed_domains = ${domains}::text[], auto_create = ${input.autoCreate ?? before.auto_create},
          link_by_email = ${linkByEmail},
          enabled = ${input.enabled ?? before.enabled}, sso_url = ${ssoUrl},
          certificates = ${certificates}::text[], verifies_emails = ${verifiesEmails},
          updated_at = clock_timestamp()
        WHERE id = ${providerId} RETURNING *`,
      );
      if (turningOff) await forgetProviderSessions(db, authDatabase(ctx).app, providerId);
      // Field names only: the values can include the secret.
      await auditEvent(db, audit, 'org.sso.updated', actor, { providerId, fields: changedFields(input) });
      return view(request, updated.rows[0]!, await identityCount(db, schemas, providerId));
    });
  });

  app.delete('/api/admin/sso/:providerId', security, async (request, reply) => {
    const actor = requireActor(request);
    const { providerId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      const { app: schema } = authDatabase(ctx);
      const found = await query<{ enabled: boolean }>(
        db,
        sql`SELECT enabled FROM ${providersTable(schemas)} WHERE id = ${providerId} AND org_id = ${actor.orgId}`,
      );
      if (found.rows[0]?.enabled) await keepProviderWhileRequired(db, schema, actor.orgId, providerId);
      await forgetProviderSessions(db, schema, providerId);
      // Identities, and the assertions a SAML provider has seen, go with it through foreign keys.
      const deleted = await query(
        db,
        sql`DELETE FROM ${providersTable(schemas)} WHERE id = ${providerId} AND org_id = ${actor.orgId}`,
      );
      if (!deleted.rowCount) throw notFound();
      await auditEvent(db, audit, 'org.sso.deleted', actor, { providerId });
    });
    return reply.code(204).send();
  });

  app.post('/api/admin/sso/test', security, async (request): Promise<SsoTestResult> => {
    requireActor(request);
    const { issuer } = parse(TestRequest, request.body);
    return testIssuer(issuer, ctx.config);
  });

  // A SAML provider's addresses include its ID, and an identity provider may want them before it
  // gives out its own details, so the ID comes first and the provider is saved under it.
  app.get('/api/admin/sso/saml/new', security, async (request): Promise<SamlDraft> => {
    requireActor(request);
    const id = newProviderId();
    return { id, serviceProvider: serviceProvider(serverOrigin(ctx, request), id) };
  });

  app.post('/api/admin/sso/saml/metadata', security, async (request): Promise<SamlMetadata> => {
    requireActor(request);
    const source = parse(SamlMetadataSource, request.body);
    if ('xml' in source) return readMetadata(source.xml, 'xml');
    return readMetadata(await fetchMetadata(source.url, ctx.config), 'url');
  });
}

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError, type SamlProviderDetails, type SsoKind, type SsoProvider } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { DataSchemas } from '../../data/context.js';
import { sealCredential, unsealCredential } from '../../credentials/service.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const MICROSOFT_ORIGIN = 'https://login.microsoftonline.com';
/** Any work or school account.  Each token's issuer is then checked against its own tenant. */
const MICROSOFT_ANY_TENANT = 'organizations';
/** A tenant ID or one of the tenant's domains: letters, digits, dots, and hyphens. */
const TENANT = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/;

export const CALLBACK_PATH = '/api/auth/sso/callback';

export interface ProviderRow {
  id: string;
  org_id: string;
  kind: SsoKind;
  name: string;
  /** The OpenID Connect issuer, or the SAML identity provider's entity ID */
  issuer: string;
  tenant: string | null;
  /** Empty for SAML, like the secret */
  client_id: string;
  sealed_secret: string;
  allowed_domains: string[];
  auto_create: boolean;
  link_by_email: boolean;
  enabled: boolean;
  /** SAML only: where the identity provider signs people in */
  sso_url: string | null;
  /** SAML only: the PEM certificates any one of which may sign */
  certificates: string[];
  /** SAML only: whether the identity provider's email addresses count as verified */
  verifies_emails: boolean;
  created_at: Date;
  updated_at: Date;
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Sixteen random letters and digits, the shape the contract gives a provider's ID. */
export function newProviderId(): string {
  let id = '';
  for (const byte of randomBytes(16)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export function providersTable(schemas: DataSchemas) {
  return ident(schemas.app, 'sso_providers');
}

export function identitiesTable(schemas: DataSchemas) {
  return ident(schemas.app, 'sso_identities');
}

/** The address people reach this server at: the configured one, or the one this request used. */
export function serverOrigin(ctx: AppContext, request: FastifyRequest): string {
  return ctx.config.baseUrl ? new URL(ctx.config.baseUrl).origin : `${request.protocol}://${request.host}`;
}

export function redirectUri(ctx: AppContext, request: FastifyRequest): string {
  return `${serverOrigin(ctx, request)}${CALLBACK_PATH}`;
}

export function fieldError(field: string, key = 'validation.invalid_format'): AppError {
  return new AppError('validation_failed', 'errors.validationFailed', { fields: { [field]: key } });
}

/**
 * An issuer Riosoma will talk to: https only, with no credentials, query, or fragment.  The value
 * is kept exactly as typed, because a provider's tokens must name the very same string.
 */
export function checkIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fieldError('issuer');
  }
  if (url.protocol !== 'https:') throw fieldError('issuer', 'sso.test.https');
  if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#'))
    throw fieldError('issuer');
  return value;
}

/** An empty tenant means any work or school account. */
export function normalTenant(value: string | undefined): string | null {
  const tenant = value?.trim() ?? '';
  if (!tenant) return null;
  if (!TENANT.test(tenant)) throw fieldError('tenant');
  return tenant;
}

export function microsoftIssuer(tenant: string | null): string {
  return `${MICROSOFT_ORIGIN}/${tenant ?? MICROSOFT_ANY_TENANT}/v2.0`;
}

/** Where a new provider signs people in: fixed for Google, from the tenant for Microsoft. */
export function placement(
  kind: SsoKind,
  input: { issuer?: string | undefined; tenant?: string | undefined },
): { issuer: string; tenant: string | null } {
  if (kind === 'google') return { issuer: GOOGLE_ISSUER, tenant: null };
  if (kind === 'microsoft') {
    const tenant = normalTenant(input.tenant);
    return { issuer: microsoftIssuer(tenant), tenant };
  }
  if (!input.issuer) throw fieldError('issuer', 'validation.invalid_type');
  return { issuer: checkIssuer(input.issuer), tenant: null };
}

function secretContext(providerId: string): string {
  return `sso:${providerId}`;
}

export async function sealSecret(
  key: Buffer,
  providerId: string,
  secret: string,
  orgId: string,
  db?: Queryable,
): Promise<string> {
  return sealCredential(key, secret, secretContext(providerId), orgId, db);
}

export async function providerSecret(key: Buffer, row: ProviderRow): Promise<string> {
  return unsealCredential(key, row.sealed_secret, secretContext(row.id), row.org_id);
}

/**
 * Changes whenever the provider's client settings do, so an edit also refreshes discovery
 * Sealing uses a fresh IV, so a replaced secret changes it too
 */
export function clientFingerprint(row: ProviderRow): string {
  return createHash('sha256')
    .update([row.id, row.issuer, row.client_id, row.sealed_secret].join('\n'))
    .digest('hex');
}

export function providerView(
  row: ProviderRow,
  identities: number,
  redirect: string,
  saml?: SamlProviderDetails,
): SsoProvider {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    issuer: row.issuer,
    tenant: row.tenant,
    clientId: row.client_id,
    hasSecret: Boolean(row.sealed_secret),
    allowedDomains: row.allowed_domains,
    autoCreate: row.auto_create,
    linkByEmail: row.link_by_email,
    enabled: row.enabled,
    redirectUri: redirect,
    createdAt: row.created_at.toISOString(),
    identities,
    ...(saml ? { saml } : {}),
  };
}

export async function identityCount(
  db: Queryable,
  schemas: DataSchemas,
  providerId: string,
): Promise<number> {
  const result = await query<{ count: number }>(
    db,
    sql`SELECT count(*)::int AS count FROM ${identitiesTable(schemas)} WHERE provider_id = ${providerId}`,
  );
  return result.rows[0]?.count ?? 0;
}

/** An enabled provider, whichever organization it belongs to.  Sign-in starts before anyone is known. */
export async function enabledProvider(
  db: Queryable,
  schemas: DataSchemas,
  providerId: string,
): Promise<ProviderRow | null> {
  const result = await query<ProviderRow>(
    db,
    sql`SELECT * FROM ${providersTable(schemas)} WHERE id = ${providerId} AND enabled`,
  );
  return result.rows[0] ?? null;
}

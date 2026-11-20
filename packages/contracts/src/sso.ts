import { z } from 'zod';

/**
 * Single sign-on with OpenID Connect (Google, Microsoft Entra ID, or any standard provider) or with
 * a SAML 2.0 identity provider.
 *
 * Admins with the Security role add providers.  People then see a button for each enabled one on
 * the sign-in page.  OpenID Connect sign-in uses the authorization code flow with PKCE, a state
 * value and a nonce bound to the browser by a short-lived cookie, and a callback only on this
 * server's own origin.  SAML sign-in sends an authentication request whose ID is bound to the
 * browser the same way, and accepts only a signed answer to that request at the provider's own
 * Assertion Consumer Service address.  A person is identified by the provider's issuer and subject
 * (for SAML, its entity ID and the `NameID`), never by email alone.  On a first sign-in, the
 * provider's verified email can link an existing account when the provider allows it, and new
 * accounts are created only for allowed email domains when the provider allows that.
 *
 * Routes:
 * - `GET /api/auth/sso` (public) → `SsoButton[]`, the enabled providers for the sign-in page
 * - `GET /api/auth/sso/:providerId/start?next=` (public) → redirects to an OpenID Connect provider
 * - `GET /api/auth/sso/callback` (public) → signs in and redirects to `next`, or to
 *   `/sign-in?error=<messageKey>` when it can't
 * - `GET /api/auth/saml/:providerId/start?next=` (public) → redirects to a SAML identity provider
 * - `POST /api/auth/saml/:providerId/acs` (public) → the Assertion Consumer Service: takes the
 *   identity provider's form post, then redirects the way the callback does
 * - `GET /api/auth/saml/:providerId/metadata` (public) → Riosoma's service provider metadata
 * - `GET /api/admin/sso`, `POST /api/admin/sso` (`SsoProviderCreate`), `PATCH /api/admin/sso/:providerId`
 *   (`SsoProviderUpdate`), `DELETE /api/admin/sso/:providerId`, `POST /api/admin/sso/test`
 *   (`{ issuer }`) → `SsoTestResult` (admin, Security area)
 * - `GET /api/admin/sso/saml/new` → `SamlDraft`, an ID for a new SAML provider with Riosoma's
 *   details for it, and `POST /api/admin/sso/saml/metadata` (`SamlMetadataSource`) →
 *   `SamlMetadata`, an identity provider's details read from its metadata (admin, Security area)
 */

export const SSO_KINDS = ['google', 'microsoft', 'oidc', 'saml'] as const;
export const SsoKind = z.enum(SSO_KINDS);
export type SsoKind = z.infer<typeof SsoKind>;

/** The kinds that sign in with OpenID Connect */
export const OIDC_KINDS = ['google', 'microsoft', 'oidc'] as const;
export const OidcKind = z.enum(OIDC_KINDS);
export type OidcKind = z.infer<typeof OidcKind>;

export const SsoProviderId = z.string().regex(/^[0-9A-Za-z]{16}$/);

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/** The button's label, like "Google" or "Acme single sign-on" */
const Name = z.string().trim().min(1).max(60);
/** Email domains allowed to create accounts on first sign-in.  Empty allows none. */
const AllowedDomains = z.array(Domain).max(50);
const ClientSecret = z.string().min(1).max(2_000);

/** At most this many signing certificates, enough for a rotation with one to spare. */
export const SAML_CERTIFICATE_LIMIT = 5;

/** A SAML identity provider's details: where it signs people in, and the keys it signs with. */
const SamlFields = {
  /** The identity provider's entity ID, the issuer named in everything it signs */
  entityId: z.string().trim().min(1).max(1_024),
  /** Where the identity provider signs people in with the HTTP-Redirect binding, over https */
  ssoUrl: z.string().trim().url().max(2_048),
  /**
   * The certificates it signs with, in PEM or as base64.  Any one of them may sign, so a rotation
   * can list the old one and the new.
   */
  certificates: z.array(z.string().trim().min(1).max(20_000)).min(1).max(SAML_CERTIFICATE_LIMIT),
  /** Whether the identity provider checks the email addresses it sends, so Riosoma can trust them */
  verifiesEmails: z.boolean(),
};

export const SamlSettings = z.object({
  ...SamlFields,
  verifiesEmails: SamlFields.verifiesEmails.default(false),
});
export type SamlSettings = z.infer<typeof SamlSettings>;

export const OidcProviderCreate = z.object({
  kind: OidcKind,
  name: Name,
  /**
   * The provider's issuer URL.  Google's and Microsoft's are filled in by the server: Microsoft's
   * from the tenant, or `organizations` for any work account.
   */
  issuer: z.string().url().max(500).optional(),
  tenant: z.string().max(100).optional(),
  clientId: z.string().min(1).max(500),
  /** Write-only; sealed with the instance key */
  clientSecret: ClientSecret,
  allowedDomains: AllowedDomains.default([]),
  /** Create accounts for new people from allowed domains */
  autoCreate: z.boolean().default(false),
  /** Link a first sign-in to an existing account with the same verified email */
  linkByEmail: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type OidcProviderCreate = z.infer<typeof OidcProviderCreate>;

export const SamlProviderCreate = z.object({
  kind: z.literal('saml'),
  /**
   * The ID from `GET /api/admin/sso/saml/new`, so the addresses already given to the identity
   * provider stay right.  Left out, the server makes one.
   */
  id: SsoProviderId.optional(),
  name: Name,
  saml: SamlSettings,
  allowedDomains: AllowedDomains.default([]),
  autoCreate: z.boolean().default(false),
  linkByEmail: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type SamlProviderCreate = z.infer<typeof SamlProviderCreate>;

export const SsoProviderCreate = z.discriminatedUnion('kind', [OidcProviderCreate, SamlProviderCreate]);
export type SsoProviderCreate = z.infer<typeof SsoProviderCreate>;

/**
 * A change to a provider of any kind.  Fields its kind doesn't use are ignored, and a field left
 * out keeps its value, so nothing here has a default.
 */
export const SsoProviderUpdate = z.object({
  name: Name.optional(),
  issuer: z.string().url().max(500).optional(),
  tenant: z.string().max(100).optional(),
  clientId: z.string().min(1).max(500).optional(),
  clientSecret: ClientSecret.optional(),
  saml: z.object(SamlFields).partial().optional(),
  allowedDomains: AllowedDomains.optional(),
  autoCreate: z.boolean().optional(),
  linkByEmail: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type SsoProviderUpdate = z.infer<typeof SsoProviderUpdate>;

export interface SamlCertificate {
  /** The certificate in PEM form */
  pem: string;
  /** Who it was issued to, like `CN=Okta` */
  subject: string;
  /** When it stops being valid, as an ISO timestamp */
  expiresAt: string;
  /** Its SHA-256 fingerprint in colon-separated hex */
  fingerprint: string;
}

/** Riosoma's side of a SAML provider, for the identity provider's own settings. */
export interface SamlServiceProvider {
  /** Riosoma's entity ID, which identity providers also call the audience or identifier */
  entityId: string;
  /** Where the identity provider sends its answer: the Assertion Consumer Service URL */
  acsUrl: string;
  /** Where Riosoma serves its metadata */
  metadataUrl: string;
  /** The metadata itself, for identity providers that take a file */
  metadata: string;
}

export interface SamlProviderDetails {
  entityId: string;
  ssoUrl: string;
  certificates: SamlCertificate[];
  verifiesEmails: boolean;
  serviceProvider: SamlServiceProvider;
}

export interface SsoProvider {
  id: string;
  kind: SsoKind;
  name: string;
  /** The OpenID Connect issuer, or the SAML identity provider's entity ID */
  issuer: string;
  tenant: string | null;
  /** Empty for SAML providers */
  clientId: string;
  hasSecret: boolean;
  allowedDomains: string[];
  autoCreate: boolean;
  linkByEmail: boolean;
  enabled: boolean;
  /** The OpenID Connect callback address to register with a provider, the same for every one */
  redirectUri: string;
  createdAt: string;
  /** People who have signed in with it */
  identities: number;
  /** A SAML provider's details, and Riosoma's for it */
  saml?: SamlProviderDetails;
}

export interface SsoButton {
  id: string;
  kind: SsoKind;
  name: string;
}

export interface SsoTestResult {
  ok: boolean;
  /** A `sso.test.*` message key when it failed */
  messageKey?: string;
  /** What the provider's discovery document says, when it loaded */
  discovered?: { issuer: string; authorizationEndpoint: string; pkce: boolean };
}

/** An ID for a SAML provider that isn't saved yet, with the addresses it will have. */
export interface SamlDraft {
  id: string;
  serviceProvider: SamlServiceProvider;
}

/** Where to read an identity provider's metadata from: its text, or an address that serves it. */
export const SamlMetadataSource = z.union([
  z.object({ xml: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ url: z.string().trim().url().max(2_048) }).strict(),
]);
export type SamlMetadataSource = z.infer<typeof SamlMetadataSource>;

/** An identity provider's details as its metadata gives them, ready for `SamlSettings`. */
export interface SamlMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: SamlCertificate[];
}

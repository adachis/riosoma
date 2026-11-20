import { randomBytes, X509Certificate } from 'node:crypto';
import {
  generateServiceProviderMetadata,
  SAML,
  SamlStatusError,
  ValidateInResponseTo,
  type CacheProvider,
  type Profile,
  type SamlConfig,
} from '@node-saml/node-saml';
import { parseXml2JsFromString } from '@node-saml/node-saml/lib/xml.js';
import {
  SAML_CERTIFICATE_LIMIT,
  type SamlCertificate,
  type SamlProviderDetails,
  type SamlServiceProvider,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { Claimed } from './accounts.js';
import type { FlowFailure } from './oidc.js';
import { fieldError, type ProviderRow } from './store.js';

/**
 * The SAML side of single sign-on, through node-saml.  The library verifies every signature
 * against the configured certificates only, never one a message carries, and refuses wrapped
 * signatures and more than one assertion.  It checks the audience, the timestamps with three
 * minutes' allowance for clock skew, and that the answer names the request this browser started.
 *
 * Around it, this module refuses document type declarations, so no external entity is ever read,
 * and messages that aren't signed, and it requires every signature a message carries to check out.
 * It also checks what the library leaves alone: the issuer, the destination and recipient, the
 * signed `InResponseTo`, the status, and the kind of `NameID`.  Nothing here logs an assertion or
 * anything in one.
 */

/** How long someone has at the identity provider before the sign-in has to start over. */
export const SAML_FLOW_MS = 10 * 60 * 1000;
/** How far apart Riosoma's clock and the identity provider's may be. */
export const CLOCK_SKEW_MS = 3 * 60 * 1000;
/** The oldest an assertion may be, counted from when it was issued. */
const ASSERTION_AGE_MS = SAML_FLOW_MS;
/** The longest base64 answer taken, far more than any identity provider sends. */
export const RESPONSE_LIMIT = 512 * 1024;

const SAML_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
/** A NameID that changes at every sign-in, so it can't say who someone is */
const TRANSIENT_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const NAME_ID_LIMIT = 512;

export type SamlRoute = 'start' | 'acs' | 'metadata';

export function samlPath(providerId: string, route: SamlRoute): string {
  return `/api/auth/saml/${providerId}/${route}`;
}

/**
 * Riosoma's side of one SAML provider.  Its entity ID is the address of its metadata, so an
 * identity provider that reads metadata from a URL finds it there.
 */
export function serviceProvider(origin: string, providerId: string): SamlServiceProvider {
  const entityId = `${origin}${samlPath(providerId, 'metadata')}`;
  const acsUrl = `${origin}${samlPath(providerId, 'acs')}`;
  const metadata = generateServiceProviderMetadata({
    issuer: entityId,
    callbackUrl: acsUrl,
    identifierFormat: null,
    wantAssertionsSigned: true,
    // The same provider always gets the same document.
    generateUniqueId: () => `_riosoma-${providerId}`,
  });
  return { entityId, acsUrl, metadataUrl: entityId, metadata };
}

/**
 * The name a SAML identity is kept under: the identity provider's entity ID, within the
 * organization.  An admin types the entity ID and supplies the certificates, so without the
 * organization one organization's provider could claim identities another's provider made, and
 * the `saml:` start keeps SAML identities apart from OpenID Connect issuers.
 */
export function identityIssuer(provider: ProviderRow): string {
  return `saml:${provider.org_id}:${provider.issuer}`;
}

// Certificates

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/g;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function fromBase64(text: string): X509Certificate | null {
  const body = text.replace(/\s+/g, '');
  if (!body || !BASE64.test(body)) return null;
  try {
    return new X509Certificate(Buffer.from(body, 'base64'));
  } catch {
    return null;
  }
}

/**
 * The certificates in some pasted text: any PEM blocks, or else one certificate's base64 body, as
 * identity providers often show it.  Text holding a private key is refused outright, since a
 * signing key belongs only at the identity provider.
 */
export function readCertificates(text: string): X509Certificate[] | 'privateKey' | null {
  if (/PRIVATE KEY/i.test(text)) return 'privateKey';
  const blocks = [...text.matchAll(PEM_CERTIFICATE)];
  if (!blocks.length) {
    const one = fromBase64(text);
    return one ? [one] : null;
  }
  const certificates: X509Certificate[] = [];
  for (const block of blocks) {
    const certificate = fromBase64(block[1] ?? '');
    if (!certificate) return null;
    certificates.push(certificate);
  }
  return certificates;
}

/**
 * Every certificate in the texts, once each, as PEM.  A field error names the entry that isn't a
 * certificate.  The text itself is never repeated back or logged.
 */
export function certificatesFrom(texts: string[], field: string): string[] {
  const found = new Map<string, string>();
  texts.forEach((text, index) => {
    const certificates = readCertificates(text);
    if (certificates === 'privateKey')
      throw fieldError(`${field}.${index}`, 'sso.saml.certificate.privateKey');
    if (!certificates) throw fieldError(`${field}.${index}`, 'sso.saml.certificate.invalid');
    for (const certificate of certificates) found.set(certificate.fingerprint256, certificate.toString());
  });
  if (found.size > SAML_CERTIFICATE_LIMIT) throw fieldError(field, 'validation.too_big');
  return [...found.values()];
}

export function certificateView(certificate: X509Certificate): SamlCertificate {
  return {
    pem: certificate.toString(),
    subject: certificate.subject.split('\n').join(', '),
    expiresAt: certificate.validToDate.toISOString(),
    fingerprint: certificate.fingerprint256,
  };
}

function storedCertificate(pem: string): SamlCertificate[] {
  try {
    return [certificateView(new X509Certificate(pem))];
  } catch {
    return [];
  }
}

export function samlDetails(row: ProviderRow, origin: string): SamlProviderDetails {
  return {
    entityId: row.issuer,
    ssoUrl: row.sso_url ?? '',
    certificates: row.certificates.flatMap(storedCertificate),
    verifiesEmails: row.verifies_emails,
    serviceProvider: serviceProvider(origin, row.id),
  };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An entity ID Riosoma will match against: any URI, with nothing invisible in it. */
export function checkEntityId(value: string, field: string): string {
  if (hasControlCharacters(value)) throw fieldError(field);
  return value;
}

/** Where people are sent to sign in: https only, with no credentials or fragment. */
export function checkSsoUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fieldError(field);
  }
  if (url.protocol !== 'https:') throw fieldError(field, 'sso.saml.url.https');
  if (url.username || url.password || url.hash || value.includes('#') || hasControlCharacters(value))
    throw fieldError(field);
  return value;
}

// The authentication request

/** A request ID in the shape node-saml makes them. */
export function newRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

function baseOptions(provider: ProviderRow, sp: SamlServiceProvider): SamlConfig {
  return {
    issuer: sp.entityId,
    audience: sp.entityId,
    callbackUrl: sp.acsUrl,
    entryPoint: provider.sso_url ?? undefined,
    idpCert: provider.certificates,
    // No idpIssuer: the library compares it byte for byte, while checkResponse compares the issuer
    // with the whitespace some identity providers write around it trimmed away.
    // The identity provider chooses the NameID format, and how people prove who they are.
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: ASSERTION_AGE_MS,
  };
}

/** Where to send the browser: the identity provider, carrying a request with this ID. */
export async function authorizeUrl(
  provider: ProviderRow,
  sp: SamlServiceProvider,
  requestId: string,
): Promise<string> {
  const saml = new SAML({ ...baseOptions(provider, sp), generateUniqueId: () => requestId });
  return saml.getAuthorizeUrlAsync('', undefined, {});
}

// The answer

/** The request this browser started, from its sealed flow cookie. */
export interface FlowBinding {
  requestId: string;
  /** When it started, in milliseconds */
  startedAt: number;
}

export type ResponseCheck =
  | { ok: true; claimed: Claimed; assertionId: string; expiresAt: Date }
  | { ok: false; failure: FlowFailure; reason: string };

/**
 * Knows exactly one request: the one this browser's cookie names.  An answer to any other
 * request, even one Riosoma really sent to someone else, is refused.
 */
function flowCache(flow: FlowBinding): CacheProvider {
  const startedAt = new Date(flow.startedAt).toISOString();
  return {
    saveAsync: async () => null,
    getAsync: async (key) => (key === flow.requestId ? startedAt : null),
    removeAsync: async () => null,
  };
}

const Text = z.union([z.string(), z.object({ _: z.string() })]);
type Text = z.infer<typeof Text>;

function textOf(value: Text): string {
  return typeof value === 'string' ? value : value._;
}

/** The unsigned outside of an answer, read only to decide what the library must check. */
const Envelope = z.object({
  Response: z.object({
    $: z.object({ InResponseTo: z.string().optional(), Destination: z.string().optional() }),
    Issuer: z.array(Text).max(1).optional(),
    Status: z
      .array(z.object({ StatusCode: z.array(z.object({ $: z.object({ Value: z.string() }) })).min(1) }))
      .length(1),
    Signature: z.array(z.unknown()).optional(),
    Assertion: z.array(z.object({ Signature: z.array(z.unknown()).optional() })).optional(),
    EncryptedAssertion: z.array(z.unknown()).optional(),
  }),
});

/** The parts of a signed assertion checked here, as the library parsed them from signed XML. */
const SignedAssertion = z.object({
  Assertion: z.object({
    $: z.object({ ID: z.string().min(1).max(256), IssueInstant: z.string() }),
    Issuer: z.array(Text).length(1),
    Subject: z
      .array(
        z.object({
          NameID: z
            .array(z.object({ _: z.string(), $: z.object({ Format: z.string().optional() }).optional() }))
            .length(1),
          SubjectConfirmation: z
            .array(
              z.object({
                $: z.object({ Method: z.string() }),
                SubjectConfirmationData: z
                  .array(
                    z.object({
                      $: z.object({
                        Recipient: z.string().optional(),
                        InResponseTo: z.string().optional(),
                        NotOnOrAfter: z.string().optional(),
                      }),
                    }),
                  )
                  .length(1),
              }),
            )
            .min(1),
        }),
      )
      .length(1),
    Conditions: z.array(z.object({ $: z.object({ NotOnOrAfter: z.string() }) })).length(1),
  }),
});

/** The library's reason, reduced to a word for the log: its own message can quote the assertion. */
const LIBRARY_REASONS: Array<[RegExp, string]> = [
  [/multiple|more than one|too many|refer to/i, 'wrapped'],
  [/signature/i, 'signature'],
  [/audience/i, 'audience'],
  [/expired|too old/i, 'expired'],
  [/not yet valid/i, 'early'],
  [/InResponseTo/i, 'inResponseTo'],
  [/decrypt|encrypted/i, 'encrypted'],
  [/issuer/i, 'issuer'],
];

function libraryReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return LIBRARY_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'invalid';
}

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'urn:oid:1.2.840.113549.1.9.1',
];
const NAME_ATTRIBUTES = [
  'name',
  'displayname',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
];
const GIVEN_NAME_ATTRIBUTES = [
  'givenname',
  'firstname',
  'first_name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  'urn:oid:2.5.4.42',
];
const FAMILY_NAME_ATTRIBUTES = [
  'sn',
  'surname',
  'familyname',
  'lastname',
  'last_name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  'urn:oid:2.5.4.4',
];

const Attributes = z.record(z.string(), z.unknown()).catch({});

function firstText(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

/** The first of these attributes that has a value, matching names without regard to case. */
function attribute(attributes: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names)
    for (const [key, value] of Object.entries(attributes))
      if (key.toLowerCase() === name) {
        const text = firstText(value);
        if (text) return text;
      }
  return undefined;
}

function displayName(attributes: Record<string, unknown>): string | undefined {
  const whole = attribute(attributes, NAME_ATTRIBUTES);
  if (whole) return whole;
  const parts = [attribute(attributes, GIVEN_NAME_ATTRIBUTES), attribute(attributes, FAMILY_NAME_ATTRIBUTES)];
  return parts.filter(Boolean).join(' ') || undefined;
}

/** Until the latest moment the assertion could still be accepted, with the clock allowance. */
function keepUntil(times: string[], issued: string): Date | null {
  const moments = times.map((time) => Date.parse(time));
  const start = Date.parse(issued);
  if (Number.isNaN(start) || moments.some((moment) => Number.isNaN(moment))) return null;
  return new Date(Math.max(start + ASSERTION_AGE_MS, ...moments) + CLOCK_SKEW_MS);
}

/**
 * Checks an identity provider's answer, the base64 `SAMLResponse` it posted, against the request
 * this browser started.  An answer that checks out says who the person is and which assertion
 * said so.
 */
export async function checkResponse(
  provider: ProviderRow,
  sp: SamlServiceProvider,
  flow: FlowBinding,
  encoded: string,
): Promise<ResponseCheck> {
  const refused = (failure: FlowFailure, reason: string): ResponseCheck => ({ ok: false, failure, reason });
  if (!encoded || encoded.length > RESPONSE_LIMIT || !/^[A-Za-z0-9+/=\s]+$/.test(encoded))
    return refused('sso.token', 'encoding');
  const xml = Buffer.from(encoded, 'base64').toString('utf8');
  // SAML never needs a document type, and one is how external entities get in.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return refused('sso.token', 'doctype');
  let parsed: unknown;
  try {
    parsed = await parseXml2JsFromString(xml);
  } catch {
    return refused('sso.token', 'xml');
  }
  const envelope = Envelope.safeParse(parsed);
  if (!envelope.success) return refused('sso.token', 'shape');
  const response = envelope.data.Response;
  if (response.Status[0]?.StatusCode[0]?.$.Value !== SUCCESS) return refused('sso.denied', 'status');
  if (response.$.InResponseTo !== flow.requestId) return refused('sso.state', 'inResponseTo');
  if (response.$.Destination !== sp.acsUrl) return refused('sso.token', 'destination');
  const outerIssuer = response.Issuer?.[0];
  if (outerIssuer !== undefined && textOf(outerIssuer).trim() !== provider.issuer)
    return refused('sso.token', 'issuer');
  const assertions = response.Assertion ?? [];
  if (assertions.length !== 1 || response.EncryptedAssertion?.length)
    return refused('sso.token', 'assertions');
  const responseSigned = Boolean(response.Signature?.length);
  const assertionSigned = Boolean(assertions[0]?.Signature?.length);
  if (!responseSigned && !assertionSigned) return refused('sso.token', 'unsigned');

  const saml = new SAML({
    ...baseOptions(provider, sp),
    // Every signature present has to check out, and at least one covers the assertion.
    wantAuthnResponseSigned: responseSigned,
    wantAssertionsSigned: assertionSigned,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_FLOW_MS,
    cacheProvider: flowCache(flow),
  });
  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: encoded }));
  } catch (error) {
    const reason = libraryReason(error);
    if (error instanceof SamlStatusError) return refused('sso.denied', reason);
    // Answering some other request is the same mistake however the library found it.
    return refused(reason === 'inResponseTo' ? 'sso.state' : 'sso.token', reason);
  }
  if (!profile) return refused('sso.token', 'empty');

  // From here on, everything comes from XML a trusted certificate signed.
  const signed = SignedAssertion.safeParse(profile.getAssertion?.());
  if (!signed.success) return refused('sso.token', 'assertion');
  const assertion = signed.data.Assertion;
  if (textOf(assertion.Issuer[0]!).trim() !== provider.issuer) return refused('sso.token', 'issuer');
  // The library never checks when an assertion was issued, only its limits, so a clock too far ahead
  // is caught here.
  if (!(Date.parse(assertion.$.IssueInstant) <= Date.now() + CLOCK_SKEW_MS))
    return refused('sso.token', 'early');
  const subject = assertion.Subject[0]!;
  for (const confirmation of subject.SubjectConfirmation) {
    const data = confirmation.SubjectConfirmationData[0]!.$;
    if (confirmation.$.Method !== BEARER || !data.NotOnOrAfter) return refused('sso.token', 'confirmation');
    if (data.Recipient !== sp.acsUrl) return refused('sso.token', 'recipient');
    if (data.InResponseTo !== flow.requestId) return refused('sso.state', 'inResponseTo');
  }
  const nameId = subject.NameID[0]!;
  const nameValue = nameId._.trim();
  const format = nameId.$?.Format;
  if (!nameValue || nameValue.length > NAME_ID_LIMIT) return refused('sso.token', 'nameId');
  if (format === TRANSIENT_FORMAT) return refused('sso.token', 'transient');
  const expiresAt = keepUntil(
    [
      assertion.Conditions[0]!.$.NotOnOrAfter,
      ...subject.SubjectConfirmation.map(
        (confirmation) => confirmation.SubjectConfirmationData[0]!.$.NotOnOrAfter ?? '',
      ),
    ],
    assertion.$.IssueInstant,
  );
  if (!expiresAt) return refused('sso.token', 'times');

  const attributes = Attributes.parse(profile.attributes);
  const email = attribute(attributes, EMAIL_ATTRIBUTES) ?? (format === EMAIL_FORMAT ? nameValue : undefined);
  return {
    ok: true,
    assertionId: assertion.$.ID,
    expiresAt,
    claimed: {
      issuer: identityIssuer(provider),
      subject: nameValue,
      email,
      emailVerified: provider.verifies_emails,
      name: displayName(attributes),
    },
  };
}

/** Whether a metadata document says the entity speaks SAML 2.0. */
export function speaksSaml(protocols: string): boolean {
  return protocols.split(/\s+/).includes(SAML_PROTOCOL);
}

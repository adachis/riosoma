import { isIP } from 'node:net';
import { parseXml2JsFromString } from '@node-saml/node-saml/lib/xml.js';
import { AppError, SAML_CERTIFICATE_LIMIT, type SamlMetadata } from '@riosoma/contracts';
import { z } from 'zod';
import { callOut, isPublicAddress, OutboundError, systemResolve } from '../../automations/outbound.js';
import type { RuntimeConfig } from '../../config.js';
import { allowsPrivate } from '../../webhooks/url.js';
import { certificateView, readCertificates, speaksSaml } from './saml.js';

/**
 * Reading an identity provider's details from its metadata, pasted or at an address.  An address
 * is fetched once, when an admin asks, through the same guarded client webhooks use: https only,
 * never a private network unless the operator allows private hosts, no redirects, and a size
 * limit.  Nothing is refreshed later, so an admin loads the metadata again to pick up a new
 * certificate.
 */

/** The largest metadata document read, far more than one identity provider needs. */
export const METADATA_LIMIT = 1_000_000;

const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

function problem(field: 'xml' | 'url', key: string): AppError {
  return new AppError('validation_failed', key, { fields: { [field]: key } });
}

const Text = z.union([z.string(), z.object({ _: z.string() })]);

const KeyDescriptor = z.object({
  $: z.object({ use: z.string().optional() }).optional(),
  KeyInfo: z
    .array(
      z.object({
        X509Data: z.array(z.object({ X509Certificate: z.array(Text).optional() })).optional(),
      }),
    )
    .optional(),
});

const IdpDescriptor = z.object({
  $: z.object({ protocolSupportEnumeration: z.string() }),
  KeyDescriptor: z.array(z.union([KeyDescriptor, z.string()])).optional(),
  SingleSignOnService: z
    .array(z.object({ $: z.object({ Binding: z.string(), Location: z.string() }) }))
    .optional(),
});

const EntityDescriptor = z.object({
  $: z.object({ entityID: z.string() }),
  IDPSSODescriptor: z.array(z.union([IdpDescriptor, z.string()])).optional(),
});
type EntityDescriptor = z.infer<typeof EntityDescriptor>;

const MetadataDocument = z.union([
  z.object({ EntityDescriptor }),
  z.object({
    EntitiesDescriptor: z.object({
      EntityDescriptor: z.array(z.union([EntityDescriptor, z.string()])).optional(),
    }),
  }),
]);

function identityProviders(entity: EntityDescriptor) {
  return (entity.IDPSSODescriptor ?? []).flatMap((descriptor) =>
    typeof descriptor !== 'string' && speaksSaml(descriptor.$.protocolSupportEnumeration) ? [descriptor] : [],
  );
}

/**
 * The identity provider a metadata document describes: its entity ID, where it takes requests
 * with the HTTP-Redirect binding, and the certificates it signs with.
 */
export async function readMetadata(xml: string, field: 'xml' | 'url' = 'xml'): Promise<SamlMetadata> {
  // Metadata never needs a document type, and one is how external entities get in.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw problem(field, 'sso.saml.metadata.invalid');
  let parsed: unknown;
  try {
    parsed = await parseXml2JsFromString(xml);
  } catch {
    throw problem(field, 'sso.saml.metadata.invalid');
  }
  const document = MetadataDocument.safeParse(parsed);
  if (!document.success) throw problem(field, 'sso.saml.metadata.invalid');
  const entities =
    'EntityDescriptor' in document.data
      ? [document.data.EntityDescriptor]
      : (document.data.EntitiesDescriptor.EntityDescriptor ?? []).flatMap((entity) =>
          typeof entity === 'string' ? [] : [entity],
        );
  const providers = entities.filter((entity) => identityProviders(entity).length > 0);
  if (providers.length !== 1) throw problem(field, 'sso.saml.metadata.invalid');
  const entity = providers[0]!;
  const descriptors = identityProviders(entity);

  const ssoUrl = descriptors
    .flatMap((descriptor) => descriptor.SingleSignOnService ?? [])
    .find((service) => service.$.Binding === REDIRECT_BINDING)?.$.Location;
  const found = new Map<string, ReturnType<typeof certificateView>>();
  for (const descriptor of descriptors)
    for (const key of descriptor.KeyDescriptor ?? []) {
      // A key without a use signs as well as encrypts.
      if (typeof key === 'string' || (key.$?.use !== undefined && key.$.use !== 'signing')) continue;
      for (const info of key.KeyInfo ?? [])
        for (const data of info.X509Data ?? [])
          for (const text of data.X509Certificate ?? []) {
            const certificates = readCertificates(typeof text === 'string' ? text : text._);
            if (!Array.isArray(certificates)) throw problem(field, 'sso.saml.metadata.invalid');
            for (const certificate of certificates)
              found.set(certificate.fingerprint256, certificateView(certificate));
          }
    }
  if (!ssoUrl || found.size === 0 || found.size > SAML_CERTIFICATE_LIMIT)
    throw problem(field, 'sso.saml.metadata.incomplete');
  return { entityId: entity.$.entityID.trim(), ssoUrl: ssoUrl.trim(), certificates: [...found.values()] };
}

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

function isLocalhost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

/**
 * Fetches metadata from an address.  It has to use https, except `http://localhost` while
 * developing, carry no credentials, and stay off private networks unless the operator allows them.
 */
export async function fetchMetadata(value: string, config: Config): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem('url', 'sso.saml.metadata.unreachable');
  }
  const local = isLocalhost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !config.production))
    throw problem('url', 'sso.saml.url.https');
  if (url.username || url.password) throw problem('url', 'sso.saml.metadata.unreachable');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const allowPrivate = allowsPrivate(url.href, config);
  if (!allowPrivate && (local || (isIP(host) && !isPublicAddress(host))))
    throw problem('url', 'sso.saml.metadata.private');
  url.hash = '';
  try {
    const response = await callOut(
      {
        url: url.href,
        method: 'GET',
        headers: {
          'user-agent': 'Riosoma-SAML',
          accept: 'application/samlmetadata+xml, application/xml, text/xml',
        },
        body: null,
      },
      { resolve: systemResolve, allowPrivate, responseLimit: METADATA_LIMIT },
    );
    if (response.status !== 200 || response.truncated) throw problem('url', 'sso.saml.metadata.unreachable');
    return response.body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof OutboundError && error.messageKey === 'automations.webhook.blocked')
      throw problem('url', 'sso.saml.metadata.private');
    throw problem('url', 'sso.saml.metadata.unreachable');
  }
}

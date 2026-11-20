import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parseXml2JsFromString, signXml } from '@node-saml/node-saml/lib/xml.js';
import { z } from 'zod';

/**
 * A small SAML identity provider for tests.  It makes its own RSA key and a self-signed
 * certificate for it, reads the authentication request a `start` redirect carries, and answers
 * with a response signed the way real identity providers sign them: the assertion, the whole
 * response, or both.  Tests can bend any answer (its audience, destination, times, or signer, or
 * the XML itself after signing) to check each refusal.
 */

// A certificate is a little DER: enough of it to wrap a public key and sign it with its own key.

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function oid(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const encoded = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) encoded.unshift(0x80 | (value & 0x7f));
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function integer(value: Buffer): Buffer {
  // DER wants the shortest form: no leading zero bytes, except one that keeps the number positive.
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const bytes = value.subarray(start);
  return der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function utcTime(date: Date): Buffer {
  return der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
}

function commonName(name: string): Buffer {
  return der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(name)))));
}

export interface KeyAndCertificate {
  /** PEM */
  certificate: string;
  /** PKCS #8 PEM */
  privateKey: string;
}

/** An RSA key and a self-signed certificate for it, valid from a minute ago. */
export function selfSignedCertificate(name: string, days = 365): KeyAndCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = der(0x30, oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const now = Date.now();
  const tbs = der(
    0x30,
    der(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(8)),
    sha256WithRsa,
    commonName(name),
    der(0x30, utcTime(new Date(now - 60_000)), utcTime(new Date(now + days * 86_400_000))),
    commonName(name),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const body = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature)).toString('base64');
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** A certificate's base64 body, as metadata carries it. */
export function certificateBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
export const PERSISTENT_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const TRANSIENT_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';

export interface SamlPerson {
  nameId: string;
  /** The email address format unless set */
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
}

/** What the identity provider read from Riosoma's request. */
export interface AuthnRequest {
  id: string;
  issuer: string;
  acsUrl: string;
  destination: string;
  /** The request's parameters besides the request itself */
  parameters: URLSearchParams;
  /** The request's XML, for checking what it asks */
  xml: string;
}

export interface Answer {
  /** What gets signed: the assertion unless set */
  sign?: 'assertion' | 'response' | 'both' | 'none';
  /** Signs with a key this identity provider never published, and includes that key's certificate */
  foreignKey?: boolean;
  issuer?: string;
  audience?: string;
  /** The response's Destination, or null to leave it out */
  destination?: string | null;
  /** The subject confirmation's Recipient */
  recipient?: string;
  /** The response's InResponseTo, or null to leave it out */
  inResponseTo?: string | null;
  /** The signed subject confirmation's InResponseTo, or null to leave it out */
  subjectInResponseTo?: string | null;
  status?: string;
  /** When the assertion was issued, now unless set */
  issuedAt?: Date;
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
  /** Who signs in, the identity provider's own person unless set */
  person?: SamlPerson;
  /** Changes the XML before it's signed, as an unusual but honest identity provider might */
  shape?: (xml: string) => string;
  /** Changes the XML after it's signed, as an attacker would */
  tamper?: (xml: string) => string;
}

export interface TestIdp {
  entityId: string;
  /** Where Riosoma sends people, with the HTTP-Redirect binding */
  ssoUrl: string;
  /** PEM */
  certificate: string;
  /** Who signs in when an answer doesn't say */
  person: SamlPerson;
  /** The identity provider's metadata, as it would publish it */
  metadata(): string;
  /** Reads the authentication request in the redirect `start` sent */
  read(location: string): Promise<AuthnRequest>;
  /** The XML of an answer, signed, before it's encoded */
  answerXml(request: AuthnRequest, answer?: Answer): string;
  /** The base64 `SAMLResponse` answering a request */
  answer(request: AuthnRequest, answer?: Answer): string;
}

const ParsedRequest = z.object({
  AuthnRequest: z.object({
    $: z.object({ ID: z.string(), Destination: z.string(), AssertionConsumerServiceURL: z.string() }),
    Issuer: z.array(z.object({ _: z.string() })).length(1),
  }),
});

function attributeStatement(attributes: Record<string, string | string[]>): string {
  const entries = Object.entries(attributes);
  if (!entries.length) return '';
  const values = (value: string | string[]) =>
    (Array.isArray(value) ? value : [value])
      .map((item) => `<saml:AttributeValue>${escapeXml(item)}</saml:AttributeValue>`)
      .join('');
  return `<saml:AttributeStatement>${entries
    .map(([name, value]) => `<saml:Attribute Name="${escapeXml(name)}">${values(value)}</saml:Attribute>`)
    .join('')}</saml:AttributeStatement>`;
}

const ASSERTION = "//*[local-name(.)='Assertion']";
const RESPONSE = "/*[local-name(.)='Response']";

export function startTestIdp(options: { entityId?: string } = {}): TestIdp {
  const host = `idp-${randomBytes(4).toString('hex')}.example.test`;
  const own = selfSignedCertificate('Test identity provider');
  const foreign = selfSignedCertificate('Someone else');

  function signed(xml: string, what: string, key: KeyAndCertificate): string {
    return signXml(
      xml,
      what,
      // Right after the Issuer, where the schema puts a signature.
      { reference: `${what}/*[local-name(.)='Issuer']`, action: 'after' },
      {
        privateKey: key.privateKey,
        publicCert: key.certificate,
        signatureAlgorithm: 'sha256',
        digestAlgorithm: 'sha256',
      },
    );
  }

  const idp: TestIdp = {
    entityId: options.entityId ?? `https://${host}/saml/metadata`,
    ssoUrl: `https://${host}/saml/sso`,
    certificate: own.certificate,
    person: { nameId: 'person@example.test', attributes: {} },
    metadata() {
      return `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(idp.entityId)}"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificateBody(own.certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>${EMAIL_FORMAT}</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(idp.ssoUrl)}/post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escapeXml(idp.ssoUrl)}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    },
    async read(location) {
      const url = new URL(location);
      const encoded = url.searchParams.get('SAMLRequest');
      if (!encoded) throw new Error('no SAMLRequest in the redirect');
      const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
      const request = ParsedRequest.parse(await parseXml2JsFromString(xml)).AuthnRequest;
      const parameters = new URLSearchParams(url.search);
      parameters.delete('SAMLRequest');
      return {
        id: request.$.ID,
        issuer: request.Issuer[0]!._,
        acsUrl: request.$.AssertionConsumerServiceURL,
        destination: request.$.Destination,
        parameters,
        xml,
      };
    },
    answerXml(request, answer = {}) {
      const now = answer.issuedAt ?? new Date();
      const notBefore = answer.notBefore ?? new Date(now.getTime() - 30_000);
      const notOnOrAfter = answer.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
      const person = answer.person ?? idp.person;
      const issuer = escapeXml(answer.issuer ?? idp.entityId);
      const destination = answer.destination === undefined ? request.acsUrl : answer.destination;
      const inResponseTo = answer.inResponseTo === undefined ? request.id : answer.inResponseTo;
      const subjectInResponseTo =
        answer.subjectInResponseTo === undefined ? request.id : answer.subjectInResponseTo;
      const assertionId = answer.assertionId ?? `_a${randomBytes(16).toString('hex')}`;
      const attribute = (name: string, value: string | null | undefined) =>
        value === null || value === undefined ? '' : ` ${name}="${escapeXml(value)}"`;
      let xml =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(16).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}"${attribute('Destination', destination)}${attribute('InResponseTo', inResponseTo)}>` +
        `<saml:Issuer>${issuer}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="${escapeXml(answer.status ?? SUCCESS)}"/></samlp:Status>` +
        `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
        `<saml:Issuer>${issuer}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="${escapeXml(person.nameIdFormat ?? EMAIL_FORMAT)}">${escapeXml(person.nameId)}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${attribute('InResponseTo', subjectInResponseTo)} NotOnOrAfter="${notOnOrAfter.toISOString()}" Recipient="${escapeXml(answer.recipient ?? request.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${notBefore.toISOString()}" NotOnOrAfter="${notOnOrAfter.toISOString()}"><saml:AudienceRestriction><saml:Audience>${escapeXml(answer.audience ?? request.issuer)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s${randomBytes(8).toString('hex')}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        attributeStatement(person.attributes ?? {}) +
        `</saml:Assertion></samlp:Response>`;
      if (answer.shape) xml = answer.shape(xml);
      const key = answer.foreignKey ? foreign : own;
      const what = answer.sign ?? 'assertion';
      if (what === 'assertion' || what === 'both') xml = signed(xml, ASSERTION, key);
      if (what === 'response' || what === 'both') xml = signed(xml, RESPONSE, key);
      return answer.tamper ? answer.tamper(xml) : xml;
    },
    answer(request, answer = {}) {
      return Buffer.from(idp.answerXml(request, answer), 'utf8').toString('base64');
    },
  };
  return idp;
}

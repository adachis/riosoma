import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SamlDraft, SamlMetadata, SsoProvider } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { certificateBody, selfSignedCertificate, startTestIdp, type TestIdp } from '../../test/saml-idp.js';

const BASE = 'https://riosoma.example.test';
let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function setup() {
  const server = await startServer(kit, 'samladmin', { baseUrl: `${BASE}/` });
  cleanups.push(() => server.close());
  return { server, idp: startTestIdp() };
}

function call(
  server: ServerFixture,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  who: SignedIn | null = server.owner,
) {
  return server.app.inject({
    method,
    url,
    headers: who ? who.headers : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function create(server: ServerFixture, idp: TestIdp, overrides: Record<string, unknown> = {}, saml = {}) {
  return call(server, 'POST', '/api/admin/sso', {
    kind: 'saml',
    name: 'Okta',
    saml: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificates: [idp.certificate], ...saml },
    ...overrides,
  });
}

function fieldsOf(response: LightMyRequestResponse): Record<string, string> | undefined {
  return response.json<{ error: { fields?: Record<string, string> } }>().error.fields;
}

function readMetadata(server: ServerFixture, source: Record<string, string>, who?: SignedIn | null) {
  return call(server, 'POST', '/api/admin/sso/saml/metadata', source, who);
}

/** Serves metadata on a loopback port, the way an identity provider publishes it. */
async function publish(body: () => { status: number; text: string }): Promise<string> {
  const server: Server = createServer((_request, response) => {
    const { status, text } = body();
    response.writeHead(status, { 'content-type': 'application/samlmetadata+xml' });
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/app/exk1/sso/saml/metadata`;
}

describe('SAML provider administration', () => {
  it('gives a new provider its ID and Riosoma’s details before it’s saved', async () => {
    const { server, idp } = await setup();
    const draft = (await call(server, 'GET', '/api/admin/sso/saml/new')).json<SamlDraft>();
    expect(draft.id).toMatch(/^[0-9A-Za-z]{16}$/);
    const entityId = `${BASE}/api/auth/saml/${draft.id}/metadata`;
    const acsUrl = `${BASE}/api/auth/saml/${draft.id}/acs`;
    expect(draft.serviceProvider).toMatchObject({ entityId, acsUrl, metadataUrl: entityId });
    expect(draft.serviceProvider.metadata).toContain(`entityID="${entityId}"`);
    expect(draft.serviceProvider.metadata).toContain(`Location="${acsUrl}"`);
    expect(draft.serviceProvider.metadata).toContain('WantAssertionsSigned="true"');
    // Each draft is new.
    expect((await call(server, 'GET', '/api/admin/sso/saml/new')).json<SamlDraft>().id).not.toBe(draft.id);

    const response = await create(server, idp, { id: draft.id, allowedDomains: ['Example.org'] });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const created = response.json<SsoProvider>();
    expect(created).toEqual({
      id: draft.id,
      kind: 'saml',
      name: 'Okta',
      issuer: idp.entityId,
      tenant: null,
      clientId: '',
      hasSecret: false,
      allowedDomains: ['example.org'],
      autoCreate: false,
      linkByEmail: true,
      enabled: true,
      redirectUri: `${BASE}/api/auth/sso/callback`,
      createdAt: expect.any(String),
      identities: 0,
      saml: {
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        certificates: [
          {
            pem: idp.certificate,
            subject: 'CN=Test identity provider',
            expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
          },
        ],
        verifiesEmails: false,
        serviceProvider: draft.serviceProvider,
      },
    });
    const listed = (await call(server, 'GET', '/api/admin/sso')).json<SsoProvider[]>();
    expect(listed).toEqual([created]);
    // Saving the same draft twice makes one provider.
    const twice = await create(server, idp, { id: draft.id });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.messageKey).toBe('errors.conflict');
    // Without a draft, the server picks the ID.
    const plain = (await create(server, idp, { name: 'Plain' })).json<SsoProvider>();
    expect(plain.id).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(plain.saml?.serviceProvider.acsUrl).toBe(`${BASE}/api/auth/saml/${plain.id}/acs`);
  });

  it('checks the identity provider’s details', async () => {
    const { server, idp } = await setup();
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ entityId: '' }, { 'saml.entityId': 'validation.too_small' }],
      [{ entityId: 'urn:acme:\u0007idp' }, { 'saml.entityId': 'validation.invalid_format' }],
      [{ ssoUrl: 'http://idp.example.test/sso' }, { 'saml.ssoUrl': 'sso.saml.url.https' }],
      [{ ssoUrl: 'javascript:alert(1)' }, { 'saml.ssoUrl': 'sso.saml.url.https' }],
      [{ ssoUrl: 'https://user:pass@idp.example.test/sso' }, { 'saml.ssoUrl': 'validation.invalid_format' }],
      [{ ssoUrl: 'https://idp.example.test/sso#top' }, { 'saml.ssoUrl': 'validation.invalid_format' }],
      [{ certificates: [] }, { 'saml.certificates': 'validation.too_small' }],
      [{ certificates: ['not a certificate'] }, { 'saml.certificates.0': 'sso.saml.certificate.invalid' }],
    ];
    for (const [saml, fields] of cases) {
      const response = await create(server, idp, {}, saml);
      expect(response.statusCode, JSON.stringify(saml)).toBe(422);
      expect(fieldsOf(response), JSON.stringify(saml)).toEqual(fields);
    }
    const missing = await call(server, 'POST', '/api/admin/sso', { kind: 'saml', name: 'Okta' });
    expect(fieldsOf(missing)).toEqual({ saml: 'validation.invalid_type' });
    // A URN is as good an entity ID as a URL, and a sign-in address may carry a query.
    const google = await create(
      server,
      idp,
      {},
      { entityId: 'urn:acme:idp', ssoUrl: 'https://accounts.google.test/o/saml2/idp?idpid=C01abc' },
    );
    expect(google.json<SsoProvider>().saml).toMatchObject({
      entityId: 'urn:acme:idp',
      ssoUrl: 'https://accounts.google.test/o/saml2/idp?idpid=C01abc',
    });
    expect((await call(server, 'GET', '/api/admin/sso')).json<SsoProvider[]>()).toHaveLength(1);
  });

  it('reads certificates the ways identity providers show them, and never takes a private key', async () => {
    const { server, idp } = await setup();
    const second = selfSignedCertificate('Next year’s key');
    const both = await create(
      server,
      idp,
      {},
      // Two in one paste, one as a bare base64 body, and a repeat.
      { certificates: [`${idp.certificate}\n${second.certificate}`, certificateBody(idp.certificate)] },
    );
    expect(both.statusCode).toBe(200);
    expect(both.json<SsoProvider>().saml?.certificates.map((certificate) => certificate.subject)).toEqual([
      'CN=Test identity provider',
      'CN=Next year’s key',
    ]);

    const leaked = await create(
      server,
      idp,
      {},
      { certificates: [`${second.certificate}${second.privateKey}`] },
    );
    expect(fieldsOf(leaked)).toEqual({ 'saml.certificates.0': 'sso.saml.certificate.privateKey' });
    expect(leaked.body).not.toContain(certificateBody(second.privateKey).slice(0, 40));

    const many = Array.from({ length: 6 }, (_, index) => selfSignedCertificate(`Key ${index}`).certificate);
    expect(fieldsOf(await create(server, idp, {}, { certificates: [many.join('\n')] }))).toEqual({
      'saml.certificates': 'validation.too_big',
    });
    const stored = await query<{ certificates: string[] }>(
      server.pool,
      sql`SELECT certificates FROM ${ident(server.schemas.app, 'sso_providers')}`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain('PRIVATE KEY');
  });

  it('changes only what an edit names', async () => {
    const { server, idp } = await setup();
    const created = (
      await create(server, idp, {
        allowedDomains: ['example.org'],
        autoCreate: true,
        linkByEmail: false,
        enabled: false,
      })
    ).json<SsoProvider>();
    const renamed = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, { name: 'Okta Workforce' });
    expect(renamed.json<SsoProvider>()).toEqual({ ...created, name: 'Okta Workforce' });

    const rotated = selfSignedCertificate('Rotated');
    const edited = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      saml: {
        ssoUrl: `${idp.ssoUrl}/v2`,
        certificates: [idp.certificate, rotated.certificate],
        verifiesEmails: true,
      },
      // A client and its secret are OpenID Connect's, so a SAML provider ignores them.
      clientId: 'ignored',
      clientSecret: 'ignored secret',
      issuer: 'https://ignored.example.test',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<SsoProvider>()).toMatchObject({
      name: 'Okta Workforce',
      issuer: idp.entityId,
      clientId: '',
      hasSecret: false,
      allowedDomains: ['example.org'],
      autoCreate: true,
      linkByEmail: false,
      enabled: false,
      saml: { entityId: idp.entityId, ssoUrl: `${idp.ssoUrl}/v2`, verifiesEmails: true },
    });
    expect(edited.json<SsoProvider>().saml?.certificates).toHaveLength(2);
    const moved = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      saml: { entityId: 'https://idp.example.test/new' },
    });
    expect(moved.json<SsoProvider>().issuer).toBe('https://idp.example.test/new');
    const refused = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, {
      saml: { ssoUrl: 'http://idp.example.test/sso' },
    });
    expect(fieldsOf(refused)).toEqual({ 'saml.ssoUrl': 'sso.saml.url.https' });

    const events = await query<{ metadata: { fields: string[] } }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'org.sso.updated' ORDER BY id`,
    );
    expect(events.rows.map((event) => event.metadata.fields)).toEqual([
      ['name'],
      ['clientId', 'clientSecret', 'issuer', 'saml.certificates', 'saml.ssoUrl', 'saml.verifiesEmails'],
      ['saml.entityId'],
    ]);
    expect(JSON.stringify(events.rows)).not.toContain('ignored secret');
  });

  it('keeps an OpenID Connect provider’s settings when an edit leaves them out', async () => {
    const { server } = await setup();
    const created = (
      await call(server, 'POST', '/api/admin/sso', {
        kind: 'google',
        name: 'Google',
        clientId: 'id',
        clientSecret: 'secret',
        allowedDomains: ['example.org'],
        autoCreate: true,
        linkByEmail: false,
        enabled: false,
      })
    ).json<SsoProvider>();
    const renamed = await call(server, 'PATCH', `/api/admin/sso/${created.id}`, { name: 'Google Workspace' });
    expect(renamed.json<SsoProvider>()).toEqual({ ...created, name: 'Google Workspace' });
  });

  describe('metadata', () => {
    it('reads what Okta publishes', async () => {
      const { server, idp } = await setup();
      const response = await readMetadata(server, { xml: idp.metadata() });
      expect(response.statusCode).toBe(200);
      expect(response.json<SamlMetadata>()).toEqual({
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        certificates: [
          {
            pem: idp.certificate,
            subject: 'CN=Test identity provider',
            expiresAt: expect.any(String),
            fingerprint: expect.any(String),
          },
        ],
      });
    });

    it('reads what Microsoft Entra ID publishes, taking only its SAML keys', async () => {
      const { server } = await setup();
      const saml = selfSignedCertificate('Microsoft Azure Federated SSO Certificate');
      const wsFederation = selfSignedCertificate('Another protocol');
      const tenant = 'https://login.microsoftonline.test/11111111-2222-3333-4444-555555555555/saml2';
      const xml = `<?xml version="1.0" encoding="utf-8"?><EntityDescriptor ID="_e1" entityID="https://sts.windows.test/11111111-2222-3333-4444-555555555555/" xmlns="urn:oasis:names:tc:SAML:2.0:metadata"><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature><RoleDescriptor xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706" xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certificateBody(wsFederation.certificate)}</X509Certificate></X509Data></KeyInfo></KeyDescriptor></RoleDescriptor><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certificateBody(saml.certificate)}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${tenant}"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${tenant}"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${tenant}"/></IDPSSODescriptor></EntityDescriptor>`;
      const found = (await readMetadata(server, { xml })).json<SamlMetadata>();
      expect(found.entityId).toBe('https://sts.windows.test/11111111-2222-3333-4444-555555555555/');
      expect(found.ssoUrl).toBe(tenant);
      expect(found.certificates.map((certificate) => certificate.subject)).toEqual([
        'CN=Microsoft Azure Federated SSO Certificate',
      ]);
    });

    it('reads what Google Workspace publishes, keys without a use, and one identity provider in a list', async () => {
      const { server } = await setup();
      const signing = selfSignedCertificate('Google');
      const encryption = selfSignedCertificate('Encryption only');
      const entity = (id: string, idp: boolean) =>
        `<md:EntityDescriptor entityID="${id}" validUntil="2031-09-26T00:00:00.000Z">${
          idp
            ? `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>\n${certificateBody(signing.certificate).replace(/(.{64})/g, '$1\n')}\n</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificateBody(encryption.certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://accounts.google.test/o/saml2/idp?idpid=C01abc"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://accounts.google.test/o/saml2/idp?idpid=C01abc"/></md:IDPSSODescriptor>`
            : '<md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/>'
        }</md:EntityDescriptor>`;
      const xml = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${entity('https://sp.example.test', false)}${entity('https://accounts.google.test/o/saml2?idpid=C01abc', true)}</md:EntitiesDescriptor>`;
      const found = (await readMetadata(server, { xml })).json<SamlMetadata>();
      expect(found).toMatchObject({
        entityId: 'https://accounts.google.test/o/saml2?idpid=C01abc',
        ssoUrl: 'https://accounts.google.test/o/saml2/idp?idpid=C01abc',
      });
      expect(found.certificates.map((certificate) => certificate.subject)).toEqual(['CN=Google']);
    });

    it('says what’s wrong with metadata it can’t use', async () => {
      const { server, idp } = await setup();
      const other = startTestIdp();
      const two = `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata">${idp.metadata().replace(/<\?xml[^>]*>/, '')}${other.metadata().replace(/<\?xml[^>]*>/, '')}</EntitiesDescriptor>`;
      const cases: Array<[string, string]> = [
        ['not xml at all', 'sso.saml.metadata.invalid'],
        ['<html><body>Sign in</body></html>', 'sso.saml.metadata.invalid'],
        [two, 'sso.saml.metadata.invalid'],
        [
          `<!DOCTYPE md [<!ENTITY x "y">]>${idp.metadata().replace(/<\?xml[^>]*>/, '')}`,
          'sso.saml.metadata.invalid',
        ],
        [
          idp.metadata().replace(/<md:SingleSignOnService[^>]*HTTP-Redirect[^>]*\/>/, ''),
          'sso.saml.metadata.incomplete',
        ],
        [
          idp.metadata().replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/, ''),
          'sso.saml.metadata.incomplete',
        ],
      ];
      for (const [xml, key] of cases) {
        const response = await readMetadata(server, { xml });
        expect(response.statusCode, xml.slice(0, 60)).toBe(422);
        expect(response.json().error.messageKey, xml.slice(0, 60)).toBe(key);
        expect(fieldsOf(response)).toEqual({ xml: key });
      }
      const both = await readMetadata(server, {
        xml: idp.metadata(),
        url: 'https://idp.example.test/metadata',
      });
      expect(both.statusCode).toBe(422);
    });

    it('fetches metadata from an address once, and only a safe one', async () => {
      const { server, idp } = await setup();
      let status = 200;
      const url = await publish(() => ({ status, text: idp.metadata() }));
      // Loopback is a private address, which only development allows, and only over http.
      expect(fieldsOf(await readMetadata(server, { url }))).toEqual({ url: 'sso.saml.url.https' });
      expect(fieldsOf(await readMetadata(server, { url: url.replace('http:', 'https:') }))).toEqual({
        url: 'sso.saml.metadata.private',
      });
      for (const address of [
        'https://10.1.2.3/metadata',
        'https://169.254.169.254/latest',
        'https://localhost/m',
      ])
        expect(fieldsOf(await readMetadata(server, { url: address })), address).toEqual({
          url: 'sso.saml.metadata.private',
        });

      server.ctx.config.production = false;
      cleanups.push(async () => {
        server.ctx.config.production = true;
      });
      const found = await readMetadata(server, { url });
      expect(found.statusCode).toBe(200);
      expect(found.json<SamlMetadata>().entityId).toBe(idp.entityId);
      status = 404;
      expect(fieldsOf(await readMetadata(server, { url }))).toEqual({ url: 'sso.saml.metadata.unreachable' });
      expect(fieldsOf(await readMetadata(server, { url: 'http://127.0.0.1:1/metadata' }))).toEqual({
        url: 'sso.saml.metadata.unreachable',
      });
      expect(fieldsOf(await readMetadata(server, { url: 'https://user:pass@idp.example.test/m' }))).toEqual({
        url: 'sso.saml.metadata.unreachable',
      });
    });
  });

  it('is for owners and admins with the Security role', async () => {
    const { server, idp } = await setup();
    const created = (await create(server, idp)).json<SsoProvider>();
    const member = await server.addMember();
    const routes = [
      ['GET', '/api/admin/sso', undefined],
      ['GET', '/api/admin/sso/saml/new', undefined],
      ['POST', '/api/admin/sso/saml/metadata', { xml: idp.metadata() }],
      [
        'POST',
        '/api/admin/sso',
        {
          kind: 'saml',
          name: 'Okta',
          saml: { entityId: 'e', ssoUrl: idp.ssoUrl, certificates: [idp.certificate] },
        },
      ],
      ['PATCH', `/api/admin/sso/${created.id}`, { name: 'Renamed' }],
      ['DELETE', `/api/admin/sso/${created.id}`, undefined],
    ] as const;
    const roles = ident(server.schemas.app, 'memberships');
    for (const adminRoles of [[], ['people'], ['data_sources', 'ai']]) {
      await query(
        server.pool,
        sql`UPDATE ${roles} SET admin_roles = ${adminRoles}::text[] WHERE user_id = ${member.userId}`,
      );
      for (const [method, url, payload] of routes) {
        const response = await call(server, method, url, payload, member);
        expect(response.statusCode, `${method} ${url} with ${adminRoles.join()}`).toBe(403);
        expect(response.json().error.messageKey).toBe('errors.adminOnly');
      }
    }
    for (const [method, url, payload] of routes)
      expect((await call(server, method, url, payload, null)).statusCode, `${method} ${url}`).toBe(401);
    await query(
      server.pool,
      sql`UPDATE ${roles} SET admin_roles = ARRAY['security'] WHERE user_id = ${member.userId}`,
    );
    for (const [method, url, payload] of routes) {
      const response = await call(server, method, url, payload, member);
      // Adding a provider decides who vouches for the organization's people, which is the owner's.
      if (method === 'POST' && url === '/api/admin/sso') {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.messageKey).toBe('sso.ownerOnly');
      } else expect(response.statusCode, `${method} ${url}`).toBeLessThan(300);
    }
    // State-changing requests still need the session's CSRF token.
    const forged = await server.app.inject({
      method: 'POST',
      url: '/api/admin/sso/saml/metadata',
      headers: { cookie: member.headers.cookie },
      payload: { xml: idp.metadata() },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.messageKey).toBe('errors.csrfMismatch');
  });

  it('leaves a provider’s identity, certificates, and email trust to the owner', async () => {
    const { server, idp } = await setup();
    const created = (await create(server, idp)).json<SsoProvider>();
    const admin = await server.addMember();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['security'] WHERE user_id = ${admin.userId}`,
    );
    const url = `/api/admin/sso/${created.id}`;
    const own = selfSignedCertificate('Someone else').certificate;
    const stored = async () =>
      (
        await query(
          server.pool,
          sql`SELECT issuer, sso_url, certificates, verifies_emails, link_by_email FROM ${ident(server.schemas.app, 'sso_providers')}`,
        )
      ).rows;
    const before = await stored();
    // A certificate of their own signs an answer for any address, including the owner's.
    for (const saml of [
      { certificates: [own] },
      { certificates: [idp.certificate, own] },
      { entityId: 'https://elsewhere.example.test/metadata' },
      { ssoUrl: 'https://elsewhere.example.test/sso' },
      { verifiesEmails: true },
    ]) {
      const refused = await call(server, 'PATCH', url, { saml }, admin);
      expect(refused.statusCode, JSON.stringify(Object.keys(saml))).toBe(403);
      expect(refused.json().error.messageKey).toBe('sso.ownerOnly');
    }
    expect(await stored()).toEqual(before);
    // A form that sends back what is stored still saves the settings the Security role keeps.
    const details = created.saml!;
    const kept = await call(
      server,
      'PATCH',
      url,
      {
        name: 'Renamed',
        allowedDomains: ['example.test'],
        linkByEmail: created.linkByEmail,
        saml: {
          entityId: details.entityId,
          ssoUrl: details.ssoUrl,
          certificates: details.certificates.map((certificate) => certificate.pem),
          verifiesEmails: details.verifiesEmails,
        },
      },
      admin,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json<SsoProvider>()).toMatchObject({ name: 'Renamed', allowedDomains: ['example.test'] });
    const owned = await call(server, 'PATCH', url, { saml: { certificates: [own], verifiesEmails: true } });
    expect(owned.statusCode, owned.body).toBe(200);
    expect(owned.json<SsoProvider>().saml).toMatchObject({ verifiesEmails: true });
  });

  it('deletes a provider with its identities and the assertions it has seen', async () => {
    const { server, idp } = await setup();
    const doomed = (await create(server, idp)).json<SsoProvider>();
    const kept = (await create(server, idp, { name: 'Kept' })).json<SsoProvider>();
    const identities = ident(server.schemas.app, 'sso_identities');
    const assertions = ident(server.schemas.app, 'saml_assertions');
    await query(
      server.pool,
      sql`INSERT INTO ${identities} (issuer, subject, user_id, provider_id)
      VALUES ('saml:x:one', 'one', ${server.owner.userId}, ${doomed.id}),
        ('saml:x:two', 'two', ${server.owner.userId}, ${kept.id})`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${assertions} (provider_id, assertion_id, expires_at)
      VALUES (${doomed.id}, '_one', clock_timestamp() + interval '1 hour'),
        (${kept.id}, '_two', clock_timestamp() + interval '1 hour')`,
    );
    expect((await call(server, 'DELETE', `/api/admin/sso/${doomed.id}`)).statusCode).toBe(204);
    expect((await query(server.pool, sql`SELECT subject FROM ${identities}`)).rows).toEqual([
      { subject: 'two' },
    ]);
    expect((await query(server.pool, sql`SELECT assertion_id FROM ${assertions}`)).rows).toEqual([
      { assertion_id: '_two' },
    ]);
    expect((await server.app.inject({ url: `/api/auth/saml/${doomed.id}/metadata` })).statusCode).toBe(404);
  });
});

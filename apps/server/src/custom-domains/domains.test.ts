import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type CustomDomain, type PublicFormLink, type SharedViewLink } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { issueTicket } from '../data/public-forms.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { signingToken, downloadToken } from '../signatures/token.js';
import { cancelToken } from '../bookings/public.js';
import { newBookingPageId } from '../bookings/pages.js';
import { harness, helpers } from '../signatures/test-support.js';
import { hostname } from './serving.js';
import { activeDomain, publicOrigin, recheckCustomDomains } from './store.js';
import { addressAllowed, validAddresses } from './settings.js';

let kit: TestPostgres;
let server: ServerFixture;
let web: string;
const dns = new Map<string, string>();
const askToken = randomBytes(32).toString('hex');
const MAIN = 'https://app.example.test';
const ADMIN = '/api/admin/custom-domains';
const recoverySource = readFileSync(
  new URL('../../../web/public/startup-recovery.js', import.meta.url),
  'utf8',
);
const recoveryHash = `'sha256-${createHash('sha256').update(recoverySource).digest('base64')}'`;

beforeAll(async () => {
  kit = await startTestPostgres();
  web = mkdtempSync(join(tmpdir(), 'domains-web-'));
  mkdirSync(join(web, 'assets'));
  mkdirSync(join(web, 'icons'));
  writeFileSync(
    join(web, 'index.html'),
    `<html><head><script id="rio-startup-recovery">${recoverySource}</script></head><body></body></html>`,
  );
  writeFileSync(join(web, 'assets', 'public.js'), 'export {}');
  writeFileSync(join(web, 'boot.js'), 'void 0');
  writeFileSync(join(web, 'layers.css'), '@layer rio.app;');
  writeFileSync(join(web, 'pressable.css'), '');
  writeFileSync(join(web, 'icons', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(web, 'sw.js'), '');
  server = await startServer(kit, 'domains', {
    baseUrl: MAIN,
    webDir: web,
    tlsAskToken: askToken,
    tlsAskAddresses: '192.0.2.10',
    trustProxy: () => true,
  });
  vi.spyOn(Resolver.prototype, 'resolveTxt').mockImplementation(async (name) => {
    const record = dns.get(name);
    return record ? [[record.slice(0, 15), record.slice(15)]] : [];
  });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  await kit?.stop();
  if (web) rmSync(web, { recursive: true, force: true });
});

async function add(host: string, kinds?: string[], headers = server.owner.headers): Promise<CustomDomain> {
  const response = await server.app.inject({ method: 'POST', url: ADMIN, headers, payload: { host, kinds } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CustomDomain>();
}
async function verify(domain: CustomDomain, headers = server.owner.headers) {
  dns.set(domain.recordName, domain.recordValue);
  return server.app.inject({ method: 'POST', url: `${ADMIN}/${domain.id}/verify`, headers });
}
async function verified(host: string, kinds?: string[]) {
  const domain = await add(host, kinds);
  const response = await verify(domain);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CustomDomain>();
}
async function remove(domain: CustomDomain, headers = server.owner.headers) {
  const response = await server.app.inject({ method: 'DELETE', url: `${ADMIN}/${domain.id}`, headers });
  expect(response.statusCode, response.body).toBe(204);
}
/** A signed-in owner of another organization on the same server */
async function otherOwner(name: string) {
  const member = await server.addMember();
  const orgId = newId('org');
  await server.pool.query(`INSERT INTO "${server.schemas.app}".orgs (id, name) VALUES ($1, $2)`, [
    orgId,
    name,
  ]);
  await server.pool.query(
    `UPDATE "${server.schemas.app}".memberships SET org_id = $2, kind = 'owner' WHERE user_id = $1`,
    [member.userId, orgId],
  );
  return { ...member, orgId };
}
/** Sends raw request lines to a live listener and returns the whole response. */
async function raw(lines: string[]): Promise<string> {
  if (!server.app.server.listening) await server.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
function ask(domain: string, token: string | undefined = askToken, remoteAddress = '192.0.2.10') {
  return server.app.inject({
    url: `/internal/tls/allow?${new URLSearchParams({ domain, ...(token ? { token } : {}) })}`,
    remoteAddress,
  });
}
async function pages() {
  const read = await readFixture(server, [{ type: 'text' }]);
  const viewId = newId('view');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: {
            id: viewId,
            tableId: read.table.id,
            name: 'Answers',
            type: 'form',
            config: { form: { questions: [{ fieldId: read.fields[0]!.id, required: false }] } },
          },
        },
      ],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json().results[0].status, created.body).toBe('applied');
  const form = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${viewId}/public-form`,
    headers: server.owner.headers,
  });
  const view = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${read.view.id}/shared-view`,
    headers: server.owner.headers,
  });
  expect(form.statusCode, form.body).toBe(200);
  expect(view.statusCode, view.body).toBe(200);
  return { read, form: form.json<PublicFormLink>(), view: view.json<SharedViewLink>() };
}

describe('custom domain verification', () => {
  it('requires the Integrations role and plain host names', async () => {
    const member = await server.addMember();
    for (const method of ['GET', 'POST'] as const) {
      const response = await server.app.inject({
        method,
        url: ADMIN,
        headers: member.headers,
        ...(method === 'POST' ? { payload: { host: 'role.example.test' } } : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    await server.pool.query(
      `UPDATE "${server.schemas.app}".memberships SET admin_roles = ARRAY['integrations'] WHERE user_id = $1`,
      [member.userId],
    );
    // A new domain serves no site until someone chooses to.
    expect((await add('role.example.test', undefined, member.headers)).kinds).toEqual([
      'forms',
      'views',
      'bookings',
      'signing',
    ]);
    for (const host of [
      '*.example.test',
      'https://forms.example.test',
      'forms.example.test:443',
      '127.0.0.1',
      'app.example.test',
    ]) {
      const response = await server.app.inject({
        method: 'POST',
        url: ADMIN,
        headers: server.owner.headers,
        payload: { host },
      });
      expect(response.statusCode, host).toBe(422);
    }
  });

  it('verifies split TXT records for one organization and serializes competing claims', async () => {
    const first = await add('claim.example.test');
    const other = await otherOwner('Other organization');
    const second = await add(first.host, undefined, other.headers);
    const records = [[first.recordValue], [second.recordValue]];
    vi.mocked(Resolver.prototype.resolveTxt).mockResolvedValueOnce(records).mockResolvedValueOnce(records);
    const responses = await Promise.all([verify(first), verify(second, other.headers)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const rows = await server.pool.query(
      `SELECT * FROM "${server.schemas.app}".custom_domains WHERE host = $1 AND verified_at IS NOT NULL`,
      [first.host],
    );
    expect(rows.rowCount).toBe(1);
    expect(
      (await server.app.inject({ method: 'DELETE', url: `${ADMIN}/${first.id}`, headers: other.headers }))
        .statusCode,
    ).toBe(404);
    await server.app.inject({ method: 'DELETE', url: `${ADMIN}/${first.id}`, headers: server.owner.headers });
    await server.app.inject({ method: 'DELETE', url: `${ADMIN}/${second.id}`, headers: other.headers });
  });

  it('refuses expired leases without waiting for a scheduler', async () => {
    const domain = await verified('lease.example.test');
    await server.pool.query(
      `UPDATE "${server.schemas.app}".custom_domains SET checked_at = clock_timestamp() - interval '25 hours' WHERE id = $1`,
      [domain.id],
    );
    expect(await activeDomain(server.ctx, domain.host)).toBeNull();
    expect((await ask(domain.host)).statusCode).toBe(404);
    await remove(domain);
  });

  it('retries lookups and takes verification away only after three failed daily checks in a row', async () => {
    const domain = await verified('daily.example.test');
    const integrations = await server.addMember({ name: 'Integrations Admin' });
    await server.pool.query(
      `UPDATE "${server.schemas.app}".memberships SET admin_roles = ARRAY['integrations'] WHERE user_id = $1`,
      [integrations.userId],
    );
    const bystander = await server.addMember({ name: 'Bystander' });
    const lookup = vi.mocked(Resolver.prototype.resolveTxt);
    const timeout = () => Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' });
    const state = async () =>
      (
        await server.pool.query<{ verified: boolean; failed_checks: number }>(
          `SELECT verified_at IS NOT NULL AS verified, failed_checks FROM "${server.schemas.app}".custom_domains WHERE id = $1`,
          [domain.id],
        )
      ).rows[0];
    /** Most of a day passes, then the daily check runs. */
    const dayPasses = async () => {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".custom_domains SET checked_at = clock_timestamp() - interval '23 hours 30 minutes' WHERE id = $1`,
        [domain.id],
      );
      lookup.mockClear();
      await recheckCustomDomains(server.ctx);
    };
    // A check that isn't due yet looks nothing up.
    lookup.mockClear();
    await recheckCustomDomains(server.ctx);
    expect(lookup).not.toHaveBeenCalled();
    // Two lookups that time out and a third that answers make one successful check.
    lookup.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout());
    await dayPasses();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(await state()).toEqual({ verified: true, failed_checks: 0 });
    // Three lookups that time out make one failed check, and the domain keeps serving.
    lookup.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout());
    await dayPasses();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(await state()).toEqual({ verified: true, failed_checks: 1 });
    expect(await activeDomain(server.ctx, domain.host)).not.toBeNull();
    expect((await ask(domain.host)).statusCode).toBe(200);
    // A domain that is failing is checked again, and finding the record starts the count over.
    dns.delete(domain.recordName);
    await dayPasses();
    expect(await state()).toEqual({ verified: true, failed_checks: 2 });
    dns.set(domain.recordName, domain.recordValue);
    await dayPasses();
    expect(await state()).toEqual({ verified: true, failed_checks: 0 });
    dns.delete(domain.recordName);
    await dayPasses();
    await dayPasses();
    expect(await state()).toEqual({ verified: true, failed_checks: 2 });
    expect((await server.app.inject({ url: '/signatures', headers: { host: domain.host } })).statusCode).toBe(
      200,
    );
    await dayPasses();
    expect(await state()).toEqual({ verified: false, failed_checks: 0 });
    expect(await activeDomain(server.ctx, domain.host)).toBeNull();
    expect((await ask(domain.host)).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/signatures', headers: { host: domain.host } })).statusCode).toBe(
      404,
    );

    const notified = await server.pool.query<{ recipient_id: string; target: Record<string, unknown> }>(
      `SELECT recipient_id, target FROM "${server.schemas.app}".notifications
        WHERE kind = 'customDomainUnverified' AND target->>'domain' = $1`,
      [domain.host],
    );
    const recipients = notified.rows.map((row) => row.recipient_id);
    expect(recipients).toEqual(expect.arrayContaining([server.owner.userId, integrations.userId]));
    expect(recipients).not.toContain(bystander.userId);
    const admins = await server.pool.query(
      `SELECT 1 FROM "${server.schemas.app}".memberships
        WHERE org_id = $1 AND (kind = 'owner' OR 'integrations' = ANY(admin_roles))`,
      [server.owner.info.org.id],
    );
    expect(recipients).toHaveLength(admins.rowCount!);
    expect(notified.rows[0]!.target).toEqual({ domain: domain.host });
    const lapsed = await server.pool.query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM "${server.schemas.audit}".events
        WHERE action = 'customDomain.failed' AND metadata->>'host' = $1`,
      [domain.host],
    );
    expect(lapsed.rows).toEqual([{ actor_id: null, metadata: { host: domain.host, failedChecks: 3 } }]);
    // Publishing the record again and verifying brings the domain back.
    expect((await verify(domain)).statusCode).toBe(200);
    expect(await state()).toEqual({ verified: true, failed_checks: 0 });
    const events = await server.pool.query<{ action: string }>(
      `SELECT action FROM "${server.schemas.audit}".events WHERE metadata->>'host' = $1 ORDER BY id`,
      [domain.host],
    );
    expect(events.rows.map((row) => row.action)).toEqual([
      'customDomain.added',
      'customDomain.verified',
      'customDomain.failed',
      'customDomain.verified',
    ]);
    await remove(domain);
  });

  it('says another organization holds a host only after the caller proves control of it', async () => {
    const held = await verified('oracle.example.test');
    const other = await otherOwner('Curious organization');
    const theirs = await add(held.host, undefined, other.headers);
    const unclaimed = await add('unclaimed.example.test', undefined, other.headers);
    const check = (domain: CustomDomain) =>
      server.app.inject({ method: 'POST', url: `${ADMIN}/${domain.id}/verify`, headers: other.headers });
    // Without their own record, a held host and an unclaimed one answer the same.
    for (const domain of [theirs, unclaimed]) {
      const response = await check(domain);
      expect(response.statusCode, domain.host).toBe(409);
      expect(response.json().error.messageKey, domain.host).toBe('customDomains.failed');
    }
    dns.set(theirs.recordName, theirs.recordValue);
    const proven = await check(theirs);
    expect(proven.statusCode).toBe(409);
    expect(proven.json().error.messageKey).toBe('customDomains.taken');
    // Their pending claim doesn't stop the holder's pages.
    expect((await server.app.inject({ url: '/signatures', headers: { host: held.host } })).statusCode).toBe(
      200,
    );
    await remove(theirs, other.headers);
    await remove(unclaimed, other.headers);
    await remove(held);
  });

  it('refuses a host whose TXT record name would be longer than DNS allows', async () => {
    const host = (length: number) =>
      ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(length - 197), 'test'].join('.');
    expect(host(237)).toHaveLength(237);
    const longest = await add(host(237));
    expect(longest.recordName).toHaveLength(253);
    const refused = await server.app.inject({
      method: 'POST',
      url: ADMIN,
      headers: server.owner.headers,
      payload: { host: host(238) },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    await remove(longest);
  });

  it('allows each organization at most the configured number of domains', async () => {
    expect(server.config.customDomainLimit).toBe(50);
    const other = await otherOwner('Limited organization');
    server.config.customDomainLimit = 2;
    try {
      const first = await add('one.limit.example.test', undefined, other.headers);
      await add('two.limit.example.test', undefined, other.headers);
      const refused = await server.app.inject({
        method: 'POST',
        url: ADMIN,
        headers: other.headers,
        payload: { host: 'three.limit.example.test' },
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toMatchObject({ messageKey: 'customDomains.limit', params: { limit: 2 } });
      // Removed domains don't count.
      await remove(first, other.headers);
      await add('three.limit.example.test', undefined, other.headers);
    } finally {
      server.config.customDomainLimit = 50;
    }
  });
});

describe('hosts that are not custom domains', () => {
  it('answers HEAD with the app page status and headers at the root and client routes', async () => {
    for (const url of ['/', '/sign-in', '/databases/example']) {
      const get = await server.app.inject({ url });
      const head = await server.app.inject({ method: 'HEAD', url });
      expect(get.statusCode).toBe(200);
      expect(head.statusCode).toBe(get.statusCode);
      expect(head.body).toBe('');
      const { date: _getDate, ...getHeaders } = get.headers;
      const { date: _headDate, ...headHeaders } = head.headers;
      expect(headHeaders).toEqual(getHeaders);
    }
    for (const url of ['/api/missing', '/v0/missing', '/themes/missing.css', '/.well-known/missing'])
      expect((await server.app.inject({ method: 'HEAD', url })).statusCode).toBe(404);
  });

  it('serve the main app on service names, addresses, and localhost, as they did before custom domains', async () => {
    for (const host of [
      'riosoma',
      'riosoma:8080',
      'riosoma.default.svc.cluster.local:8080',
      '127.0.0.1:8080',
      'localhost:8080',
      'scanner.example.test',
    ]) {
      expect((await server.app.inject({ url: '/healthz', headers: { host } })).statusCode, host).toBe(200);
      expect(
        (await server.app.inject({ url: '/api/setup/status', headers: { host } })).statusCode,
        host,
      ).toBe(200);
      const session = await server.app.inject({
        url: '/api/auth/session',
        headers: { ...server.owner.headers, host },
      });
      expect(session.statusCode, host).toBe(200);
      // SCIM answers as it does on the main address, asking for its token.
      expect(
        (await server.app.inject({ url: '/scim/v2/ServiceProviderConfig', headers: { host } })).statusCode,
        host,
      ).toBe(401);
    }
  });

  it('let health checks through on IPv6 literals and with no Host at all', async () => {
    expect(hostname('[FD00::5]:8080')).toBe('fd00::5');
    expect(hostname('[::1]')).toBe('::1');
    for (const host of ['[::1]', '[::1]:8080', '[fd00::5]:8080'])
      for (const url of ['/healthz', '/readyz'])
        expect((await server.app.inject({ url, headers: { host } })).statusCode, `${host}${url}`).toBe(200);
    for (const path of ['/healthz', '/readyz'])
      expect(await raw([`GET ${path} HTTP/1.0`]), path).toMatch(/^HTTP\/1\.1 200 /);
  });

  it('serve the main app on a host added but not verified yet', async () => {
    const pending = await add('pending.example.test');
    // Adding a host proves nothing, so it can't take a name the server answers to away from anyone.
    for (const path of ['/healthz', '/api/setup/status', '/api/auth/session']) {
      const response = await server.app.inject({
        url: path,
        headers: { ...server.owner.headers, host: pending.host },
      });
      expect(response.statusCode, path).toBe(200);
    }
    const shell = await server.app.inject({ url: '/', headers: { host: pending.host } });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).not.toContain('rio-public-domain');
    expect((await ask(pending.host)).statusCode).toBe(404);
    // Once verified it's a custom domain, and it stays one after removal, since certificates and
    // links for it may still be out there.
    expect((await verify(pending)).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/healthz', headers: { host: pending.host } })).statusCode).toBe(
      404,
    );
    await remove(pending);
    expect((await server.app.inject({ url: '/healthz', headers: { host: pending.host } })).statusCode).toBe(
      404,
    );
  });

  it('answer SCIM requests on a custom domain with 404', async () => {
    const domain = await verified('directory.example.test');
    const pending = await add('pending-directory.example.test');
    const bearer = () => ({ authorization: `Bearer ${randomBytes(32).toString('base64url')}` });
    for (const url of ['/scim/v2/ServiceProviderConfig', '/scim/v2/Users']) {
      const response = await server.app.inject({ url, headers: { host: domain.host, ...bearer() } });
      expect(response.statusCode, url).toBe(404);
      // A host that isn't verified is the main app, where SCIM refuses a token it doesn't know.
      const main = await server.app.inject({ url, headers: { host: pending.host, ...bearer() } });
      expect(main.statusCode, url).toBe(401);
    }
    await remove(domain);
    await remove(pending);
  });
});

describe('the Compose example settings', () => {
  it('match the Caddy profile’s custom domain setup', () => {
    const root = new URL('../../../../deploy/compose/', import.meta.url);
    const example = readFileSync(new URL('.env.example', root), 'utf8');
    const compose = readFileSync(new URL('compose.yaml', root), 'utf8');
    const caddy = /RIOSOMA_TLS_ASK_ADDRESSES: \$\{RIOSOMA_TLS_ASK_ADDRESSES:-([0-9.]+)\}/.exec(compose)?.[1];
    expect(caddy).toBeDefined();
    expect(example).toMatch(/^# RIOSOMA_TLS_ASK_TOKEN=/m);
    expect(example).toContain(`RIOSOMA_TRUST_PROXY=${caddy}`);
    expect(example).not.toMatch(/RIOSOMA_TRUST_PROXY=1\b/);
  });
});

describe('custom domain serving', () => {
  it('serves chosen kinds anonymously and rejects app routes, other tenants, and spoofed forwarding', async () => {
    const domain = await verified('forms.example.test', ['forms']);
    const { form, view } = await pages();
    expect(form.url).toBe(`https://${domain.host}${form.path}`);
    expect(view.url).toBe(`${MAIN}${view.path}`);
    const resolve = vi.spyOn(server.ctx.sessions, 'resolve');
    resolve.mockClear();
    for (const path of [
      form.path,
      `/api/public/forms/${form.formId}`,
      '/assets/public.js',
      '/boot.js',
      '/layers.css',
      '/pressable.css',
      '/icons/icon.svg',
    ]) {
      const response = await server.app.inject({
        url: path,
        headers: { ...server.owner.headers, host: domain.host, 'x-forwarded-host': 'app.example.test' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      const policy = String(response.headers['content-security-policy']);
      expect(policy).not.toMatch(/wss?:/);
      expect(policy.split('; ').find((part) => part.startsWith('script-src '))).toBe(
        `script-src 'self' ${path === form.path ? recoveryHash : ''}`.trim(),
      );
      if (path === form.path) {
        expect(response.body).toContain('rio-public-domain');
        const head = await server.app.inject({ method: 'HEAD', url: path, authority: domain.host });
        expect(head.statusCode).toBe(response.statusCode);
        expect(head.body).toBe('');
      }
    }
    const submit = await server.app.inject({
      method: 'POST',
      url: `/api/public/forms/${form.formId}/submissions`,
      headers: { host: domain.host, ...server.owner.headers },
      payload: { values: {}, ticket: issueTicket(server.config.secretKey, form.formId, Date.now() - 3000) },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    for (const path of [
      '/',
      '/api/auth/session',
      '/api/databases',
      '/sign-in',
      '/setup',
      '/api/setup/status',
      '/admin',
      '/index.html',
      '/sw.js',
      '/api/config',
      '/healthz',
      view.path,
      `/api/public/views/${view.linkId}`,
      '/api/public/forms/unknown',
      '/f/unknown',
      '/assets/missing.js',
    ]) {
      const response = await server.app.inject({
        url: path,
        headers: { ...server.owner.headers, host: domain.host },
      });
      expect(response.statusCode, path).toBe(404);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
    const org = newId('org');
    await server.pool.query(`INSERT INTO "${server.schemas.app}".orgs (id, name) VALUES ($1, 'Elsewhere')`, [
      org,
    ]);
    await server.pool.query(`UPDATE "${server.schemas.app}".public_forms SET org_id = $2 WHERE id = $1`, [
      form.formId,
      org,
    ]);
    for (const path of [form.path, `/api/public/forms/${form.formId}`])
      expect(
        (await server.app.inject({ url: path, headers: { host: domain.host, ...server.owner.headers } }))
          .statusCode,
      ).toBe(404);
    // A host no organization added is the main app, whatever a forwarded header claims.
    const unknown = await server.app.inject({
      url: '/',
      headers: { host: 'unknown.example.test', 'x-forwarded-host': domain.host },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).not.toContain('rio-public-domain');
    await remove(domain);
    expect(await publicOrigin(server.ctx, server.owner.info.org.id, 'forms')).toBe(MAIN);
  });

  it('changes allowed kinds immediately and unlocks views without cookies', async () => {
    const domain = await verified('views.example.test', ['views']);
    const { view } = await pages();
    const password = ['view', randomBytes(12).toString('hex')].join('-');
    const updated = await server.app.inject({
      method: 'PATCH',
      url: `/api/views/${view.viewId}/shared-view`,
      headers: server.owner.headers,
      payload: { password },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<SharedViewLink>().url).toBe(`https://${domain.host}${view.path}`);
    const path = `/api/public/views/${view.linkId}`;
    const unlocked = await server.app.inject({
      method: 'POST',
      url: `${path}/password`,
      headers: { host: domain.host },
      payload: { password },
    });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect(unlocked.headers['set-cookie']).toBeUndefined();
    const pass = unlocked.json<{ pass: string }>().pass;
    expect(
      (
        await server.app.inject({ url: path, headers: { host: domain.host, 'x-public-view-pass': pass } })
      ).json().status,
    ).toBe('open');
    expect((await server.app.inject({ url: path, headers: { host: domain.host } })).json().status).toBe(
      'locked',
    );
    const changed = await server.app.inject({
      method: 'PATCH',
      url: `${ADMIN}/${domain.id}`,
      headers: server.owner.headers,
      payload: { kinds: ['bookings', 'signing'] },
    });
    expect(changed.statusCode).toBe(200);
    expect((await server.app.inject({ url: view.path, headers: { host: domain.host } })).statusCode).toBe(
      404,
    );
    expect((await server.app.inject({ url: '/signatures', headers: { host: domain.host } })).statusCode).toBe(
      200,
    );
  });

  it('checks tenant ownership for booking cancellations and both signature token purposes', async () => {
    const domain = await verified('tokens.example.test', ['bookings', 'signing']);
    const read = await readFixture(server, [{ type: 'text' }]);
    const org = newId('org');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".orgs (id, name) VALUES ($1, 'Other pages')`,
      [org],
    );
    const pageId = newBookingPageId();
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".booking_pages (id, org_id, database_id, table_id, settings) VALUES ($1, $2, $3, $4, '{}')`,
      [pageId, org, read.table.databaseId, read.table.id],
    );
    const bookingId = newId('booking');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".bookings (id, page_id, record_id, starts_at, ends_at, email_key) VALUES ($1, $2, $3, clock_timestamp() + interval '2 days', clock_timestamp() + interval '3 days', $4)`,
      [bookingId, pageId, newId('record'), randomBytes(16).toString('hex')],
    );
    const token = cancelToken(server.config.secretKey, bookingId);
    for (const path of [
      `/b/${pageId}`,
      `/api/public/bookings/${pageId}`,
      `/bookings/cancel?token=${token}`,
      `/api/public/bookings/cancel?token=${token}`,
    ])
      expect((await server.app.inject({ url: path, headers: { host: domain.host } })).statusCode).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/public/bookings/cancel',
          headers: { host: domain.host },
          payload: { token },
        })
      ).statusCode,
    ).toBe(404);
    const requestId = newId('signatureRequest');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".signature_requests (id, org_id, database_id, table_id, record_id, field_id, source_id, name, original_hash, expires_at, input, pages, signers) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Agreement', $8, clock_timestamp() + interval '1 day', '{}', '[]', '[]')`,
      [
        requestId,
        org,
        read.table.databaseId,
        read.table.id,
        newId('record'),
        read.fields[0]!.id,
        newId('attachment'),
        randomBytes(32).toString('hex'),
      ],
    );
    const expires = new Date(Date.now() + 86_400_000);
    const signing = signingToken(server.config.secretKey, requestId, newId('signatureSigner'), expires);
    const download = downloadToken(server.config.secretKey, requestId, expires);
    for (const suffix of ['', '/document', '/sign', '/decline', '/download']) {
      const response = await server.app.inject({
        method: ['/sign', '/decline'].includes(suffix) ? 'POST' : 'GET',
        url: `/api/public/signatures${suffix}?token=${suffix === '/download' ? download : signing}`,
        headers: { host: domain.host },
      });
      expect(response.statusCode, suffix).toBe(404);
    }
    await server.pool.query(`UPDATE "${server.schemas.app}".booking_pages SET org_id = $2 WHERE id = $1`, [
      pageId,
      server.owner.info.org.id,
    ]);
    expect(
      (await server.app.inject({ url: `/b/${pageId}`, headers: { host: domain.host } })).statusCode,
    ).toBe(200);
  });
});

describe('signing domain links', () => {
  it('emails custom signing links and serves the request anonymously on that domain', async () => {
    const h = await harness('domain_signing');
    try {
      const response = await h.server.app.inject({
        method: 'POST',
        url: ADMIN,
        headers: h.server.owner.headers,
        payload: { host: 'sign.example.test', kinds: ['signing'] },
      });
      expect(response.statusCode, response.body).toBe(200);
      const domain = response.json<CustomDomain>();
      dns.set(domain.recordName, domain.recordValue);
      expect(
        (
          await h.server.app.inject({
            method: 'POST',
            url: `${ADMIN}/${domain.id}/verify`,
            headers: h.server.owner.headers,
          })
        ).statusCode,
      ).toBe(200);
      const helper = helpers(h);
      const fixture = await helper.fixture();
      const id = await fixture.start();
      await helper.settle();
      expect(h.sent.some((message) => message.text.includes('https://sign.example.test/signatures#'))).toBe(
        true,
      );
      const [token] = await fixture.tokens(id);
      const opened = await h.server.app.inject({
        url: `/api/public/signatures?token=${token}`,
        headers: { host: domain.host, ...h.server.owner.headers },
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.headers['set-cookie']).toBeUndefined();
      const removed = await h.server.app.inject({
        method: 'DELETE',
        url: `${ADMIN}/${domain.id}`,
        headers: h.server.owner.headers,
      });
      expect(removed.statusCode).toBe(204);
      expect(await publicOrigin(h.server.ctx, h.server.owner.info.org.id, 'signing')).toBe(
        'https://app.example.test',
      );
    } finally {
      await h.server.close();
      await h.kit.stop();
    }
  });
});

describe('certificate permission', () => {
  it('requires an allowed socket address and token and stops immediately after removal', async () => {
    const domain = await add('tls.example.test');
    expect((await ask(domain.host)).statusCode).toBe(404);
    expect((await verify(domain)).statusCode).toBe(200);
    expect((await ask(domain.host)).statusCode).toBe(200);
    expect((await ask(domain.host, '')).statusCode).toBe(404);
    expect((await ask(domain.host, randomBytes(32).toString('hex'))).statusCode).toBe(404);
    expect((await ask('unknown.example.test')).statusCode).toBe(404);
    expect((await ask(domain.host, askToken, '203.0.113.20')).statusCode).toBe(404);
    const forwarded = await server.app.inject({
      url: `/internal/tls/allow?domain=${domain.host}`,
      remoteAddress: '203.0.113.20',
      headers: { 'x-tls-ask-token': askToken, 'x-forwarded-for': '192.0.2.10' },
    });
    expect(forwarded.statusCode).toBe(404);
    const authorized = await server.app.inject({
      url: `/internal/tls/allow?domain=${domain.host}`,
      remoteAddress: '192.0.2.10',
      headers: { 'x-tls-ask-token': askToken },
    });
    expect(authorized.statusCode).toBe(200);
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `${ADMIN}/${domain.id}`,
      headers: server.owner.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect((await ask(domain.host)).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/signatures', headers: { host: domain.host } })).statusCode).toBe(
      404,
    );
    expect(await publicOrigin(server.ctx, server.owner.info.org.id, 'forms')).not.toContain(domain.host);
    expect(
      (
        await server.pool.query(
          `SELECT 1 FROM "${server.schemas.audit}".events WHERE action = 'customDomain.removed' AND metadata->>'host' = $1`,
          [domain.host],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('validates address allowlists and handles mapped IPv4 peers', () => {
    expect(validAddresses('192.0.2.10,2001:db8::/64')).toBe(true);
    expect(validAddresses('192.0.2.0/99')).toBe(false);
    expect(validAddresses('proxy.example.test')).toBe(false);
    expect(addressAllowed('::ffff:192.0.2.10', '192.0.2.10')).toBe(true);
    expect(addressAllowed('2001:db8::10', '2001:db8::/64')).toBe(true);
    expect(addressAllowed('192.0.2.11', '192.0.2.10')).toBe(false);
  });
});

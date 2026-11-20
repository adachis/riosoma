import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { newId, type ScimDomainVerification } from '@riosoma/contracts';
import { authDatabase, randomToken } from '../database.js';
import { signInClaimed } from '../sso/accounts.js';
import type { ProviderRow } from '../sso/store.js';
import { recheckDomains } from './domains.js';
import { call, patch, provision, server, setup, signedIn, user, useScimServer } from './scim.test-helpers.js';

/**
 * Who may claim an email domain: one organization on the server at most, only while its DNS
 * record stays published, and only through a single sign-on connection that still lists it.
 */
useScimServer();

const request = { headers: {}, protocol: 'http', ip: '127.0.0.1' } as FastifyRequest;

async function connection(domains: string[], headers = server.owner.headers) {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/admin/sso',
    headers,
    payload: {
      kind: 'oidc',
      name: `Directory ${randomBytes(4).toString('hex')}`,
      issuer: `https://identity-${randomBytes(4).toString('hex')}.example.test`,
      clientId: randomToken(),
      clientSecret: randomToken(),
      allowedDomains: domains,
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json<{ id: string }>().id;
}

async function providerRow(id: string) {
  const { app } = authDatabase(server.ctx);
  return (await server.pool.query<ProviderRow>(`SELECT * FROM ${app}.sso_providers WHERE id = $1`, [id]))
    .rows[0]!;
}

/** Verifies a domain through the admin routes, with the DNS lookup answering the challenge. */
async function verifyThroughDns(providerId: string, domain: string, headers = server.owner.headers) {
  const challenge = await server.app.inject({
    method: 'POST',
    url: '/api/admin/scim/domains',
    headers,
    payload: { providerId, domain },
  });
  if (challenge.statusCode !== 200) return challenge;
  vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([
    [challenge.json<ScimDomainVerification>().recordValue],
  ]);
  return server.app.inject({
    method: 'POST',
    url: '/api/admin/scim/domains/verify',
    headers,
    payload: { providerId, domain },
  });
}

/** An owner, signed in, of a second organization on the same server */
async function secondOwner() {
  const { app } = authDatabase(server.ctx);
  const orgId = newId('org');
  const userId = newId('user');
  await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, 'Second organization')`, [orgId]);
  await server.pool.query(`INSERT INTO ${app}.users (id, email, name) VALUES ($1, $2, 'Second Owner')`, [
    userId,
    'owner@second-company.test',
  ]);
  await server.pool.query(`INSERT INTO ${app}.memberships (org_id, user_id, kind) VALUES ($1, $2, 'owner')`, [
    orgId,
    userId,
  ]);
  return { ...(await signedIn(userId)), orgId };
}

describe('SCIM single sign-on answers', () => {
  it('answers every unverified address the same, whoever holds it and whatever their state', async () => {
    const { token } = await setup();
    const providerId = await connection(['example.test']);
    const provider = await providerRow(providerId);
    await provision(token, { userName: 'managed@example.test', externalId: 'managed', emails: [] });
    const gone = await provision(token, { userName: 'gone@example.test', externalId: 'gone', emails: [] });
    await call(token, 'PATCH', `Users/${gone}`, patch([{ op: 'replace', path: 'active', value: false }]));
    const member = await server.addMember();
    for (const email of ['managed@example.test', 'gone@example.test', member.email, 'nobody@example.test']) {
      const outcome = await signInClaimed(server.ctx, request, provider, {
        issuer: provider.issuer,
        subject: `subject-${email}`,
        email,
        emailVerified: false,
        name: 'Anyone',
      });
      expect(outcome, email).toEqual({ failure: 'sso.noAccount' });
    }
  });
});

describe('SCIM domain ownership', () => {
  it('lets only one organization on the server verify a domain', async () => {
    await setup({ domain: null });
    const ours = await connection(['shared.test']);
    expect((await verifyThroughDns(ours, 'shared.test')).statusCode).toBe(200);
    const second = await secondOwner();
    const theirs = await connection(['shared.test'], second.headers);
    const refused = await verifyThroughDns(theirs, 'shared.test', second.headers);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { messageKey: 'scim.errors.domainTaken', params: { domain: 'shared.test' } },
    });
    // A challenge requested before the first verification can't be finished afterward either.
    const { app } = authDatabase(server.ctx);
    const challenge = randomToken();
    await server.pool.query(
      `INSERT INTO ${app}.sso_domain_verifications (org_id, provider_id, domain, challenge)
      VALUES ($1, $2, 'shared.test', $3)`,
      [second.orgId, theirs, challenge],
    );
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([[challenge]]);
    const finished = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/domains/verify',
      headers: second.headers,
      payload: { providerId: theirs, domain: 'shared.test' },
    });
    expect(finished.statusCode, finished.body).toBe(409);
    const verified = await server.pool.query(
      `SELECT org_id FROM ${app}.sso_domain_verifications WHERE domain = 'shared.test' AND verified_at IS NOT NULL`,
    );
    expect(verified.rows).toEqual([{ org_id: server.owner.info.org.id }]);
    // Another of our own connections can verify it too.
    expect((await verifyThroughDns(await connection(['shared.test']), 'shared.test')).statusCode).toBe(200);
  });

  it('rechecks verified domains daily and takes verification away after three failures in a row', async () => {
    const { token } = await setup({ domain: null });
    const { app, audit } = authDatabase(server.ctx);
    const providerId = await connection(['example.test']);
    expect((await verifyThroughDns(providerId, 'example.test')).statusCode).toBe(200);
    const security = await server.addMember({ name: 'Security Admin' });
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['security'] WHERE user_id = $1`,
      [security.userId],
    );
    const bystander = await server.addMember({ name: 'Bystander' });
    const lookup = vi.spyOn(Resolver.prototype, 'resolveTxt');
    const state = async () =>
      (
        await server.pool.query<{ verified: boolean; failed_checks: number }>(
          `SELECT verified_at IS NOT NULL AS verified, failed_checks FROM ${app}.sso_domain_verifications`,
        )
      ).rows[0];
    /** A day passes, then the daily check runs with the lookup finding what's given. */
    const dayPasses = async (records: string[][]) => {
      await server.pool.query(
        `UPDATE ${app}.sso_domain_verifications SET checked_at = clock_timestamp() - interval '25 hours'`,
      );
      lookup.mockResolvedValue(records);
      await recheckDomains(server.ctx);
    };
    // A check that isn't due yet changes nothing.
    lookup.mockResolvedValue([]);
    await recheckDomains(server.ctx);
    expect(await state()).toEqual({ verified: true, failed_checks: 0 });
    await dayPasses([]);
    await dayPasses([]);
    expect(await state()).toEqual({ verified: true, failed_checks: 2 });
    // Finding the record starts the count over.
    const { challenge } = (
      await server.pool.query<{ challenge: string }>(`SELECT challenge FROM ${app}.sso_domain_verifications`)
    ).rows[0]!;
    await dayPasses([[challenge]]);
    expect(await state()).toEqual({ verified: true, failed_checks: 0 });
    await dayPasses([]);
    await dayPasses([]);
    expect(
      (
        await call(
          token,
          'POST',
          'Users',
          user({ userName: 'before@example.test', externalId: 'before', emails: [] }),
        )
      ).statusCode,
    ).toBe(201);
    await dayPasses([]);
    expect(await state()).toEqual({ verified: false, failed_checks: 0 });
    const refused = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'after@example.test', externalId: 'after', emails: [] }),
    );
    expect(refused.statusCode).toBe(400);

    const notified = await server.pool.query<{ recipient_id: string; target: Record<string, unknown> }>(
      `SELECT recipient_id, target FROM ${app}.notifications WHERE kind = 'domainUnverified' ORDER BY recipient_id`,
    );
    expect(notified.rows.map((row) => row.recipient_id).sort()).toEqual(
      [server.owner.userId, security.userId].sort(),
    );
    expect(notified.rows.map((row) => row.recipient_id)).not.toContain(bystander.userId);
    expect(notified.rows[0]!.target).toEqual({ domain: 'example.test' });
    const events = await server.pool.query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM ${audit}.events WHERE action = 'scim.domain.unverified'`,
    );
    expect(events.rows).toEqual([
      { actor_id: null, metadata: { providerId, domain: 'example.test', failedChecks: 3 } },
    ]);
    // Publishing the same record again verifies the domain again.
    lookup.mockResolvedValue([[challenge]]);
    const again = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/domains/verify',
      headers: server.owner.headers,
      payload: { providerId, domain: 'example.test' },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<ScimDomainVerification>()).toMatchObject({
      failedChecks: 0,
      verifiedAt: expect.any(String),
    });
  });

  it('gives addresses only on a domain the verified connection still lists and still uses', async () => {
    const { token } = await setup({ domain: null });
    const providerId = await connection(['example.test']);
    expect((await verifyThroughDns(providerId, 'example.test')).statusCode).toBe(200);
    expect(
      (
        await call(
          token,
          'POST',
          'Users',
          user({ userName: 'carol@example.test', externalId: 'carol', emails: [] }),
        )
      ).statusCode,
    ).toBe(201);
    const change = (payload: object) =>
      server.app.inject({
        method: 'PATCH',
        url: `/api/admin/sso/${providerId}`,
        headers: server.owner.headers,
        payload,
      });
    expect((await change({ allowedDomains: ['other.test'] })).statusCode).toBe(200);
    const dropped = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'dave@example.test', externalId: 'dave', emails: [] }),
    );
    expect(dropped.statusCode, dropped.body).toBe(400);
    expect(dropped.json()).toMatchObject({
      scimType: 'invalidValue',
      detail: expect.stringContaining('example.test'),
    });
    expect((await change({ allowedDomains: ['example.test'], enabled: false })).statusCode).toBe(200);
    const off = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'erin@example.test', externalId: 'erin', emails: [] }),
    );
    expect(off.statusCode, off.body).toBe(400);
    expect((await change({ enabled: true })).statusCode).toBe(200);
    expect(
      (
        await call(
          token,
          'POST',
          'Users',
          user({ userName: 'erin@example.test', externalId: 'erin', emails: [] }),
        )
      ).statusCode,
    ).toBe(201);
  });
});

import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { newId, type ScimToken, type ScimDomainVerification } from '@riosoma/contracts';
import { authDatabase, randomToken, tokenHash } from '../database.js';
import { createSession, findIdentity } from '../sessions.js';
import { signInClaimed } from '../sso/accounts.js';
import type { ProviderRow } from '../sso/store.js';
import { ENTERPRISE_SCHEMA, GROUP_SCHEMA, USER_SCHEMA } from './patch.js';
import {
  call,
  createDatabase,
  patch,
  provision,
  server,
  setup,
  signedIn,
  user,
  useScimServer,
} from './scim.test-helpers.js';

useScimServer();

describe('SCIM provisioning', () => {
  it.each(['Okta', 'Entra'])('replays the %s existence probe and provisioning sequence', async (provider) => {
    const { token } = await setup();
    const probe = `Users?filter=${encodeURIComponent('userName eq "bjensen@example.test"')}&startIndex=1&count=100`;
    expect((await call(token, 'GET', probe)).json()).toMatchObject({ totalResults: 0, Resources: [] });
    const created = await call(token, 'POST', 'Users', user());
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/scim+json');
    const id = created.json<{ id: string }>().id;
    expect(created.headers.location).toContain(`/scim/v2/Users/${id}`);
    expect((await call(token, 'GET', probe)).json()).toMatchObject({ totalResults: 1, Resources: [{ id }] });
    const updated = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch(
        provider === 'Entra'
          ? [{ op: 'Replace', path: 'displayName', value: 'Barbara Updated' }]
          : [{ op: 'replace', value: { displayName: 'Barbara Updated' } }],
      ),
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ displayName: 'Barbara Updated' });
    const group = await call(token, 'POST', 'Groups', {
      schemas: [GROUP_SCHEMA],
      displayName: 'Operations',
      externalId: 'directory-group',
      members: [],
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json<{ id: string }>().id;
    const added = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: provider === 'Entra' ? 'Add' : 'add', path: 'members', value: [{ value: id }] }]),
    );
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ members: [{ value: id }] });
    expect(
      (await call(token, 'GET', `Groups?filter=${encodeURIComponent('displayName eq "Operations"')}`)).json(),
    ).toMatchObject({ totalResults: 1 });
    const removed = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch(
        provider === 'Entra'
          ? [{ op: 'Remove', path: 'members', value: [{ value: id }] }]
          : [{ op: 'remove', path: `members[value eq "${id}"]` }],
      ),
    );
    expect(removed.json()).toMatchObject({ members: [] });
    const deactivated = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch(
        provider === 'Entra'
          ? [{ op: 'Replace', path: 'active', value: false }]
          : [{ op: 'replace', value: { active: false } }],
      ),
    );
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ active: false });
    expect(
      (
        await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'replace', path: 'active', value: true }]))
      ).json(),
    ).toMatchObject({ active: true });
  });

  it('scopes reads, writes, filters, and group membership to the token organization', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const { app } = authDatabase(server.ctx);
    const foreignOrg = newId('org');
    const secret = randomToken();
    await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, $2)`, [
      foreignOrg,
      'Another organization',
    ]);
    await server.pool.query(
      `INSERT INTO ${app}.scim_tokens (id, org_id, name, secret_hash) VALUES ($1, $2, $3, $4)`,
      [randomBytes(16).toString('hex'), foreignOrg, 'Other directory', tokenHash(secret)],
    );
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(
        (
          await call(
            secret,
            method,
            `Users/${id}`,
            method === 'PUT'
              ? user()
              : method === 'PATCH'
                ? patch([{ op: 'replace', path: 'active', value: false }])
                : undefined,
          )
        ).statusCode,
      ).toBe(404);
    }
    expect((await call(secret, 'GET', 'Users')).json()).toMatchObject({ totalResults: 0 });
    expect(
      (
        await call(secret, 'POST', 'Groups', {
          schemas: [GROUP_SCHEMA],
          displayName: 'Foreign',
          members: [{ value: id }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await call(token, 'GET', `Users/${id}`)).json()).toMatchObject({ active: true });
  });

  it('rejects duplicate user names and external IDs with uniqueness errors', async () => {
    const { token } = await setup();
    expect((await call(token, 'POST', 'Users', user())).statusCode).toBe(201);
    for (const body of [user(), user({ userName: 'another@example.test', emails: [] })]) {
      const response = await call(token, 'POST', 'Users', body);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    }
  });

  it('supports all filter operators, boolean precedence, paging, and malformed filters', async () => {
    const { token } = await setup();
    await call(token, 'POST', 'Users', user());
    for (const filter of [
      'userName eq "BJENSEN@example.test"',
      'userName co "jensen"',
      'userName sw "bjen"',
      'userName pr',
      'externalId eq "directory-person"',
      'externalId co "person"',
      'externalId sw "directory"',
      'externalId pr',
      'emails.value eq "bjensen@example.test"',
      'emails.value co "example"',
      'emails.value sw "bjen"',
      'emails.value pr',
      'displayName eq "Barbara Jensen"',
      'displayName co "Jensen"',
      'displayName sw "Barbara"',
      'displayName pr',
      'displayName pr and (userName sw "bjen" or externalId eq "absent")',
    ]) {
      const response = await call(token, 'GET', `Users?filter=${encodeURIComponent(filter)}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ totalResults: 1 });
    }
    expect((await call(token, 'GET', 'Users?count=0')).json()).toMatchObject({
      totalResults: 1,
      itemsPerPage: 0,
      Resources: [],
    });
    expect((await call(token, 'GET', 'Users?startIndex=2&count=1')).json()).toMatchObject({
      totalResults: 1,
      Resources: [],
    });
    const invalid = await call(token, 'GET', `Users?filter=${encodeURIComponent('userName eq "unclosed')}`);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ scimType: 'invalidFilter' });
  });

  it('applies filtered PATCH paths atomically and replaces optional attributes with PUT', async () => {
    const { token } = await setup();
    const id = (
      await call(
        token,
        'POST',
        'Users',
        user({ [ENTERPRISE_SCHEMA]: { department: 'Operations', employeeNumber: '42' } }),
      )
    ).json<{ id: string }>().id;
    const changed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'emails[type eq "work"].value', value: 'updated@example.test' }]),
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      userName: 'bjensen@example.test',
      emails: [{ value: 'updated@example.test' }],
    });
    const { app } = authDatabase(server.ctx);
    expect(
      (await server.pool.query(`SELECT email FROM ${app}.users WHERE id = $1`, [id])).rows[0].email,
    ).toBe('updated@example.test');
    const failed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([
        { op: 'replace', path: 'displayName', value: 'Should roll back' },
        { op: 'replace', path: 'emails[type eq "work"', value: 'unterminated@example.test' },
      ]),
    );
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ scimType: 'invalidPath' });
    expect((await call(token, 'GET', `Users/${id}`)).json()).toMatchObject({ displayName: 'Barbara Jensen' });
    const replaced = await call(token, 'PUT', `Users/${id}`, {
      schemas: [USER_SCHEMA],
      userName: 'bjensen@example.test',
      emails: [{ value: 'updated@example.test', type: 'work' }],
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).not.toHaveProperty(ENTERPRISE_SCHEMA);
    expect(replaced.json()).not.toHaveProperty('externalId');
  });

  it('ends sessions and API tokens immediately on suspension without removing ownership', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const { app } = authDatabase(server.ctx);
    const identity = (await findIdentity(server.pool, app, id))!;
    const request = { headers: {}, protocol: 'http', ip: '127.0.0.1' } as FastifyRequest;
    const session = await createSession(server.pool, server.ctx, identity, request);
    const headers = { cookie: `rio_session=${session.token}`, 'x-csrf-token': session.info.csrfToken };
    const apiToken = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers,
      payload: {
        name: 'Automation',
        scopes: ['data.records:read', 'schema.bases:read'],
        databases: 'all',
        expiresInDays: 30,
      },
    });
    expect(apiToken.statusCode).toBe(200);
    const database = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers,
      payload: {
        id: newId('database'),
        name: 'Owned data',
        table: {
          id: newId('table'),
          name: 'Records',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'All records' },
        },
      },
    });
    expect(database.statusCode).toBe(200);
    expect(
      (await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'replace', path: 'active', value: false }])))
        .statusCode,
    ).toBe(200);
    expect((await server.app.inject({ url: '/api/databases', headers })).statusCode).toBe(401);
    const bearer = { authorization: `Bearer ${apiToken.json<{ token: string }>().token}` };
    expect((await server.app.inject({ url: '/api/v1/databases', headers: bearer })).statusCode).toBe(401);
    const stored = await server.pool.query(`SELECT revoked_at FROM ${app}.api_tokens WHERE user_id = $1`, [
      id,
    ]);
    expect(stored.rows[0].revoked_at).toBeTruthy();
    expect(
      (
        await server.pool.query(`SELECT 1 FROM ${app}.grants WHERE principal_id = $1 AND role = 'owner'`, [
          id,
        ])
      ).rowCount,
    ).toBe(1);
    await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'replace', path: 'active', value: true }]));
    expect((await server.app.inject({ url: '/api/databases', headers })).statusCode).toBe(401);
  });

  it('requires Security administration and revokes rotated tokens', async () => {
    const created = await setup();
    const member = await server.addMember();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/admin/scim/tokens',
          headers: member.headers,
          payload: { name: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
    const { app: adminSchema } = authDatabase(server.ctx);
    await server.pool.query(
      `UPDATE ${adminSchema}.memberships SET admin_roles = ARRAY['security'] WHERE org_id = $1 AND user_id = $2`,
      [server.owner.info.org.id, member.userId],
    );
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/admin/scim/tokens',
          headers: member.headers,
          payload: { name: 'Security directory' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/admin/scim/tokens',
          headers: { cookie: member.headers.cookie },
          payload: { name: 'Missing verification' },
        })
      ).statusCode,
    ).toBe(403);
    const rotated = await server.app.inject({
      method: 'POST',
      url: `/api/admin/scim/tokens/${created.id}/rotate`,
      headers: server.owner.headers,
    });
    expect(rotated.statusCode).toBe(200);
    expect((await call(created.token, 'GET', 'Users')).statusCode).toBe(401);
    const current = rotated.json<ScimToken & { token: string }>();
    expect((await call(current.token, 'GET', 'ServiceProviderConfig')).statusCode).toBe(200);
    const listed = await server.app.inject({ url: '/api/admin/scim', headers: server.owner.headers });
    expect(listed.body).not.toContain(current.token);
    expect(
      listed.json<{ tokens: ScimToken[] }>().tokens.find((item) => item.id === current.id)?.lastUsedAt,
    ).toBeTruthy();
    await server.app.inject({
      method: 'DELETE',
      url: `/api/admin/scim/tokens/${current.id}`,
      headers: server.owner.headers,
    });
    expect((await call(current.token, 'GET', 'Schemas')).statusCode).toBe(401);
    const { app } = authDatabase(server.ctx);
    const stored = await server.pool.query(`SELECT secret_hash FROM ${app}.scim_tokens WHERE id = $1`, [
      current.id,
    ]);
    expect(stored.rows[0].secret_hash).toBe(tokenHash(current.token));
  });

  it('keeps dry runs out of account and membership storage while auditing proposed changes', async () => {
    const { token, id: tokenId } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    await server.app.inject({
      method: 'PUT',
      url: '/api/admin/scim',
      headers: server.owner.headers,
      payload: { dryRun: true, deleteAction: 'suspend' },
    });
    const preview = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'active', value: false }]),
    );
    expect(preview.headers['x-scim-dry-run']).toBe('true');
    expect(preview.json()).toMatchObject({ active: false });
    expect((await call(token, 'GET', `Users/${id}`)).json()).toMatchObject({ active: true });
    const create = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'preview@example.test', externalId: 'preview', emails: [] }),
    );
    expect(create.statusCode).toBe(201);
    expect((await call(token, 'GET', `Users/${create.json<{ id: string }>().id}`)).statusCode).toBe(404);
    const { app, audit } = authDatabase(server.ctx);
    expect(
      (await server.pool.query(`SELECT 1 FROM ${app}.users WHERE email = $1`, ['preview@example.test']))
        .rowCount,
    ).toBe(0);
    const events = await server.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM ${audit}.events WHERE action = 'scim.users.patch'`,
    );
    expect(events.rows).toEqual([
      {
        metadata: expect.objectContaining({
          tokenId,
          tokenName: 'Directory provisioning',
          dryRun: true,
          after: expect.objectContaining({ active: false }),
        }),
      },
    ]);
  });

  it('refuses the first SSO link until the connection domain is verified', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/admin/sso',
      headers: server.owner.headers,
      payload: {
        kind: 'oidc',
        name: 'Directory',
        issuer: 'https://identity.example.test',
        clientId: randomToken(),
        clientSecret: randomToken(),
        allowedDomains: ['example.test'],
      },
    });
    expect(created.statusCode).toBe(200);
    const providerId = created.json<{ id: string }>().id;
    const { app } = authDatabase(server.ctx);
    const provider = (
      await server.pool.query<ProviderRow>(`SELECT * FROM ${app}.sso_providers WHERE id = $1`, [providerId])
    ).rows[0]!;
    const request = { headers: {}, protocol: 'http', ip: '127.0.0.1' } as FastifyRequest;
    const claimed = {
      issuer: provider.issuer,
      subject: 'directory-person',
      email: 'bjensen@example.test',
      emailVerified: true,
      name: 'Barbara Jensen',
    };
    expect(await signInClaimed(server.ctx, request, provider, claimed)).toEqual({
      failure: 'sso.domainUnverified',
    });
    expect(
      (await server.pool.query(`SELECT 1 FROM ${app}.sso_identities WHERE user_id = $1`, [id])).rowCount,
    ).toBe(0);
    const challenge = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/domains',
      headers: server.owner.headers,
      payload: { providerId, domain: 'example.test' },
    });
    expect(challenge.statusCode).toBe(200);
    vi.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValue([
      [challenge.json<ScimDomainVerification>().recordValue],
    ]);
    const verified = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/domains/verify',
      headers: server.owner.headers,
      payload: { providerId, domain: 'example.test' },
    });
    expect(verified.statusCode).toBe(200);
    expect(await signInClaimed(server.ctx, request, provider, claimed)).toMatchObject({
      session: { info: { user: { id } } },
    });
  });

  it('rate limits each token independently and rejects unauthenticated discovery', async () => {
    const { token, id } = await setup();
    const { app } = authDatabase(server.ctx);
    await server.pool.query(
      `UPDATE ${app}.scim_tokens SET rate_count = 120, rate_started_at = clock_timestamp() WHERE id = $1`,
      [id],
    );
    const limited = await call(token, 'GET', 'Users');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await server.app.inject({ url: '/scim/v2/ServiceProviderConfig' })).statusCode).toBe(401);
    const next = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/tokens',
      headers: server.owner.headers,
      payload: { name: 'Second directory' },
    });
    expect((await call(next.json<{ token: string }>().token, 'GET', 'Users')).statusCode).toBe(200);
  });
});

describe('SCIM access and RFC examples', () => {
  it('applies group membership to database and folder roles and removes access immediately', async () => {
    const { token } = await setup();
    const person = await signedIn(await provision(token));
    const direct = (await createDatabase()).id;
    const inherited = (await createDatabase()).id;
    const group = (
      await call(token, 'POST', 'Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Operators',
        members: [{ value: person.userId }],
      })
    ).json<{ id: string }>();
    const granted = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${direct}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'group', id: group.id }, role: 'reader' },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toContainEqual({
      principal: { kind: 'group', id: group.id, name: 'Operators' },
      role: 'reader',
    });
    const folder = await server.app.inject({
      method: 'POST',
      url: '/api/org/folders',
      headers: server.owner.headers,
      payload: { name: 'Shared folder', databases: [inherited] },
    });
    expect(folder.statusCode).toBe(200);
    const folderId = folder.json<{ id: string }>().id;
    const folderGrant = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${folderId}/grants`,
      headers: server.owner.headers,
      payload: { groupId: group.id, role: 'editor' },
    });
    expect(folderGrant.statusCode).toBe(200);
    const list = () => server.app.inject({ url: '/api/databases', headers: person.headers });
    expect((await list()).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: direct, role: 'reader' }),
        expect.objectContaining({ id: inherited, role: 'editor' }),
      ]),
    );
    const removed = await call(
      token,
      'PATCH',
      `Groups/${group.id}`,
      patch([{ op: 'Remove', path: 'members', value: [{ value: person.userId }] }]),
    );
    expect(removed.statusCode).toBe(200);
    expect((await list()).json()).toEqual([]);
    const { app } = authDatabase(server.ctx);
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['people'] WHERE user_id = $1`,
      [person.userId],
    );
    const denied = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${folderId}/grants`,
      headers: person.headers,
      payload: { groupId: group.id, role: 'owner' },
    });
    expect(denied.statusCode).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: `/api/org/groups/${group.id}`,
          headers: server.owner.headers,
          payload: { name: 'Renamed locally' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('deletes a resource by suspending its person and restores that account on reprovisioning', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const deleted = await call(token, 'DELETE', `Users/${id}`);
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await call(token, 'GET', `Users/${id}`)).statusCode).toBe(404);
    expect((await call(token, 'GET', 'Users')).json()).toMatchObject({ totalResults: 0 });
    const { app } = authDatabase(server.ctx);
    expect(
      (await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [id])).rows[0]
        .deactivated_at,
    ).toBeTruthy();
    const restored = await call(token, 'POST', 'Users', user());
    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({ id, active: true });
    expect(
      (await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [id])).rows[0]
        .deactivated_at,
    ).toBeNull();
  });

  it('removes a person only when configured and removes their group references', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const groupId = (
      await call(token, 'POST', 'Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Operators',
        members: [{ value: id }],
      })
    ).json<{ id: string }>().id;
    await server.app.inject({
      method: 'PUT',
      url: '/api/admin/scim',
      headers: server.owner.headers,
      payload: { dryRun: false, deleteAction: 'remove' },
    });
    const removed = await call(token, 'DELETE', `Users/${id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const { app } = authDatabase(server.ctx);
    expect((await server.pool.query(`SELECT id FROM ${app}.users WHERE id = $1`, [id])).rowCount).toBe(0);
    expect((await call(token, 'GET', `Groups/${groupId}`)).json()).toMatchObject({ members: [] });
    expect((await call(token, 'DELETE', `Groups/${groupId}`)).statusCode).toBe(204);
    expect((await call(token, 'GET', `Groups/${groupId}`)).statusCode).toBe(404);
  });

  it('reports discovery, invalid values, and failed paths in SCIM response shapes', async () => {
    const { token } = await setup();
    expect((await call(token, 'GET', 'ServiceProviderConfig')).json()).toMatchObject({
      patch: { supported: true },
      filter: { supported: true, maxResults: 1000 },
      bulk: { supported: false },
      etag: { supported: false },
    });
    expect((await call(token, 'GET', 'ResourceTypes')).json()).toMatchObject({
      totalResults: 2,
      Resources: [
        { id: 'User', schema: USER_SCHEMA },
        { id: 'Group', schema: GROUP_SCHEMA },
      ],
    });
    expect((await call(token, 'GET', 'ResourceTypes/User')).json()).toMatchObject({
      schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }],
    });
    expect((await call(token, 'GET', `Schemas/${encodeURIComponent(USER_SCHEMA)}`)).json()).toMatchObject({
      id: USER_SCHEMA,
      attributes: expect.arrayContaining([expect.objectContaining({ name: 'userName', required: true })]),
    });
    const invalid = await call(token, 'POST', 'Users', user({ active: 'sometimes' }));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '400',
      scimType: 'invalidValue',
    });
    const malformed = await server.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/scim+json');
    expect(malformed.json()).toHaveProperty('schemas');
    const groupId = (
      await call(token, 'POST', 'Groups', { schemas: [GROUP_SCHEMA], displayName: 'Before', members: [] })
    ).json<{ id: string }>().id;
    expect(
      (
        await call(token, 'PUT', `Groups/${groupId}`, { schemas: [GROUP_SCHEMA], displayName: 'After' })
      ).json(),
    ).toMatchObject({ displayName: 'After', members: [] });
    const missing = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: 'replace', path: 'members[value eq "absent"].display', value: 'Nobody' }]),
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toHaveProperty('scimType', 'noTarget');
  });

  it('audits all user and group writes with the token name and excludes the secret', async () => {
    const { token, id: tokenId } = await setup();
    const personId = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const groupId = (
      await call(token, 'POST', 'Groups', { schemas: [GROUP_SCHEMA], displayName: 'Audit group' })
    ).json<{ id: string }>().id;
    await call(token, 'PATCH', `Users/${personId}`, patch([{ op: 'replace', path: 'active', value: false }]));
    await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: 'add', path: 'members', value: [{ value: personId }] }]),
    );
    await call(token, 'DELETE', `Groups/${groupId}`);
    await call(token, 'DELETE', `Users/${personId}`);
    const { audit } = authDatabase(server.ctx);
    const result = await server.pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM ${audit}.events WHERE action LIKE 'scim.users.%' OR action LIKE 'scim.groups.%' ORDER BY id`,
    );
    expect(result.rows.map((row) => row.action)).toEqual([
      'scim.users.post',
      'scim.groups.post',
      'scim.users.patch',
      'scim.groups.patch',
      'scim.groups.delete',
      'scim.users.delete',
    ]);
    for (const event of result.rows)
      expect(event.metadata).toMatchObject({ tokenId, tokenName: 'Directory provisioning', dryRun: false });
    expect(JSON.stringify(result.rows)).not.toContain(token);
  });

  it('rolls back group writes and deletion in dry run', async () => {
    const { token } = await setup();
    const personId = (await call(token, 'POST', 'Users', user())).json<{ id: string }>().id;
    const groupId = (
      await call(token, 'POST', 'Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Preview group',
        members: [{ value: personId }],
      })
    ).json<{ id: string }>().id;
    await server.app.inject({
      method: 'PUT',
      url: '/api/admin/scim',
      headers: server.owner.headers,
      payload: { dryRun: true, deleteAction: 'remove' },
    });
    expect(
      (await call(token, 'PATCH', `Groups/${groupId}`, patch([{ op: 'remove', path: 'members' }]))).json(),
    ).toMatchObject({ members: [] });
    expect((await call(token, 'GET', `Groups/${groupId}`)).json()).toMatchObject({
      members: [{ value: personId }],
    });
    expect((await call(token, 'DELETE', `Users/${personId}`)).statusCode).toBe(204);
    expect((await call(token, 'GET', `Users/${personId}`)).json()).toMatchObject({ active: true });
    expect((await call(token, 'DELETE', `Groups/${groupId}`)).statusCode).toBe(204);
    expect((await call(token, 'GET', `Groups/${groupId}`)).statusCode).toBe(200);
  });
});

it('keeps enterprise profiles read-only and rejects cross-organization group requests', async () => {
  const { token } = await setup();
  const manager = await server.addMember({ name: 'Manager' });
  const created = await call(
    token,
    'POST',
    'Users',
    user({
      [ENTERPRISE_SCHEMA]: {
        department: 'Operations',
        employeeNumber: '42',
        manager: { value: manager.userId },
      },
    }),
  );
  expect(created.statusCode).toBe(201);
  const id = created.json<{ id: string }>().id;
  const members = await server.app.inject({ url: '/api/org/members', headers: server.owner.headers });
  expect(members.json()).toContainEqual(
    expect.objectContaining({
      id,
      managed: 'scim',
      profile: expect.objectContaining({
        givenName: 'Barbara',
        familyName: 'Jensen',
        department: 'Operations',
        employeeNumber: '42',
        manager: { value: manager.userId },
      }),
    }),
  );
  const groupId = (
    await call(token, 'POST', 'Groups', { schemas: [GROUP_SCHEMA], displayName: 'Private group' })
  ).json<{ id: string }>().id;
  const { app } = authDatabase(server.ctx);
  const orgId = newId('org');
  const foreignToken = randomToken();
  await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, $2)`, [
    orgId,
    'Other organization',
  ]);
  await server.pool.query(
    `INSERT INTO ${app}.scim_tokens (id, org_id, name, secret_hash) VALUES ($1, $2, $3, $4)`,
    [randomBytes(16).toString('hex'), orgId, 'Other directory', tokenHash(foreignToken)],
  );
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
    expect(
      (
        await call(
          foreignToken,
          method,
          `Groups/${groupId}`,
          method === 'PUT'
            ? { schemas: [GROUP_SCHEMA], displayName: 'Changed' }
            : method === 'PATCH'
              ? patch([{ op: 'replace', path: 'displayName', value: 'Changed' }])
              : undefined,
        )
      ).statusCode,
    ).toBe(404);
  }
  expect((await call(foreignToken, 'GET', 'Groups')).json()).toMatchObject({ totalResults: 0 });
  expect((await server.app.inject({ url: '/scim/v2/Users', headers: server.owner.headers })).statusCode).toBe(
    401,
  );
});

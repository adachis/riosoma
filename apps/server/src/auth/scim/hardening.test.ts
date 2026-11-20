import { describe, expect, it } from 'vitest';
import { newId, type CalendarFeedCreated, type Grant, type SharedViewLink } from '@riosoma/contracts';
import { authDatabase } from '../database.js';
import { ENTERPRISE_SCHEMA, USER_SCHEMA } from './patch.js';
import {
  call,
  createDatabase,
  group,
  otherOrganization,
  patch,
  provision,
  server,
  setup,
  signedIn,
  user,
  useScimServer,
} from './scim.test-helpers.js';

/**
 * Where provisioning meets the rest of Riosoma: which addresses a directory may claim, who it may
 * suspend, who may join its groups, and what a suspension stops.  The protocol cases replay what
 * Okta and Entra send as shipped.
 */
useScimServer();

const deactivate = patch([{ op: 'replace', path: 'active', value: false }]);
const reactivate = patch([{ op: 'replace', path: 'active', value: true }]);

async function dryRun(on: boolean) {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/scim',
    headers: server.owner.headers,
    payload: { dryRun: on, deleteAction: 'suspend' },
  });
  expect(response.statusCode).toBe(200);
}

async function emailOf(userId: string): Promise<string | undefined> {
  const { app } = authDatabase(server.ctx);
  const result = await server.pool.query<{ email: string }>(`SELECT email FROM ${app}.users WHERE id = $1`, [
    userId,
  ]);
  return result.rows[0]?.email;
}

describe('SCIM address ownership', () => {
  it('claims addresses only on the organization’s own verified domains', async () => {
    const { token } = await setup();
    const other = await otherOrganization('other-company.test');
    const squat = user({ userName: 'ceo@other-company.test', externalId: 'ceo', emails: [] });
    const refused = await call(token, 'POST', 'Users', squat);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      scimType: 'invalidValue',
      detail: expect.stringContaining('other-company.test'),
    });
    expect((await call(other.token, 'POST', 'Users', squat)).statusCode).toBe(201);
    // An address another organization holds reads the same as any address outside our domains.
    const probe = await call(token, 'POST', 'Users', { ...squat, externalId: 'probe' });
    expect(probe.statusCode).toBe(400);
    expect(probe.json()).toMatchObject({ scimType: 'invalidValue' });

    const id = await provision(token);
    for (const [method, body] of [
      [
        'PATCH',
        patch([{ op: 'replace', path: 'emails[type eq "work"].value', value: 'moved@other-company.test' }]),
      ],
      ['PUT', user({ userName: 'moved@other-company.test', emails: [] })],
    ] as const) {
      const response = await call(token, method, `Users/${id}`, body);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        scimType: 'invalidValue',
        detail: expect.stringContaining('other-company.test'),
      });
    }
    expect(await emailOf(id)).toBe('bjensen@example.test');

    await dryRun(true);
    const preview = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'preview@unverified.test', externalId: 'preview', emails: [] }),
    );
    expect(preview.statusCode).toBe(400);
    expect(preview.json()).toMatchObject({ detail: expect.stringContaining('unverified.test') });
    const { app } = authDatabase(server.ctx);
    const stored = await server.pool.query<{ email: string }>(
      `SELECT email FROM ${app}.users WHERE email NOT LIKE '%@example.test' ORDER BY email`,
    );
    expect(stored.rows).toEqual([{ email: 'ceo@other-company.test' }]);
  });

  it('keeps the directory login name apart from the person’s email, as Entra sends it', async () => {
    const { token } = await setup();
    const upn = 'Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1@contoso.onmicrosoft.test';
    // Entra's documented create: the user principal name as userName, and a different work address.
    const created = await call(token, 'POST', 'Users', {
      schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
      externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
      userName: upn,
      active: true,
      emails: [{ primary: true, type: 'work', value: 'Alex.Wilber@example.test' }],
      meta: { resourceType: 'User' },
      name: { formatted: 'Alex Wilber', familyName: 'Wilber', givenName: 'Alex' },
      roles: [],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ userName: upn });
    expect(await emailOf(id)).toBe('alex.wilber@example.test');
    const count = async (filter: string) =>
      (await call(token, 'GET', `Users?filter=${encodeURIComponent(filter)}`)).json<{
        totalResults: number;
      }>().totalResults;
    expect(await count(`userName eq "${upn.toUpperCase()}"`)).toBe(1);
    expect(await count('userName eq "alex.wilber@example.test"')).toBe(0);

    // The login name is unique in the organization without regard to case, and only there.
    const duplicate = await call(
      token,
      'POST',
      'Users',
      user({
        userName: upn.toLowerCase(),
        externalId: 'second',
        emails: [{ value: 'second@example.test', type: 'work' }],
      }),
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ scimType: 'uniqueness' });
    const other = await otherOrganization('elsewhere.test');
    expect(
      (
        await call(
          other.token,
          'POST',
          'Users',
          user({ userName: upn, emails: [{ value: 'alex@elsewhere.test', type: 'work' }] }),
        )
      ).statusCode,
    ).toBe(201);

    // A renamed login keeps the address, and without a primary the work address is the email.
    const renamed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'userName', value: 'alex@contoso.onmicrosoft.test' }]),
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await emailOf(id)).toBe('alex.wilber@example.test');
    const work = await provision(token, {
      userName: 'second@contoso.onmicrosoft.test',
      externalId: 'work',
      emails: [
        { type: 'home', value: 'home@example.test' },
        { type: 'work', value: 'work@example.test' },
      ],
    });
    expect(await emailOf(work)).toBe('work@example.test');
    const plain = await provision(token, { userName: 'Plain@Example.test', externalId: 'plain', emails: [] });
    expect(await emailOf(plain)).toBe('plain@example.test');
    const nameless = await call(token, 'POST', 'Users', user({ userName: 'no-address', emails: [] }));
    expect(nameless.statusCode).toBe(400);
    expect(nameless.json()).toMatchObject({ scimType: 'invalidValue' });
  });
});

describe('SCIM deprovisioning', () => {
  it('suspends and deletes managed people whatever admin roles they hold', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const id = await provision(token);
    const second = await provision(token, {
      userName: 'second@example.test',
      externalId: 'second',
      emails: [],
    });
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['security', 'people'] WHERE user_id = ANY($1::text[])`,
      [[id, second]],
    );
    const person = await signedIn(id);
    expect((await server.app.inject({ url: '/api/databases', headers: person.headers })).statusCode).toBe(
      200,
    );
    const suspended = await call(token, 'PATCH', `Users/${id}`, deactivate);
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(suspended.json()).toMatchObject({ active: false });
    expect((await server.app.inject({ url: '/api/databases', headers: person.headers })).statusCode).toBe(
      401,
    );
    expect((await call(token, 'DELETE', `Users/${second}`)).statusCode).toBe(204);
    const stored = await server.pool.query(
      `SELECT id FROM ${app}.users WHERE id = ANY($1::text[]) AND deactivated_at IS NOT NULL`,
      [[id, second]],
    );
    expect(stored.rowCount).toBe(2);
  });

  it('never changes the organization owner, and refuses without naming a role', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const ownerId = server.owner.userId;
    // Nothing links the owner to a directory today, so this stands in for one that someday might.
    await server.pool.query(`INSERT INTO ${app}.scim_users (org_id, user_id, document) VALUES ($1, $2, $3)`, [
      server.owner.info.org.id,
      ownerId,
      JSON.stringify({
        schemas: [USER_SCHEMA],
        id: ownerId,
        userName: server.owner.email,
        active: true,
        emails: [],
      }),
    ]);
    for (const [method, body] of [
      ['PATCH', deactivate],
      ['PUT', user({ userName: server.owner.email, emails: [] })],
      ['DELETE', undefined],
    ] as const) {
      const response = await call(token, method, `Users/${ownerId}`, body);
      expect(response.statusCode, `${method} ${response.body}`).toBe(409);
      expect(response.json()).toMatchObject({ detail: 'scim.errors.protectedAccount' });
      expect(response.body).not.toMatch(/owner|admin|role/i);
    }
    const joined = await call(token, 'POST', 'Groups', group({ members: [{ value: ownerId }] }));
    expect(joined.statusCode).toBe(400);
    const stored = await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [
      ownerId,
    ]);
    expect(stored.rows[0].deactivated_at).toBeNull();
  });
});

describe('SCIM group members', () => {
  it('accepts only people this directory provisioned', async () => {
    const { token } = await setup();
    const managed = await provision(token);
    const member = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    for (const outsider of [member.userId, guest.userId, server.owner.userId]) {
      const created = await call(
        token,
        'POST',
        'Groups',
        group({ displayName: `Group ${outsider}`, members: [{ value: outsider }] }),
      );
      expect(created.statusCode, created.body).toBe(400);
      expect(created.json()).toMatchObject({ scimType: 'invalidValue' });
    }
    const groupId = (await call(token, 'POST', 'Groups', group({ members: [{ value: managed }] }))).json<{
      id: string;
    }>().id;
    const added = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: 'add', path: 'members', value: [{ value: guest.userId }] }]),
    );
    expect(added.statusCode).toBe(400);
    const replaced = await call(
      token,
      'PUT',
      `Groups/${groupId}`,
      group({ members: [{ value: managed }, { value: member.userId }] }),
    );
    expect(replaced.statusCode).toBe(400);
    expect((await call(token, 'GET', `Groups/${groupId}`)).json()).toMatchObject({
      members: [{ value: managed }],
    });

    // A person the directory deleted is no longer one it manages, though their old groups keep them.
    expect((await call(token, 'DELETE', `Users/${managed}`)).statusCode).toBe(204);
    const later = await provision(token, { userName: 'later@example.test', externalId: 'later', emails: [] });
    expect(
      (
        await call(
          token,
          'PATCH',
          `Groups/${groupId}`,
          patch([{ op: 'add', path: 'members', value: [{ value: later }] }]),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call(token, 'POST', 'Groups', group({ displayName: 'Fresh', members: [{ value: managed }] })))
        .statusCode,
    ).toBe(400);
  });

  it('withholds group roles from guests, as it does roles shared with everyone', async () => {
    const { token } = await setup();
    const guest = await server.addMember({ kind: 'guest' });
    const database = await createDatabase();
    const groupId = (await call(token, 'POST', 'Groups', group())).json<{ id: string }>().id;
    const { app } = authDatabase(server.ctx);
    // Provisioning can't put a guest in a group any longer, so this stands in for older data.
    await server.pool.query(
      `INSERT INTO ${app}.group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [server.owner.info.org.id, groupId, guest.userId],
    );
    const granted = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${database.id}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'group', id: groupId }, role: 'editor' },
    });
    expect(granted.statusCode).toBe(200);
    expect((await server.app.inject({ url: '/api/databases', headers: guest.headers })).json()).toEqual([]);
    expect(
      (await server.app.inject({ url: `/api/databases/${database.id}/grants`, headers: guest.headers }))
        .statusCode,
    ).toBe(404);
  });
});

describe('SCIM audit events', () => {
  it('record the token, not a person, as the actor', async () => {
    const { token, id: tokenId } = await setup();
    const personId = await provision(token);
    const groupId = (await call(token, 'POST', 'Groups', group())).json<{ id: string }>().id;
    await call(token, 'PATCH', `Users/${personId}`, deactivate);
    await call(token, 'DELETE', `Groups/${groupId}`);
    const { audit } = authDatabase(server.ctx);
    const events = await server.pool.query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM ${audit}.events
      WHERE action LIKE 'scim.users.%' OR action LIKE 'scim.groups.%' ORDER BY id`,
    );
    expect(events.rows).toHaveLength(4);
    for (const event of events.rows) {
      expect(event.actor_id).toBeNull();
      expect(event.metadata).toMatchObject({
        actorKind: 'scim_token',
        tokenId,
        tokenName: 'Directory provisioning',
      });
    }
    // Managing the token is still a person's action.
    const created = await server.pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM ${audit}.events WHERE action = 'scim.token.created'`,
    );
    expect(created.rows).toEqual([{ actor_id: server.owner.userId }]);
  });
});

describe('SCIM suspension', () => {
  it('revokes calendar feed addresses for good', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const person = await signedIn(id);
    const databaseId = newId('database');
    const tableId = newId('table');
    const when = newId('field');
    const database = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: person.headers,
      payload: {
        id: databaseId,
        name: 'Schedule',
        table: {
          id: tableId,
          name: 'Events',
          fields: [
            { id: newId('field'), name: 'Name', type: 'text' },
            { id: when, name: 'When', type: 'date' },
          ],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    });
    expect(database.statusCode, database.body).toBe(200);
    const viewId = newId('view');
    const commands = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: person.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'view.create',
            view: {
              id: viewId,
              tableId,
              name: 'Calendar',
              type: 'calendar',
              config: { calendar: { startFieldId: when, endFieldId: null } },
            },
          },
        ],
      },
    });
    expect(commands.statusCode, commands.body).toBe(200);
    const feed = await server.app.inject({
      method: 'POST',
      url: `/api/views/${viewId}/calendar-feed`,
      headers: person.headers,
      payload: { timeZone: 'UTC' },
    });
    expect(feed.statusCode, feed.body).toBe(200);
    const { path } = feed.json<CalendarFeedCreated>();
    const poll = () => server.app.inject({ url: path });
    expect((await poll()).statusCode).toBe(200);
    await call(token, 'PATCH', `Users/${id}`, deactivate);
    expect((await poll()).statusCode).toBe(410);
    await call(token, 'PATCH', `Users/${id}`, reactivate);
    expect((await poll()).statusCode).toBe(410);
  });

  it('stops a suspended person’s public view links until they are reactivated', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const person = await signedIn(id);
    const database = await createDatabase(person.headers);
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${database.viewId}/shared-view`,
      headers: person.headers,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const { linkId } = shared.json<SharedViewLink>();
    const statuses = async () =>
      Promise.all(
        [`/api/public/views/${linkId}`, `/api/public/views/${linkId}/rows`].map(
          async (url) => (await server.app.inject({ url })).statusCode,
        ),
      );
    expect(await statuses()).toEqual([200, 200]);
    await call(token, 'PATCH', `Users/${id}`, deactivate);
    expect(await statuses()).toEqual([410, 410]);
    await call(token, 'PATCH', `Users/${id}`, reactivate);
    expect(await statuses()).toEqual([200, 200]);
    expect((await call(token, 'DELETE', `Users/${id}`)).statusCode).toBe(204);
    expect(await statuses()).toEqual([410, 410]);
  });
});

describe('SCIM folder access', () => {
  async function folder(headers: Record<string, string>, databases: string[]) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/org/folders',
      headers,
      payload: { name: 'Quarterly', databases },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  }
  function grantFolder(headers: Record<string, string>, folderId: string, groupId: string, role: string) {
    return server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${folderId}/grants`,
      headers,
      payload: { groupId, role },
    });
  }

  it('lists access inherited through a folder in the share list, read-only, naming the folder', async () => {
    const { token } = await setup();
    const database = await createDatabase();
    const groupId = (await call(token, 'POST', 'Groups', group())).json<{ id: string }>().id;
    const folderId = await folder(server.owner.headers, [database.id]);
    expect((await grantFolder(server.owner.headers, folderId, groupId, 'editor')).statusCode).toBe(200);
    const inherited: Grant = {
      principal: { kind: 'group', id: groupId, name: 'Operators' },
      role: 'editor',
      inheritedFrom: { kind: 'folder', id: folderId, name: 'Quarterly' },
    };
    const listed = await server.app.inject({
      url: `/api/databases/${database.id}/grants`,
      headers: server.owner.headers,
    });
    expect(listed.json<Grant[]>()).toContainEqual(inherited);
    // Changing the database's own grants leaves the folder's in place.
    const direct = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${database.id}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'group', id: groupId }, role: 'reader' },
    });
    expect(direct.json<Grant[]>()).toEqual(
      expect.arrayContaining([inherited, { principal: inherited.principal, role: 'reader' }]),
    );
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/databases/${database.id}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'group', id: groupId } },
    });
    expect(removed.json<Grant[]>()).toContainEqual(inherited);
  });

  it('lets only the organization owner and a folder’s owners grant roles on it', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const adminId = await provision(token);
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['people'] WHERE user_id = $1`,
      [adminId],
    );
    const admin = await signedIn(adminId);
    const groupId = (await call(token, 'POST', 'Groups', group({ members: [{ value: adminId }] }))).json<{
      id: string;
    }>().id;
    // A People administrator can make an empty folder but can't give their own group owner access.
    const folderId = await folder(admin.headers, []);
    const listed = await server.app.inject({ url: '/api/org/folders', headers: admin.headers });
    expect(listed.json()).toEqual([expect.objectContaining({ id: folderId, canGrant: false })]);
    const denied = await grantFolder(admin.headers, folderId, groupId, 'owner');
    expect(denied.statusCode).toBe(403);
    const { rowCount } = await server.pool.query(
      `SELECT 1 FROM ${app}.grants WHERE resource_kind = 'folder' AND resource_id = $1`,
      [folderId],
    );
    expect(rowCount).toBe(0);
    expect((await grantFolder(server.owner.headers, folderId, groupId, 'owner')).statusCode).toBe(200);
    // Owner access through the folder lets them change its roles, down to giving that access up.
    expect((await grantFolder(admin.headers, folderId, groupId, 'editor')).statusCode).toBe(200);
    expect((await grantFolder(admin.headers, folderId, groupId, 'owner')).statusCode).toBe(403);
  });
});

describe('SCIM protocol compatibility', () => {
  it('accepts the string booleans Entra sends, in any case', async () => {
    const { token } = await setup();
    const id = await provision(token, {
      active: 'True',
      emails: [{ value: 'bjensen@example.test', type: 'work', primary: 'true' }],
    });
    expect((await call(token, 'GET', `Users/${id}`)).json()).toMatchObject({
      active: true,
      emails: [{ primary: true }],
    });
    const off = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'Replace', path: 'active', value: 'False' }]),
    );
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ active: false });
    const { app } = authDatabase(server.ctx);
    expect(
      (await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [id])).rows[0]
        .deactivated_at,
    ).toBeTruthy();
    const on = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'Replace', value: { active: 'TRUE' } }]),
    );
    expect(on.json()).toMatchObject({ active: true });
    const filtered = await call(token, 'GET', `Users?filter=${encodeURIComponent('active eq "true"')}`);
    expect(filtered.json()).toMatchObject({ totalResults: 1 });
    const invalid = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'x@example.test', active: 'sometimes' }),
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('ignores read-only attributes in a path-less replace, as in Okta’s group rename', async () => {
    const { token } = await setup();
    const groupId = (await call(token, 'POST', 'Groups', group({ displayName: 'Test SCIMv2' }))).json<{
      id: string;
    }>().id;
    const renamed = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: 'replace', value: { id: groupId, displayName: 'Test SCIMv2 renamed' } }]),
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: groupId, displayName: 'Test SCIMv2 renamed' });
    const id = await provision(token);
    const replaced = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([
        {
          op: 'replace',
          value: {
            id: 'someone-else',
            schemas: [USER_SCHEMA],
            meta: { resourceType: 'User' },
            displayName: 'Barbara J',
          },
        },
      ]),
    );
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json()).toMatchObject({ id, displayName: 'Barbara J', meta: { resourceType: 'User' } });
  });

  it('ignores attributes Riosoma doesn’t store, as POST and PUT do', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const changed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([
        { op: 'replace', value: { displayName: 'Barbara J', title: 'Lead', 'name.middleName': 'J' } },
        { op: 'replace', path: 'phoneNumbers[type eq "mobile"].value', value: '555-0100' },
        { op: 'replace', path: 'title', value: 'Lead' },
        { op: 'replace', path: 'addresses[type eq "work"].formatted', value: '1 Main Street' },
        { op: 'Add', path: 'nickName', value: 'Babs' },
        { op: 'replace', path: 'preferredLanguage', value: 'en-US' },
        { op: 'replace', path: 'name.middleName', value: 'J' },
        { op: 'replace', path: `${ENTERPRISE_SCHEMA}:costCenter`, value: '4130' },
        { op: 'replace', path: 'emails[type eq "work"].nickname', value: 'x' },
        { op: 'replace', path: 'password', value: ['pass', 'word'].join('') },
      ]),
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ displayName: 'Barbara J', name: { givenName: 'Barbara' } });
    for (const key of ['title', 'phoneNumbers', 'addresses', 'nickName', 'preferredLanguage', 'password'])
      expect(changed.json()).not.toHaveProperty(key);
    // A path that doesn't parse still fails the whole request.
    const malformed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([
        { op: 'replace', path: 'displayName', value: 'Rolled back' },
        { op: 'replace', path: 'emails[type eq "work"', value: 'x' },
      ]),
    );
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ scimType: 'invalidPath' });
    expect((await call(token, 'GET', `Users/${id}`)).json()).toMatchObject({ displayName: 'Barbara J' });
  });

  it('reports noTarget only for a replace that matches nothing', async () => {
    const { token } = await setup();
    const groupId = (await call(token, 'POST', 'Groups', group())).json<{ id: string }>().id;
    const absent = await call(
      token,
      'PATCH',
      `Groups/${groupId}`,
      patch([{ op: 'remove', path: 'members[value eq "absent"]' }]),
    );
    expect(absent.statusCode, absent.body).toBe(200);
    const id = await provision(token, { userName: 'megan@example.test', externalId: 'megan', emails: [] });
    const added = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'Add', path: 'emails[type eq "work"].value', value: 'megan.bowen@example.test' }]),
    );
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ emails: [{ type: 'work', value: 'megan.bowen@example.test' }] });
    expect(await emailOf(id)).toBe('megan.bowen@example.test');
    const removed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'remove', path: 'emails[type eq "home"]' }]),
    );
    expect(removed.statusCode).toBe(200);
    const replaced = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'emails[type eq "home"].value', value: 'home@example.test' }]),
    );
    expect(replaced.statusCode).toBe(400);
    expect(replaced.json()).toMatchObject({ scimType: 'noTarget' });
  });

  it('filters by value paths, as Entra matches people by work email', async () => {
    const { token } = await setup();
    const id = await provision(token);
    expect((await call(token, 'POST', 'Groups', group({ members: [{ value: id }] }))).statusCode).toBe(201);
    const count = async (kind: string, filter: string) => {
      const response = await call(token, 'GET', `${kind}?filter=${encodeURIComponent(filter)}`);
      expect(response.statusCode, `${filter} ${response.body}`).toBe(200);
      return response.json<{ totalResults: number }>().totalResults;
    };
    expect(await count('Users', 'emails[type eq "work"].value eq "bjensen@example.test"')).toBe(1);
    expect(await count('Users', 'emails[type eq "work"].value sw "BJEN"')).toBe(1);
    expect(await count('Users', 'emails[type eq "work" and value co "jensen"]')).toBe(1);
    expect(await count('Users', 'emails[primary eq true] and userName pr')).toBe(1);
    expect(await count('Users', 'emails[type eq "home"].value eq "bjensen@example.test"')).toBe(0);
    expect(await count('Groups', `members[value eq "${id}"]`)).toBe(1);
    expect(await count('Groups', `members[value eq "${id.toUpperCase()}"]`)).toBe(0);
    for (const filter of [
      'emails[type eq "work"',
      'emails[type eq "work"].value',
      'emails[type eq "work"].unknown eq "x"',
      'displayName[type eq "work"]',
    ]) {
      const response = await call(token, 'GET', `Users?filter=${encodeURIComponent(filter)}`);
      expect(response.statusCode, filter).toBe(400);
      expect(response.json()).toMatchObject({ scimType: 'invalidFilter' });
    }
  });

  it('honors attributes and excludedAttributes', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const groupId = (await call(token, 'POST', 'Groups', group({ members: [{ value: id }] }))).json<{
      id: string;
    }>().id;
    const single = await call(token, 'GET', `Groups/${groupId}?excludedAttributes=members`);
    expect(single.json()).toMatchObject({ id: groupId, displayName: 'Operators' });
    expect(single.json()).not.toHaveProperty('members');
    const listed = await call(token, 'GET', 'Groups?excludedAttributes=members');
    expect(listed.json<{ Resources: object[] }>().Resources[0]).not.toHaveProperty('members');
    const changed = await call(
      token,
      'PATCH',
      `Groups/${groupId}?excludedAttributes=members`,
      patch([{ op: 'replace', path: 'displayName', value: 'Renamed' }]),
    );
    expect(changed.json()).toMatchObject({ displayName: 'Renamed' });
    expect(changed.json()).not.toHaveProperty('members');
    const picked = await call(token, 'GET', `Users/${id}?attributes=userName`);
    expect(Object.keys(picked.json()).sort()).toEqual(['id', 'schemas', 'userName']);
    const nested = await call(token, 'GET', `Users?attributes=name.givenName,emails.value`);
    expect(nested.json<{ Resources: object[] }>().Resources[0]).toEqual({
      schemas: expect.any(Array),
      id,
      name: { givenName: 'Barbara' },
      emails: [{ value: 'bjensen@example.test' }],
    });
    const trimmed = await call(token, 'GET', `Users/${id}?excludedAttributes=emails,name.familyName,id`);
    expect(trimmed.json()).toMatchObject({ id, name: { givenName: 'Barbara' } });
    expect(trimmed.json()).not.toHaveProperty('emails');
    expect(trimmed.json()).not.toHaveProperty('name.familyName');
  });

  it('keeps a suspended person suspended when a PUT leaves active out', async () => {
    const { token } = await setup();
    const id = await provision(token);
    await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'replace', value: { active: false } }]));
    const replaced = await call(token, 'PUT', `Users/${id}`, {
      schemas: [USER_SCHEMA],
      userName: 'bjensen@example.test',
      name: { givenName: 'Another', familyName: 'User' },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json()).toMatchObject({ active: false });
    const { app } = authDatabase(server.ctx);
    expect(
      (await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [id])).rows[0]
        .deactivated_at,
    ).toBeTruthy();
    const restored = await call(token, 'PUT', `Users/${id}`, user({ active: true }));
    expect(restored.json()).toMatchObject({ active: true });
  });

  it('reads active null, or active removed, as leaving a person as they are', async () => {
    const { token } = await setup();
    const id = await provision(token, {
      userName: 'test.user@example.test',
      externalId: 'test-user',
      emails: [],
    });
    const { app } = authDatabase(server.ctx);
    const suspended = async () =>
      (await server.pool.query(`SELECT deactivated_at FROM ${app}.users WHERE id = $1`, [id])).rows[0]
        .deactivated_at !== null;
    for (const [method, body] of [
      ['PUT', { schemas: [USER_SCHEMA], userName: 'test.user@example.test', active: null }],
      ['PUT', { schemas: [USER_SCHEMA], userName: 'test.user@example.test', Active: null }],
      ['PATCH', patch([{ op: 'remove', path: 'active' }])],
      ['PATCH', patch([{ op: 'replace', path: 'active', value: null }])],
      ['PATCH', patch([{ op: 'replace', value: { active: null } }])],
    ] as const) {
      expect((await call(token, 'PATCH', `Users/${id}`, deactivate)).statusCode).toBe(200);
      const response = await call(token, method, `Users/${id}`, body);
      expect(response.statusCode, `${method} ${JSON.stringify(body)} ${response.body}`).toBe(200);
      expect(response.json(), JSON.stringify(body)).toMatchObject({ active: false });
      expect(await suspended(), JSON.stringify(body)).toBe(true);
    }
    // And an active person stays active.
    expect((await call(token, 'PATCH', `Users/${id}`, reactivate)).statusCode).toBe(200);
    expect(
      (await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'remove', path: 'active' }]))).json(),
    ).toMatchObject({
      active: true,
    });
    expect(await suspended()).toBe(false);
  });

  it('accepts a manager sent as a bare ID, as Microsoft’s SCIM guide shows it', async () => {
    const { token } = await setup();
    const manager = await provision(token, {
      userName: 'manager@example.test',
      externalId: 'manager',
      emails: [],
    });
    const created = await call(
      token,
      'POST',
      'Users',
      user({
        schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
        [ENTERPRISE_SCHEMA]: { department: 'Ops', manager },
      }),
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      [ENTERPRISE_SCHEMA]: { department: 'Ops', manager: { value: manager } },
    });
    const id = created.json<{ id: string }>().id;
    const other = await provision(token, {
      userName: 'other.manager@example.test',
      externalId: 'other',
      emails: [],
    });
    const changed = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'Add', path: `${ENTERPRISE_SCHEMA}:manager`, value: other }]),
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      [ENTERPRISE_SCHEMA]: { department: 'Ops', manager: { value: other } },
    });
    const cleared = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'Replace', path: `${ENTERPRISE_SCHEMA}:manager`, value: '' }]),
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()[ENTERPRISE_SCHEMA]).toEqual({ department: 'Ops' });
  });

  it('leaves the sub-attributes a complex replace doesn’t name unchanged (RFC 7644 section 3.5.2.3)', async () => {
    const { token } = await setup();
    const id = await provision(token, {
      userName: 'rita@example.test',
      externalId: 'rita',
      displayName: undefined,
      name: { givenName: 'Rita', familyName: 'Field', formatted: 'Rita Field' },
      emails: [],
      schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
      [ENTERPRISE_SCHEMA]: { department: 'Ops', employeeNumber: '7' },
    });
    const named = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'name', value: { givenName: 'Rae' } }]),
    );
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().name).toEqual({ givenName: 'Rae', familyName: 'Field', formatted: 'Rita Field' });
    const pathless = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', value: { name: { FamilyName: 'Fields' } } }]),
    );
    expect(pathless.json().name).toEqual({ givenName: 'Rae', familyName: 'Fields', formatted: 'Rita Field' });
    const extension = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', value: { [ENTERPRISE_SCHEMA]: { department: 'Sales' } } }]),
    );
    expect(extension.json()[ENTERPRISE_SCHEMA]).toEqual({ department: 'Sales', employeeNumber: '7' });
    const { app } = authDatabase(server.ctx);
    expect((await server.pool.query(`SELECT name FROM ${app}.users WHERE id = $1`, [id])).rows[0].name).toBe(
      'Rita Field',
    );
    // A multi-valued attribute without a filter is still replaced whole.
    const emails = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: 'emails', value: [{ value: 'rae@example.test', type: 'work' }] }]),
    );
    expect(emails.json().emails).toEqual([{ value: 'rae@example.test', type: 'work' }]);
  });

  it('matches a group member’s type without regard to case', async () => {
    const { token } = await setup();
    const id = await provision(token);
    for (const [index, type] of ['user', 'USER', 'User'].entries()) {
      const created = await call(
        token,
        'POST',
        'Groups',
        group({ displayName: `Typed ${index}`, members: [{ value: id, type }] }),
      );
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({ members: [{ value: id, type: 'User' }] });
    }
    const refused = await call(
      token,
      'POST',
      'Groups',
      group({ displayName: 'Nested', members: [{ value: id, type: 'Group' }] }),
    );
    expect(refused.statusCode).toBe(400);
  });

  it('refuses NUL characters and lone surrogates with 400', async () => {
    const { token } = await setup();
    const nul = String.fromCharCode(0);
    const lone = String.fromCharCode(0xd800);
    const id = await provision(token);
    const requests = [
      call(token, 'GET', `Users?filter=${encodeURIComponent('userName eq "\\u0000"')}`),
      call(token, 'GET', `Users?filter=${encodeURIComponent(`userName eq "a${nul}"`)}`),
      call(token, 'GET', `Users?filter=${encodeURIComponent('userName eq "\\ud800"')}`),
      call(token, 'GET', 'Users/%00'),
      call(token, 'GET', `Groups/${encodeURIComponent(`a${nul}`)}`),
      call(
        token,
        'POST',
        'Users',
        user({ userName: 'nul@example.test', externalId: `a${nul}b`, emails: [] }),
      ),
      call(
        token,
        'POST',
        'Users',
        user({ userName: 'lone@example.test', displayName: `a${lone}b`, emails: [] }),
      ),
      call(token, 'POST', 'Users', user({ userName: 'key@example.test', emails: [], [`x${nul}`]: 'y' })),
      call(token, 'POST', 'Groups', group({ displayName: `g${nul}` })),
      call(token, 'PATCH', `Users/${id}`, patch([{ op: 'replace', path: 'displayName', value: `a${nul}` }])),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ status: '400' });
    }
  });

  it('answers 404 for an empty ResourceTypes or Schemas ID', async () => {
    const { token } = await setup();
    for (const path of ['ResourceTypes/', 'Schemas/']) {
      const response = await call(token, 'GET', path);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ status: '404' });
    }
  });

  it('uses the RFC’s error types for long or repeated filters and a remove without a path', async () => {
    const { token } = await setup();
    const id = await provision(token);
    for (const query of [
      `filter=${encodeURIComponent(`userName eq "${'a'.repeat(4090)}"`)}`,
      'filter=userName%20pr&filter=userName%20pr',
    ]) {
      const response = await call(token, 'GET', `Users?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ scimType: 'invalidFilter' });
    }
    const remove = await call(token, 'PATCH', `Users/${id}`, patch([{ op: 'remove' }]));
    expect(remove.statusCode).toBe(400);
    expect(remove.json()).toMatchObject({ scimType: 'noTarget' });
  });
});

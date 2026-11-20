import { ident, query, sql } from '@riosoma/db';
import { organizationChannel } from '../../data/notify.js';
import { describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type Member,
  type PublicFormLink,
  type ScimAdministration,
  type ScimToken,
  type SharedViewLink,
} from '@riosoma/contracts';
import { issueTicket } from '../../data/public-forms.js';
import { authDatabase } from '../database.js';
import { ENTERPRISE_SCHEMA, USER_SCHEMA } from './patch.js';
import {
  call,
  createDatabase,
  group,
  patch,
  provision,
  server,
  setup,
  signedIn,
  user,
  useScimServer,
} from './scim.test-helpers.js';

/**
 * What happens around a provisioned person's account over its life: who a deleted account is
 * restored for, which members a directory takes over, and what outlives a person when they're
 * suspended or removed: their tokens, their databases, and their public links and forms.
 */
useScimServer();

const deactivate = patch([{ op: 'replace', path: 'active', value: false }]);
const reactivate = patch([{ op: 'replace', path: 'active', value: true }]);

async function deleteMeansRemove() {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/scim',
    headers: server.owner.headers,
    payload: { dryRun: false, deleteAction: 'remove' },
  });
  expect(response.statusCode).toBe(200);
}

async function person(userId: string) {
  const { app } = authDatabase(server.ctx);
  const result = await server.pool.query<{ email: string; name: string; deactivated: boolean }>(
    `SELECT email, name, deactivated_at IS NOT NULL AS deactivated FROM ${app}.users WHERE id = $1`,
    [userId],
  );
  return result.rows[0];
}

async function events(action: string) {
  const { audit } = authDatabase(server.ctx);
  const result = await server.pool.query<{
    actor_id: string | null;
    target: string;
    metadata: Record<string, unknown>;
  }>(`SELECT actor_id, target, metadata FROM ${audit}.events WHERE action = $1 ORDER BY id`, [action]);
  return result.rows;
}

function share(databaseId: string, headers: Record<string, string>, principal: object, role: string) {
  return server.app.inject({
    method: 'PUT',
    url: `/api/databases/${databaseId}/grants`,
    headers,
    payload: { principal, role },
  });
}

async function run(databaseId: string, headers: Record<string, string>, command: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...command }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
}

describe('SCIM reprovisioning', () => {
  it('never hands a deleted person’s account to another directory record that reuses their login name', async () => {
    const { token } = await setup();
    const jane = await provision(token, {
      userName: 'jsmith@example.test',
      externalId: 'objectid-old',
      displayName: 'Jane Smith',
      emails: [],
    });
    const database = await createDatabase((await signedIn(jane)).headers);
    expect((await call(token, 'DELETE', `Users/${jane}`)).statusCode).toBe(204);

    const john = user({
      userName: 'jsmith@example.test',
      externalId: 'objectid-new',
      displayName: 'John Smith',
      emails: [{ value: 'john.smith@example.test', primary: true }],
    });
    const refused = await call(token, 'POST', 'Users', john);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      scimType: 'uniqueness',
      detail: expect.stringContaining('deactivated'),
    });
    expect(await person(jane)).toMatchObject({ email: 'jsmith@example.test', deactivated: true });
    const { app } = authDatabase(server.ctx);
    const owners = await server.pool.query(
      `SELECT principal_id FROM ${app}.grants WHERE resource_id = $1 AND role = 'owner'`,
      [database.id],
    );
    expect(owners.rows).toEqual([{ principal_id: jane }]);

    // The same directory record restores the same person.
    const restored = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'jsmith@example.test', externalId: 'objectid-old', emails: [] }),
    );
    expect(restored.statusCode, restored.body).toBe(201);
    expect(restored.json()).toMatchObject({ id: jane, active: true });
  });

  it('restores by address only when neither record has an external ID', async () => {
    const { token } = await setup();
    const plain = await provision(token, {
      userName: 'plain@example.test',
      externalId: undefined,
      emails: [],
    });
    expect((await call(token, 'DELETE', `Users/${plain}`)).statusCode).toBe(204);
    const again = await call(
      token,
      'POST',
      'Users',
      user({ userName: 'Plain@example.test', externalId: undefined, emails: [] }),
    );
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ id: plain });

    // A record with an ID of its own is a different identity, even at the same address.
    expect((await call(token, 'DELETE', `Users/${plain}`)).statusCode).toBe(204);
    const other = await call(
      token,
      'POST',
      'Users',
      user({
        userName: 'someone.else',
        externalId: 'new-record',
        emails: [{ value: 'plain@example.test', primary: true }],
      }),
    );
    expect(other.statusCode, other.body).toBe(409);
    expect(await person(plain)).toMatchObject({ deactivated: true });
  });
});

describe('Removing a deactivated account in People settings', () => {
  const remove = (userId: string, headers: Record<string, string>) =>
    server.app.inject({ method: 'DELETE', url: `/api/org/members/${userId}`, headers });

  it('removes it as a directory removal would and frees its login name for a new identity', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const jane = await provision(token, {
      userName: 'jsmith@example.test',
      externalId: 'objectid-old',
      displayName: 'Jane Smith',
      emails: [],
    });
    const database = await createDatabase((await signedIn(jane)).headers);
    const groupId = (await call(token, 'POST', 'Groups', group({ members: [{ value: jane }] }))).json<{
      id: string;
    }>().id;
    expect((await call(token, 'DELETE', `Users/${jane}`)).statusCode).toBe(204);
    const john = user({
      userName: 'jsmith@example.test',
      externalId: 'objectid-new',
      displayName: 'John Smith',
      emails: [{ value: 'john.smith@example.test', primary: true }],
    });
    const blocked = await call(token, 'POST', 'Users', john);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ detail: expect.stringContaining('Remove account') });

    const adminId = await provision(token, {
      userName: 'people.admin@example.test',
      externalId: 'people-admin',
      emails: [],
    });
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['people'] WHERE user_id = $1`,
      [adminId],
    );
    const admin = await signedIn(adminId);
    const removed = await remove(jane, admin.headers);
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await person(jane)).toBeUndefined();
    // Her database went to the organization's owner first, and she left her group.
    const owners = await server.pool.query(
      `SELECT principal_id FROM ${app}.grants WHERE resource_id = $1 AND role = 'owner'`,
      [database.id],
    );
    expect(owners.rows).toEqual([{ principal_id: server.owner.userId }]);
    expect((await call(token, 'GET', `Groups/${groupId}`)).json()).toMatchObject({ members: [] });
    expect(await events('people.account.removed')).toEqual([
      {
        actor_id: adminId,
        target: jane,
        metadata: { userId: jane, userName: 'jsmith@example.test', externalId: 'objectid-old' },
      },
    ]);
    expect(await events('scim.database.ownerChanged')).toEqual([
      expect.objectContaining({ actor_id: adminId, target: database.id }),
    ]);

    const created = await call(token, 'POST', 'Users', john);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<{ id: string }>().id).not.toBe(jane);
    const listed = await server.app.inject({
      url: '/api/databases',
      headers: (await signedIn(created.json<{ id: string }>().id)).headers,
    });
    expect(listed.json()).toEqual([]);
  });

  it('refuses active people, the owner, unmanaged members, shared accounts, and people without the role', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const active = await provision(token);
    const plain = await server.addMember({ name: 'Plain Member' });
    const shared = await provision(token, {
      userName: 'shared@example.test',
      externalId: 'shared',
      emails: [],
    });
    await call(token, 'PATCH', `Users/${shared}`, deactivate);
    const elsewhere = newId('org');
    await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, 'Elsewhere')`, [elsewhere]);
    await server.pool.query(`INSERT INTO ${app}.memberships (org_id, user_id) VALUES ($1, $2)`, [
      elsewhere,
      shared,
    ]);
    const suspended = await provision(token, {
      userName: 'suspended@example.test',
      externalId: 'suspended',
      emails: [],
    });
    await call(token, 'PATCH', `Users/${suspended}`, deactivate);
    for (const [userId, status, messageKey] of [
      [active, 409, 'people.remove.active'],
      [server.owner.userId, 409, 'people.guard.lastOwner'],
      [plain.userId, 409, 'people.remove.notManaged'],
      [shared, 403, 'people.remove.shared'],
      [newId('user'), 404, 'errors.notFound'],
    ] as const) {
      const response = await remove(userId, server.owner.headers);
      expect(response.statusCode, `${messageKey} ${response.body}`).toBe(status);
      expect(response.json()).toMatchObject({ error: { messageKey } });
    }
    // Only the owner and People administrators may remove anyone.
    expect((await remove(suspended, plain.headers)).statusCode).toBe(403);
    expect(await person(suspended)).toMatchObject({ deactivated: true });
    expect(await person(active)).toMatchObject({ deactivated: false });
    expect(await events('people.account.removed')).toEqual([]);
    expect((await remove(suspended, server.owner.headers)).statusCode).toBe(204);
    expect(await person(suspended)).toBeUndefined();
  });
});

describe('SCIM tokens and their creators', () => {
  async function securityAdmin(token: string, userName: string) {
    const { app } = authDatabase(server.ctx);
    const id = await provision(token, { userName, externalId: userName, emails: [] });
    await server.pool.query(
      `UPDATE ${app}.memberships SET admin_roles = ARRAY['security'] WHERE user_id = $1`,
      [id],
    );
    const admin = await signedIn(id);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/admin/scim/tokens',
      headers: admin.headers,
      payload: { name: `Side token for ${userName}` },
    });
    expect(created.statusCode, created.body).toBe(200);
    return { id, side: created.json<ScimToken & { token: string }>() };
  }

  it('revokes the provisioning tokens a person made when they’re suspended or removed', async () => {
    const { token, id: tokenId } = await setup();
    const suspended = await securityAdmin(token, 'sec.admin@example.test');
    expect((await call(suspended.side.token, 'GET', 'Users')).statusCode).toBe(200);
    expect((await call(token, 'PATCH', `Users/${suspended.id}`, deactivate)).statusCode).toBe(200);
    expect((await call(suspended.side.token, 'GET', 'Users')).statusCode).toBe(401);
    // Reactivation doesn't bring a token back, so it can't reactivate its maker either.
    expect((await call(token, 'PATCH', `Users/${suspended.id}`, reactivate)).statusCode).toBe(200);
    expect((await call(suspended.side.token, 'PATCH', `Users/${suspended.id}`, reactivate)).statusCode).toBe(
      401,
    );

    const removed = await securityAdmin(token, 'second.admin@example.test');
    await deleteMeansRemove();
    expect((await call(token, 'DELETE', `Users/${removed.id}`)).statusCode).toBe(204);
    expect((await call(removed.side.token, 'GET', 'Users')).statusCode).toBe(401);

    const revocations = await events('scim.token.revoked');
    expect(revocations).toEqual([
      {
        actor_id: null,
        target: suspended.side.id,
        metadata: expect.objectContaining({
          actorKind: 'scim_token',
          tokenId,
          revokedTokenId: suspended.side.id,
          creatorId: suspended.id,
          reason: 'creatorSuspended',
        }),
      },
      {
        actor_id: null,
        target: removed.side.id,
        metadata: expect.objectContaining({ revokedTokenId: removed.side.id, reason: 'creatorRemoved' }),
      },
    ]);

    // The token list names each token's creator, while their account exists.
    const listed = await server.app.inject({ url: '/api/admin/scim', headers: server.owner.headers });
    const tokens = listed.json<ScimAdministration>().tokens;
    expect(tokens.find((item) => item.id === tokenId)?.createdBy).toEqual({
      id: server.owner.userId,
      name: 'Owner',
    });
    expect(tokens.find((item) => item.id === suspended.side.id)).toMatchObject({
      createdBy: { id: suspended.id, name: 'Barbara Jensen' },
      revokedAt: expect.any(String),
    });
    expect(tokens.find((item) => item.id === removed.side.id)).toMatchObject({
      createdBy: null,
      revokedAt: expect.any(String),
    });
  });
});

describe('SCIM removal', () => {
  it('gives each database the removed person alone owned to the organization’s owner', async () => {
    const { token, id: tokenId } = await setup();
    const id = await provision(token);
    const leaving = await signedIn(id);
    const colleague = await server.addMember({ name: 'Colleague' });
    const alone = await createDatabase(leaving.headers);
    const shared = await createDatabase(leaving.headers);
    expect((await share(alone.id, leaving.headers, { kind: 'org' }, 'editor')).statusCode).toBe(200);
    expect(
      (await share(shared.id, leaving.headers, { kind: 'user', id: colleague.userId }, 'owner')).statusCode,
    ).toBe(200);
    await deleteMeansRemove();
    expect((await call(token, 'DELETE', `Users/${id}`)).statusCode).toBe(204);

    const listed = await server.app.inject({ url: '/api/databases', headers: server.owner.headers });
    expect(listed.json()).toContainEqual(expect.objectContaining({ id: alone.id, role: 'owner' }));
    expect((await share(alone.id, server.owner.headers, { kind: 'org' }, 'reader')).statusCode).toBe(200);
    // A database someone else still owns stays theirs.
    const { app } = authDatabase(server.ctx);
    const owners = await server.pool.query(
      `SELECT principal_id FROM ${app}.grants WHERE resource_id = $1 AND role = 'owner'`,
      [shared.id],
    );
    expect(owners.rows).toEqual([{ principal_id: colleague.userId }]);
    expect(await events('scim.database.ownerChanged')).toEqual([
      {
        actor_id: null,
        target: alone.id,
        metadata: expect.objectContaining({
          actorKind: 'scim_token',
          tokenId,
          databaseId: alone.id,
          previousOwnerId: id,
          ownerId: server.owner.userId,
        }),
      },
    ]);
  });
});

describe('SCIM adoption of existing members', () => {
  it('manages a member who joined outside provisioning when the directory creates them', async () => {
    const { token } = await setup();
    const member = await server.addMember({ name: 'Invited Member' });
    const other = await server.addMember({ name: 'Still Outside' });
    const unmanaged = async () =>
      (await server.app.inject({ url: '/api/admin/scim', headers: server.owner.headers }))
        .json<ScimAdministration>()
        .unmanaged.map((entry) => entry.id);
    expect(await unmanaged()).toEqual([member.userId, other.userId]);

    const created = await call(
      token,
      'POST',
      'Users',
      user({
        userName: member.email.toUpperCase(),
        externalId: 'directory-member',
        displayName: 'Directory Name',
        emails: [],
      }),
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ id: member.userId, active: true });
    expect(await person(member.userId)).toMatchObject({ email: member.email, name: 'Directory Name' });
    expect(await unmanaged()).toEqual([other.userId]);
    expect(await events('scim.users.adopted')).toEqual([
      {
        actor_id: null,
        target: member.userId,
        metadata: expect.objectContaining({ actorKind: 'scim_token', dryRun: false }),
      },
    ]);
    // From now on the directory's deactivation reaches them.
    expect((await call(token, 'PATCH', `Users/${member.userId}`, deactivate)).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/api/databases', headers: member.headers })).statusCode).toBe(
      401,
    );
  });

  it('never adopts the owner, a guest, or someone another organization shares', async () => {
    const { token } = await setup();
    const { app } = authDatabase(server.ctx);
    const guest = await server.addMember({ kind: 'guest' });
    const shared = await server.addMember();
    const elsewhere = newId('org');
    await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, 'Elsewhere')`, [elsewhere]);
    await server.pool.query(`INSERT INTO ${app}.memberships (org_id, user_id) VALUES ($1, $2)`, [
      elsewhere,
      shared.userId,
    ]);
    for (const [address, status] of [
      [server.owner.email, 409],
      [guest.email, 409],
      [shared.email, 409],
    ] as const) {
      const response = await call(
        token,
        'POST',
        'Users',
        user({ userName: address, externalId: address, emails: [] }),
      );
      expect(response.statusCode, `${address} ${response.body}`).toBe(status);
    }
    const managed = await server.pool.query(`SELECT user_id FROM ${app}.scim_users`);
    expect(managed.rowCount).toBe(0);
  });
});

describe('SCIM suspension and what a person shared', () => {
  it('pauses a suspended person’s public forms, stops them on removal, and lets another sharer bring one back', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const sharer = await signedIn(id);
    const fieldId = newId('field');
    const database = { id: newId('database'), tableId: newId('table') };
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: sharer.headers,
      payload: {
        id: database.id,
        name: 'Team feedback',
        table: {
          id: database.tableId,
          name: 'Answers',
          fields: [{ id: fieldId, name: 'Comment', type: 'text' }],
          view: { id: newId('view'), name: 'All answers' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    // The organization's owner shares the database, so the forms are a team's.
    expect(
      (await share(database.id, sharer.headers, { kind: 'user', id: server.owner.userId }, 'owner'))
        .statusCode,
    ).toBe(200);
    const formView = newId('view');
    await run(database.id, sharer.headers, {
      kind: 'view.create',
      view: {
        id: formView,
        name: 'Feedback',
        tableId: database.tableId,
        type: 'form',
        config: { form: { title: 'Feedback', questions: [{ fieldId }] } },
      },
    });
    const secondView = newId('view');
    await run(database.id, sharer.headers, {
      kind: 'view.create',
      view: {
        id: secondView,
        name: 'Second',
        tableId: database.tableId,
        type: 'form',
        config: { form: { title: 'Second', questions: [{ fieldId }] } },
      },
    });
    const publish = async (viewId: string, headers: Record<string, string>) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/views/${viewId}/public-form`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PublicFormLink>();
    };
    const first = await publish(formView, sharer.headers);
    const second = await publish(secondView, sharer.headers);
    let address = 0;
    const statuses = async (formId: string) => [
      (await server.app.inject({ url: `/api/public/forms/${formId}` })).statusCode,
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/public/forms/${formId}/submissions`,
          payload: {
            ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3_000),
            values: { [fieldId]: 'Hello' },
          },
          remoteAddress: `203.0.113.${(address += 1)}`,
        })
      ).statusCode,
    ];
    expect(await statuses(first.formId)).toEqual([200, 200]);
    await call(token, 'PATCH', `Users/${id}`, deactivate);
    expect(await statuses(first.formId)).toEqual([410, 410]);

    // The owner sees the form paused, naming its sharer, and sharing it again keeps its address.
    const seen = await server.app.inject({
      url: `/api/views/${formView}/public-form`,
      headers: server.owner.headers,
    });
    expect(seen.json<PublicFormLink>()).toMatchObject({
      formId: first.formId,
      suspendedSharer: { id, name: 'Barbara Jensen' },
    });
    const again = await publish(formView, server.owner.headers);
    expect(again).toMatchObject({
      formId: first.formId,
      createdBy: server.owner.userId,
      suspendedSharer: null,
    });
    expect(await statuses(first.formId)).toEqual([200, 200]);

    await call(token, 'PATCH', `Users/${id}`, reactivate);
    expect(await statuses(second.formId)).toEqual([200, 200]);
    await deleteMeansRemove();
    expect((await call(token, 'DELETE', `Users/${id}`)).statusCode).toBe(204);
    expect(await statuses(second.formId)).toEqual([404, 404]);
    expect(await statuses(first.formId)).toEqual([200, 200]);
  });

  it('shows a team view’s link paused, naming its suspended sharer, until someone shares it again', async () => {
    const { token } = await setup();
    const id = await provision(token);
    const sharer = await signedIn(id);
    const database = await createDatabase();
    expect((await share(database.id, server.owner.headers, { kind: 'user', id }, 'creator')).statusCode).toBe(
      200,
    );
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${database.viewId}/shared-view`,
      headers: sharer.headers,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const { linkId } = shared.json<SharedViewLink>();
    const status = async () => (await server.app.inject({ url: `/api/public/views/${linkId}` })).statusCode;
    const settings = (method: 'GET' | 'PUT' | 'PATCH', payload?: object) =>
      server.app.inject({
        method,
        url: `/api/views/${database.viewId}/shared-view`,
        headers: server.owner.headers,
        ...(payload ? { payload } : {}),
      });
    expect(await status()).toBe(200);
    await call(token, 'PATCH', `Users/${id}`, deactivate);
    expect(await status()).toBe(410);
    expect((await settings('GET')).json<SharedViewLink>()).toMatchObject({
      linkId,
      createdBy: id,
      suspendedSharer: { id, name: 'Barbara Jensen' },
    });
    // Changing its settings leaves it paused.  Sharing it again keeps the address and the owner shares it.
    expect((await settings('PATCH', { allowCopy: true })).json<SharedViewLink>()).toMatchObject({
      suspendedSharer: { id },
    });
    expect(await status()).toBe(410);
    const again = await settings('PUT');
    expect(again.json<SharedViewLink>()).toMatchObject({
      linkId,
      createdBy: server.owner.userId,
      suspendedSharer: null,
      settings: { allowCopy: true },
    });
    expect(await status()).toBe(200);
    expect(await events('data.view.shareTakenOver')).toEqual([
      expect.objectContaining({
        actor_id: server.owner.userId,
        metadata: expect.objectContaining({ previousSharerId: id }),
      }),
    ]);
  });
});

describe('SCIM people elsewhere in Riosoma', () => {
  it('offers scheduled reports to everyone who can open the database, through groups and folders too', async () => {
    const { token } = await setup();
    const database = await createDatabase();
    const inFolder = await createDatabase();
    const direct = await provision(token, {
      userName: 'direct.reader@example.test',
      externalId: 'direct',
      displayName: 'Direct Reader',
      emails: [],
    });
    const grouped = await provision(token, {
      userName: 'group.reader@example.test',
      externalId: 'grouped',
      displayName: 'Group Reader',
      emails: [],
    });
    const foldered = await provision(token, {
      userName: 'folder.reader@example.test',
      externalId: 'foldered',
      displayName: 'Folder Reader',
      emails: [],
    });
    const groupId = (await call(token, 'POST', 'Groups', group({ members: [{ value: grouped }] }))).json<{
      id: string;
    }>().id;
    const folderGroup = (
      await call(
        token,
        'POST',
        'Groups',
        group({ displayName: 'Folder people', members: [{ value: foldered }] }),
      )
    ).json<{ id: string }>().id;
    expect(
      (await share(database.id, server.owner.headers, { kind: 'user', id: direct }, 'reader')).statusCode,
    ).toBe(200);
    expect(
      (await share(database.id, server.owner.headers, { kind: 'group', id: groupId }, 'reader')).statusCode,
    ).toBe(200);
    const folder = await server.app.inject({
      method: 'POST',
      url: '/api/org/folders',
      headers: server.owner.headers,
      payload: { name: 'Reports folder', databases: [database.id, inFolder.id] },
    });
    expect(folder.statusCode, folder.body).toBe(200);
    const folderGrant = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${folder.json<{ id: string }>().id}/grants`,
      headers: server.owner.headers,
      payload: { groupId: folderGroup, role: 'reader' },
    });
    expect(folderGrant.statusCode, folderGrant.body).toBe(200);
    const reports = await server.app.inject({
      url: `/api/views/${database.viewId}/reports`,
      headers: server.owner.headers,
    });
    expect(reports.statusCode, reports.body).toBe(200);
    expect(reports.json<{ members: Array<{ name: string }> }>().members.map((member) => member.name)).toEqual(
      ['Direct Reader', 'Folder Reader', 'Group Reader', 'Owner'],
    );
  });

  it('shows guests only other people’s names and addresses, never their directory records', async () => {
    const { token } = await setup();
    const id = await provision(token, {
      [ENTERPRISE_SCHEMA]: { department: 'Payroll', employeeNumber: 'E-4411' },
    });
    const guest = await server.addMember({ kind: 'guest' });
    const database = await createDatabase();
    for (const principal of [id, guest.userId])
      expect(
        (await share(database.id, server.owner.headers, { kind: 'user', id: principal }, 'reader'))
          .statusCode,
      ).toBe(200);
    const listed = async (headers: Record<string, string>) =>
      (await server.app.inject({ url: '/api/org/members', headers }))
        .json<Member[]>()
        .find((member) => member.id === id);
    const seenByGuest = await listed(guest.headers);
    expect(seenByGuest).toMatchObject({ name: 'Barbara Jensen', email: 'bjensen@example.test' });
    expect(seenByGuest).not.toHaveProperty('profile');
    expect(seenByGuest).not.toHaveProperty('managed');
    expect(JSON.stringify(seenByGuest)).not.toContain('Payroll');
    expect(await listed(server.owner.headers)).toMatchObject({
      managed: 'scim',
      profile: { department: 'Payroll', employeeNumber: 'E-4411' },
    });
  });
});

describe('SCIM attributes Riosoma doesn’t store', () => {
  it('provisions people whatever their directory sends as a cost center, division, or organization', async () => {
    const token = (await setup()).token;
    const cases: Array<Record<string, unknown>> = [
      { costCenter: 4410 },
      { division: null },
      { organization: { name: 'Acme' } },
      { costCenter: 'c'.repeat(1500) },
    ];
    for (const [index, enterprise] of cases.entries()) {
      const address = `enterprise${index}@example.test`;
      const created = await call(
        token,
        'POST',
        'Users',
        user({
          schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
          userName: address,
          externalId: `enterprise-${index}`,
          emails: [{ value: address, primary: true, type: 'work' }],
          [ENTERPRISE_SCHEMA]: { department: 'Research', ...enterprise },
        }),
      );
      expect(created.statusCode, JSON.stringify(enterprise)).toBe(201);
    }
    const id = await provision(token);
    const patched = await call(
      token,
      'PATCH',
      `Users/${id}`,
      patch([{ op: 'replace', path: `${ENTERPRISE_SCHEMA}:costCenter`, value: 4410 }]),
    );
    expect(patched.statusCode, patched.body).toBe(200);
  });

  it('suspends someone the directory turns off, whatever else the change carries', async () => {
    const token = (await setup()).token;
    const active = async (id: string) =>
      (
        await server.pool.query<{ on: boolean }>(
          `SELECT deactivated_at IS NULL AS on FROM "${server.schemas.app}".users WHERE id = $1`,
          [id],
        )
      ).rows[0]!.on;
    // A replacement the directory sends whole, with a value Riosoma can't use
    const replaced = await provision(token);
    const put = await call(
      token,
      'PUT',
      `Users/${replaced}`,
      user({
        schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
        active: false,
        [ENTERPRISE_SCHEMA]: { costCenter: 4410 },
      }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(await active(replaced)).toBe(false);
    // A replacement whose other values can't be applied at all still suspends.
    const refused = await provision(token, {
      userName: 'refused@example.test',
      externalId: 'refused',
      emails: [{ value: 'refused@example.test', primary: true, type: 'work' }],
    });
    const bad = await call(
      token,
      'PUT',
      `Users/${refused}`,
      user({ active: 'False', emails: [{ value: 'not an address', primary: true }] }),
    );
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json<{ active: boolean }>().active).toBe(false);
    expect(await active(refused)).toBe(false);
    // A change, as Entra sends it, alongside an operation that can't be applied
    const changed = await provision(token, {
      userName: 'changed@example.test',
      externalId: 'changed',
      emails: [{ value: 'changed@example.test', primary: true, type: 'work' }],
    });
    const ops = await call(
      token,
      'PATCH',
      `Users/${changed}`,
      patch([
        { op: 'replace', path: 'emails[type eq "work"', value: 'x' },
        { op: 'Replace', path: 'active', value: 'False' },
      ]),
    );
    expect(ops.statusCode, ops.body).toBe(200);
    expect(await active(changed)).toBe(false);
    // Nothing else is refused this way: a change that doesn't turn anyone off still fails.
    const kept = await provision(token, {
      userName: 'kept@example.test',
      externalId: 'kept',
      emails: [{ value: 'kept@example.test', primary: true, type: 'work' }],
    });
    const invalid = await call(
      token,
      'PATCH',
      `Users/${kept}`,
      patch([{ op: 'replace', path: 'emails[type eq "work"', value: 'x' }]),
    );
    expect(invalid.statusCode).toBe(400);
    expect(await active(kept)).toBe(true);
    // A replacement that turns someone off while taking another person's name still suspends them.
    const clash = await provision(token, {
      userName: 'clash@example.test',
      externalId: 'clash',
      emails: [{ value: 'clash@example.test', primary: true, type: 'work' }],
    });
    const taken = await call(
      token,
      'PUT',
      `Users/${clash}`,
      user({
        active: false,
        userName: 'kept@example.test',
        externalId: 'clash',
        emails: [{ value: 'clash@example.test', primary: true, type: 'work' }],
      }),
    );
    expect(taken.statusCode, taken.body).toBe(200);
    expect(await active(clash)).toBe(false);
    expect(await active(kept)).toBe(true);
  });
});

it.each([false, true])(
  'publishes person changes for fallback suspension only outside dry runs %s',
  async (dryRun) => {
    const { token } = await setup();
    const id = await provision(token);
    const session = await signedIn(id);
    const settings = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/scim',
      headers: server.owner.headers,
      payload: { dryRun, deleteAction: 'suspend' },
    });
    expect(settings.statusCode).toBe(200);
    const listener = await server.pool.connect();
    const notices: Array<{ personChanged?: string }> = [];
    const receive = (notice: { payload?: string }) => {
      if (notice.payload) notices.push(JSON.parse(notice.payload));
    };
    listener.on('notification', receive);
    try {
      await query(listener, sql`LISTEN ${ident(organizationChannel(server.schemas))}`);
      const response = await call(
        token,
        'PUT',
        `Users/${id}`,
        user({ active: false, emails: [{ value: 'invalid address', primary: true }] }),
      );
      expect(response.statusCode, response.body).toBe(200);
      await query(listener, sql`SELECT 1`);
      expect(notices.filter((notice) => notice.personChanged === id)).toHaveLength(dryRun ? 0 : 1);
      expect(
        (await server.app.inject({ url: '/api/auth/session', headers: session.headers })).statusCode,
      ).toBe(dryRun ? 200 : 401);
      expect(await person(id)).toMatchObject({ deactivated: !dryRun });
    } finally {
      await query(listener, sql`UNLISTEN ${ident(organizationChannel(server.schemas))}`);
      listener.off('notification', receive);
      listener.release();
    }
  },
);

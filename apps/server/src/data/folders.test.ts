import pg from 'pg';
import { refreshLogins } from '../sql/login.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATABASE_ROLES,
  newId,
  roleAllows,
  type AccessLoss,
  type DatabaseRole,
  type Grant,
  type HomeAction,
  type HomeListing,
  type SqlLogin,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { purgeTrash } from './purge.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'home_folders', { sqlOutsideLogins: true });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const command = (who: SignedIn, action: HomeAction, id = newId('command')) =>
  server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: who.headers,
    payload: { id, action },
  });
async function apply(who: SignedIn, action: HomeAction) {
  const response = await command(who, action);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string }>();
}
async function folder(who: SignedIn, parentId: string | null = null) {
  const folderId = newId('folder');
  await apply(who, { kind: 'folder.create', folderId, parentId, name: 'Projects' });
  return folderId;
}
async function database(who: SignedIn) {
  const id = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const fieldId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: {
      id,
      name: 'Private project',
      table: {
        id: tableId,
        name: 'Tasks',
        view: { id: viewId, name: 'Grid' },
        fields: [{ id: fieldId, name: 'Name', type: 'text', options: {} }],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { id, tableId, viewId, fieldId };
}
async function home(who: SignedIn) {
  const response = await server.app.inject({ url: '/api/home', headers: who.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<HomeListing>();
}
const share = (who: SignedIn, folderId: string, userId: string, role: DatabaseRole | null) =>
  apply(who, { kind: 'folder.share', folderId, principal: { kind: 'user', id: userId }, role });

describe('home folder access matrix', () => {
  it.each(['database', 'folder'] as const)(
    'hides private ancestor metadata in %s grants while retaining inheritance',
    async (kind) => {
      const maker = await server.addMember();
      const reader = await server.addMember();
      const parent = await folder(maker);
      const child = await folder(maker, parent);
      const data = await database(maker);
      await apply(maker, {
        kind: 'database.move',
        databaseId: data.id,
        parentId: child,
        confirmedLosses: [],
      });
      const id = kind === 'database' ? data.id : child;
      if (kind === 'database') {
        const shared = await server.app.inject({
          method: 'PUT',
          url: `/api/databases/${id}/grants`,
          headers: maker.headers,
          payload: { principal: { kind: 'user', id: reader.userId }, role: 'reader' },
        });
        expect(shared.statusCode, shared.body).toBe(200);
      } else await share(maker, child, reader.userId, 'reader');
      const grants = async () => {
        const response = await server.app.inject({
          url: `/api/${kind}s/${id}/grants`,
          headers: reader.headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<Grant[]>();
      };
      const hidden = (await grants()).filter((grant) => grant.inheritedFrom);
      expect(hidden.length).toBeGreaterThan(0);
      for (const grant of hidden) expect(grant.inheritedFrom).toEqual({ kind: 'folder' });
      expect(
        (await server.app.inject({ url: `/api/folders/${parent}/grants`, headers: reader.headers }))
          .statusCode,
      ).toBe(404);
      await share(maker, parent, reader.userId, 'reader');
      expect(await grants()).toContainEqual(
        expect.objectContaining({
          inheritedFrom: { kind: 'folder', id: parent, name: 'Projects' },
        }),
      );
    },
  );

  it.each(DATABASE_ROLES.flatMap((role) => ['direct', 'group', 'inherited'].map((path) => ({ role, path }))))(
    'requires existing ownership for database moves with $path $role access',
    async ({ role, path }) => {
      const maker = await server.addMember();
      const member = await server.addMember();
      const recipient = await server.addMember();
      const parent = await folder(maker);
      const source = await folder(maker, parent);
      const destination = await folder(member);
      const data = await database(maker);
      await apply(maker, {
        kind: 'database.move',
        databaseId: data.id,
        parentId: source,
        confirmedLosses: [],
      });
      let principal = { kind: 'user' as 'user' | 'group', id: member.userId };
      if (path === 'group') {
        const groupId = newId('group');
        await server.pool.query(
          `INSERT INTO "${server.schemas.app}".groups (id, org_id, name) VALUES ($1, $2, $3)`,
          [groupId, maker.info.org.id, groupId],
        );
        await server.pool.query(
          `INSERT INTO "${server.schemas.app}".group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
          [maker.info.org.id, groupId, member.userId],
        );
        principal = { kind: 'group', id: groupId };
      }
      if (path === 'inherited') await share(maker, parent, member.userId, role);
      else {
        const granted = await server.app.inject({
          method: 'PUT',
          url: `/api/databases/${data.id}/grants`,
          headers: maker.headers,
          payload: { principal, role },
        });
        expect(granted.statusCode, granted.body).toBe(200);
      }
      const shareDatabase = () =>
        server.app.inject({
          method: 'PUT',
          url: `/api/databases/${data.id}/grants`,
          headers: member.headers,
          payload: { principal: { kind: 'user', id: recipient.userId }, role: 'owner' },
        });
      const status = role === 'owner' ? 200 : 403;
      expect((await shareDatabase()).statusCode).toBe(status);
      for (const parentId of [destination, null]) {
        const action: HomeAction = {
          kind: 'database.move',
          databaseId: data.id,
          parentId,
          confirmedLosses: [],
        };
        const preview = await server.app.inject({
          method: 'POST',
          url: '/api/home/move-preview',
          headers: member.headers,
          payload: { id: newId('command'), action },
        });
        expect(preview.statusCode, preview.body).toBe(status);
        if (role === 'owner')
          action.confirmedLosses = preview.json<AccessLoss[]>().map((person) => person.id);
        const moved = await command(member, action);
        expect(moved.statusCode, moved.body).toBe(status);
        if (role === 'owner' && path === 'inherited' && parentId === null) {
          expect((await home(member)).databases.map((item) => item.id)).not.toContain(data.id);
          expect((await shareDatabase()).statusCode).toBe(404);
        } else {
          expect((await home(member)).databases).toContainEqual(
            expect.objectContaining({
              id: data.id,
              role,
              parentId: role === 'owner' ? parentId : source,
            }),
          );
          expect((await shareDatabase()).statusCode).toBe(status);
        }
      }
      if (role !== 'owner') expect((await home(recipient)).databases).toEqual([]);
    },
  );

  it.each(DATABASE_ROLES)(
    'keeps parent authority unchanged when a %s creates, shares, or moves a child',
    async (role) => {
      const maker = await server.addMember();
      const member = await server.addMember();
      const recipient = await server.addMember();
      const parent = await folder(maker);
      const data = await database(maker);
      await apply(maker, {
        kind: 'database.move',
        databaseId: data.id,
        parentId: parent,
        confirmedLosses: [],
      });
      await share(maker, parent, member.userId, role);
      const child = newId('folder');
      const created = await command(member, {
        kind: 'folder.create',
        folderId: child,
        parentId: parent,
        name: 'Drafts',
      });
      expect(created.statusCode, created.body).toBe(roleAllows(role, 'editRecords') ? 200 : 403);
      if (roleAllows(role, 'editRecords')) {
        await share(member, child, recipient.userId, 'owner');
        await apply(member, {
          kind: 'folder.move',
          folderId: child,
          parentId: null,
          confirmedLosses: [`${maker.userId}:${child}`],
        });
      }
      expect((await home(member)).folders).toContainEqual(expect.objectContaining({ id: parent, role }));
      expect((await home(member)).databases).toContainEqual(expect.objectContaining({ id: data.id, role }));
      expect((await home(recipient)).databases).toEqual([]);
      expect((await home(recipient)).folders.map((item) => item.id)).not.toContain(parent);
      const shared = await command(member, {
        kind: 'folder.share',
        folderId: parent,
        principal: { kind: 'user', id: recipient.userId },
        role: 'owner',
      });
      expect(shared.statusCode, shared.body).toBe(role === 'owner' ? 200 : 403);
      const destination = await folder(member);
      const moved = await command(member, {
        kind: 'folder.move',
        folderId: parent,
        parentId: destination,
        confirmedLosses: [],
      });
      expect(moved.statusCode, moved.body).toBe(role === 'owner' ? 200 : 403);
    },
  );

  it.each(DATABASE_ROLES)('checks external sharing before a child inherits guest %s access', async (role) => {
    const maker = await server.addMember();
    const member = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const ancestor = await folder(maker);
    const parent = await folder(maker, ancestor);
    await share(maker, ancestor, member.userId, 'editor');
    await share(maker, ancestor, guest.userId, role);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".orgs SET settings = jsonb_set(settings, '{unitPolicy}', $1) WHERE id = $2`,
      [JSON.stringify({ values: { externalSharing: false } }), maker.info.org.id],
    );
    const child = newId('folder');
    try {
      const created = await command(member, {
        kind: 'folder.create',
        folderId: child,
        parentId: parent,
        name: 'Private drafts',
      });
      expect(created.statusCode, created.body).toBe(403);
      expect(created.json()).toMatchObject({
        error: {
          messageKey: 'orgUnits.policy.denied',
          params: { setting: 'externalSharing' },
        },
      });
      expect((await home(guest)).folders.map((item) => item.id)).not.toContain(child);
      expect((await home(member)).folders.map((item) => item.id)).not.toContain(child);
      await folder(member);
    } finally {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings - 'unitPolicy' WHERE id = $1`,
        [maker.info.org.id],
      );
    }
    await apply(member, { kind: 'folder.create', folderId: child, parentId: parent, name: 'Shared drafts' });
    expect((await home(guest)).folders).toContainEqual(expect.objectContaining({ id: child, role }));
  });

  it.each(['folder.move', 'database.move'] as const)(
    'revokes an existing SQL connection transactionally after %s removes inherited access',
    async (kind) => {
      const maker = server.owner;
      const reader = await server.addMember();
      const parent = await folder(maker);
      const child = await folder(maker, parent);
      const nested = await folder(maker, child);
      const data = await database(maker);
      await apply(maker, {
        kind: 'database.move',
        databaseId: data.id,
        parentId: nested,
        confirmedLosses: [],
      });
      await share(maker, parent, reader.userId, 'reader');
      const inserted = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${data.id}/commands`,
        headers: maker.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.create',
              tableId: data.tableId,
              records: [{ id: newId('record'), values: { [data.fieldId]: 'Confidential project' } }],
            },
          ],
        },
      });
      expect(inserted.json(), inserted.body).toMatchObject({ results: [{ status: 'applied' }] });
      const enabled = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${data.id}/sql/login`,
        headers: maker.headers,
        payload: { action: 'enable', personId: reader.userId },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const login = enabled.json<SqlLogin>();
      expect(login.ready).toBe(true);
      const client = new pg.Client({ ...server.pool.options, user: login.role, password: login.password });
      await client.connect();
      try {
        const select = () => client.query('SELECT "Name" FROM "Tasks"');
        expect((await select()).rows).toEqual([{ Name: 'Confidential project' }]);
        const action: HomeAction =
          kind === 'folder.move'
            ? { kind, folderId: child, parentId: null, confirmedLosses: [] }
            : { kind, databaseId: data.id, parentId: null, confirmedLosses: [] };
        const preview = await server.app.inject({
          method: 'POST',
          url: '/api/home/move-preview',
          headers: maker.headers,
          payload: { id: newId('command'), action },
        });
        expect(preview.statusCode, preview.body).toBe(200);
        expect((await select()).rows).toEqual([{ Name: 'Confidential project' }]);
        expect((await command(maker, action)).statusCode).toBe(409);
        expect((await select()).rows).toEqual([{ Name: 'Confidential project' }]);
        await apply(maker, {
          ...action,
          confirmedLosses: preview.json<AccessLoss[]>().map((person) => person.id),
        });
        expect(
          (await server.app.inject({ url: `/api/databases/${data.id}/schema`, headers: reader.headers }))
            .statusCode,
        ).toBe(404);
        await expect(select()).rejects.toMatchObject({ code: '42P01' });
        await refreshLogins(server.pool, server.schemas);
        await expect(select()).rejects.toMatchObject({ code: '42P01' });
      } finally {
        await client.end();
        await server.app.inject({
          method: 'POST',
          url: `/api/databases/${data.id}/sql/login`,
          headers: maker.headers,
          payload: { action: 'disable' },
        });
      }
    },
  );

  it.each([
    ['database.move', null],
    ['database.move', 'reader'],
    ['database.move', 'editor'],
    ['folder.move', null],
    ['folder.move', 'reader'],
    ['folder.move', 'editor'],
  ] as const)('checks guest access changes for %s with prior role %s', async (kind, prior) => {
    const maker = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const destination = await folder(maker);
    const parent = await folder(maker, destination);
    const source = await folder(maker);
    const nested = await folder(maker, source);
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: nested, confirmedLosses: [] });
    await share(maker, destination, guest.userId, 'editor');
    if (prior) await share(maker, source, guest.userId, prior);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".orgs SET settings = jsonb_set(settings, '{unitPolicy}', $1) WHERE id = $2`,
      [JSON.stringify({ values: { externalSharing: false } }), maker.info.org.id],
    );
    try {
      const action: HomeAction =
        kind === 'folder.move'
          ? { kind, folderId: source, parentId: parent, confirmedLosses: [] }
          : { kind, databaseId: data.id, parentId: parent, confirmedLosses: [] };
      const response = await command(maker, action);
      expect(response.statusCode, response.body).toBe(prior === 'editor' ? 200 : 403);
      if (prior !== 'editor') {
        expect(response.json()).toMatchObject({
          error: { messageKey: 'orgUnits.policy.denied', params: { setting: 'externalSharing' } },
        });
        const listing = await home(maker);
        expect(listing.folders.find((item) => item.id === source)?.parentId).toBeNull();
        expect(listing.databases.find((item) => item.id === data.id)?.parentId).toBe(nested);
      }
      const schema = await server.app.inject({
        url: `/api/databases/${data.id}/schema`,
        headers: guest.headers,
      });
      expect(schema.statusCode).toBe(prior ? 200 : 404);
    } finally {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings - 'unitPolicy' WHERE id = $1`,
        [maker.info.org.id],
      );
    }
  });

  it('lets People administrators file owned databases in organization folders while preserving personal access checks', async () => {
    const admin = await server.addMember();
    await server.pool.query(
      `UPDATE "${server.schemas.app}".memberships SET admin_roles = ARRAY['people'] WHERE user_id = $1`,
      [admin.userId],
    );
    const data = await database(admin);
    const saved = await server.app.inject({
      method: 'POST',
      url: '/api/org/folders',
      headers: admin.headers,
      payload: { name: 'Organization projects', databases: [data.id] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const id = saved.json<{ id: string }>().id;
    const listed = await server.app.inject({ url: '/api/org/folders', headers: admin.headers });
    expect(listed.json()).toContainEqual(
      expect.objectContaining({ id, databases: [data.id], canGrant: false }),
    );
    const updated = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${id}`,
      headers: admin.headers,
      payload: { name: 'Renamed projects', databases: [data.id] },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const privateFolder = await folder(server.owner);
    const privateUpdate = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${privateFolder}`,
      headers: admin.headers,
      payload: { name: 'Private projects', databases: [data.id] },
    });
    expect(privateUpdate.statusCode).toBe(404);
    const other = await database(server.owner);
    const refused = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${id}`,
      headers: admin.headers,
      payload: { name: 'Renamed projects', databases: [data.id, other.id] },
    });
    expect(refused.statusCode).toBe(404);
    expect(
      (
        await command(admin, {
          kind: 'database.move',
          databaseId: data.id,
          parentId: id,
          confirmedLosses: [],
        })
      ).statusCode,
    ).toBe(404);
  });

  it('inherits through nested folders and removes every API and search path after a confirmed move', async () => {
    const maker = await server.addMember();
    const reader = await server.addMember();
    const parent = await folder(maker);
    const child = await folder(maker, parent);
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: child, confirmedLosses: [] });
    await share(maker, parent, reader.userId, 'reader');
    expect((await home(reader)).folders.map((item) => item.id)).toEqual(
      expect.arrayContaining([parent, child]),
    );
    expect((await home(reader)).databases).toContainEqual(
      expect.objectContaining({ id: data.id, role: 'reader', shared: true }),
    );
    const listed = await server.app.inject({ url: '/api/databases', headers: reader.headers });
    expect(listed.json()).toContainEqual(expect.objectContaining({ id: data.id }));
    const action: HomeAction = { kind: 'folder.move', folderId: child, parentId: null, confirmedLosses: [] };
    const preview = await server.app.inject({
      method: 'POST',
      url: '/api/home/move-preview',
      headers: maker.headers,
      payload: { id: newId('command'), action },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const losses = preview.json<AccessLoss[]>();
    expect(losses.map((person) => person.id)).toEqual(
      expect.arrayContaining([`${reader.userId}:${child}`, `${reader.userId}:${data.id}`]),
    );
    expect((await command(maker, action)).statusCode).toBe(409);
    await apply(maker, { ...action, confirmedLosses: losses.map((person) => person.id) });
    expect((await home(reader)).folders.map((item) => item.id)).not.toContain(child);
    expect((await home(reader)).databases).toEqual([]);
    expect((await server.app.inject({ url: '/api/databases', headers: reader.headers })).json()).toEqual([]);
    for (const url of [
      `/api/databases/${data.id}/schema`,
      `/api/views/${data.viewId}/rows`,
      `/api/folders/${child}/grants`,
    ]) {
      expect((await server.app.inject({ url, headers: reader.headers })).statusCode).toBe(404);
    }
    const search = await server.app.inject({
      method: 'POST',
      url: `/api/views/${data.viewId}/search`,
      headers: reader.headers,
      payload: { query: 'Private' },
    });
    expect(search.statusCode).toBe(404);
  });

  it('uses the strongest group or person grant and keeps organization access out of Shared with me and guests', async () => {
    const maker = await server.addMember();
    const member = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const root = await folder(maker);
    const child = await folder(maker, root);
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: child, confirmedLosses: [] });
    await apply(maker, { kind: 'folder.share', folderId: root, principal: { kind: 'org' }, role: 'reader' });
    expect((await home(member)).databases).toContainEqual(
      expect.objectContaining({ id: data.id, shared: false }),
    );
    expect((await home(guest)).databases).toEqual([]);
    const groupId = newId('group');
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".groups (id, org_id, name) VALUES ($1, $2, $3)`,
      [groupId, maker.info.org.id, 'Project team'],
    );
    for (const person of [member, guest])
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
        [maker.info.org.id, groupId, person.userId],
      );
    await apply(maker, {
      kind: 'folder.share',
      folderId: root,
      principal: { kind: 'group', id: groupId },
      role: 'editor',
    });
    expect((await home(member)).databases).toContainEqual(
      expect.objectContaining({ id: data.id, role: 'editor', shared: true }),
    );
    expect((await home(guest)).databases).toEqual([]);
    await share(maker, root, guest.userId, 'reader');
    expect((await home(guest)).databases).toContainEqual(
      expect.objectContaining({ id: data.id, role: 'reader' }),
    );
    expect(
      (
        await command(guest, {
          kind: 'folder.create',
          folderId: newId('folder'),
          parentId: null,
          name: 'Guest folder',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await command(member, {
          kind: 'folder.share',
          folderId: root,
          principal: { kind: 'org' },
          role: 'owner',
        })
      ).statusCode,
    ).toBe(403);
    await share(maker, root, guest.userId, null);
    expect((await home(guest)).databases).toEqual([]);
    expect(
      (await server.app.inject({ url: `/api/databases/${data.id}/schema`, headers: guest.headers }))
        .statusCode,
    ).toBe(404);
  });

  it('rejects cycles and an eleventh level and updates every descendant path when moving', async () => {
    const maker = await server.addMember();
    const root = await folder(maker);
    let deepest = root;
    for (let i = 1; i < 10; i++) deepest = await folder(maker, deepest);
    expect(
      (
        await command(maker, {
          kind: 'folder.create',
          folderId: newId('folder'),
          name: 'Too deep',
          parentId: deepest,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await command(maker, { kind: 'folder.move', folderId: root, parentId: deepest, confirmedLosses: [] }))
        .statusCode,
    ).toBe(422);
    const all = await home(maker);
    const branch = all.folders.find((item) => item.parentId === root)!;
    await apply(maker, { kind: 'folder.move', folderId: branch.id, parentId: null, confirmedLosses: [] });
    expect((await home(maker)).folders.find((item) => item.id === deepest)?.path).toHaveLength(8);
  });

  it('trashes and restores contents together while preserving earlier trash and undo conflicts', async () => {
    const maker = await server.addMember();
    const root = await folder(maker);
    const child = await folder(maker, root);
    const old = await folder(maker, root);
    await apply(maker, { kind: 'folder.trash', folderId: old });
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: child, confirmedLosses: [] });
    await apply(maker, { kind: 'folder.trash', folderId: root });
    expect((await home(maker)).databases.map((item) => item.id)).not.toContain(data.id);
    const trash = await server.app.inject({ url: '/api/trash', headers: maker.headers });
    expect(trash.json<{ databases: Array<{ id: string }> }>().databases.map((item) => item.id)).not.toContain(
      data.id,
    );
    await apply(maker, { kind: 'folder.restore', folderId: root });
    const restored = await home(maker);
    expect(restored.databases.map((item) => item.id)).toContain(data.id);
    expect(restored.folders.find((item) => item.id === old)?.trashed).toBe(true);
    const renamed = await apply(maker, { kind: 'folder.rename', folderId: child, name: 'Renamed' });
    const undone = await server.app.inject({
      method: 'POST',
      url: `/api/home/undo/${renamed.id}`,
      headers: maker.headers,
      payload: { id: newId('command') },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect((await home(maker)).folders.find((item) => item.id === child)?.name).toBe('Projects');
    const events = await server.pool.query(
      `SELECT action FROM "${server.schemas.audit}".events WHERE metadata->>'folderId' = $1`,
      [root],
    );
    expect(events.rows.map((event) => event.action)).toEqual(
      expect.arrayContaining(['data.folder.create', 'data.folder.trash', 'data.folder.restore']),
    );
  });

  it('keeps personal folder names out of People administration without a grant', async () => {
    const maker = await server.addMember();
    const personal = await folder(maker);
    const hidden = await server.app.inject({ url: '/api/org/folders', headers: server.owner.headers });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json<Array<{ id: string }>>().map((item) => item.id)).not.toContain(personal);
    const renamed = await server.app.inject({
      method: 'PUT',
      url: `/api/org/folders/${personal}`,
      headers: server.owner.headers,
      payload: { name: 'Hidden', databases: [] },
    });
    expect(renamed.statusCode).toBe(404);
    await share(maker, personal, server.owner.userId, 'reader');
    const shared = await server.app.inject({ url: '/api/org/folders', headers: server.owner.headers });
    expect(shared.json<Array<{ id: string }>>().map((item) => item.id)).toContain(personal);
  });

  it('reviews inherited access when undoing a move and rejects stale undo', async () => {
    const maker = await server.addMember();
    const reader = await server.addMember();
    const root = await folder(maker);
    await share(maker, root, reader.userId, 'reader');
    const data = await database(maker);
    const moved = await apply(maker, {
      kind: 'database.move',
      databaseId: data.id,
      parentId: root,
      confirmedLosses: [],
    });
    const undo = (confirmedLosses: string[] = []) =>
      server.app.inject({
        method: 'POST',
        url: `/api/home/undo/${moved.id}`,
        headers: maker.headers,
        payload: { id: newId('command'), confirmedLosses },
      });
    const refused = await undo();
    expect(refused.statusCode).toBe(409);
    const people = JSON.parse(
      refused.json<{ error: { params: { losses: string } } }>().error.params.losses,
    ) as AccessLoss[];
    expect(people.map((person) => person.id)).toContain(`${reader.userId}:${data.id}`);
    expect((await undo(people.map((person) => person.id))).statusCode).toBe(200);
    expect((await home(reader)).databases.map((item) => item.id)).not.toContain(data.id);
    const renamed = await apply(maker, { kind: 'folder.rename', folderId: root, name: 'First' });
    await apply(maker, { kind: 'folder.rename', folderId: root, name: 'Second' });
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/home/undo/${renamed.id}`,
          headers: maker.headers,
          payload: { id: newId('command') },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('expires a folder with its contents and refuses restoring a database outside its trashed parent', async () => {
    const maker = await server.addMember();
    const root = await folder(maker);
    const child = await folder(maker, root);
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: child, confirmedLosses: [] });
    await apply(maker, { kind: 'folder.trash', folderId: root });
    const restored = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${data.id}/commands`,
      headers: maker.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), kind: 'database.restore' }],
      },
    });
    expect(restored.json()).toMatchObject({
      results: [{ status: 'rejected', error: { messageKey: 'home.folders.restoreParent' } }],
    });
    await server.pool.query(
      `UPDATE "${server.schemas.app}".folders SET trashed_at = now() - interval '31 days' WHERE id = ANY($1::text[])`,
      [[root, child]],
    );
    await server.pool.query(
      `UPDATE "${server.schemas.app}".databases SET trashed_at = now() - interval '31 days' WHERE id = $1`,
      [data.id],
    );
    expect((await command(maker, { kind: 'folder.restore', folderId: root })).statusCode).toBe(404);
    await purgeTrash(server.ctx);
    expect((await home(maker)).folders.map((item) => item.id)).not.toContain(root);
    const left = await server.pool.query(
      `SELECT id FROM "${server.schemas.app}".folders WHERE id = ANY($1::text[])`,
      [[root, child]],
    );
    expect(left.rowCount).toBe(0);
  });

  it('requires a database owner role and destination editor role and applies a command once', async () => {
    const maker = await server.addMember();
    const editor = await server.addMember();
    const root = await folder(maker);
    const data = await database(maker);
    await share(maker, root, editor.userId, 'reader');
    expect(
      (
        await command(editor, {
          kind: 'database.move',
          databaseId: data.id,
          parentId: root,
          confirmedLosses: [],
        })
      ).statusCode,
    ).toBe(404);
    const id = newId('command');
    const action: HomeAction = { kind: 'folder.rename', folderId: root, name: 'Once' };
    expect((await command(maker, action, id)).json()).toMatchObject({ status: 'applied' });
    expect((await command(maker, action, id)).json()).toMatchObject({ status: 'duplicate' });
    expect((await command(editor, action, id)).statusCode).toBe(404);
  });
});

it('previews a grouped drop without effects and undoes all moved items together', async () => {
  const maker = await server.addMember();
  const destination = await folder(maker);
  const first = await database(maker);
  const second = await database(maker);
  const actions: HomeAction[] = [first, second].map((item) => ({
    kind: 'database.move',
    databaseId: item.id,
    parentId: destination,
    confirmedLosses: [],
  }));
  const preview = await server.app.inject({
    method: 'POST',
    url: '/api/home/drop-preview',
    headers: maker.headers,
    payload: { id: newId('command'), action: actions[0], actions },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(
    (await home(maker)).databases
      .filter((item) => [first.id, second.id].includes(item.id))
      .map((item) => item.parentId),
  ).toEqual([null, null]);
  const id = newId('command');
  const drop = await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: maker.headers,
    payload: { id, action: actions[0], actions },
  });
  expect(drop.statusCode, drop.body).toBe(200);
  expect(
    (await home(maker)).databases
      .filter((item) => [first.id, second.id].includes(item.id))
      .map((item) => item.parentId),
  ).toEqual([destination, destination]);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${id}`,
    headers: maker.headers,
    payload: { id: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(
    (await home(maker)).databases
      .filter((item) => [first.id, second.id].includes(item.id))
      .map((item) => item.parentId),
  ).toEqual([null, null]);
});

it('refuses an entire grouped drop when one database is not owned', async () => {
  const maker = await server.addMember();
  const stranger = await server.addMember();
  const destination = await folder(maker);
  const own = await database(maker);
  const hidden = await database(stranger);
  const actions: HomeAction[] = [own, hidden].map((item) => ({
    kind: 'database.move',
    databaseId: item.id,
    parentId: destination,
    confirmedLosses: [],
  }));
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: maker.headers,
    payload: { id: newId('command'), action: actions[0], actions },
  });
  expect(result.statusCode).not.toBe(200);
  expect((await home(maker)).databases.find((item) => item.id === own.id)?.parentId).toBeNull();
});

it('stores favorite order for its owner and restores the prior position with undo', async () => {
  const maker = await server.addMember();
  const data = await database(maker);
  await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${data.id}/favorite`,
    headers: maker.headers,
    payload: { favorite: true },
  });
  const result = await apply(maker, { kind: 'favorite.move', databaseId: data.id, position: -10 });
  expect((await home(maker)).databases.find((item) => item.id === data.id)?.favoritePosition).toBe(-10);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${result.id}`,
    headers: maker.headers,
    payload: { id: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect((await home(maker)).databases.find((item) => item.id === data.id)?.favoritePosition).toBe(0);
});

it('assigns distinct positions when databases become favorites', async () => {
  const maker = await server.addMember();
  const first = await database(maker);
  const second = await database(maker);
  for (const item of [first, second]) {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${item.id}/favorite`,
      headers: maker.headers,
      payload: { favorite: true },
    });
    expect(response.statusCode).toBe(200);
  }
  const listing = await home(maker);
  expect(listing.databases.find((item) => item.id === second.id)!.favoritePosition).toBeGreaterThan(
    listing.databases.find((item) => item.id === first.id)!.favoritePosition!,
  );
});

it('previews a drop without taking the home lock or writing data', async () => {
  const maker = await server.addMember();
  const destination = await folder(maker);
  const data = await database(maker);
  const client = await server.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { previewHomeDrop } = await import('./commands/home.js');
    await previewHomeDrop(
      server.app,
      {
        userId: maker.userId,
        orgId: maker.info.org.id,
        kind: 'member',
        adminRoles: [],
        sessionId: '',
        csrfToken: '',
      },
      {
        id: newId('command'),
        action: { kind: 'database.move', databaseId: data.id, parentId: destination, confirmedLosses: [] },
      },
      client,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('reorders more than 100 tied favorites with one command and one undo', async () => {
  const maker = await server.addMember();
  const entries: string[] = [];
  for (let index = 0; index < 101; index++) {
    const data = await database(maker);
    entries.push(data.id);
    await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${data.id}/favorite`,
      headers: maker.headers,
      payload: { favorite: true },
    });
  }
  await server.pool.query(
    `UPDATE "${server.schemas.app}".user_database_state SET favorite_position = 0 WHERE user_id = $1`,
    [maker.userId],
  );
  const ordered = [...entries].sort((a, b) => a.localeCompare(b));
  const moving = ordered.at(-1)!;
  const result = await command(maker, {
    kind: 'favorite.move',
    databaseId: moving,
    position: 0,
    beforeId: ordered[1],
  } as HomeAction);
  expect(result.statusCode, result.body).toBe(200);
  const after = (await home(maker)).databases
    .filter((item) => item.favorite)
    .sort((a, b) => a.favoritePosition! - b.favoritePosition! || a.id.localeCompare(b.id))
    .map((item) => item.id);
  expect(after).toEqual([ordered[0], moving, ...ordered.slice(1, -1)]);
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${result.json<{ id: string }>().id}`,
    headers: maker.headers,
    payload: { id: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(
    (await home(maker)).databases
      .filter((item) => item.favorite)
      .sort((a, b) => a.favoritePosition! - b.favoritePosition!)
      .map((item) => item.id),
  ).toEqual(ordered);
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type HomeAction, type HomeListing } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { purgeTrash } from './purge.js';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'home_items');
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
  return response.json<{ id: string }>().id;
}
async function home(who: SignedIn) {
  const response = await server.app.inject({ url: '/api/home', headers: who.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<HomeListing>();
}
async function database(who: SignedIn) {
  const id = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: {
      id,
      name: 'Planning',
      table: {
        id: tableId,
        name: 'Tasks',
        view: { id: viewId, name: 'Private launch' },
        fields: [{ id: newId('field'), name: 'Name', type: 'text', options: {} }],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { id, tableId, viewId };
}
async function dataCommand(databaseId: string, who: SignedIn, input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().results[0], response.body).toMatchObject({ status: 'applied' });
}
async function share(databaseId: string, maker: SignedIn, who: SignedIn, role: string | null) {
  const response = await server.app.inject({
    method: role ? 'PUT' : 'DELETE',
    url: `/api/databases/${databaseId}/grants`,
    headers: maker.headers,
    payload: { principal: { kind: 'user', id: who.userId }, ...(role ? { role } : {}) },
  });
  expect(response.statusCode, response.body).toBe(200);
}

it('redacts aliases after access loss, follows renames, and trashes deleted targets', async () => {
  const maker = await server.addMember();
  const reader = await server.addMember();
  const data = await database(maker);
  await share(data.id, maker, reader, 'reader');
  const shortcutId = newId('shortcut');
  await apply(reader, {
    kind: 'shortcut.create',
    shortcutId,
    parentId: null,
    target: { kind: 'view', id: data.viewId },
  });
  expect((await home(reader)).shortcuts).toContainEqual(
    expect.objectContaining({
      id: shortcutId,
      name: 'Private launch',
      href: `/${data.id}/${data.tableId}/${data.viewId}`,
    }),
  );
  await dataCommand(data.id, maker, { kind: 'view.update', viewId: data.viewId, name: 'Renamed launch' });
  expect((await home(reader)).shortcuts?.find((item) => item.id === shortcutId)?.name).toBe('Renamed launch');
  await share(data.id, maker, reader, null);
  expect((await home(reader)).shortcuts?.find((item) => item.id === shortcutId)).toEqual({
    id: shortcutId,
    parentId: null,
    owned: true,
    trashed: false,
    available: false,
  });
  expect(
    (
      await command(reader, {
        kind: 'shortcut.create',
        shortcutId: newId('shortcut'),
        parentId: null,
        target: { kind: 'view', id: data.viewId },
      })
    ).statusCode,
  ).toBe(404);
  await dataCommand(data.id, maker, { kind: 'database.trash' });
  expect((await home(reader)).shortcuts?.find((item) => item.id === shortcutId)?.trashed).toBe(true);
});

it.each(['dashboard', 'interface', 'form'] as const)(
  'opens %s aliases and restores only live targets',
  async (kind) => {
    const who = await server.addMember();
    const data = await database(who);
    const id = newId(kind === 'form' ? 'view' : kind);
    await dataCommand(
      data.id,
      who,
      kind === 'dashboard'
        ? {
            kind: 'dashboard.create',
            dashboard: { id, name: 'Overview', config: { tiles: [] } },
            position: 0,
          }
        : kind === 'interface'
          ? { kind: 'interface.create', interface: { id, name: 'Overview', pages: [] }, position: 0 }
          : {
              kind: 'view.create',
              tableId: data.tableId,
              view: { id, tableId: data.tableId, name: 'Overview', type: 'form', config: {} },
              position: 1,
            },
    );
    const shortcutId = newId('shortcut');
    await apply(who, { kind: 'shortcut.create', shortcutId, parentId: null, target: { kind, id } });
    expect((await home(who)).shortcuts?.find((item) => item.id === shortcutId)).toMatchObject({
      available: true,
      name: 'Overview',
    });
    await dataCommand(
      data.id,
      who,
      kind === 'form' ? { kind: 'view.trash', viewId: id } : { kind: `${kind}.trash`, [`${kind}Id`]: id },
    );
    expect((await home(who)).shortcuts?.find((item) => item.id === shortcutId)).toMatchObject({
      available: false,
      trashed: true,
    });
    expect((await command(who, { kind: 'shortcut.restore', shortcutId })).statusCode).toBe(404);
  },
);

it('keeps private tags private and shared assignments within the resource access', async () => {
  const maker = await server.addMember();
  const reader = await server.addMember();
  const outsider = await server.addMember();
  const data = await database(maker);
  await share(data.id, maker, reader, 'reader');
  const privateId = newId('tag');
  const sharedId = newId('tag');
  const resource = { kind: 'database' as const, id: data.id };
  await apply(maker, {
    kind: 'tag.create',
    tagId: sharedId,
    name: 'Launch',
    color: '#ff3b30',
    visibility: 'shared',
  });
  await apply(maker, { kind: 'tag.assign', tagId: sharedId, resource, assigned: true });
  await apply(reader, {
    kind: 'tag.create',
    tagId: privateId,
    name: 'My plans',
    color: '#007aff',
    visibility: 'private',
  });
  await apply(reader, { kind: 'tag.assign', tagId: privateId, resource, assigned: true });
  expect((await home(reader)).tags?.map((tag) => tag.id)).toEqual(
    expect.arrayContaining([sharedId, privateId]),
  );
  expect((await home(maker)).tags?.map((tag) => tag.id)).not.toContain(privateId);
  expect((await home(outsider)).tags?.map((tag) => tag.id)).not.toContain(sharedId);
  const unrelated = await database(outsider);
  expect(
    (
      await command(outsider, {
        kind: 'tag.assign',
        tagId: sharedId,
        resource: { kind: 'database', id: unrelated.id },
        assigned: true,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await command(reader, { kind: 'tag.assign', tagId: sharedId, resource, assigned: false })).statusCode,
  ).toBe(403);
  expect(
    (await command(maker, { kind: 'tag.assign', tagId: privateId, resource, assigned: true })).statusCode,
  ).toBe(404);
  await share(data.id, maker, reader, 'editor');
  const removed = await apply(reader, { kind: 'tag.assign', tagId: sharedId, resource, assigned: false });
  expect((await home(reader)).tags?.map((tag) => tag.id)).not.toContain(sharedId);
  const restored = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${removed}`,
    headers: reader.headers,
    payload: { id: newId('command') },
  });
  expect(restored.statusCode, restored.body).toBe(200);
  expect((await home(reader)).tags?.map((tag) => tag.id)).toContain(sharedId);
  await share(data.id, maker, reader, null);
  expect((await home(reader)).tagLinks).toEqual([]);
  expect((await home(reader)).tags?.map((tag) => tag.id)).not.toContain(sharedId);
});

it('guards undo against later edits, records audits, and restricts palette changes to administrators', async () => {
  const who = await server.addMember();
  const tagId = newId('tag');
  const first = await apply(who, {
    kind: 'tag.create',
    tagId,
    name: 'Draft',
    color: '#ff3b30',
    visibility: 'private',
  });
  const last = await apply(who, { kind: 'tag.update', tagId, name: 'Ready', color: '#34c759' });
  const undo = (id: string) =>
    server.app.inject({
      method: 'POST',
      url: `/api/home/undo/${id}`,
      headers: who.headers,
      payload: { id: newId('command') },
    });
  expect((await undo(first)).statusCode).toBe(409);
  expect((await undo(last)).statusCode).toBe(200);
  expect((await home(who)).tags?.find((tag) => tag.id === tagId)?.name).toBe('Draft');
  const colorId = newId('tagColor');
  const action: HomeAction = { kind: 'tagColor.set', colorId, value: { name: 'Brand', color: '#223344' } };
  expect((await command(who, action)).statusCode).toBe(403);
  await apply(server.owner, action);
  expect((await home(who)).tagColors).toContainEqual({ id: colorId, ...action.value });
  const events = await server.pool.query(
    `SELECT action, metadata FROM "${server.schemas.audit}".events WHERE action LIKE 'data.tag.%' AND actor_id = $1`,
    [who.userId],
  );
  expect(events.rows.map((row) => row.action)).toContain('data.tag.update');
  expect(JSON.stringify(events.rows)).not.toContain(tagId);
  expect(JSON.stringify(events.rows)).not.toContain('Draft');
  expect(JSON.stringify(events.rows)).not.toContain('Ready');
});

it('restores folder aliases only after every trash source is restored', async () => {
  const who = await server.addMember();
  const data = await database(who);
  const folderId = newId('folder');
  const shortcutId = newId('shortcut');
  await apply(who, { kind: 'folder.create', folderId, name: 'Files', parentId: null });
  await apply(who, {
    kind: 'shortcut.create',
    shortcutId,
    parentId: folderId,
    target: { kind: 'view', id: data.viewId },
  });
  await apply(who, { kind: 'folder.trash', folderId });
  await dataCommand(data.id, who, { kind: 'database.trash' });
  await apply(who, { kind: 'folder.restore', folderId });
  expect((await home(who)).shortcuts?.find((item) => item.id === shortcutId)).toMatchObject({
    trashed: true,
    available: false,
  });
  await dataCommand(data.id, who, { kind: 'database.restore' });
  expect((await home(who)).shortcuts?.find((item) => item.id === shortcutId)).toMatchObject({
    trashed: false,
    available: true,
  });
});

it('does not undo folder creation over a shortcut added afterward', async () => {
  const who = await server.addMember();
  const data = await database(who);
  const folderId = newId('folder');
  const id = await apply(who, { kind: 'folder.create', folderId, name: 'Files', parentId: null });
  await apply(who, {
    kind: 'shortcut.create',
    shortcutId: newId('shortcut'),
    parentId: folderId,
    target: { kind: 'view', id: data.viewId },
  });
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${id}`,
    headers: who.headers,
    payload: { id: newId('command') },
  });
  expect(undo.statusCode).toBe(409);
  expect((await home(who)).folders.find((item) => item.id === folderId)?.trashed).toBe(false);
});

async function restrictedToken(who: SignedIn, databaseId: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: who.headers,
    payload: {
      name: 'Home integration',
      scopes: ['schema.bases:read', 'schema.bases:write'],
      databases: [databaseId],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

it.each(['shortcut.move', 'shortcut.trash', 'shortcut.restore'] as const)(
  'rejects %s outside a token database allowlist without changing the shortcut',
  async (kind) => {
    const who = await server.addMember();
    const allowed = await database(who);
    const hidden = await database(who);
    const shortcutId = newId('shortcut');
    await apply(who, {
      kind: 'shortcut.create',
      shortcutId,
      parentId: null,
      target: { kind: 'view', id: hidden.viewId },
    });
    if (kind === 'shortcut.restore') await apply(who, { kind: 'shortcut.trash', shortcutId });
    const headers = await restrictedToken(who, allowed.id);
    const before = await home(who);
    const listing = await server.app.inject({ url: '/api/v1/home', headers });
    expect(listing.json<HomeListing>().shortcuts).toEqual([]);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/home/commands',
      headers,
      payload: {
        id: newId('command'),
        action: { kind, shortcutId, ...(kind === 'shortcut.move' ? { parentId: null } : {}) },
      },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect((await home(who)).shortcuts).toEqual(before.shortcuts);
  },
);

it.each(['shared', 'private'] as const)(
  'checks every assignment before a scoped token changes %s tag metadata',
  async (visibility) => {
    const who = await server.addMember();
    const allowed = await database(who);
    const hidden = await database(who);
    const headers = await restrictedToken(who, allowed.id);
    const tagId = newId('tag');
    await apply(who, {
      kind: 'tag.create',
      tagId,
      name: 'Confidential merger',
      color: '#ff3b30',
      visibility,
    });
    await apply(who, {
      kind: 'tag.assign',
      tagId,
      resource: { kind: 'database', id: hidden.id },
      assigned: true,
    });
    const mutate = (action: HomeAction) =>
      server.app.inject({
        method: 'POST',
        url: '/api/v1/home/commands',
        headers,
        payload: { id: newId('command'), action },
      });
    for (const alsoVisible of [false, true]) {
      if (alsoVisible)
        await apply(who, {
          kind: 'tag.assign',
          tagId,
          resource: { kind: 'database', id: allowed.id },
          assigned: true,
        });
      for (const action of [
        { kind: 'tag.update', tagId, name: 'Changed', color: '#007aff' },
        { kind: 'tag.trash', tagId },
      ] satisfies HomeAction[]) {
        const response = await mutate(action);
        expect(response.statusCode, response.body).toBe(404);
      }
      expect((await home(who)).tags).toContainEqual(
        expect.objectContaining({ id: tagId, name: 'Confidential merger' }),
      );
    }
    await apply(who, { kind: 'tag.trash', tagId });
    expect((await mutate({ kind: 'tag.restore', tagId })).statusCode).toBe(404);
    await apply(who, { kind: 'tag.restore', tagId });
    await apply(who, {
      kind: 'tag.assign',
      tagId,
      resource: { kind: 'database', id: hidden.id },
      assigned: false,
    });
    expect((await mutate({ kind: 'tag.update', tagId, name: 'Allowed', color: '#007aff' })).statusCode).toBe(
      200,
    );
    expect((await mutate({ kind: 'tag.trash', tagId })).statusCode).toBe(200);
    expect((await mutate({ kind: 'tag.restore', tagId })).statusCode).toBe(200);
  },
);

it('rejects tag metadata changes through a scoped token when a folder is also affected', async () => {
  const who = await server.addMember();
  const allowed = await database(who);
  const headers = await restrictedToken(who, allowed.id);
  const folderId = newId('folder');
  const tagId = newId('tag');
  await apply(who, { kind: 'folder.create', folderId, name: 'Private files', parentId: null });
  await apply(who, { kind: 'tag.create', tagId, name: 'Plans', color: '#ff3b30', visibility: 'shared' });
  for (const resource of [
    { kind: 'folder', id: folderId },
    { kind: 'database', id: allowed.id },
  ] as const)
    await apply(who, { kind: 'tag.assign', tagId, resource, assigned: true });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/home/commands',
    headers,
    payload: {
      id: newId('command'),
      action: { kind: 'tag.update', tagId, name: 'Changed', color: '#007aff' },
    },
  });
  expect(response.statusCode, response.body).toBe(404);
});

it.each(['folder', 'database'] as const)(
  'purges %s tag assignments without relying on other expired home items',
  async (kind) => {
    const who = await server.addMember();
    const other = await server.addMember();
    const id = kind === 'folder' ? newId('folder') : (await database(who)).id;
    const tagId = newId('tag');
    if (kind === 'folder')
      await apply(who, { kind: 'folder.create', folderId: id, name: 'Private files', parentId: null });
    await apply(who, {
      kind: 'tag.create',
      tagId,
      name: 'Confidential merger',
      color: '#ff3b30',
      visibility: 'shared',
    });
    await apply(who, { kind: 'tag.assign', tagId, resource: { kind, id }, assigned: true });
    await expect(
      withTransaction(server.pool, async (db) => {
        await query(
          db,
          sql`DELETE FROM ${ident(server.schemas.app, kind === 'folder' ? 'folders' : 'databases')} WHERE id = ${id}`,
        );
        const removed = await query(
          db,
          sql`SELECT * FROM ${ident(server.schemas.app, 'home_tag_links')} WHERE tag_id = ${tagId}`,
        );
        expect(removed.rows).toEqual([]);
        throw new Error('Roll back deletion');
      }),
    ).rejects.toThrow('Roll back deletion');
    expect(
      (
        await query(
          server.pool,
          sql`SELECT * FROM ${ident(server.schemas.app, 'home_tag_links')} WHERE tag_id = ${tagId}`,
        )
      ).rows,
    ).toHaveLength(1);
    if (kind === 'folder') await apply(who, { kind: 'folder.trash', folderId: id });
    else await dataCommand(id, who, { kind: 'database.trash' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, kind === 'folder' ? 'folders' : 'databases')} SET trashed_at = now() - interval '31 days' WHERE id = ${id}`,
    );
    await purgeTrash(server.app.ctx);
    const links = await query(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, 'home_tag_links')} WHERE tag_id = ${tagId}`,
    );
    expect(links.rows).toEqual([]);
    if (kind === 'folder') {
      await apply(other, { kind: 'folder.create', folderId: id, name: 'New files', parentId: null });
      expect((await home(other)).tags?.map((tag) => tag.id)).not.toContain(tagId);
    }
  },
);

it.each([7, 90, null])('uses the organization trash window of %s days for home items', async (days) => {
  const data = await database(server.owner);
  const shortcutId = newId('shortcut');
  const tagId = newId('tag');
  const set = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: {
      kind: 'governance.apply',
      id: newId('command'),
      action: { kind: 'retention.set', databaseId: null, policy: { trashDays: days }, legalHold: false },
    },
  });
  expect(set.json().status, set.body).toBe('applied');
  await apply(server.owner, {
    kind: 'shortcut.create',
    shortcutId,
    parentId: null,
    target: { kind: 'view', id: data.viewId },
  });
  await apply(server.owner, {
    kind: 'tag.create',
    tagId,
    name: 'Kept tag',
    color: '#007aff',
    visibility: 'private',
  });
  await apply(server.owner, { kind: 'shortcut.trash', shortcutId });
  await apply(server.owner, { kind: 'tag.trash', tagId });
  const age = async () => {
    for (const [table, id] of [
      ['home_shortcuts', shortcutId],
      ['home_tags', tagId],
    ])
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, table!)} SET trashed_at = now() - interval '45 days' WHERE id = ${id}`,
      );
  };
  await age();
  const listed = (await home(server.owner)).shortcuts?.some((item) => item.id === shortcutId);
  expect.soft(listed).toBe(days !== 7);
  const restoredShortcut = await command(server.owner, { kind: 'shortcut.restore', shortcutId });
  expect.soft(restoredShortcut.statusCode, restoredShortcut.body).toBe(days === 7 ? 404 : 200);
  const restoredTag = await command(server.owner, { kind: 'tag.restore', tagId });
  expect.soft(restoredTag.statusCode, restoredTag.body).toBe(days === 7 ? 404 : 200);
  await age();
  await purgeTrash(server.ctx);
  for (const [table, id] of [
    ['home_shortcuts', shortcutId],
    ['home_tags', tagId],
  ]) {
    const rows = await query(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, table!)} WHERE id = ${id}`,
    );
    expect.soft(rows.rowCount).toBe(days === 7 ? 0 : 1);
  }
});

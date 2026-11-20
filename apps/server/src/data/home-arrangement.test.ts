import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type HomeAction, type HomeListing, type DatabaseRole } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { homeChannel } from './notify.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'home_arrangement');
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

it('keeps single folder commands and undo available beyond the grouped drop limit', async () => {
  const maker = await server.addMember();
  const parent = await folder(maker);
  const destination = await folder(maker);
  const children = Array.from({ length: 1002 }, () => newId('folder'));
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".folders (id, org_id, owner_id, name, parent_id, path)
     SELECT id, $2, $3, 'Child', $4, ARRAY[$4]::text[] FROM unnest($1::text[]) AS id`,
    [children, maker.info.org.id, maker.userId, parent],
  );
  const renamed = await apply(maker, { kind: 'folder.rename', folderId: parent, name: 'Large folder' });
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${renamed.id}`,
    headers: maker.headers,
    payload: { id: newId('command') },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  await apply(maker, { kind: 'folder.move', folderId: parent, parentId: destination, confirmedLosses: [] });
  await apply(maker, { kind: 'folder.trash', folderId: parent });
  await apply(maker, { kind: 'folder.restore', folderId: parent });
  const listing = await home(maker);
  expect(listing.folders.find(({ id }) => id === parent)).toMatchObject({
    name: 'Projects',
    parentId: destination,
    trashed: false,
  });
  expect(listing.folders.filter(({ id, trashed }) => children.includes(id) && !trashed)).toHaveLength(1002);
  const actions: HomeAction[] = [
    { kind: 'folder.rename', folderId: parent, name: 'Refused' },
    { kind: 'folder.rename', folderId: destination, name: 'Refused' },
  ];
  const batch = await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: maker.headers,
    payload: { id: newId('command'), action: actions[0], actions },
  });
  expect(batch.json()).toMatchObject({ error: { messageKey: 'home.arrange.tooLarge' } });
});

it('notifies shared folder readers for shortcut creation and moves while personal shortcuts stay private', async () => {
  const maker = await server.addMember();
  const reader = await server.addMember();
  const destination = await folder(maker);
  const data = await database(maker);
  await share(maker, destination, reader.userId, 'reader');
  const listener = await server.pool.connect();
  const notices: Array<{ orgId: string; userId: string }> = [];
  const channel = homeChannel(server.schemas);
  listener.on('notification', (notice) => {
    if (notice.channel === channel && notice.payload) notices.push(JSON.parse(notice.payload));
  });
  try {
    await listener.query(`LISTEN "${channel}"`);
    const shortcutId = newId('shortcut');
    for (const action of [
      {
        kind: 'shortcut.create',
        shortcutId,
        parentId: destination,
        target: { kind: 'view', id: data.viewId },
      },
      { kind: 'shortcut.move', shortcutId, parentId: null },
      { kind: 'shortcut.move', shortcutId, parentId: destination },
      {
        kind: 'shortcut.create',
        shortcutId: newId('shortcut'),
        parentId: null,
        target: { kind: 'view', id: data.viewId },
      },
    ] satisfies HomeAction[]) {
      notices.length = 0;
      await apply(maker, action);
      // A round trip on the listening connection consumes the committed notifications.
      await listener.query('SELECT 1');
      const recipients = notices.map(({ userId }) => userId).sort();
      expect(recipients).toEqual(
        (action.kind === 'shortcut.create' && action.parentId === null
          ? [maker.userId]
          : [maker.userId, reader.userId]
        ).sort(),
      );
    }
  } finally {
    await listener.query('UNLISTEN *');
    listener.release();
  }
});

/** Who each committed Home notice names, read after `work` finishes. */
async function recipients(work: () => Promise<unknown>): Promise<string[]> {
  const listener = await server.pool.connect();
  const notices: string[] = [];
  const channel = homeChannel(server.schemas);
  listener.on('notification', (notice) => {
    if (notice.channel === channel && notice.payload)
      notices.push((JSON.parse(notice.payload) as { userId: string }).userId);
  });
  try {
    await listener.query(`LISTEN "${channel}"`);
    await work();
    // A round trip on the listening connection consumes the committed notifications.
    await listener.query('SELECT 1');
    return notices.sort();
  } finally {
    await listener.query('UNLISTEN *');
    listener.release();
  }
}

/** Every statement the server runs during `work`, with its parameters. */
async function statements(work: () => Promise<unknown>): Promise<Array<[string, unknown[]]>> {
  const seen: Array<[string, unknown[]]> = [];
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  const watch = (client: pg.PoolClient) => {
    if (wrapped.has(client)) return;
    const original = client.query;
    wrapped.set(client, original);
    client.query = ((...args: unknown[]) => {
      if (typeof args[0] === 'string') seen.push([args[0], Array.isArray(args[1]) ? args[1] : []]);
      return (original as (...input: unknown[]) => unknown).apply(client, args);
    }) as pg.PoolClient['query'];
  };
  server.pool.on('acquire', watch);
  try {
    await work();
    return seen;
  } finally {
    server.pool.off('acquire', watch);
    for (const [client, original] of wrapped) client.query = original;
  }
}

it('tells only a folder’s own readers when it is renamed or shared', async () => {
  const maker = await server.addMember();
  const outsider = await server.addMember();
  const guest = await server.addMember();
  const parent = await folder(maker);
  const data = await database(maker);
  await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: parent, confirmedLosses: [] });
  // The outsider reads the database inside, but never the folder, so its name and sharing are not theirs to hear about.
  const granted = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${data.id}/grants`,
    headers: maker.headers,
    payload: { principal: { kind: 'user', id: outsider.userId }, role: 'reader' },
  });
  expect(granted.statusCode, granted.body).toBe(200);
  expect(
    await recipients(() => apply(maker, { kind: 'folder.rename', folderId: parent, name: 'Renamed' })),
  ).toEqual([maker.userId]);
  expect(await recipients(() => share(maker, parent, guest.userId, 'reader'))).toEqual(
    [maker.userId, guest.userId].sort(),
  );
});

it('sends every Home notice of a command in one statement', async () => {
  const maker = await server.addMember();
  const readers = [await server.addMember(), await server.addMember(), await server.addMember()];
  const parent = await folder(maker);
  for (const reader of readers) await share(maker, parent, reader.userId, 'reader');
  let heard: string[] = [];
  const seen = await statements(async () => {
    heard = await recipients(() =>
      apply(maker, { kind: 'folder.rename', folderId: parent, name: 'Announced' }),
    );
  });
  expect(heard).toEqual([maker, ...readers].map((who) => who.userId).sort());
  const notices = seen.filter(
    ([text, values]) => text.includes('pg_notify') && values.includes(homeChannel(server.schemas)),
  );
  expect(notices).toHaveLength(1);
});

it('stars and orders favorites while Home and data commands hold their locks', async () => {
  const maker = await server.addMember();
  const first = await database(maker);
  const second = await database(maker);
  await apply(maker, { kind: 'favorite.set', databaseId: second.id, favorite: true });
  const holder = await server.pool.connect();
  try {
    await holder.query('BEGIN');
    for (const key of [
      `database:${first.id}`,
      `database:${second.id}`,
      `home:${maker.info.org.id}`,
      `database:${maker.info.org.id}`,
    ])
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${server.schemas.app}:${key}`,
      ]);
    const settled = (work: Promise<{ statusCode: number }>) =>
      Promise.race([
        work.then((response) => response.statusCode),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 3000)),
      ]);
    expect(
      await settled(
        server.app.inject({
          method: 'PUT',
          url: `/api/databases/${first.id}/favorite`,
          headers: maker.headers,
          payload: { favorite: true },
        }),
      ),
    ).toBe(200);
    expect(
      await settled(
        command(maker, { kind: 'favorite.move', databaseId: first.id, position: 0, beforeId: second.id }),
      ),
    ).toBe(200);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  expect(
    (await home(maker)).databases
      .filter((item) => item.favorite)
      .sort((a, b) => (a.favoritePosition ?? 0) - (b.favoritePosition ?? 0))
      .map((item) => item.id),
  ).toEqual([first.id, second.id]);
});

it("makes an undone favorite move wait for the same person's other favorite changes", async () => {
  const maker = await server.addMember();
  const first = await database(maker);
  const second = await database(maker);
  await apply(maker, { kind: 'favorite.set', databaseId: first.id, favorite: true });
  await apply(maker, { kind: 'favorite.set', databaseId: second.id, favorite: true });
  const moved = await apply(maker, {
    kind: 'favorite.move',
    databaseId: second.id,
    position: 0,
    beforeId: first.id,
  });
  const holder = await server.pool.connect();
  let undone: Promise<{ statusCode: number; body: string }> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${server.schemas.app}:favorites:${maker.userId}`,
    ]);
    undone = server.app.inject({
      method: 'POST',
      url: `/api/home/undo/${moved.id}`,
      headers: maker.headers,
      payload: { id: newId('command') },
    });
    const early = await Promise.race([
      undone.then(() => 'finished'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 1500)),
    ]);
    expect(early).toBe('waiting');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const response = await undone!;
  expect(response.statusCode, response.body).toBe(200);
  expect(
    (await home(maker)).databases
      .filter((item) => item.favorite)
      .sort((a, b) => (a.favoritePosition ?? 0) - (b.favoritePosition ?? 0))
      .map((item) => item.id),
  ).toEqual([first.id, second.id]);
});

interface PlanNode {
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  Plans?: PlanNode[];
}
/** Rows each plan node produced or looked at and threw away, over all its loops. */
const touched = (node: PlanNode): number =>
  (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)) *
    node['Actual Loops'] +
  (node.Plans ?? []).reduce((sum, child) => sum + touched(child), 0);

// Runs last, since it fills the organization with people and grants.
it('reads a move’s audience in work bounded by the moved folders’ grants, not by every grant', async () => {
  const maker = await server.addMember();
  const orgId = maker.info.org.id;
  const app = server.schemas.app;
  const people = Array.from({ length: 400 }, () => newId('user'));
  await server.pool.query(
    `INSERT INTO "${app}".users (id, email, name, password_hash)
     SELECT id, lower(id) || '@example.test', 'Person', 'unused' FROM unnest($1::text[]) AS id`,
    [people],
  );
  await server.pool.query(
    `INSERT INTO "${app}".memberships (org_id, user_id, kind)
     SELECT $2, id, CASE WHEN n % 10 = 0 THEN 'guest' ELSE 'member' END FROM unnest($1::text[]) WITH ORDINALITY AS p(id, n)`,
    [people, orgId],
  );
  // Thousands of grants on folders the move never touches.
  const elsewhere = Array.from({ length: 400 }, () => newId('folder'));
  await server.pool.query(
    `INSERT INTO "${app}".folders (id, org_id, owner_id, name, parent_id, path)
     SELECT id, $2, $3, 'Elsewhere', NULL, ARRAY[]::text[] FROM unnest($1::text[]) AS id`,
    [elsewhere, orgId, maker.userId],
  );
  await server.pool.query(
    `INSERT INTO "${app}".grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     SELECT $2, 'folder', f, 'user', p, 'reader' FROM unnest($1::text[]) AS f, unnest($3::text[]) AS p`,
    [elsewhere, orgId, people.slice(0, 10)],
  );
  const parent = await folder(maker);
  const child = await folder(maker, parent);
  await apply(maker, {
    kind: 'folder.share',
    folderId: parent,
    principal: { kind: 'org' },
    role: 'reader',
  });
  for (const person of people.slice(0, 5)) await share(maker, child, person, 'commenter');
  for (let index = 0; index < 3; index += 1) {
    const data = await database(maker);
    await apply(maker, { kind: 'database.move', databaseId: data.id, parentId: child, confirmedLosses: [] });
  }
  await server.pool.query(
    `ANALYZE "${app}".users, "${app}".memberships, "${app}".folders, "${app}".grants, "${app}".folder_databases`,
  );
  let preview: { statusCode: number; body: string; json: <T>() => T } | undefined;
  const seen = await statements(async () => {
    preview = await server.app.inject({
      method: 'POST',
      url: '/api/home/move-preview',
      headers: maker.headers,
      payload: {
        id: newId('command'),
        action: { kind: 'folder.move', folderId: child, parentId: null, confirmedLosses: [] },
      },
    });
  });
  expect(preview!.statusCode, preview!.body).toBe(200);
  // Everyone in the organization reads the moved folder through its parent, and loses that.
  expect(preview!.json<unknown[]>().length).toBeGreaterThan(300);
  const reads = seen.filter(([text]) => /^\s*(SELECT|WITH)\b/i.test(text) && !text.includes('pg_advisory'));
  expect(reads.length).toBeGreaterThan(0);
  let most = 0;
  for (const [text, values] of reads) {
    const plan = await server.pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
      values,
    );
    most = Math.max(most, touched(plan.rows[0]!['QUERY PLAN'][0]!.Plan));
  }
  // Every person times every resource times every grant would be millions of rows.
  expect(most).toBeLessThan(50_000);
});

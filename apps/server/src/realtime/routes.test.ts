import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  presenceColor,
  type Change,
  type ClientMessage,
  type HomeAction,
  type AccessLoss,
  type ServerMessage,
  type PersonalProfile,
  type DatabaseSchema,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp } from '../app.js';
import { changesChannel, homeChannel, organizationChannel, presenceChannel } from '../data/notify.js';
import { AccessScope } from '../data/access.js';
import { sealNotice } from './presence.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
let address: string;
const clients: BrowserTab[] = [];
const cleanups: Array<() => Promise<void>> = [];
// Socket I/O keeps progressing while a test controls only the coalescing timer.
const realDelay = delay;

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeout) throw new Error('condition timed out');
    await realDelay(10);
  }
}

class BrowserTab {
  readonly clientId = newId('client');
  readonly socket: WebSocket;
  readonly history: ServerMessage[] = [];
  readonly inbox: ServerMessage[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url.replace(/^http/, 'ws') + '/api/realtime', { headers });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
    });
    this.closed = new Promise((resolve) =>
      this.socket.addEventListener('close', (event) => resolve(event.code)),
    );
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.history.push(message);
      this.inbox.push(message);
    });
    clients.push(this);
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async next<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeout = 5_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    let index = -1;
    await until(() => {
      index = this.inbox.findIndex(
        (message) => message.type === type && predicate(message as Extract<ServerMessage, { type: T }>),
      );
      return index >= 0;
    }, timeout);
    return this.inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    await this.closed;
  }
}

async function tab(url = address, who = server.owner): Promise<BrowserTab> {
  const client = new BrowserTab(url, { cookie: who.headers.cookie, origin: new URL(url).origin });
  await client.opened;
  client.send({ type: 'hello', csrf: who.info.csrfToken, clientId: client.clientId });
  expect(await client.next('ready')).toEqual({ type: 'ready' });
  return client;
}

async function database(who: SignedIn = server.owner) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const app = server.schemas.app;
  const orgId = server.owner.info.org.id;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'databases')} (id, org_id, name)
    VALUES (${databaseId}, ${orgId}, ${'Database'})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${orgId}, 'database', ${databaseId}, 'user', ${who.userId}, 'reader')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'tables')}
    (id, org_id, database_id, name, primary_field_id, position)
    VALUES (${tableId}, ${orgId}, ${databaseId}, ${'Table'}, ${newId('field')}, 0)`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'views')}
    (id, org_id, table_id, name, type, position)
    VALUES (${viewId}, ${orgId}, ${tableId}, ${'View'}, 'grid', 0)`,
  );
  return { databaseId, tableId, viewId };
}

type TestDatabase = Awaited<ReturnType<typeof database>>;

async function folderDatabase() {
  const reader = await server.addMember();
  const parent = newId('folder');
  const child = newId('folder');
  const nested = newId('folder');
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const viewId = newId('view');
  const home = async (action: HomeAction) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/home/commands',
      headers: server.owner.headers,
      payload: { id: newId('command'), action },
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Projects',
      table: {
        id: tableId,
        name: 'Tasks',
        fields: [{ id: fieldId, name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  for (const [folderId, parentId] of [
    [parent, null],
    [child, parent],
    [nested, child],
  ] as const)
    await home({ kind: 'folder.create', folderId, parentId, name: 'Projects' });
  await home({ kind: 'database.move', databaseId, parentId: nested, confirmedLosses: [] });
  await home({
    kind: 'folder.share',
    folderId: parent,
    principal: { kind: 'user', id: reader.userId },
    role: 'reader',
  });
  return {
    databaseId,
    tableId,
    viewId,
    reader,
    async revoke() {
      const action = { kind: 'folder.move' as const, folderId: child, parentId: null, confirmedLosses: [] };
      const preview = await server.app.inject({
        method: 'POST',
        url: '/api/home/move-preview',
        headers: server.owner.headers,
        payload: { id: newId('command'), action },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      await home({ ...action, confirmedLosses: preview.json<AccessLoss[]>().map((loss) => loss.id) });
    },
    async record() {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.create',
              tableId,
              records: [{ id: newId('record'), values: { [fieldId]: 'Confidential project' } }],
            },
          ],
        },
      });
      expect(response.json(), response.body).toMatchObject({ results: [{ status: 'applied' }] });
    },
  };
}

async function commit(
  db: TestDatabase,
  count = 1,
  kind: 'record.trashed' | 'database.trashed' = 'record.trashed',
) {
  const client = await server.pool.connect();
  try {
    await query(client, sql`BEGIN`);
    const result = await query<{ change_seq: string }>(
      client,
      sql`
      UPDATE ${ident(server.schemas.app, 'databases')} SET change_seq = change_seq + ${count}
      WHERE id = ${db.databaseId} RETURNING change_seq`,
    );
    const last = Number(result.rows[0]!.change_seq);
    const changes: Change[] = Array.from({ length: count }, (_, index) => ({
      seq: last - count + index + 1,
      databaseId: db.databaseId,
      commandId: newId('command'),
      groupId: newId('action'),
      actorId: server.owner.userId,
      clientId: null,
      at: new Date().toISOString(),
      ...(kind === 'database.trashed'
        ? { kind }
        : { kind, tableId: db.tableId, recordIds: [newId('record')] }),
    }));
    await query(
      client,
      // Stored the way the command bus stores them: the change's body alone, the rest in columns.
      sql`INSERT INTO ${ident(server.schemas.app, 'changes')}
      (database_id, seq, org_id, table_id, command_id, group_id, actor_id, client_id, at, kind, body, prev)
      SELECT ${db.databaseId}, (c->>'seq')::bigint, ${server.owner.info.org.id}, ${db.tableId},
        c->>'commandId', c->>'groupId', c->>'actorId', c->>'clientId', (c->>'at')::timestamptz, c->>'kind',
        c - 'seq' - 'databaseId' - 'commandId' - 'groupId' - 'actorId' - 'clientId' - 'at',
        '{"private":true}'::jsonb
      FROM jsonb_array_elements(${JSON.stringify(changes)}::jsonb) c`,
    );
    await query(
      client,
      sql`SELECT pg_notify(${changesChannel(server.schemas)},
      ${JSON.stringify({ databaseId: db.databaseId, seq: last })})`,
    );
    await query(client, sql`COMMIT`);
    return changes;
  } finally {
    client.release();
  }
}

async function subscribe(client: BrowserTab, db: TestDatabase, sinceSeq = 0): Promise<void> {
  client.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq });
  await client.next('caughtUp', (message) => message.databaseId === db.databaseId);
}

async function replica(options: { pooler?: 'transaction'; listenHost?: string; listenPort?: number } = {}) {
  const profile = server.config.database!;
  const ctx = {
    ...server.ctx,
    config: { ...server.config, baseUrl: undefined, database: { ...profile, ...options } },
  };
  const app = await buildApp(ctx);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  return { app, url, ctx };
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'realtime');
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  delete server.ctx.data;
  server.config.baseUrl = undefined;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  while (cleanups.length) await cleanups.pop()!();
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('realtime sockets', () => {
  it('refreshes only the affected schema when a role changes with the same database grant', async () => {
    const member = await server.addMember();
    const hidden = await server.addMember();
    const db = await database(member);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${db.databaseId}, 'user', ${server.owner.userId}, 'reader')`,
    );
    const schema = async () => {
      const response = await server.app.inject({
        url: `/api/databases/${db.databaseId}/schema`,
        headers: member.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<DatabaseSchema>();
    };
    expect((await schema()).collaborators.map((person) => person.id)).toContain(hidden.userId);
    const mine = await tab(address, member);
    const other = await tab();
    await subscribe(mine, db);
    await subscribe(other, db);
    const changed = await server.app.inject({
      method: 'PATCH',
      url: `/api/org/members/${member.userId}/role`,
      headers: server.owner.headers,
      payload: { role: 'guest' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await mine.next('reload')).toMatchObject({
      databaseId: db.databaseId,
      reason: 'accessChanged',
    });
    await subscribe(mine, db);
    expect(other.history.some((message) => message.type === 'reload')).toBe(false);
    const after = await schema();
    expect(after.database.role).toBe('reader');
    expect(after.collaborators.map((person) => person.id)).not.toContain(hidden.userId);
    const fingerprint = () =>
      new AccessScope(server.pool, server.schemas, {
        userId: member.userId,
        orgId: member.info.org.id,
        kind: 'guest',
        adminRoles: [],
        sessionId: newId('client'),
        csrfToken: member.info.csrfToken,
      }).fingerprint(db.databaseId);
    const beforeName = await fingerprint();
    const current = (
      await server.app.inject({ url: '/api/me/profile', headers: member.headers })
    ).json<PersonalProfile>();
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url: '/api/me/profile',
          headers: member.headers,
          payload: { revision: current.revision, name: 'Guest profile name' },
        })
      ).statusCode,
    ).toBe(200);
    await mine.next('personChanged', (message) => message.person.name === 'Guest profile name');
    expect(await fingerprint()).toBe(beforeName);
    expect(mine.history.filter((message) => message.type === 'reload')).toHaveLength(1);
  });

  it('delivers profile notices only to person readers and locks the affected tab on deactivation', async () => {
    const member = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const mine = await tab(address, member);
    const reader = await tab();
    const hidden = await tab(address, guest);
    const before = (
      await server.app.inject({ url: '/api/me/profile', headers: member.headers })
    ).json<PersonalProfile>();
    const saved = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/profile',
      headers: member.headers,
      payload: { revision: before.revision, name: 'Live profile name' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    for (const viewer of [mine, reader])
      expect((await viewer.next('personChanged')).person).toMatchObject({
        id: member.userId,
        name: 'Live profile name',
      });
    expect(hidden.history.some((message) => message.type === 'personChanged')).toBe(false);
    const ended = await server.app.inject({
      method: 'PATCH',
      url: `/api/org/members/${member.userId}/status`,
      headers: server.owner.headers,
      payload: { deactivated: true },
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(await mine.next('accountDeactivated')).toEqual({ type: 'accountDeactivated' });
    expect(await mine.closed).toBe(4401);
    expect(
      (await reader.next('personChanged', (message) => Boolean(message.person.deactivated))).person
        .deactivated,
    ).toBe(true);
    expect((await server.app.inject({ url: '/api/auth/session', headers: member.headers })).statusCode).toBe(
      401,
    );
  });

  it.each([false, true])(
    'rechecks a subscription registered after a folder move with an existing database subscription: %s',
    async (existing) => {
      const db = await folderDatabase();
      const owner = await tab();
      if (existing) await subscribe(owner, db);
      const client = await tab(address, db.reader);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const original = AccessScope.prototype.fingerprint;
      const check = vi.spyOn(AccessScope.prototype, 'fingerprint').mockImplementation(async function (
        this: AccessScope,
        id,
      ) {
        const fingerprint = await original.call(this, id);
        if (!held && this.actor.userId === db.reader.userId && id === db.databaseId) {
          held = true;
          await gate;
        }
        return fingerprint;
      });
      try {
        client.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 0 });
        await until(() => held);
        client.inbox.length = 0;
        await db.revoke();
        await client.next('homeChanged');
        await db.record();
        release();
        await until(() =>
          client.history.some((message) => message.type === 'reload' || message.type === 'caughtUp'),
        );
        expect(
          client.history.filter((message) => message.type === 'change' || message.type === 'caughtUp'),
        ).toEqual([]);
        expect(await client.next('reload')).toMatchObject({
          databaseId: db.databaseId,
          reason: 'accessChanged',
        });
        await db.record();
        if (existing) await owner.next('change', (message) => message.change.kind === 'record.created');
        client.send({ type: 'ping' });
        await client.next('pong');
        expect(client.history.filter((message) => message.type === 'change')).toEqual([]);
      } finally {
        release();
        check.mockRestore();
      }
    },
  );

  it('checks folder access before the next polling delivery', async () => {
    const db = await folderDatabase();
    const other = await replica({ pooler: 'transaction' });
    const client = await tab(other.url, db.reader);
    await subscribe(client, db);
    client.history.length = 0;
    await db.revoke();
    await db.record();
    await until(() =>
      client.history.some((message) => message.type === 'change' || message.type === 'reload'),
    );
    expect(client.history.filter((message) => message.type === 'change')).toEqual([]);
    expect(await client.next('reload')).toMatchObject({ databaseId: db.databaseId, reason: 'accessChanged' });
  });

  it('delivers both home and organization notices across replicas', async () => {
    const other = await replica();
    const client = await tab(other.url);
    await until(async () => {
      await query(
        server.pool,
        sql`SELECT pg_notify(${organizationChannel(server.schemas)}, ${server.owner.info.org.id})`,
      );
      return client.history.some((message) => message.type === 'organizationChanged');
    });
    client.inbox.splice(0);
    await query(
      server.pool,
      sql`SELECT pg_notify(${homeChannel(server.schemas)}, ${server.owner.info.org.id}),
        pg_notify(${organizationChannel(server.schemas)}, ${server.owner.info.org.id})`,
    );
    expect(await client.next('homeChanged')).toEqual({ type: 'homeChanged' });
    expect(await client.next('organizationChanged')).toEqual({ type: 'organizationChanged' });
  });

  it('refuses missing sessions, missing origins, and foreign origins before upgrading', async () => {
    const cases: Record<string, string>[] = [
      { origin: address },
      { cookie: server.owner.headers.cookie },
      { origin: 'https://foreign.example', cookie: server.owner.headers.cookie },
    ];
    for (const headers of cases) {
      const client = new BrowserTab(address, headers);
      await expect(client.opened).rejects.toThrow('upgrade refused');
    }
  });

  it('uses the configured origin, including its scheme and port', async () => {
    server.config.baseUrl = 'https://database.example.test/path';
    const refused = new BrowserTab(address, { cookie: server.owner.headers.cookie, origin: address });
    await expect(refused.opened).rejects.toThrow('upgrade refused');
    const accepted = new BrowserTab(address, {
      cookie: server.owner.headers.cookie,
      origin: 'https://database.example.test',
    });
    await accepted.opened;
    accepted.send({ type: 'hello', clientId: accepted.clientId, csrf: server.owner.info.csrfToken });
    await accepted.next('ready');
    const response = await server.app.inject({ url: '/healthz' });
    expect(response.headers['content-security-policy']).toContain(
      "connect-src 'self' wss://database.example.test",
    );
  });

  it('requires hello first and compares its CSRF token before sending ready', async () => {
    for (const first of [
      { type: 'ping' },
      { type: 'hello', clientId: newId('client'), csrf: 'wrong' },
      { type: 'hello', clientId: newId('client'), csrf: 'x'.repeat(server.owner.info.csrfToken.length) },
    ]) {
      const client = new BrowserTab(address, { cookie: server.owner.headers.cookie, origin: address });
      await client.opened;
      client.socket.send(JSON.stringify(first));
      expect(await client.closed).toBe(4401);
      expect(client.history).toEqual([]);
    }
    const client = await tab();
    client.send({ type: 'ping' });
    await client.next('pong');
  });

  it('rejects invalid messages, bounds message size, and limits a rolling second to 50 messages', async () => {
    const client = await tab();
    for (const invalid of ['{', '{}', '{"type":"subscribe","databaseId":"invalid","sinceSeq":0}']) {
      client.socket.send(invalid);
      expect(await client.next('error')).toEqual({ type: 'error', messageKey: 'errors.badRequest' });
    }
    client.socket.send('x'.repeat(64 * 1024 + 1));
    expect(await client.closed).toBe(1009);
    const flooding = await tab();
    for (let i = 0; i < 49; i++) flooding.send({ type: 'ping' });
    await until(() => flooding.history.filter((message) => message.type === 'pong').length === 49);
    flooding.send({ type: 'ping' });
    expect(await flooding.closed).toBe(1008);
    expect(flooding.history.filter((message) => message.type === 'pong')).toHaveLength(49);
  });

  it('hides databases without a read grant', async () => {
    const db = await database();
    const reader = await server.addMember();
    const client = await tab(address, reader);
    client.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 0 });
    expect(await client.next('error')).toEqual({ type: 'error', messageKey: 'errors.notFound' });
    client.send({ type: 'watch', databaseId: db.databaseId, viewId: db.viewId, snapshot: 'snapshot' });
    expect(await client.next('error')).toMatchObject({ messageKey: 'errors.notFound' });
    client.send({ type: 'presence', databaseId: db.databaseId, where: null });
    expect(await client.next('error')).toMatchObject({ messageKey: 'errors.notFound' });
  });

  it('replays ordered bodies, catches up, streams once, and unsubscribes', async () => {
    const db = await database();
    const changes = await commit(db, 3);
    const client = await tab();
    await subscribe(client, db, 1);
    expect(client.history.filter((m) => m.type === 'change')).toEqual(
      changes.slice(1).map((change) => ({ type: 'change', change })),
    );
    expect(client.history.find((m) => m.type === 'caughtUp')).toMatchObject({ seq: 3 });
    const live = await commit(db, 2);
    await client.next('change', (m) => m.change.seq === 5);
    await query(
      server.pool,
      sql`SELECT pg_notify(${changesChannel(server.schemas)},
      ${JSON.stringify({ databaseId: db.databaseId, seq: 5 })})`,
    );
    await delay(100);
    expect(client.history.filter((m) => m.type === 'change')).toEqual(
      [...changes.slice(1), ...live].map((change) => ({ type: 'change', change })),
    );
    client.send({ type: 'unsubscribe', databaseId: db.databaseId });
    client.send({ type: 'ping' });
    await client.next('pong');
    await commit(db);
    await delay(100);
    expect(client.history.filter((m) => m.type === 'change')).toHaveLength(4);
  });

  it('does not skip or duplicate commits made while a replay is in progress', async () => {
    const db = await database();
    await commit(db, 1_000);
    const client = await tab();
    // Hold the read behind a table lock, commit another change, then release the replay.
    const blocker = await server.pool.connect();
    try {
      await query(blocker, sql`BEGIN`);
      await query(blocker, sql`LOCK TABLE ${ident(server.schemas.app, 'changes')} IN ACCESS EXCLUSIVE MODE`);
      client.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 100 });
      await until(async () => {
        const waiting = await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${'%realtime replay%'} `,
        );
        return Number(waiting.rows[0]!.count) > 0;
      });
      const during = commit(db, 10);
      await query(blocker, sql`COMMIT`);
      await during;
      await client.next('caughtUp');
      await commit(db, 10);
      await client.next('change', (m) => m.change.seq === 1_020);
      await delay(100);
      expect(client.history.filter((m) => m.type === 'change').map((m) => m.change.seq)).toEqual(
        Array.from({ length: 920 }, (_, i) => i + 101),
      );
    } finally {
      await query(blocker, sql`ROLLBACK`);
      blocker.release();
    }
  });

  it('allows 5,000 replayed changes and reloads beyond the limit', async () => {
    const db = await database();
    await commit(db, 5_001);
    const behind = await tab();
    behind.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 0 });
    expect(await behind.next('reload')).toEqual({
      type: 'reload',
      databaseId: db.databaseId,
      reason: 'tooFarBehind',
    });
    expect(behind.history.some((m) => m.type === 'change' || m.type === 'caughtUp')).toBe(false);
    const boundary = await tab();
    await subscribe(boundary, db, 1);
    expect(boundary.history.filter((m) => m.type === 'change')).toHaveLength(5_000);
  });

  it('queues a committed notice after the replay query has returned and before caughtUp', async () => {
    const db = await database();
    await commit(db, 2);
    const client = await tab();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = false;
    let held = false;
    const original = server.pool.query;
    const read = vi.spyOn(server.pool, 'query').mockImplementation(
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (
            !captured &&
            typeof args[0] === 'string' &&
            args[0].includes('realtime replay') &&
            Array.isArray(args[1]) &&
            args[1][0] === db.databaseId &&
            result instanceof Promise
          ) {
            captured = true;
            return result.then(async (rows: unknown) => {
              held = true;
              await gate;
              return rows;
            });
          }
          return result;
        },
      }),
    );
    try {
      client.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 0 });
      await until(() => held);
      await commit(db, 2);
      expect(client.history.some((m) => m.type === 'caughtUp')).toBe(false);
      release();
      await client.next('change', (m) => m.change.seq === 4);
      await delay(100);
      expect(client.history.filter((m) => m.type === 'change').map((m) => m.change.seq)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(client.history.find((m) => m.type === 'caughtUp')).toMatchObject({ seq: 2 });
    } finally {
      release();
      read.mockRestore();
    }
  });

  it('fans a committed change out to two replicas and shares presence and departures', async () => {
    const db = await database();
    const other = await replica();
    const first = await tab();
    const second = await tab(other.url);
    await subscribe(first, db);
    await subscribe(second, db);
    await commit(db);
    await first.next('change');
    await second.next('change');
    first.send({ type: 'presence', databaseId: db.databaseId, where: { tableId: db.tableId } });
    second.send({
      type: 'presence',
      databaseId: db.databaseId,
      where: { tableId: db.tableId, viewId: db.viewId },
    });
    expect((await first.next('presence', (m) => m.peers.length === 1)).peers).toEqual([
      {
        clientId: second.clientId,
        userId: server.owner.userId,
        name: server.owner.info.user.name,
        color: presenceColor(server.owner.userId),
        where: { tableId: db.tableId, viewId: db.viewId },
      },
    ]);
    expect((await second.next('presence', (m) => m.peers.length === 1)).peers[0]!.clientId).toBe(
      first.clientId,
    );
    const recordId = newId('record');
    second.send({ type: 'presence', databaseId: db.databaseId, where: { tableId: db.tableId, recordId } });
    await first.next('presence', (m) => m.peers[0]?.where?.recordId === recordId);
    await second.close();
    await first.next('presence', (m) => m.peers.length === 0);
  });

  it('coalesces presence updates and expires remote tabs without treating pings as presence', async () => {
    const db = await database();
    const observer = await tab();
    const peer = await tab();
    await subscribe(observer, db);
    await subscribe(peer, db);
    peer.send({ type: 'presence', databaseId: db.databaseId, where: { tableId: db.tableId } });
    await observer.next('presence', (m) => m.peers.length === 1);
    const before = observer.history.filter((m) => m.type === 'presence').length;
    // Authentication can spread a burst across several real 100-millisecond windows.
    // Drain every frame behind a pong before advancing this one controlled window.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldClearNativeTimers: true,
    });
    try {
      for (let i = 0; i < 20; i++)
        peer.send({
          type: 'presence',
          databaseId: db.databaseId,
          where: { tableId: db.tableId, editing: Boolean(i % 2) },
        });
      peer.send({ type: 'ping' });
      await peer.next('pong');
      await vi.advanceTimersByTimeAsync(100);
      await observer.next('presence', (m) => m.peers[0]?.where?.editing === true);
      expect(observer.history.filter((m) => m.type === 'presence').length - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const future = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    observer.send({ type: 'ping' });
    peer.send({ type: 'ping' });
    await observer.next('pong');
    await peer.next('pong');
    // Expiry uses a real one-second sweep and a 100-millisecond coalescing timer.  Advancing
    // Date.now does not run either timer, so allow twenty seconds for scheduling under load.
    const expiryWaitMs = 20_000;
    await observer.next('presence', (m) => m.peers.length === 0, expiryWaitMs);
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    const remoteId = newId('client');
    const forgedId = newId('client');
    const remote = (clientId: string) => ({
      databaseId: db.databaseId,
      clientId,
      userId: server.owner.userId,
      name: 'Remote',
      color: presenceColor(server.owner.userId),
      where: null,
      timestamp: future - 59_000,
    });
    // Every database client can send on the channel, so a notice no server sealed names nobody.
    await query(
      server.pool,
      sql`SELECT pg_notify(${presenceChannel(server.schemas)}, ${JSON.stringify(remote(forgedId))})`,
    );
    await query(
      server.pool,
      sql`SELECT pg_notify(${presenceChannel(server.schemas)}, ${sealNotice(server.config.secretKey, remote(remoteId))})`,
    );
    const arrived = await observer.next('presence', (m) => m.peers.some((p) => p.clientId === remoteId));
    expect(arrived.peers.map((p) => p.clientId)).not.toContain(forgedId);
    vi.spyOn(Date, 'now').mockReturnValue(future + 2_000);
    await observer.next('presence', (m) => m.peers.length === 0, expiryWaitMs);
  });

  it('shows other database clients nothing of who is where', async () => {
    const db = await database();
    const observer = await tab();
    const peer = await tab();
    await subscribe(observer, db);
    await subscribe(peer, db);
    const listener = new pg.Client({ ...server.pool.options });
    const heard: string[] = [];
    await listener.connect();
    try {
      listener.on('notification', (event) => heard.push(event.payload ?? ''));
      await query(listener, sql`LISTEN ${ident(presenceChannel(server.schemas))}`);
      peer.send({ type: 'presence', databaseId: db.databaseId, where: { tableId: db.tableId } });
      await observer.next('presence', (m) => m.peers.length === 1);
      await until(() => heard.length > 0);
      for (const payload of heard)
        for (const secret of [server.owner.userId, db.databaseId, db.tableId, peer.clientId])
          expect(payload).not.toContain(secret);
    } finally {
      await listener.end();
    }
  });

  it('retains presence when a tab leaves and rejoins within the same millisecond', async () => {
    const db = await database();
    const observer = await tab();
    const peer = await tab();
    await subscribe(observer, db);
    await subscribe(peer, db);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    peer.send({ type: 'presence', databaseId: db.databaseId, where: { tableId: db.tableId } });
    await observer.next('presence', (m) => m.peers.length === 1);
    peer.send({ type: 'unsubscribe', databaseId: db.databaseId });
    await observer.next('presence', (m) => m.peers.length === 0);
    await subscribe(peer, db);
    peer.send({ type: 'presence', databaseId: db.databaseId, where: null });
    expect((await observer.next('presence', (m) => m.peers.length === 1)).peers[0]!.where).toBeNull();
  });

  it('polls without a direct pooler connection and after LISTEN connection failure', async () => {
    for (const options of [
      { pooler: 'transaction' as const },
      { pooler: 'transaction' as const, listenHost: '127.0.0.1', listenPort: 1 },
    ]) {
      const db = await database();
      const other = await replica(options);
      const client = await tab(other.url);
      await subscribe(client, db);
      const [change] = await commit(db);
      expect(await client.next('change')).toEqual({ type: 'change', change });
    }
  });

  it('uses the direct pooler endpoint and reconnects a dropped listener without losing changes', async () => {
    const db = await database();
    const profile = server.config.database!;
    const other = await replica({
      pooler: 'transaction',
      listenHost: profile.host,
      listenPort: profile.port,
    });
    const client = await tab(other.url);
    await subscribe(client, db);
    // Subscriptions can be ready before both asynchronous listener connections finish starting.
    let listeners: Array<{ pid: number }> = [];
    await until(async () => {
      listeners = (
        await query<{ pid: number }>(
          server.pool,
          sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${`${profile.applicationName}-realtime`}`,
        )
      ).rows;
      return listeners.length >= 2;
    });
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    await query(
      server.pool,
      sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${`${profile.applicationName}-realtime`}`,
    );
    await commit(db, 3);
    await client.next('change', (m) => m.change.seq === 3);
    await until(async () => {
      const replacement = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${`${profile.applicationName}-realtime`}
          AND pid <> ALL(${listeners.map((row) => row.pid)}::int[])`,
      );
      return Number(replacement.rows[0]!.count) >= 2;
    });
    await commit(db, 2);
    await client.next('change', (m) => m.change.seq === 5);
    expect(client.history.filter((m) => m.type === 'change').map((m) => m.change.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('computes view deltas once for local watchers of the changed table and stops null watches', async () => {
    const db = await database();
    const elsewhere = await database();
    const first = await tab();
    const second = await tab();
    await subscribe(first, db);
    await subscribe(second, db);
    const recordId = newId('record');
    const viewDeltas = vi.fn(async () => [
      {
        viewId: db.viewId,
        snapshot: 'page',
        entered: [recordId],
        left: [],
        moved: [],
      },
    ]);
    server.ctx.data = { viewDeltas };
    for (const client of [first, second]) {
      client.send({ type: 'watch', databaseId: db.databaseId, viewId: db.viewId, snapshot: 'page' });
      client.send({ type: 'ping' });
      await client.next('pong');
    }
    const [change] = await commit(db);
    await first.next('viewDelta');
    await second.next('viewDelta');
    expect(viewDeltas).toHaveBeenCalledExactlyOnceWith(change, [{ viewId: db.viewId, snapshot: 'page' }]);
    first.send({ type: 'watch', databaseId: db.databaseId, viewId: elsewhere.viewId, snapshot: 'page' });
    expect(await first.next('error')).toMatchObject({ messageKey: 'errors.notFound' });
    for (const client of [first, second]) {
      client.send({ type: 'watch', databaseId: db.databaseId, viewId: db.viewId, snapshot: null });
      client.send({ type: 'ping' });
      await client.next('pong');
    }
    await commit(db);
    await first.next('change', (m) => m.change.seq === 2);
    expect(viewDeltas).toHaveBeenCalledTimes(1);
  });

  it('drops every subscription when its database is trashed', async () => {
    const db = await database();
    const first = await tab();
    const second = await tab();
    await subscribe(first, db);
    await subscribe(second, db);
    await commit(db, 1, 'database.trashed');
    for (const client of [first, second])
      expect(await client.next('reload')).toEqual({
        type: 'reload',
        databaseId: db.databaseId,
        reason: 'trashed',
      });
    await commit(db);
    await delay(100);
    expect(first.history.filter((m) => m.type === 'change')).toHaveLength(1);
    expect(second.history.filter((m) => m.type === 'change')).toHaveLength(1);
  });

  it('reloads tabs whose role changes and stops sending changes to people who lose access', async () => {
    const db = await database();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'owner'
      WHERE resource_id = ${db.databaseId}`,
    );
    const member = await server.addMember();
    const share = (role: string | null) =>
      server.app.inject({
        method: role === null ? 'DELETE' : 'PUT',
        url: `/api/databases/${db.databaseId}/grants`,
        headers: server.owner.headers,
        payload: { principal: { kind: 'user', id: member.userId }, ...(role === null ? {} : { role }) },
      });
    expect((await share('editor')).statusCode).toBe(200);
    const owner = await tab();
    const shared = await tab(address, member);
    await subscribe(owner, db);
    await subscribe(shared, db);

    expect((await share('reader')).statusCode).toBe(200);
    expect(await shared.next('reload')).toEqual({
      type: 'reload',
      databaseId: db.databaseId,
      reason: 'accessChanged',
    });
    await subscribe(shared, db);

    expect((await share(null)).statusCode).toBe(200);
    expect(await shared.next('reload')).toMatchObject({ reason: 'accessChanged' });
    shared.send({ type: 'subscribe', databaseId: db.databaseId, sinceSeq: 0 });
    expect(await shared.next('error')).toEqual({ type: 'error', messageKey: 'errors.notFound' });
    await commit(db);
    await owner.next('change');
    await delay(100);
    expect(shared.history.filter((message) => message.type === 'change')).toHaveLength(0);
    // The owner's role never changed, so the owner keeps streaming without a reload.
    expect(owner.history.filter((message) => message.type === 'reload')).toHaveLength(0);
  });

  it('closes silent sockets at 60 seconds and rechecks ended sessions every minute', async () => {
    const silent = await tab();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    expect(await silent.closed).toBe(4408);
    clock.mockRestore();
    const member = await server.addMember();
    const active = await tab(address, member);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'sessions')} SET revoked_at = now()
      WHERE user_id = ${member.userId}`,
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    active.send({ type: 'ping' });
    await active.next('pong');
    expect(await active.closed).toBe(4401);
  });
});

describe('with the command bus', () => {
  it('delivers what the bus commits, in order, as complete changes without previous values', async () => {
    const who = server.owner;
    const databaseId = newId('database');
    const tableId = newId('table');
    const primary = newId('field');
    const recordId = newId('record');
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: who.headers,
      payload: {
        id: databaseId,
        name: 'Live',
        table: {
          id: tableId,
          name: 'Table 1',
          fields: [{ id: primary, name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
          records: [{ id: recordId }],
        },
      },
    });
    expect(created.statusCode).toBe(200);

    const client = await tab();
    client.send({ type: 'subscribe', databaseId, sinceSeq: 0 });
    expect((await client.next('change')).change).toMatchObject({
      seq: 1,
      databaseId,
      actorId: who.userId,
      kind: 'database.created',
    });
    expect((await client.next('change')).change).toMatchObject({ seq: 2, kind: 'table.created' });
    await client.next('caughtUp', (message) => message.seq === 2);

    const commandId = newId('command');
    const edit = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: who.headers,
      payload: {
        clientId: client.clientId,
        commands: [
          {
            id: commandId,
            groupId: newId('action'),
            kind: 'record.update',
            tableId,
            records: [{ id: recordId, values: { [primary]: 'Hello' } }],
          },
        ],
      },
    });
    expect(edit.json<{ results: Array<{ status: string }> }>().results[0]!.status).toBe('applied');
    const live = (await client.next('change')).change;
    expect(live).toMatchObject({
      seq: 3,
      databaseId,
      commandId,
      clientId: client.clientId,
      actorId: who.userId,
      kind: 'record.updated',
      tableId,
      records: [{ id: recordId, values: { [primary]: 'Hello' } }],
    });
    expect(typeof live.at).toBe('string');
    expect(JSON.stringify(live)).not.toContain('"prev"');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_EMAIL,
  newId,
  type NotificationPreferences,
  type NotificationsPage,
  type UnreadCount,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'bell');
  server.ctx.notifications?.pause();
  databaseId = newId('database');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Garden',
      table: {
        id: newId('table'),
        name: 'Beds',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** Shares made a minute apart, the newest last, so their order is certain. */
async function seed(who: SignedIn, count: number): Promise<string[]> {
  const ids: string[] = [];
  const start = Date.parse('2026-09-01T12:00:00.000Z');
  for (let i = 0; i < count; i += 1) {
    const id = newId('notification');
    ids.push(id);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'notifications')}
      (id, org_id, recipient_id, kind, actor_id, subject_id, target, created_at)
      VALUES (${id}, ${who.info.org.id}, ${who.userId}, 'share', ${server.owner.userId}, ${databaseId},
        ${JSON.stringify({ databaseId, databaseName: 'Garden', role: 'reader' })}::jsonb,
        ${new Date(start + i * 60_000)})`,
    );
  }
  return ids;
}

async function get<T>(who: SignedIn, url: string): Promise<T> {
  const response = await server.app.inject({ method: 'GET', url, headers: who.headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<T>();
}

function markRead(who: SignedIn, payload: object) {
  return server.app.inject({ method: 'POST', url: '/api/notifications/read', headers: who.headers, payload });
}

describe('notification routes', () => {
  it('list only the person’s own, newest first, 30 a page', async () => {
    const sam = await server.addMember({ name: 'Sam' });
    const pat = await server.addMember({ name: 'Pat' });
    const ids = await seed(sam, 35);
    const theirs = await seed(pat, 2);
    const first = await get<NotificationsPage>(sam, '/api/notifications');
    expect(first.notifications.map((notification) => notification.id)).toEqual(ids.slice(5).reverse());
    expect(first.notifications[0]).toEqual({
      id: ids[34],
      kind: 'share',
      createdAt: '2026-09-01T12:34:00.000Z',
      readAt: null,
      actor: { id: server.owner.userId, name: 'Owner' },
      target: { databaseId, databaseName: 'Garden', role: 'reader' },
    });
    expect(first.next).toEqual(expect.any(String));
    const second = await get<NotificationsPage>(
      sam,
      `/api/notifications?before=${encodeURIComponent(first.next!)}`,
    );
    expect(second.notifications.map((notification) => notification.id)).toEqual(ids.slice(0, 5).reverse());
    expect(second.next).toBeNull();
    const short = await get<NotificationsPage>(sam, '/api/notifications?limit=10');
    expect(short.notifications).toHaveLength(10);
    const rest = await get<NotificationsPage>(
      sam,
      `/api/notifications?limit=30&before=${encodeURIComponent(short.next!)}`,
    );
    expect(rest.notifications.map((notification) => notification.id)).toEqual(ids.slice(0, 25).reverse());
    expect((await get<NotificationsPage>(pat, '/api/notifications')).notifications.map((n) => n.id)).toEqual(
      [...theirs].reverse(),
    );
    for (const url of [
      '/api/notifications?limit=0',
      '/api/notifications?limit=31',
      '/api/notifications?before=not-a-cursor',
      `/api/notifications?before=${Buffer.from(JSON.stringify({ at: 'yesterday', id: ids[0] })).toString('base64url')}`,
    ]) {
      const response = await server.app.inject({ method: 'GET', url, headers: sam.headers });
      expect(response.statusCode, url).toBe(422);
      expect(response.json()).toMatchObject({ error: { messageKey: 'errors.validationFailed' } });
    }
  });

  it('count unread and mark some or all read, only ever the person’s own', async () => {
    const sam = await server.addMember({ name: 'Sam Unread' });
    const pat = await server.addMember({ name: 'Pat Unread' });
    const ids = await seed(sam, 4);
    const [theirs] = await seed(pat, 1);
    expect(await get<UnreadCount>(sam, '/api/notifications/unread')).toEqual({ count: 4 });
    const some = await markRead(sam, { ids: [ids[0], ids[1], theirs] });
    expect(some.statusCode, some.body).toBe(200);
    expect(some.json<UnreadCount>()).toEqual({ count: 2 });
    const listed = await get<NotificationsPage>(sam, '/api/notifications');
    expect(
      listed.notifications
        .filter((notification) => notification.readAt)
        .map((n) => n.id)
        .sort(),
    ).toEqual([ids[0], ids[1]].sort());
    expect(await get<UnreadCount>(pat, '/api/notifications/unread')).toEqual({ count: 1 });
    // Reading them again keeps when they were first read.
    const readAt = listed.notifications.find((notification) => notification.id === ids[0])!.readAt;
    await markRead(sam, { ids: [ids[0]] });
    const again = await get<NotificationsPage>(sam, '/api/notifications');
    expect(again.notifications.find((notification) => notification.id === ids[0])!.readAt).toBe(readAt);
    const all = await markRead(sam, { all: true });
    expect(all.json<UnreadCount>()).toEqual({ count: 0 });
    expect(await get<UnreadCount>(pat, '/api/notifications/unread')).toEqual({ count: 1 });
    for (const payload of [{}, { ids: [] }, { all: false }, { ids: ['not-an-id'] }]) {
      expect((await markRead(sam, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
  });

  it('keep each person’s email choices, starting from the defaults', async () => {
    const sam = await server.addMember({ name: 'Sam Choices' });
    const pat = await server.addMember({ name: 'Pat Choices' });
    expect(await get<NotificationPreferences>(sam, '/api/notifications/preferences')).toEqual({
      email: {
        adminRolesChanged: true,
        mention: true,
        share: true,
        automationStopped: true,
        automationFailed: false,
        syncFailed: false,
        syncHeld: true,
        reportStopped: true,
        feedbackReply: true,
        fileScan: false,
        webhookFailed: true,
        domainUnverified: true,
        credentialVaultUnavailable: true,
        vaultUnavailable: true,
        customDomainUnverified: true,
        routineReport: false,
        routineApproval: true,
        routinePaused: true,
        securityEvent: true,
        backupFailed: true,
        updateFailed: true,
        calendarEventKept: true,
        automationNotification: true,
        'ingest.question': true,
        'ingest.file.read': false,
        'ingest.file.held': true,
        'ingest.sender.unapproved': true,
        'ingest.format.needsApproval': true,
        'ingest.paused': true,
      },
      emailAvailable: false,
    });
    const put = (payload: object) =>
      server.app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: sam.headers,
        payload,
      });
    const first = await put({ email: { mention: false } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<NotificationPreferences>().email).toEqual({
      ...DEFAULT_NOTIFICATION_EMAIL,
      mention: false,
    });
    // Each change keeps the others.
    await put({ email: { automationFailed: true } });
    expect((await get<NotificationPreferences>(sam, '/api/notifications/preferences')).email).toEqual({
      ...DEFAULT_NOTIFICATION_EMAIL,
      mention: false,
      automationFailed: true,
    });
    expect((await get<NotificationPreferences>(pat, '/api/notifications/preferences')).email).toEqual(
      DEFAULT_NOTIFICATION_EMAIL,
    );
    for (const payload of [{}, { email: { birthdays: true } }, { email: { mention: 'yes' } }]) {
      expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    // With a mailer and an address to link to, the choices take effect.
    server.ctx.mailer = { send: async () => undefined };
    server.ctx.config.baseUrl = 'https://riosoma.example.test';
    try {
      expect((await get<NotificationPreferences>(sam, '/api/notifications/preferences')).emailAvailable).toBe(
        true,
      );
    } finally {
      server.ctx.mailer = null;
      server.ctx.config.baseUrl = undefined;
    }
  });

  it('turn away anyone not signed in, and changes without the session’s token', async () => {
    for (const url of ['/api/notifications', '/api/notifications/unread', '/api/notifications/preferences']) {
      expect((await server.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    const { cookie } = server.owner.headers;
    const read = await server.app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie },
      payload: { all: true },
    });
    expect(read.statusCode).toBe(403);
    const choices = await server.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      headers: { cookie },
      payload: { email: { mention: false } },
    });
    expect(choices.statusCode).toBe(403);
  });
});

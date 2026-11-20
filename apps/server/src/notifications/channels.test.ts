import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  newId,
  NOTIFICATION_KINDS,
  type NotificationChannelPreferences,
  type NotificationCommandResult,
  type NotificationConnection,
  type PushSubscriptionInput,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { hashPassword } from '../auth/passwords.js';
import { queueNotificationChannels, recordCredentialAlert } from '../data/notification-delivery.js';
import { deliverChannels } from './channel-delivery.js';
import { digestSlot } from './digest.js';
import { NOTIFICATION_COPY } from '../reports/email.js';
import { CredentialStore } from '../data/credentials/store.js';
import { privatePayload } from './messages.js';
import { createVapidKeys, encryptPush, pushEndpointAllowed, sendPush, vapidAuthorization } from './push.js';
import { sendSlack, sendSms, sendTeams } from './transports.js';

function subscription() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const input: PushSubscriptionInput = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(24).toString('base64url')}`,
    keys: {
      p256dh: receiver.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  return { receiver, input };
}
const payload = () => ({
  title: randomUUID(),
  body: randomUUID(),
  url: new URL('/settings/notifications', 'https://example.test').href,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('push protocol', () => {
  it('encrypts an authenticated single record that the receiving device can decrypt', () => {
    const { receiver, input } = subscription();
    const message = payload();
    const encrypted = encryptPush(input, message);
    const salt = encrypted.subarray(0, 16);
    expect(encrypted.readUInt32BE(16)).toBe(4096);
    expect(encrypted[20]).toBe(65);
    const publicKey = encrypted.subarray(21, 86);
    const ikm = hkdfSync(
      'sha256',
      receiver.computeSecret(publicKey),
      Buffer.from(input.keys.auth, 'base64url'),
      Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), publicKey]),
      32,
    );
    const key = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12);
    const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce), {
      authTagLength: 16,
    });
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(86, -16)), decipher.final()]);
    expect(plaintext.at(-1)).toBe(2);
    expect(JSON.parse(plaintext.subarray(0, -1).toString())).toEqual(message);
    expect(encryptPush(input, message)).not.toEqual(encrypted);
    expect(encrypted.includes(Buffer.from(message.body))).toBe(false);
  });

  it('signs VAPID for the push service with a short expiration and the installation public key', () => {
    const keys = createVapidKeys();
    const { input } = subscription();
    const now = Date.now();
    const subject = new URL(payload().url).origin;
    const authorization = vapidAuthorization(keys, input.endpoint, subject, now);
    const token = authorization.match(/^vapid t=(.+), k=(.+)$/)!;
    expect(token[2]).toBe(keys.publicKey);
    const parts = token[1]!.split('.');
    expect(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())).toEqual({
      aud: new URL(input.endpoint).origin,
      exp: Math.floor(now / 1000) + 3600,
      sub: subject,
    });
    const key = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: key.subarray(1, 33).toString('base64url'),
        y: key.subarray(33).toString('base64url'),
      },
    });
    expect(
      verify(
        'sha256',
        Buffer.from(parts.slice(0, 2).join('.')),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2]!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('rejects unrelated endpoints, treats expired subscriptions distinctly, and never follows redirects', async () => {
    expect(pushEndpointAllowed(payload().url)).toBe(false);
    const { input } = subscription();
    for (const status of [404, 410]) {
      const request: typeof fetch = async (_url, init) => {
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('content-encoding')).toBe('aes128gcm');
        return new Response(null, { status });
      };
      await expect(
        sendPush(input, createVapidKeys(), payload(), new URL(payload().url).origin, request),
      ).resolves.toBe('expired');
    }
    await expect(
      sendPush(
        input,
        createVapidKeys(),
        payload(),
        new URL(payload().url).origin,
        async () => new Response(null, { status: 500 }),
      ),
    ).rejects.toMatchObject({ messageKey: 'notifications.delivery.failed' });
  });

  it('never includes record contents or actor names in an external payload', () => {
    const secret = randomBytes(24).toString('hex');
    const notification = {
      kind: 'mention' as const,
      target: {
        databaseId: newId('database'),
        tableId: newId('table'),
        databaseName: secret,
        excerpt: secret,
      },
    };
    const result = privatePayload(notification, 'en-US', new URL(payload().url).origin);
    expect(Object.keys(result).sort()).toEqual(['body', 'title', 'url']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('digest local scheduling', () => {
  it('handles daily slots, Monday weekly slots, skipped hours, and repeated hours', () => {
    const daily = { frequency: 'daily' as const, hour: 2, timeZone: 'America/New_York' };
    expect(digestSlot(daily, new Date('2026-03-08T06:59:00Z'))).toBeNull();
    expect(digestSlot(daily, new Date('2026-03-08T07:00:00Z'))).toBe('daily:2026-03-08');
    const fall = { ...daily, hour: 1 };
    expect(digestSlot(fall, new Date('2026-11-01T05:30:00Z'))).toBe(
      digestSlot(fall, new Date('2026-11-01T06:30:00Z')),
    );
    const weekly = { ...daily, frequency: 'weekly' as const, hour: 9 };
    expect(digestSlot(weekly, new Date('2026-09-28T13:00:00Z'))).toBe('weekly:2026-09-28');
    expect(digestSlot(weekly, new Date('2026-09-29T13:00:00Z'))).toBeNull();
    expect(digestSlot({ ...daily, frequency: 'off' }, new Date())).toBeNull();
  });
});

describe('direct message transports', () => {
  it('form-encodes Slack lookup and keeps conversation and message requests as JSON', async () => {
    const token = randomBytes(24).toString('base64url');
    const email = `${randomUUID()}+alerts@example.test`;
    const message = payload();
    const responses = [{ ok: true, user: { id: 'U1' } }, { ok: true, channel: { id: 'D1' } }, { ok: true }];
    const request = vi.fn<typeof fetch>(async () => json(responses.shift()));
    await sendSlack({ channel: 'slack', token }, email, message, request);
    expect(request).toHaveBeenCalledTimes(3);
    const methods = ['users.lookupByEmail', 'conversations.open', 'chat.postMessage'];
    for (const [index, [input, init]] of request.mock.calls.entries()) {
      expect(String(input)).toBe(`https://slack.com/api/${methods[index]}`);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).get('content-type')).toBe(
        index === 0 ? 'application/x-www-form-urlencoded' : 'application/json',
      );
    }
    expect(request.mock.calls[0]![1]?.body).toBe(`email=${encodeURIComponent(email)}`);
    expect(request.mock.calls[1]![1]?.body).toBe(JSON.stringify({ users: 'U1' }));
    expect(request.mock.calls[2]![1]?.body).toBe(
      JSON.stringify({
        channel: 'D1',
        text: `${message.title}\n${message.body}\n${message.url}`,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  });

  it('resolves a Slack user by email and opens their direct conversation before sending', async () => {
    const token = randomBytes(24).toString('base64url');
    const email = `${randomUUID()}@example.test`;
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const method = String(input).split('/').at(-1)!;
      calls.push(method);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      if (method === 'users.lookupByEmail') {
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ email });
        return json({ ok: true, user: { id: 'U1' } });
      }
      const body = JSON.parse(String(init?.body));
      if (method === 'conversations.open') {
        expect(body).toEqual({ users: 'U1' });
        return json({ ok: true, channel: { id: 'D1' } });
      }
      expect(body).toMatchObject({ channel: 'D1', mrkdwn: false, unfurl_links: false });
      return json({ ok: true });
    };
    await sendSlack({ channel: 'slack', token }, email, payload(), request);
    expect(calls).toEqual(['users.lookupByEmail', 'conversations.open', 'chat.postMessage']);
    await expect(
      sendSlack({ channel: 'slack', token }, email, payload(), async () => json({ ok: false, error: token })),
    ).rejects.toMatchObject({ messageKey: 'notifications.delivery.failed' });
  });

  it.each([
    ['users.lookupByEmail', 'users_not_found'],
    ['conversations.open', 'missing_scope'],
    ['chat.postMessage', 'channel_not_found'],
  ])('identifies a Slack %s failure without exposing private response fields', async (method, code) => {
    const token = randomBytes(24).toString('base64url');
    const email = `${randomUUID()}@example.test`;
    const message = payload();
    const calls: string[] = [];
    const request: typeof fetch = async (input) => {
      const current = String(input).split('/').at(-1)!;
      calls.push(current);
      if (current === method) return json({ ok: false, error: code, token, email, message });
      if (current === 'users.lookupByEmail') return json({ ok: true, user: { id: 'U1' } });
      return json({ ok: true, channel: { id: 'D1' } });
    };
    const error = await sendSlack({ channel: 'slack', token }, email, message, request).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      messageKey: 'notifications.delivery.failed',
      serviceMethod: method,
      serviceError: code,
    });
    expect((error as AppError).toBody()).toEqual({
      error: { code: 'unavailable', messageKey: 'notifications.delivery.failed', userFault: false },
    });
    for (const value of [token, email, message.title, message.body, message.url])
      expect(JSON.stringify(error)).not.toContain(value);
    const methods = ['users.lookupByEmail', 'conversations.open', 'chat.postMessage'];
    expect(calls).toEqual(methods.slice(0, methods.indexOf(method) + 1));
  });

  it('keeps the Slack method on HTTP, network, and malformed response failures', async () => {
    const token = randomBytes(24).toString('base64url');
    const email = `${randomUUID()}@example.test`;
    const message = payload();
    const cases: Array<{ request: typeof fetch; serviceError?: string }> = [
      { request: async () => json({ ok: false, error: 'ratelimited' }, 429), serviceError: 'ratelimited' },
      {
        request: async () => {
          throw new Error(`${token} ${email} ${message.body}`);
        },
      },
      { request: async () => new Response(`${token} ${email} ${message.body}`, { status: 502 }) },
      { request: async () => json(null) },
      { request: async () => json({ ok: true, user: { deleted: true, id: 'U1' } }) },
      { request: async () => json({ ok: false, error: token }) },
      { request: async () => json({ ok: false, error: email }) },
    ];
    for (const item of cases) {
      const error = await sendSlack({ channel: 'slack', token }, email, message, item.request).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        messageKey: 'notifications.delivery.failed',
        serviceMethod: 'users.lookupByEmail',
        serviceError: item.serviceError,
      });
      for (const value of [token, email, message.body]) expect(JSON.stringify(error)).not.toContain(value);
    }
  });

  it('refreshes a delegated Graph token and sends plain text to a one-to-one chat', async () => {
    const connection: Extract<NotificationConnection, { channel: 'teams' }> = {
      channel: 'teams',
      tenantId: randomUUID(),
      clientId: randomUUID(),
      clientSecret: randomBytes(24).toString('hex'),
      refreshToken: randomBytes(24).toString('hex'),
    };
    const access = randomBytes(24).toString('hex');
    const refresh = randomBytes(24).toString('hex');
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/token')) {
        expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
        return json({ access_token: access, refresh_token: refresh });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);
      if (url.pathname.endsWith('/me')) return json({ id: 'sender' });
      if (url.pathname.endsWith('/users')) {
        expect(url.searchParams.get('$filter')).toContain('mail eq');
        return json({ value: [{ id: 'recipient' }] });
      }
      const body = JSON.parse(String(init?.body));
      if (url.pathname.endsWith('/chats')) {
        expect(body.chatType).toBe('oneOnOne');
        expect(body.members).toHaveLength(2);
        return json({ id: 'private-chat' });
      }
      expect(body.body.contentType).toBe('text');
      return json({ id: randomUUID() });
    };
    expect(await sendTeams(connection, `${randomUUID()}@example.test`, payload(), request)).toBe(refresh);
    expect(calls).toHaveLength(5);
  });

  it('retains OAuth and Graph error codes without their response text', async () => {
    const connection: Extract<NotificationConnection, { channel: 'teams' }> = {
      channel: 'teams',
      tenantId: randomUUID(),
      clientId: randomUUID(),
      clientSecret: randomBytes(24).toString('hex'),
      refreshToken: randomBytes(24).toString('hex'),
    };
    const email = `${randomUUID()}@example.test`;
    await expect(
      sendTeams(connection, email, payload(), async () =>
        json({ error: 'invalid_grant', error_description: connection.refreshToken }, 400),
      ),
    ).rejects.toMatchObject({
      messageKey: 'notifications.delivery.failed',
      serviceMethod: 'oauth2.token',
      serviceError: 'invalid_grant',
    });
    await expect(
      sendTeams(connection, email, payload(), async (input) =>
        String(input).endsWith('/token')
          ? json({ access_token: randomBytes(24).toString('hex') })
          : json({ error: { code: 'InvalidAuthenticationToken', message: email } }, 401),
      ),
    ).rejects.toMatchObject({
      messageKey: 'notifications.delivery.failed',
      serviceMethod: 'me',
      serviceError: 'InvalidAuthenticationToken',
    });
  });

  it('sends SMS through the configured account and hides provider response text on failure', async () => {
    const connection = {
      channel: 'sms' as const,
      accountSid: `AC${randomBytes(16).toString('hex')}`,
      authToken: randomBytes(24).toString('hex'),
      from: '+12025550101',
    };
    const text = randomUUID();
    await sendSms(connection, '+12025550102', text, async (_url, init) => {
      expect(new URLSearchParams(String(init?.body)).get('Body')).toBe(text);
      expect(new URLSearchParams(String(init?.body)).get('To')).toBe('+12025550102');
      return json({ status: 'queued' });
    });
    await expect(
      sendSms(connection, '+12025550102', text, async () =>
        json({ error_code: 1, message: connection.authToken }),
      ),
    ).rejects.toMatchObject({
      messageKey: 'notifications.delivery.failed',
      serviceMethod: 'Messages.create',
      serviceError: 1,
    });
    await expect(
      sendSms(connection, '+12025550102', text, async () =>
        json({ code: 21211, message: connection.authToken }, 400),
      ),
    ).rejects.toMatchObject({
      messageKey: 'notifications.delivery.failed',
      serviceMethod: 'Messages.create',
      serviceError: 21211,
    });
  });
});

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'notification_channels', { baseUrl: new URL(payload().url).origin });
  server.ctx.notifications?.pause();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function command(who: SignedIn, input: object) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/notifications/commands',
    headers: who.headers,
    payload: { id: newId('command'), ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationCommandResult>();
}
async function preferences(who: SignedIn) {
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/notifications/channels',
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationChannelPreferences>();
}
async function notice(who: SignedIn, kind = 'feedbackReply', read = false) {
  const id = newId('notification');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'notifications')}(id, org_id, recipient_id, kind, subject_id, target, email, read_at)
    VALUES (${id}, ${who.info.org.id}, ${who.userId}, ${kind}, ${randomUUID()}, ${JSON.stringify({ excerpt: randomBytes(16).toString('hex') })}::jsonb, 'pending', ${read ? new Date() : null})`,
  );
  return id;
}

/**
 * A second organization on the same server, so a vault alert the first one recorded earlier this
 * hour can't stand in for one a test expects.  Each person who joins is signed in.
 */
async function freshOrganization() {
  const orgId = newId('org');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${orgId}, 'Fresh organization')`,
  );
  const join = async (kind: 'owner' | 'member', adminRoles: string[] = []): Promise<SignedIn> => {
    const userId = newId('user');
    const email = `fresh-${randomBytes(6).toString('hex')}@example.test`;
    const password = randomBytes(18).toString('base64url');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email, name, password_hash)
      VALUES (${userId}, ${email}, 'Fresh person', ${await hashPassword(password)})`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id, kind, admin_roles)
      VALUES (${orgId}, ${userId}, ${kind}, ${adminRoles}::text[])`,
    );
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: { email, password },
    });
    expect(response.statusCode, response.body).toBe(200);
    const info = response.json<SignedIn['info']>();
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    return { userId, email, headers: { cookie, 'x-csrf-token': info.csrfToken }, info };
  };
  const owner = await join('owner');
  /** Vault alerts recorded for the organization, leaving out a credential profile's own failures */
  const vaultEvents = async () =>
    (
      await query<{ count: number }>(
        server.pool,
        sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.audit, 'events')}
        WHERE org_id = ${orgId} AND action = 'credentials.unavailable' AND metadata ->> 'profile' IS NULL`,
      )
    ).rows[0]!.count;
  return { orgId, owner, join, vaultEvents };
}

it('stores personal choices through audited, replay-safe commands with conflict-aware undo', async () => {
  const person = await server.addMember();
  const other = await server.addMember();
  const id = newId('command');
  const change = { id, kind: 'notifications.preferences', update: { channels: { push: { mention: true } } } };
  expect((await command(person, change)).status).toBe('applied');
  expect((await command(person, change)).status).toBe('duplicate');
  expect((await preferences(person)).channels.push.mention).toBe(true);
  expect((await preferences(other)).channels.push.mention).toBe(false);
  expect((await command(other, { kind: 'notifications.undo', actionId: id })).status).toBe('rejected');
  expect((await command(person, { kind: 'notifications.undo', actionId: id })).status).toBe('applied');
  expect((await preferences(person)).channels.push.mention).toBe(false);
  const changed = await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { mention: true } } },
  });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { share: true } } },
  });
  expect(
    (await command(person, { kind: 'notifications.undo', actionId: changed.actionId })).error?.messageKey,
  ).toBe('errors.conflict');
  const events = await query(
    server.pool,
    sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE actor_id = ${person.userId} AND action = 'notifications.preferences'`,
  );
  expect(events.rowCount).toBe(3);
});

it('keeps one installation VAPID key and scopes subscriptions to their owner', async () => {
  const person = await server.addMember();
  const other = await server.addMember();
  const a = await command(person, { kind: 'notifications.push.prepare' });
  const b = await command(other, { kind: 'notifications.push.prepare' });
  expect(a.publicKey).toBe(b.publicKey);
  const { input } = subscription();
  const added = await command(person, { kind: 'notifications.push.subscribe', subscription: input });
  expect(added.status).toBe('applied');
  expect((await command(other, { kind: 'notifications.push.subscribe', subscription: input })).status).toBe(
    'rejected',
  );
  expect(
    (await command(other, { kind: 'notifications.push.unsubscribe', deviceId: added.deviceId })).status,
  ).toBe('rejected');
  expect((await preferences(other)).devices).toEqual([]);
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { push: { feedbackReply: true } } },
  });
  await notice(person);
  let sends = 0;
  await deliverChannels(server.app, async () => {
    sends += 1;
    return new Response(null, { status: 410 });
  });
  expect(sends).toBe(1);
  expect((await preferences(person)).devices).toEqual([]);
  const stored = await query<{ sealed: string }>(
    server.pool,
    sql`SELECT sealed FROM ${ident(server.schemas.app, 'notification_credentials')} WHERE scope_key = 'install'`,
  );
  expect(stored.rows[0]!.sealed.startsWith('rio1.')).toBe(true);
});

it('groups only unread selected kinds once per local digest slot and suppresses instant email', async () => {
  const person = await server.addMember();
  const sent: Array<{ to: string; text: string; subject: string }> = [];
  server.ctx.mailer = {
    send: async (message) => {
      sent.push(message);
    },
  };
  await command(person, {
    kind: 'notifications.preferences',
    update: {
      channels: { digest: { feedbackReply: true } },
      digest: { frequency: 'daily', hour: 0, timeZone: 'UTC' },
    },
  });
  await notice(person);
  await notice(person);
  await notice(person, 'feedbackReply', true);
  const now = new Date(Date.now() + 1000);
  await deliverChannels(server.app, fetch, now);
  await deliverChannels(server.app, fetch, now);
  await server.ctx.notifications!.drain();
  const own = sent.filter((message) => message.to === person.email);
  expect(own).toHaveLength(1);
  expect(own[0]!.text).toContain('Feedback replies: 2');
  const pending = await query<{ email: string }>(
    server.pool,
    sql`SELECT email FROM ${ident(server.schemas.app, 'notifications')} WHERE recipient_id = ${person.userId}`,
  );
  expect(pending.rows.every((row) => row.email === 'skipped')).toBe(true);
  server.ctx.mailer = null;
});

it('limits SMS to verified administrators and three alert attempts per hour', async () => {
  const person = await server.addMember();
  const sms = {
    channel: 'sms',
    accountSid: `AC${randomBytes(16).toString('hex')}`,
    authToken: randomBytes(24).toString('hex'),
    from: '+12025550103',
  };
  expect((await command(person, { kind: 'notifications.connection', connection: sms })).status).toBe(
    'rejected',
  );
  expect(
    (await command(person, { kind: 'notifications.phone.request', number: '+12025550104' })).status,
  ).toBe('rejected');
  expect(
    (
      await command(person, {
        kind: 'notifications.preferences',
        update: { channels: { sms: { securityEvent: true } } },
      })
    ).status,
  ).toBe('rejected');
  expect((await command(server.owner, { kind: 'notifications.connection', connection: sms })).status).toBe(
    'applied',
  );
  expect(
    (
      await command(server.owner, {
        kind: 'notifications.preferences',
        update: { channels: { sms: { mention: true } } },
      })
    ).status,
  ).toBe('rejected');
  await command(server.owner, {
    kind: 'notifications.preferences',
    update: { channels: { sms: { securityEvent: true } } },
  });
  await notice(server.owner, 'securityEvent');
  const texts: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    texts.push(new URLSearchParams(String(init?.body)).get('Body')!);
    return json({ status: 'queued' });
  };
  await deliverChannels(server.app, request);
  expect(texts).toHaveLength(0);
  await command(server.owner, { kind: 'notifications.phone.request', number: '+12025550104' });
  expect(
    (await command(server.owner, { kind: 'notifications.phone.request', number: '+12025550104' })).error
      ?.messageKey,
  ).toBe('notifications.phone.rateLimited');
  await deliverChannels(server.app, request);
  const code = texts[0]!.match(/\b[0-9]{6}\b/)![0];
  const incorrect = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  expect((await command(server.owner, { kind: 'notifications.phone.verify', code: incorrect })).status).toBe(
    'rejected',
  );
  expect((await preferences(server.owner)).phone?.verified).toBe(false);
  expect((await command(server.owner, { kind: 'notifications.phone.verify', code })).status).toBe('applied');
  for (let i = 0; i < 5; i += 1) await notice(server.owner, 'securityEvent');
  await queueNotificationChannels(server.ctx);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'notification_deliveries')} SET created_at = now() - interval '2 hours' WHERE user_id = ${server.owner.userId} AND channel = 'sms' AND state = 'pending'`,
  );
  await Promise.all([deliverChannels(server.app, request), deliverChannels(server.app, request)]);
  expect(texts).toHaveLength(4);
  expect((await preferences(server.owner)).phone?.verified).toBe(true);
});

it('honors organization channel shutdown and current membership before direct messages', async () => {
  const person = await server.addMember();
  await command(server.owner, {
    kind: 'notifications.connection',
    connection: { channel: 'slack', token: randomBytes(24).toString('hex') },
  });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { feedbackReply: true } } },
  });
  await notice(person);
  await command(server.owner, { kind: 'notifications.organization', update: { enabled: { slack: false } } });
  let calls = 0;
  const request: typeof fetch = async () => {
    calls += 1;
    return json({ ok: true });
  };
  await deliverChannels(server.app, request);
  expect(calls).toBe(0);
  await command(server.owner, { kind: 'notifications.organization', update: { enabled: { slack: true } } });
  await notice(person);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${person.userId}`,
  );
  await deliverChannels(server.app, request);
  expect(calls).toBe(0);
});

it('delivers selected direct messages once and retains rotated Graph credentials encrypted', async () => {
  const person = await server.addMember();
  const slackToken = randomBytes(24).toString('hex');
  const teams = {
    channel: 'teams' as const,
    tenantId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: randomBytes(24).toString('hex'),
    refreshToken: randomBytes(24).toString('hex'),
  };
  const rotated = randomBytes(24).toString('hex');
  await command(server.owner, {
    kind: 'notifications.connection',
    connection: { channel: 'slack', token: slackToken },
  });
  await command(server.owner, { kind: 'notifications.connection', connection: teams });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { feedbackReply: true }, teams: { feedbackReply: true } } },
  });
  const sent: string[] = [];
  const refreshes: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) {
      refreshes.push(new URLSearchParams(String(init?.body)).get('refresh_token')!);
      return json({ access_token: randomBytes(24).toString('hex'), refresh_token: rotated });
    }
    if (url.pathname.endsWith('/me')) return json({ id: 'sender' });
    if (url.pathname.endsWith('/users')) return json({ value: [{ id: 'recipient' }] });
    if (url.pathname.endsWith('/chats')) return json({ id: 'private' });
    if (url.pathname.endsWith('/messages')) {
      sent.push('teams');
      return json({ id: randomUUID() });
    }
    if (url.pathname.endsWith('/users.lookupByEmail')) {
      expect(new URLSearchParams(String(init?.body)).get('email')).toBe(person.email);
      return json({ ok: true, user: { id: 'U1' } });
    }
    if (url.pathname.endsWith('/conversations.open')) return json({ ok: true, channel: { id: 'D1' } });
    sent.push('slack');
    return json({ ok: true });
  };
  await notice(person);
  await deliverChannels(server.app, request);
  await deliverChannels(server.app, request);
  expect(sent.sort()).toEqual(['slack', 'teams']);
  await notice(person);
  await deliverChannels(server.app, request);
  expect(refreshes).toEqual([teams.refreshToken, rotated]);
  expect(JSON.stringify(await preferences(person))).not.toContain(rotated);
  const secrets = await query<{ sealed: string }>(
    server.pool,
    sql`SELECT sealed FROM ${ident(server.schemas.app, 'notification_credentials')} WHERE scope_key = ${person.info.org.id}`,
  );
  expect(JSON.stringify(secrets.rows)).not.toContain(rotated);
  expect(JSON.stringify(secrets.rows)).not.toContain(slackToken);
});

it('logs the failed Slack method and error code without private delivery data', async () => {
  const person = await server.addMember();
  const token = randomBytes(24).toString('hex');
  await command(server.owner, {
    kind: 'notifications.connection',
    connection: { channel: 'slack', token },
  });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { feedbackReply: true } } },
  });
  const id = await notice(person);
  const responseText = randomUUID();
  const warning = vi.spyOn(server.app.log, 'warn').mockImplementation(() => {});
  try {
    await deliverChannels(server.app, async () =>
      json({ ok: false, error: 'users_not_found', token, email: person.email, text: responseText }),
    );
    const delivery = await query<{ id: string; state: string }>(
      server.pool,
      sql`SELECT id, state FROM ${ident(server.schemas.app, 'notification_deliveries')} WHERE notification_id = ${id} AND channel = 'slack'`,
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0]!.state).toBe('failed');
    expect(warning).toHaveBeenCalledWith(
      {
        deliveryId: delivery.rows[0]!.id,
        channel: 'slack',
        messageKey: 'notifications.delivery.failed',
        serviceMethod: 'users.lookupByEmail',
        serviceError: 'users_not_found',
      },
      'notification delivery failed',
    );
    const logs = JSON.stringify(warning.mock.calls);
    for (const value of [token, person.email, responseText]) expect(logs).not.toContain(value);
  } finally {
    warning.mockRestore();
  }
});

it('keeps unread items eligible after a failed digest and retries them at the next scheduled slot', async () => {
  const person = await server.addMember();
  await notice(person);
  await command(person, {
    kind: 'notifications.preferences',
    update: {
      channels: { digest: { feedbackReply: true } },
      digest: { frequency: 'daily', hour: 0, timeZone: 'UTC' },
    },
  });
  const now = new Date(Date.now() + 1000);
  server.ctx.mailer = {
    send: async () => {
      throw new Error();
    },
  };
  await deliverChannels(server.app, fetch, now);
  const sent: string[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      if (message.to === person.email) sent.push(message.text);
    },
  };
  await deliverChannels(server.app, fetch, now);
  expect(sent).toEqual([]);
  await deliverChannels(server.app, fetch, new Date(now.getTime() + 86_400_000));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Feedback replies: 1');
  server.ctx.mailer = null;
});

it('fans out durable admin alerts once and reports unreadable delivery credentials', async () => {
  const person = await server.addMember();
  const orgId = server.owner.info.org.id;
  for (const action of ['auth.second_step.failed', 'organization.export.failed', 'updates.update_failed'])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.audit, 'events')}(org_id, action) VALUES (${orgId}, ${action})`,
    );
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { slack: { feedbackReply: true } } },
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'notification_credentials')} SET sealed = ${randomBytes(24).toString('hex')} WHERE scope_key = ${orgId} AND name = 'slack'`,
  );
  await notice(person);
  const request: typeof fetch = async () => json({ status: 'queued' });
  await deliverChannels(server.app, request);
  await Promise.all([deliverChannels(server.app, request), deliverChannels(server.app, request)]);
  const alerts = await query<{ kind: string; recipient_id: string }>(
    server.pool,
    sql`SELECT kind, recipient_id FROM ${ident(server.schemas.app, 'notifications')}
    WHERE subject_id IN (SELECT event_id FROM ${ident(server.schemas.app, 'notification_alert_events')})`,
  );
  // The unreadable Slack connection is a vault that can't be reached, which alerts the owner and
  // Integrations administrators, and this organization's only administrator is its owner.
  expect(alerts.rows.map((row) => row.kind).sort()).toEqual([
    'backupFailed',
    'securityEvent',
    'updateFailed',
    'vaultUnavailable',
  ]);
  expect(alerts.rows.every((row) => row.recipient_id === server.owner.userId)).toBe(true);
});

it('records an unreachable vault once an hour and alerts only the owner and Integrations administrators', async () => {
  const fresh = await freshOrganization();
  const integrations = await fresh.join('member', ['integrations']);
  const others = [
    await fresh.join('member', ['security']),
    await fresh.join('member', ['people']),
    await fresh.join('member'),
  ];
  expect(await fresh.vaultEvents()).toBe(0);
  // However many deliveries fail at once, an unreachable vault is recorded once an hour.
  await Promise.all([
    recordCredentialAlert(server.ctx, fresh.orgId),
    recordCredentialAlert(server.ctx, fresh.orgId),
  ]);
  expect(await fresh.vaultEvents()).toBe(1);
  await recordCredentialAlert(server.ctx, fresh.orgId);
  expect(await fresh.vaultEvents()).toBe(1);
  const sent: Array<{ to: string; text: string }> = [];
  server.ctx.mailer = {
    send: async (message) => {
      sent.push(message);
    },
  };
  const request: typeof fetch = async () => json({ status: 'queued' });
  try {
    // Two passes at once fan the one event out once, and only to the people who can reconnect.
    await Promise.all([deliverChannels(server.app, request), deliverChannels(server.app, request)]);
    await server.ctx.notifications!.drain();
  } finally {
    server.ctx.mailer = null;
  }
  const alerts = await query<{ recipient_id: string }>(
    server.pool,
    sql`SELECT recipient_id FROM ${ident(server.schemas.app, 'notifications')}
    WHERE org_id = ${fresh.orgId} AND kind = 'vaultUnavailable'`,
  );
  expect(alerts.rows.map((row) => row.recipient_id).sort()).toEqual(
    [integrations.userId, fresh.owner.userId].sort(),
  );
  // Each email leads to the organization's own channels, which only they can open, and says what
  // happened to the messages.
  const linked = sent.filter((message) => message.text.includes('/settings/notifications#organization'));
  const to = new Set(linked.map((message) => message.to));
  expect(to).toContain(fresh.owner.email);
  expect(to).toContain(integrations.email);
  for (const other of others) expect(to).not.toContain(other.email);
  const email = linked.find((message) => message.to === integrations.email)!;
  expect(email.text).toContain(
    'Slack, Teams, and text messages for that time weren’t sent, and each notification stays in the bell.',
  );
  expect(email.text).not.toContain('messages wait');
});

it('records a vault alert only when the organization’s own connections can’t be read', async () => {
  const fresh = await freshOrganization();
  const person = await fresh.join('member');
  // A credential profile that failed has an alert of its own, which doesn't hold this one back.
  await new CredentialStore(server.ctx).failed(fresh.orgId, `vault-${randomUUID()}`);
  // A person's phone record uses the server's own key, not a vault.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'notification_phones')}(org_id, user_id, sealed)
    VALUES (${fresh.orgId}, ${person.userId}, ${randomBytes(24).toString('hex')})`,
  );
  await notice(person);
  await deliverChannels(server.app, async () => json({ ok: true }));
  expect(await fresh.vaultEvents()).toBe(0);
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'notification_phones')} WHERE org_id = ${fresh.orgId}`,
  );
  // So does the installation's push key.
  await command(person, { kind: 'notifications.push.subscribe', subscription: subscription().input });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { push: { feedbackReply: true } } },
  });
  const vapid = (
    await query<{ sealed: string }>(
      server.pool,
      sql`SELECT sealed FROM ${ident(server.schemas.app, 'notification_credentials')} WHERE scope_key = 'install' AND name = 'vapid'`,
    )
  ).rows[0]!.sealed;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'notification_credentials')} SET sealed = ${randomBytes(24).toString('hex')} WHERE scope_key = 'install' AND name = 'vapid'`,
  );
  let pushes = 0;
  try {
    await notice(person);
    await deliverChannels(server.app, async () => {
      pushes++;
      return new Response(null, { status: 201 });
    });
  } finally {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'notification_credentials')} SET sealed = ${vapid} WHERE scope_key = 'install' AND name = 'vapid'`,
    );
  }
  expect(pushes).toBe(0);
  expect(await fresh.vaultEvents()).toBe(0);
  // The organization's own connection is what a vault holds, so that one alerts.
  await command(fresh.owner, {
    kind: 'notifications.connection',
    connection: { channel: 'slack', token: randomBytes(24).toString('hex') },
  });
  await command(person, {
    kind: 'notifications.preferences',
    update: { channels: { push: { feedbackReply: false }, slack: { feedbackReply: true } } },
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'notification_credentials')} SET sealed = ${randomBytes(24).toString('hex')} WHERE scope_key = ${fresh.orgId} AND name = 'slack'`,
  );
  await notice(person);
  await deliverChannels(server.app, async () => json({ ok: true }));
  expect(await fresh.vaultEvents()).toBe(1);
});

it('keeps unreadable phone credentials from blocking email and another person’s push', async () => {
  const affected = await server.addMember();
  const healthy = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'notification_phones')}(org_id, user_id, sealed)
    VALUES (${affected.info.org.id}, ${affected.userId}, ${randomBytes(24).toString('hex')})`,
  );
  await command(healthy, { kind: 'notifications.push.subscribe', subscription: subscription().input });
  await command(healthy, {
    kind: 'notifications.preferences',
    update: { channels: { push: { feedbackReply: true } } },
  });
  await notice(affected);
  await notice(healthy);
  let pushes = 0;
  await deliverChannels(server.app, async () => {
    pushes++;
    return new Response(null, { status: 201 });
  });
  expect(pushes).toBe(1);
  const recipients: string[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      recipients.push(message.to);
    },
  };
  try {
    await server.ctx.notifications!.drain();
    expect(recipients).toContain(affected.email);
    expect(recipients).toContain(healthy.email);
  } finally {
    server.ctx.mailer = null;
  }
});

it('requires sessions and CSRF for channel settings and declares organization scope for administration', async () => {
  const person = await server.addMember();
  expect((await server.app.inject({ method: 'GET', url: '/api/notifications/channels' })).statusCode).toBe(
    401,
  );
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/notifications/commands',
        headers: { cookie: person.headers.cookie },
        payload: { id: newId('command'), kind: 'notifications.phone.remove' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/admin/notification-channels/commands',
        headers: person.headers,
        payload: {
          id: newId('command'),
          kind: 'notifications.organization',
          update: { enabled: { push: false } },
        },
      })
    ).statusCode,
  ).toBe(403);
});

it('has copy, a private payload, and a storable row for every notification kind', async () => {
  const person = await server.addMember();
  for (const kind of NOTIFICATION_KINDS) {
    expect(NOTIFICATION_COPY[`notifications.kind.${kind}`], kind).toBeDefined();
    const payloadFor = privatePayload({ kind, target: {} }, 'en-US', new URL(payload().url).origin);
    expect(payloadFor.title, kind).toBeTruthy();
    await notice(person, kind);
  }
});

it('reaches a verified administrator by SMS when the credential store loses a vault', async () => {
  const orgId = server.owner.info.org.id;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'notification_deliveries')} SET attempted_at = now() - interval '2 hours' WHERE channel = 'sms'`,
  );
  expect((await preferences(server.owner)).phone?.verified).toBe(true);
  await command(server.owner, {
    kind: 'notifications.preferences',
    update: { channels: { sms: { credentialVaultUnavailable: true } } },
  });
  const texts: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    texts.push(new URLSearchParams(String(init?.body)).get('Body')!);
    return json({ status: 'queued' });
  };
  await new CredentialStore(server.ctx).failed(orgId, `vault-${randomUUID()}`);
  await deliverChannels(server.app, request);
  await deliverChannels(server.app, request);
  expect(texts).toHaveLength(1);
});

it('includes a notification that committed late in the next digest instead of skipping it', async () => {
  const person = await server.addMember();
  await command(person, {
    kind: 'notifications.preferences',
    update: {
      channels: { digest: { feedbackReply: true } },
      digest: { frequency: 'daily', hour: 0, timeZone: 'UTC' },
    },
  });
  await notice(person);
  const sent: string[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      if (message.to !== person.email) return;
      sent.push(message.text);
      const late = await notice(person);
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'notifications')} SET created_at = now() - interval '1 hour' WHERE id = ${late}`,
      );
    },
  };
  const now = new Date(Date.now() + 1000);
  await deliverChannels(server.app, fetch, now);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Feedback replies: 1');
  await deliverChannels(server.app, fetch, new Date(now.getTime() + 86_400_000));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain('Feedback replies: 1');
  server.ctx.mailer = null;
});

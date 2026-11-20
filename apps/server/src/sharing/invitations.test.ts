import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Invitation, InvitationPreview, InviteResult, SessionInfo, newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp } from '../app.js';
import { tokenHash } from '../auth/database.js';
import type { MailMessage } from '../mail/index.js';
import { invitationMessage } from '../mail/messages.js';
import { startServer, useMainAuthority, type ServerFixture } from '../test/fixture.js';
import { createInvitation } from './invitations.js';

let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function fixture() {
  const server = await startServer(kit, 'invites', { baseUrl: 'https://database.example.test/' });
  cleanups.push(() => server.close());
  const messages: MailMessage[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      messages.push(message);
    },
  };
  return { ...server, messages };
}

function invite(
  server: ServerFixture,
  emails = ['invitee@example.test'],
  kind: 'member' | 'guest' = 'member',
) {
  return server.app.inject({
    method: 'POST',
    url: '/api/org/invitations',
    headers: {
      ...server.owner.headers,
      'x-forwarded-host': 'untrusted.example.test',
    },
    payload: { emails, kind },
  });
}

function tokenOf(message: MailMessage): string {
  const token = message.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  expect(token).toBeDefined();
  return token!;
}

function accept(server: ServerFixture, token: string, remoteAddress = '127.0.0.1') {
  return server.app.inject({
    method: 'POST',
    url: '/api/auth/invitations/accept',
    remoteAddress,
    payload: { token, name: '  New person  ', locale: 'fr-FR' },
  });
}

function expectNotFound(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ error: { code: 'not_found', messageKey: 'errors.notFound' } });
  expect(response.headers['set-cookie']).toBeUndefined();
}

describe('organization invitations', () => {
  it.each([
    ['America/Los_Angeles', '2026-03-07T20:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-31T19:00:00.000Z'],
    ['UTC', '2026-03-07T20:00:00.000Z'],
    ['UTC', '2026-10-31T19:00:00.000Z'],
  ])('keeps a seven-day elapsed lifetime in %s from %s', async (zone, now) => {
    const server = await fixture();
    const db = await server.pool.connect();
    try {
      await db.query('BEGIN');
      // Expiry uses the database clock, which JavaScript fake timers cannot pin. Shadow it only
      // on this connection; rolling back restores the schema and the creation-time default.
      await db.query('CREATE SCHEMA expiry_clock');
      await db.query(`CREATE FUNCTION expiry_clock.clock_timestamp() RETURNS timestamptz
        LANGUAGE sql STABLE AS $$ SELECT current_setting('test.now')::timestamptz $$`);
      await db.query('SET LOCAL search_path = expiry_clock, pg_catalog, public');
      await db.query("SELECT set_config('TimeZone', $1, true), set_config('test.now', $2, true)", [
        zone,
        now,
      ]);
      await query(
        db,
        sql`ALTER TABLE ${ident(server.schemas.app, 'invitations')}
          ALTER COLUMN created_at SET DEFAULT expiry_clock.clock_timestamp()`,
      );
      for (const kind of ['member', 'guest'] as const) {
        const { invitation } = await createInvitation(
          db,
          server.schemas.app,
          { orgId: server.owner.info.org.id, userId: server.owner.userId },
          { email: `${kind}@example.test`, kind },
        );
        expect(invitation.createdAt).toBe(now);
        expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(
          7 * 24 * 60 * 60 * 1000,
        );
      }
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it.each(['member', 'guest'] as const)(
    'invites and signs in a %s with a single-use, hashed link',
    async (kind) => {
      const server = await fixture();
      const response = await invite(server, ['  INVITEE@example.test  '], kind);
      expect(response.statusCode).toBe(200);
      const result = InviteResult.parse(response.json());
      expect(result.alreadyMembers).toEqual([]);
      expect(result.invited).toHaveLength(1);
      const invitation = result.invited[0]!;
      expect(invitation).toMatchObject({
        email: 'invitee@example.test',
        kind,
        invitedBy: server.owner.userId,
      });
      expect(server.messages).toHaveLength(1);
      const message = server.messages[0]!;
      expect(message.to).toBe(invitation.email);
      expect(message.subject).toBe('You’re invited to Test organization on Riosoma');
      const token = tokenOf(message);
      const link = `https://database.example.test/join#token=${token}`;
      expect(message.text).toBe(
        `Owner invited you to join Test organization on Riosoma.  Use this link to accept: ${link}  It works for 7 days.  If you weren’t expecting this, you can ignore this email.`,
      );
      expect(message.html).toContain(`<a href="${link}">`);
      expect(message.text).not.toContain('untrusted.example.test');
      expect(response.body).not.toContain(token);
      const stored = await query<{ token_hash: string }>(
        server.pool,
        sql`
      SELECT token_hash FROM ${ident(server.schemas.app, 'invitations')} WHERE id = ${invitation.id}`,
      );
      expect(stored.rows[0]!.token_hash).toBe(tokenHash(token));
      const lifetime = Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt);
      expect(lifetime).toBeGreaterThanOrEqual(7 * 86_400_000);
      expect(lifetime).toBeLessThan(7 * 86_400_000 + 1000);

      const pending = await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers });
      expect(Invitation.array().parse(pending.json())).toEqual([invitation]);
      const preview = await server.app.inject({ url: `/api/auth/invitations/${token}` });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['cache-control']).toBe('no-store');
      expect(InvitationPreview.parse(preview.json())).toEqual({
        orgName: 'Test organization',
        email: invitation.email,
        invitedByName: 'Owner',
        level: { start: kind === 'guest' ? 'simple' : 'standard', highest: 'advanced' },
      });

      const accepted = await accept(server, token);
      expect(accepted.statusCode).toBe(200);
      const info = SessionInfo.parse(accepted.json());
      expect(info).toMatchObject({
        user: { email: invitation.email, name: 'New person', locale: 'fr-FR' },
        membership: { kind, adminRoles: [] },
        org: server.owner.info.org,
      });
      const cookie = String(accepted.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      const signedIn = await server.app.inject({
        url: '/api/auth/session',
        headers: { cookie: cookie.split(';')[0]! },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json()).toEqual(info);
      expect(
        (await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers })).json(),
      ).toEqual([]);
      expectNotFound(await accept(server, token));
      expectNotFound(await server.app.inject({ url: `/api/auth/invitations/${token}` }));
    },
  );

  it('rejects expired, revoked, and unknown links in preview and acceptance', async () => {
    const server = await fixture();
    const result = InviteResult.parse(
      (await invite(server, ['expired@example.test', 'revoked@example.test'])).json(),
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'invitations')}
      SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${result.invited[0]!.id}`,
    );
    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/api/org/invitations/${result.invited[1]!.id}`,
      headers: server.owner.headers,
    });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.body).toBe('');
    for (const token of [...server.messages.map(tokenOf), 'x'.repeat(43)]) {
      expectNotFound(await server.app.inject({ url: `/api/auth/invitations/${token}` }));
      expectNotFound(await accept(server, token));
    }
    expectNotFound(await server.app.inject({ url: '/api/auth/invitations/short' }));
    expect(
      (await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers })).json(),
    ).toEqual([]);
  });

  it('replaces pending links, deduplicates addresses, and skips existing members', async () => {
    const server = await fixture();
    const existing = await server.addMember();
    const emails = [
      'fresh@example.test',
      ' FRESH@example.test ',
      existing.email.toUpperCase(),
      server.owner.email,
    ];
    const first = InviteResult.parse((await invite(server, emails)).json());
    expect(first.invited).toHaveLength(1);
    expect(first.alreadyMembers).toEqual([existing.email, server.owner.email]);
    const oldToken = tokenOf(server.messages[0]!);
    const replacement = InviteResult.parse((await invite(server, ['fresh@example.test'], 'guest')).json());
    expect(replacement.invited[0]!.id).not.toBe(first.invited[0]!.id);
    expect(server.messages).toHaveLength(2);
    expectNotFound(await accept(server, oldToken));
    expectNotFound(await server.app.inject({ url: `/api/auth/invitations/${oldToken}` }));
    const pending = await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers });
    expect(pending.json()).toEqual(replacement.invited);
    expect(
      SessionInfo.parse((await accept(server, tokenOf(server.messages[1]!))).json()).membership.kind,
    ).toBe('guest');
  });

  it('serializes concurrent replacements and accepts a link only once', async () => {
    const server = await fixture();
    const invitations = await Promise.all([invite(server), invite(server)]);
    expect(invitations.map((r) => r.statusCode)).toEqual([200, 200]);
    const previews = await Promise.all(
      server.messages.map((message) =>
        server.app.inject({ url: `/api/auth/invitations/${tokenOf(message)}` }),
      ),
    );
    expect(previews.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const token = tokenOf(server.messages[previews.findIndex((r) => r.statusCode === 200)]!);
    const results = await Promise.all([
      accept(server, token, '192.0.2.1'),
      accept(server, token, '192.0.2.2'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const members = await query(
      server.pool,
      sql`SELECT user_id FROM ${ident(server.schemas.app, 'memberships')}`,
    );
    expect(members.rowCount).toBe(2);
  });

  it('preserves the identity and membership when the invitee has already joined', async () => {
    const server = await fixture();
    await invite(server, ['existing@example.test'], 'guest');
    const member = await server.addMember({ name: 'Existing person' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')}
      SET email = 'Existing@example.test', locale = 'es-ES', preferences = ${JSON.stringify({ sounds: false })}::jsonb
      WHERE id = ${member.userId}`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')}
      SET admin_roles = ARRAY['people'] WHERE user_id = ${member.userId}`,
    );
    const result = await accept(server, tokenOf(server.messages[0]!));
    expect(result.statusCode).toBe(200);
    expect(SessionInfo.parse(result.json())).toMatchObject({
      user: { id: member.userId, name: 'Existing person', email: 'Existing@example.test', locale: 'es-ES' },
      membership: { kind: 'member', adminRoles: ['people'] },
      preferences: { sounds: false },
    });
  });

  it('defaults a new account to English and refuses to reactivate a disabled account', async () => {
    const server = await fixture();
    await invite(server, ['default@example.test', 'disabled@example.test']);
    const accepted = await server.app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { token: tokenOf(server.messages[0]!), name: 'Default language' },
    });
    expect(SessionInfo.parse(accepted.json()).user.locale).toBe('en-US');
    const member = await server.addMember();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')}
      SET email = 'disabled@example.test', deactivated_at = clock_timestamp() WHERE id = ${member.userId}`,
    );
    expectNotFound(await accept(server, tokenOf(server.messages[1]!)));
    const row = await query<{ accepted_at: Date | null }>(
      server.pool,
      sql`
      SELECT accepted_at FROM ${ident(server.schemas.app, 'invitations')} WHERE email = 'disabled@example.test'`,
    );
    expect(row.rows[0]!.accepted_at).toBeNull();
  });

  it('requires a People administrator and CSRF for changes', async () => {
    const server = await fixture();
    const member = await server.addMember();
    const invitation = InviteResult.parse((await invite(server)).json()).invited[0]!;
    for (const headers of [member.headers, {}]) {
      const status = 'cookie' in headers ? 403 : 401;
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/org/invitations',
            headers,
            payload: { emails: ['other@example.test'] },
          })
        ).statusCode,
      ).toBe(status);
      expect((await server.app.inject({ url: '/api/org/invitations', headers })).statusCode).toBe(status);
      expect(
        (await server.app.inject({ method: 'DELETE', url: `/api/org/invitations/${invitation.id}`, headers }))
          .statusCode,
      ).toBe(status);
    }
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/org/invitations',
          headers: { cookie: server.owner.headers.cookie },
          payload: { emails: ['csrf@example.test'] },
        })
      ).statusCode,
    ).toBe(403);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['people'] WHERE user_id = ${member.userId}`,
    );
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/org/invitations',
          headers: member.headers,
          payload: { emails: ['admin-invited@example.test'] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/org/invitations/${invitation.id}`,
          headers: member.headers,
        })
      ).statusCode,
    ).toBe(204);
  });

  it('keeps invitation management within the organization', async () => {
    const server = await fixture();
    const orgId = newId('org');
    const invitationId = newId('invitation');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${orgId}, 'Other organization')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'invitations')} (id, org_id, email, token_hash, expires_at)
      VALUES (${invitationId}, ${orgId}, 'elsewhere@example.test', ${tokenHash('foreign token')}, clock_timestamp() + interval '7 days')`,
    );
    expect(
      (await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers })).json(),
    ).toEqual([]);
    expectNotFound(
      await server.app.inject({
        method: 'DELETE',
        url: `/api/org/invitations/${invitationId}`,
        headers: server.owner.headers,
      }),
    );
  });

  it('requires configured mail and a base URL, and does not wait for delivery', async () => {
    const server = await fixture();
    const mailer = server.ctx.mailer;
    server.ctx.mailer = null;
    const unavailable = await invite(server);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: 'unavailable', messageKey: 'org.invite.noMail' },
    });
    server.ctx.mailer = mailer;
    server.config.baseUrl = undefined;
    expect((await invite(server)).statusCode).toBe(503);
    expect(server.messages).toHaveLength(0);
    server.config.baseUrl = 'https://database.example.test';
    let finish: (() => void) | undefined;
    server.ctx.mailer = {
      send: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    try {
      expect((await invite(server)).statusCode).toBe(200);
      expect(finish).toBeDefined();
    } finally {
      finish?.();
    }
    server.ctx.mailer = {
      send: async () => {
        throw new Error('delivery failed');
      },
    };
    expect((await invite(server, ['failed@example.test'])).statusCode).toBe(200);
  });

  it('rate limits every attempt across instances and allows another IP or a new window', async () => {
    const server = await fixture();
    const second = await buildApp({ ...server.ctx });
    useMainAuthority(second, server.config);
    cleanups.push(() => second.close());
    await invite(server);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? server.app : second).inject({
          method: 'POST',
          url: '/api/auth/invitations/accept',
          remoteAddress: '192.0.2.20',
          headers: { 'x-forwarded-for': `192.0.2.${i + 30}` },
          payload: { token: 'x'.repeat(43), name: 'Attempt' },
        }),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 404)).toHaveLength(10);
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(2);
    const token = tokenOf(server.messages[0]!);
    const limited = await accept(server, token, '192.0.2.20');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: 'rate_limited', messageKey: 'auth.link.tooMany' },
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(900);
    expect((await accept(server, token, '192.0.2.21')).statusCode).toBe(200);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'auth_attempts')} SET at = clock_timestamp() - interval '16 minutes'`,
    );
    expectNotFound(await accept(server, 'x'.repeat(43), '192.0.2.20'));
  });

  it('counts malformed bodies and successful joins toward the attempt limit', async () => {
    const server = await fixture();
    await invite(server);
    expect((await accept(server, tokenOf(server.messages[0]!))).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/auth/invitations/accept',
            payload: { token: 'short', name: '' },
          })
        ).statusCode,
      ).toBe(422);
    }
    expect((await accept(server, 'x'.repeat(43))).statusCode).toBe(429);
  });

  it('audits creation, revocation, and acceptance without addresses or tokens', async () => {
    const server = await fixture();
    const result = InviteResult.parse(
      (await invite(server, ['accepted@example.test', 'revoked@example.test'])).json(),
    );
    const accepted = await accept(server, tokenOf(server.messages[0]!));
    const info = SessionInfo.parse(accepted.json());
    await server.app.inject({
      method: 'DELETE',
      url: `/api/org/invitations/${result.invited[1]!.id}`,
      headers: server.owner.headers,
    });
    const events = await query<{ action: string; org_id: string; actor_id: string; metadata: unknown }>(
      server.pool,
      sql`
      SELECT action, org_id, actor_id, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'org.invitation.%' ORDER BY id`,
    );
    expect(events.rows).toEqual([
      {
        action: 'org.invitation.created',
        org_id: info.org.id,
        actor_id: server.owner.userId,
        metadata: { count: 2 },
      },
      {
        action: 'org.invitation.accepted',
        org_id: info.org.id,
        actor_id: info.user.id,
        metadata: { invitationId: result.invited[0]!.id },
      },
      {
        action: 'org.invitation.revoked',
        org_id: info.org.id,
        actor_id: server.owner.userId,
        metadata: { invitationId: result.invited[1]!.id },
      },
    ]);
    const serialized = JSON.stringify(events.rows);
    for (const message of server.messages) {
      expect(serialized).not.toContain(message.to);
      expect(serialized).not.toContain(tokenOf(message));
    }
  });
});

it('uses the English fallback and escapes names and URLs in invitation HTML', () => {
  const message = invitationMessage(
    'person@example.test',
    'fr-FR',
    '<Org> & {link}',
    '<Inviter>',
    'https://example.test/join#token=a&b',
  );
  expect(message.subject).toBe('You’re invited to <Org> & {link} on Riosoma');
  expect(message.text).toContain('<Inviter> invited you to join <Org> & {link}');
  expect(message.html).toContain('&lt;Inviter&gt;');
  expect(message.html).toContain('&lt;Org&gt; &amp; {link}');
  expect(message.html).toContain('href="https://example.test/join#token=a&amp;b"');
  expect(message.html).not.toContain('<Inviter>');
});

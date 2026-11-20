import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InvitationPreview, InviteResult, SessionInfo } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

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
  const server = await startServer(kit, 'levels', { baseUrl: 'https://database.example.test/' });
  cleanups.push(() => server.close());
  const messages: MailMessage[] = [];
  server.ctx.mailer = {
    send: async (message) => {
      messages.push(message);
    },
  };
  return { ...server, messages };
}

function setLevels(server: ServerFixture, person: SignedIn, payload: object) {
  return server.app.inject({ method: 'PUT', url: '/api/admin/levels', headers: person.headers, payload });
}

function choose(server: ServerFixture, person: SignedIn, level: string) {
  return server.app.inject({
    method: 'PATCH',
    url: '/api/me/preferences',
    headers: person.headers,
    payload: { level },
  });
}

async function sessionOf(server: ServerFixture, person: SignedIn): Promise<SessionInfo> {
  const response = await server.app.inject({ url: '/api/auth/session', headers: person.headers });
  expect(response.statusCode).toBe(200);
  return SessionInfo.parse(response.json());
}

async function levelEvents(server: ServerFixture) {
  const result = await query<{ metadata: unknown }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'org.levels.updated' ORDER BY id`,
  );
  return result.rows.map((row) => row.metadata);
}

describe('the organization’s levels', () => {
  it('saves the default level and the guest limit into the settings every session carries', async () => {
    const server = await fixture();
    const saved = await setLevels(server, server.owner, { defaultLevel: 'simple', guestLevel: 'standard' });
    expect(saved.statusCode).toBe(200);
    // The rest of the settings, such as the default theme, stay as they were.
    expect(saved.json()).toMatchObject({
      defaultLevel: 'simple',
      guestLevel: 'standard',
      defaultTheme: { theme: 'nature' },
    });
    const member = await server.addMember();
    expect((await sessionOf(server, member)).org.settings).toMatchObject({
      defaultLevel: 'simple',
      guestLevel: 'standard',
    });
    // Saving the same choices again records nothing new.
    expect(
      (await setLevels(server, server.owner, { defaultLevel: 'simple', guestLevel: 'standard' })).statusCode,
    ).toBe(200);
    expect(await levelEvents(server)).toEqual([
      {
        from: { defaultLevel: null, guestLevel: null },
        to: { defaultLevel: 'simple', guestLevel: 'standard' },
      },
    ]);
  });

  it('is for owners and admins with the People role, and checks what it is sent', async () => {
    const server = await fixture();
    const member = await server.addMember();
    const refused = await setLevels(server, member, { defaultLevel: 'advanced', guestLevel: 'advanced' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'errors.adminOnly' } });

    const admin = await server.addMember({ name: 'People admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${['people']}
      WHERE user_id = ${admin.userId}`,
    );
    const allowed = await setLevels(server, admin, { defaultLevel: 'advanced', guestLevel: 'simple' });
    expect(allowed.statusCode).toBe(200);

    const invalid = await setLevels(server, server.owner, { defaultLevel: 'expert', guestLevel: 'simple' });
    expect(invalid.statusCode).toBe(422);
    const missing = await setLevels(server, server.owner, { defaultLevel: 'simple' });
    expect(missing.statusCode).toBe(422);
  });
});

describe('a person’s level', () => {
  it('holds guests to the organization’s limit, and nobody else', async () => {
    const server = await fixture();
    await setLevels(server, server.owner, { defaultLevel: 'standard', guestLevel: 'standard' });
    const guest = await server.addMember({ kind: 'guest' });
    const above = await choose(server, guest, 'advanced');
    expect(above.statusCode).toBe(403);
    expect(above.json()).toMatchObject({ error: { messageKey: 'levels.aboveGuestLimit' } });
    expect((await sessionOf(server, guest)).preferences.level).toBeUndefined();

    const within = await choose(server, guest, 'standard');
    expect(within.statusCode).toBe(200);
    expect(within.json()).toMatchObject({ level: 'standard' });

    const member = await server.addMember();
    expect((await choose(server, member, 'advanced')).statusCode).toBe(200);
    expect((await sessionOf(server, member)).preferences.level).toBe('advanced');
  });

  it('goes back to following the organization’s default once the choice is cleared', async () => {
    const server = await fixture();
    await setLevels(server, server.owner, { defaultLevel: 'standard', guestLevel: 'advanced' });
    const member = await server.addMember();
    await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: member.headers,
      payload: { level: 'simple', theme: 'nature' },
    });
    expect((await sessionOf(server, member)).preferences).toMatchObject({ level: 'simple', theme: 'nature' });

    const cleared = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: member.headers,
      payload: { level: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).not.toHaveProperty('level');
    // The other preferences stay, and a later change to the default reaches the person.
    const after = await sessionOf(server, member);
    expect(after.preferences.level).toBeUndefined();
    expect(after.preferences.theme).toBe('nature');
    await setLevels(server, server.owner, { defaultLevel: 'advanced', guestLevel: 'advanced' });
    expect((await sessionOf(server, member)).org.settings.defaultLevel).toBe('advanced');

    // Nothing else can be cleared this way.
    const theme = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: member.headers,
      payload: { theme: null },
    });
    expect(theme.statusCode).toBe(422);
  });

  it('lets a guest clear a choice, whatever the limit', async () => {
    const server = await fixture();
    const guest = await server.addMember({ kind: 'guest' });
    expect((await choose(server, guest, 'standard')).statusCode).toBe(200);
    await setLevels(server, server.owner, { defaultLevel: 'standard', guestLevel: 'simple' });
    const cleared = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: guest.headers,
      payload: { level: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((await sessionOf(server, guest)).preferences.level).toBeUndefined();
  });

  it('keeps the suggestion’s dismissal with the person', async () => {
    const server = await fixture();
    const saved = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: server.owner.headers,
      payload: { levelSuggestion: 'dismissed' },
    });
    expect(saved.statusCode).toBe(200);
    expect((await sessionOf(server, server.owner)).preferences.levelSuggestion).toBe('dismissed');
  });
});

describe('choosing a level while joining', () => {
  async function invitation(server: Awaited<ReturnType<typeof fixture>>, kind: 'member' | 'guest') {
    const email = `${kind}-${server.messages.length}@example.test`;
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/org/invitations',
      headers: server.owner.headers,
      payload: { emails: [email], kind },
    });
    expect(InviteResult.parse(response.json()).invited).toHaveLength(1);
    const token = server.messages.at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    return token;
  }

  function preview(server: ServerFixture, token: string) {
    return server.app
      .inject({ url: `/api/auth/invitations/${token}` })
      .then((response) => InvitationPreview.parse(response.json()));
  }

  function join(server: ServerFixture, token: string, level?: string) {
    return server.app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { token, name: 'New person', ...(level ? { level } : {}) },
    });
  }

  it('tells the invitee where they start and how far up they can go', async () => {
    const server = await fixture();
    await setLevels(server, server.owner, { defaultLevel: 'advanced', guestLevel: 'standard' });
    expect((await preview(server, await invitation(server, 'member'))).level).toEqual({
      start: 'advanced',
      highest: 'advanced',
    });
    expect((await preview(server, await invitation(server, 'guest'))).level).toEqual({
      start: 'simple',
      highest: 'standard',
    });
  });

  it('keeps the level chosen while joining, held to the guest limit', async () => {
    const server = await fixture();
    await setLevels(server, server.owner, { defaultLevel: 'standard', guestLevel: 'standard' });
    const member = await join(server, await invitation(server, 'member'), 'advanced');
    expect(member.statusCode).toBe(200);
    expect(SessionInfo.parse(member.json()).preferences.level).toBe('advanced');

    const guest = await join(server, await invitation(server, 'guest'), 'advanced');
    expect(guest.statusCode).toBe(200);
    expect(SessionInfo.parse(guest.json()).preferences.level).toBe('standard');

    // Someone who keeps the suggested level makes no choice, so the default keeps applying.
    const quiet = await join(server, await invitation(server, 'member'));
    expect(SessionInfo.parse(quiet.json()).preferences.level).toBeUndefined();
  });
});

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { ident, query, sql } from '@riosoma/db';
import { newId, type AccountSession } from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import type { MailMessage } from '../mail/index.js';
import { tokenHash } from './database.js';
import { attemptKey } from './attempts.js';
import { accountMessages } from './messages.js';
import { ownerResetLink } from '../tools/password-reset.js';
import { runAuthenticationCommand } from '../data/commands/authentication.js';
import * as accountStore from './account-store.js';
import * as passwords from './passwords.js';

let kit: TestPostgres;
let server: ServerFixture;
let messages: MailMessage[];
const initialPasswords = new Map<string, string>();
const password = () => `new password ${randomBytes(18).toString('hex')}`;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
beforeEach(async () => {
  server = await startServer(kit, 'reset_sessions', { baseUrl: 'http://example.test' });
  messages = [];
  initialPasswords.clear();
  server.ctx.mailer = {
    async send(message) {
      messages.push(message);
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
});
afterAll(async () => {
  await kit?.stop();
});

const table = (name: string) => ident(server.schemas.app, name);
const post = (url: string, payload: Record<string, unknown>, who?: SignedIn) =>
  server.app.inject({ method: 'POST', url, payload, ...(who ? { headers: who.headers } : {}) });
const tokenIn = (link: string) => new URL(link).hash.slice('#token='.length);
async function resetLink(who: SignedIn) {
  const response = await post(
    `/api/admin/people/${who.userId}/password-reset`,
    { delivery: 'copy' },
    server.owner,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ link: string }>().link;
}
async function sessions(who: SignedIn) {
  const result = await server.app.inject({ url: '/api/me/sessions', headers: who.headers });
  expect(result.statusCode, result.body).toBe(200);
  return result.json<AccountSession[]>();
}
async function addMember(options?: Parameters<ServerFixture['addMember']>[0]) {
  const member = await server.addMember(options);
  const value = password();
  initialPasswords.set(member.email, value);
  await query(
    server.pool,
    sql`UPDATE ${table('users')} SET password_hash = ${await passwords.hashPassword(value)} WHERE id = ${member.userId}`,
  );
  return member;
}
async function signIn(email: string, value = initialPasswords.get(email)!) {
  return post('/api/auth/sign-in', { email, password: value });
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('condition timed out');
}

it('answers known and unknown addresses before account lookup or email delivery can finish', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = accountStore.accountByEmail;
  const lookup = vi.spyOn(accountStore, 'accountByEmail').mockImplementation(async (...args) => {
    await blocked;
    return original(...args);
  });
  try {
    const member = await addMember();
    const emails = [member.email, `absent-${randomBytes(8).toString('hex')}@example.test`];
    const outcomes = await Promise.all(
      emails.map(async (email) => {
        const started = performance.now();
        const response = await post('/api/auth/password-reset', { email });
        return { status: response.statusCode, body: response.body, time: performance.now() - started };
      }),
    );
    expect(outcomes.map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 202, body: '' },
      { status: 202, body: '' },
    ]);
    expect(outcomes.every((outcome) => outcome.time < 1000)).toBe(true);
    expect(messages).toEqual([]);
    const recorded = await query<{ address_hash: string; request_number: string }>(
      server.pool,
      sql`SELECT address_hash, request_number FROM ${table('password_reset_latest_requests')}`,
    );
    expect(recorded.rows.map((row) => row.address_hash).sort()).toEqual(emails.map(tokenHash).sort());
    for (const email of emails) expect(JSON.stringify(recorded.rows)).not.toContain(email);
    await until(() => lookup.mock.calls.length === 2);
  } finally {
    release();
  }
  await until(() => messages.length === 1);
  expect(messages[0]!.text).toContain('30 minutes');
  expect(messages[0]!.text).toContain('administrator');
});

it('stores only token hashes, replaces older links, expires them, and consumes a reset exactly once', async () => {
  const member = await addMember();
  const old = tokenIn(await resetLink(member));
  const token = tokenIn(await resetLink(member));
  const stored = await query<{ token_hash: string; lifetime: number }>(
    server.pool,
    sql`SELECT token_hash, extract(epoch FROM expires_at - created_at)::float8 AS lifetime FROM ${table('login_tokens')} WHERE token_hash = ${tokenHash(token)}`,
  );
  expect(stored.rows[0]!.token_hash).toBe(tokenHash(token));
  expect(stored.rows[0]!.lifetime).toBeGreaterThanOrEqual(1800);
  expect(stored.rows[0]!.lifetime).toBeLessThan(1805);
  expect(JSON.stringify(stored.rows)).not.toContain(token);
  expect(
    (await post('/api/auth/password-reset/redeem', { token: old, password: password() })).statusCode,
  ).toBe(401);
  await query(
    server.pool,
    sql`UPDATE ${table('login_tokens')} SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = ${tokenHash(token)}`,
  );
  expect((await post('/api/auth/password-reset/redeem', { token, password: password() })).statusCode).toBe(
    401,
  );
  const fresh = tokenIn(await resetLink(member));
  const value = password();
  const outcomes = await Promise.all(
    [1, 2].map(() => post('/api/auth/password-reset/redeem', { token: fresh, password: value })),
  );
  expect(outcomes.map((result) => result.statusCode).sort()).toEqual([204, 401]);
  expect((await signIn(member.email, value)).statusCode).toBe(200);
  expect((await signIn(member.email)).statusCode).toBe(401);
  await until(() => messages.some((message) => message.subject === 'Your Riosoma password changed'));
  const audit = await query<{ action: string; metadata: unknown }>(
    server.pool,
    sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}`,
  );
  expect(audit.rows.map((row) => row.action)).toContain('auth.password_reset.completed');
  expect(JSON.stringify(audit.rows)).not.toContain(fresh);
  expect(JSON.stringify(audit.rows)).not.toContain(value);
});

it('invalidates an older reset link as soon as a newer request is accepted before delivery can look up the account', async () => {
  const member = await addMember();
  const token = tokenIn(await resetLink(member));
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = accountStore.accountByEmail;
  vi.spyOn(accountStore, 'accountByEmail').mockImplementation(async (...args) => {
    started();
    await blocked;
    return original(...args);
  });
  try {
    const accepted = await post('/api/auth/password-reset', { email: member.email.toUpperCase() });
    expect(accepted.statusCode, accepted.body).toBe(202);
    await ready;
    expect(messages).toHaveLength(0);
    const refused = await post('/api/auth/password-reset/redeem', { token, password: password() });
    expect(refused.statusCode, refused.body).toBe(401);
    expect((await signIn(member.email)).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/api/auth/session', headers: member.headers })).statusCode).toBe(
      200,
    );
  } finally {
    release();
  }
  await until(() => messages.length === 1);
  const fresh = /#token=([\w-]+)/.exec(messages[0]!.text)![1]!;
  expect(
    (await post('/api/auth/password-reset/redeem', { token: fresh, password: password() })).statusCode,
  ).toBe(204);
});

it('ends every session on reset, closes live connections, and keeps second factors and recovery codes', async () => {
  const member = await addMember();
  const another = await signIn(member.email);
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  server.config.baseUrl = address;
  const socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
    headers: { cookie: member.headers.cookie, origin: address },
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener('close', () => resolve(), { once: true }),
  );
  const secret = randomBytes(40).toString('base64url');
  await query(
    server.pool,
    sql`INSERT INTO ${table('authenticator_secrets')} (user_id, sealed_secret, confirmed_at)
    VALUES (${member.userId}, ${secret}, clock_timestamp())`,
  );
  const codeHash = tokenHash(randomBytes(32).toString('hex'));
  await query(
    server.pool,
    sql`INSERT INTO ${table('recovery_codes')} (user_id, code_hash) VALUES (${member.userId}, ${codeHash})`,
  );
  const publicKey = randomBytes(65);
  const credentialId = randomBytes(32).toString('base64url');
  await query(
    server.pool,
    sql`INSERT INTO ${table('passkeys')} (id, user_id, credential_id, public_key, user_handle, name)
    VALUES (${randomBytes(16).toString('hex')}, ${member.userId}, ${credentialId}, ${publicKey},
      ${randomBytes(32).toString('base64url')}, 'Test passkey')`,
  );
  const value = password();
  const reset = await post(
    '/api/auth/password-reset/redeem',
    { token: tokenIn(await resetLink(member)), password: value },
    member,
  );
  expect(reset.statusCode, reset.body).toBe(204);
  await Promise.race([
    closed,
    delay(4000).then(() => {
      throw new Error('live connection stayed open');
    }),
  ]);
  expect((await server.app.inject({ url: '/api/auth/session', headers: member.headers })).statusCode).toBe(
    401,
  );
  const cookie = (another.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
  expect((await server.app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  server.config.baseUrl = 'https://example.test';
  const next = await signIn(member.email, value);
  expect(next.json().secondStep.methods).toContain('authenticator');
  expect(next.json().secondStep.methods).toContain('recovery');
  expect(next.json().secondStep.methods).toContain('passkey');
  expect(
    (
      await query<{ public_key: Buffer }>(
        server.pool,
        sql`SELECT public_key FROM ${table('passkeys')} WHERE credential_id = ${credentialId}`,
      )
    ).rows[0]!.public_key,
  ).toEqual(publicKey);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT sealed_secret FROM ${table('authenticator_secrets')} WHERE user_id = ${member.userId}`,
      )
    ).rows[0]!.sealed_secret,
  ).toEqual(secret);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT code_hash FROM ${table('recovery_codes')} WHERE user_id = ${member.userId}`,
      )
    ).rows[0]!.code_hash,
  ).toBe(codeHash);
});

it('closes a script connection when its session ends without a realtime tab', async () => {
  const member = await addMember();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  server.config.baseUrl = address;
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/scripts/${newId('script')}/run`, {
    headers: { cookie: member.headers.cookie, origin: address },
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    expect((await post('/api/me/sessions/end', {}, member)).statusCode).toBe(204);
    expect(
      await Promise.race([
        closed,
        delay(4000).then(() => {
          throw new Error('script connection stayed open');
        }),
      ]),
    ).toBe(4401);
  } finally {
    socket.close();
  }
});

it('invalidates pending first steps and earlier sign-in links after reset', async () => {
  const member = await addMember();
  await query(
    server.pool,
    sql`UPDATE ${table('orgs')} SET second_step_policy = 'everyone' WHERE id = ${server.owner.info.org.id}`,
  );
  const pending = await signIn(member.email);
  expect(pending.json().secondStep.stage).toBe('setup');
  const cookie = (pending.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
  await post('/api/auth/link', { email: member.email });
  await until(() => messages.length > 0);
  const signInToken = /#token=([\w-]+)/.exec(messages[0]!.text)![1]!;
  expect(
    (
      await post('/api/auth/password-reset/redeem', {
        token: tokenIn(await resetLink(member)),
        password: password(),
      })
    ).statusCode,
  ).toBe(204);
  const status = await server.app.inject({ url: '/api/auth/second-step', headers: { cookie } });
  expect(status.json().secondStep).toBeNull();
  const attempt = await server.app.inject({
    method: 'POST',
    url: '/api/auth/second-step/authenticator',
    headers: { cookie },
    payload: {},
  });
  expect(attempt.statusCode).toBe(401);
  expect((await post('/api/auth/link/redeem', { token: signInToken })).statusCode).toBe(401);
});

it('refuses password verification started before a reset can open a new session or first step', async () => {
  for (const secondStep of [false, true]) {
    const member = await addMember();
    if (secondStep)
      await query(
        server.pool,
        sql`INSERT INTO ${table('authenticator_secrets')} (user_id, sealed_secret, confirmed_at)
        VALUES (${member.userId}, ${randomBytes(40).toString('base64url')}, clock_timestamp())`,
      );
    const token = tokenIn(await resetLink(member));
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const verify = passwords.verifyPassword;
    const spy = vi.spyOn(passwords, 'verifyPassword').mockImplementationOnce(async (...args) => {
      const valid = await verify(...args);
      started();
      await blocked;
      return valid;
    });
    const signingIn = signIn(member.email);
    try {
      await ready;
      expect(
        (await post('/api/auth/password-reset/redeem', { token, password: password() })).statusCode,
      ).toBe(204);
    } finally {
      release();
    }
    expect((await signingIn).statusCode).toBe(401);
    spy.mockRestore();
  }
});

it('limits requests per address and per network without changing their public answers', async () => {
  const member = await addMember();
  for (let count = 0; count < 6; count++) {
    expect((await post('/api/auth/password-reset', { email: member.email })).statusCode).toBe(202);
    if (count < 5) await until(() => messages.length === count + 1);
  }
  await until(
    async () =>
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${table('login_tokens')} WHERE user_id = ${member.userId} AND purpose = 'recover'`,
        )
      ).rowCount === 5,
  );
  const latest = await query<{ accepted: string; issued: string }>(
    server.pool,
    sql`SELECT request_number::text AS accepted,
      (SELECT max(reset_request)::text FROM ${table('login_tokens')}
        WHERE user_id = ${member.userId} AND purpose = 'recover') AS issued
      FROM ${table('password_reset_latest_requests')} WHERE address_hash = ${tokenHash(member.email)}`,
  );
  expect(latest.rows[0]!.accepted).toBe(latest.rows[0]!.issued);
  const before = messages.length;
  await query(
    server.pool,
    sql`INSERT INTO ${table('auth_attempts')} (key) SELECT ${attemptKey('reset-ip', '127.0.0.1')} FROM generate_series(1, 100)`,
  );
  const other = await addMember();
  expect((await post('/api/auth/password-reset', { email: other.email })).statusCode).toBe(202);
  await delay(60);
  expect(messages.length).toBe(before);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${table('login_tokens')} WHERE user_id = ${other.userId} AND purpose = 'recover'`,
      )
    ).rowCount,
  ).toBe(0);
});

it('sends organization sign-in guidance for single-sign-on-only accounts and nothing for deactivated accounts', async () => {
  const member = await addMember();
  await query(
    server.pool,
    sql`UPDATE ${table('users')} SET password_hash = NULL WHERE id = ${member.userId}`,
  );
  expect((await post('/api/auth/password-reset', { email: member.email })).statusCode).toBe(202);
  await until(() => messages.length === 1);
  expect(messages[0]!.text).toContain('organization');
  expect(messages[0]!.text).not.toContain('#token=');
  await query(
    server.pool,
    sql`UPDATE ${table('users')} SET deactivated_at = clock_timestamp() WHERE id = ${member.userId}`,
  );
  expect((await post('/api/auth/password-reset', { email: member.email })).statusCode).toBe(202);
  await delay(60);
  expect(messages).toHaveLength(1);
});

it('enforces the policy switch, supports administrator email and copied links, and checks People scope', async () => {
  const member = await addMember();
  const outsider = await addMember();
  await resetLink(member);
  expect(
    (await post(`/api/admin/people/${member.userId}/password-reset`, { delivery: 'copy' }, outsider))
      .statusCode,
  ).toBe(403);
  expect((await post(`/api/admin/people/${member.userId}/sessions/end`, {}, outsider)).statusCode).toBe(403);
  expect(
    (
      await post(
        `/api/admin/people/${server.owner.userId}/password-reset`,
        { delivery: 'copy' },
        server.owner,
      )
    ).statusCode,
  ).toBe(403);
  await query(
    server.pool,
    sql`UPDATE ${table('memberships')} SET admin_roles = ARRAY['people'] WHERE user_id = ${outsider.userId}`,
  );
  expect(
    (await post(`/api/admin/people/${member.userId}/password-reset`, { delivery: 'email' }, outsider))
      .statusCode,
  ).toBe(200);
  expect(messages[0]!.text).toContain('#token=');
  const token = /#token=([\w-]+)/.exec(messages[0]!.text)![1]!;
  expect((await post(`/api/admin/people/${server.owner.userId}/sessions/end`, {}, outsider)).statusCode).toBe(
    403,
  );
  await server.app.inject({
    method: 'PUT',
    url: '/api/admin/password-reset/policy',
    headers: server.owner.headers,
    payload: { enabled: false },
  });
  expect((await server.app.inject({ url: '/api/auth/password-reset' })).json().enabled).toBe(false);
  expect((await post('/api/auth/password-reset/redeem', { token, password: password() })).statusCode).toBe(
    401,
  );
  expect(
    (await post(`/api/admin/people/${member.userId}/password-reset`, { delivery: 'copy' }, server.owner))
      .statusCode,
  ).toBe(403);
});

it('lets only an owner copy a reset link for a person with administration roles', async () => {
  const admin = await addMember();
  const security = await addMember();
  const lead = await addMember();
  const roles = async (who: SignedIn, value: string[]) =>
    query(
      server.pool,
      sql`UPDATE ${table('memberships')} SET admin_roles = ${value}::text[] WHERE user_id = ${who.userId}`,
    );
  await roles(admin, ['people']);
  await roles(security, ['security']);
  const unit = await post('/api/org/units', { name: 'Research', parentId: null }, server.owner);
  expect(unit.statusCode, unit.body).toBe(201);
  const granted = await server.app.inject({
    method: 'PUT',
    url: `/api/org/units/${unit.json<{ id: string }>().id}/admins/${lead.userId}`,
    headers: server.owner.headers,
    payload: { roles: ['security'] },
  });
  expect(granted.statusCode, granted.body).toBe(200);
  const copy = (target: SignedIn, who: SignedIn) =>
    post(`/api/admin/people/${target.userId}/password-reset`, { delivery: 'copy' }, who);
  for (const target of [security, lead]) {
    const refused = await copy(target, admin);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'auth.reset.adminLink' } });
    expect(refused.body).not.toContain('#token=');
  }
  const tokens = await query(
    server.pool,
    sql`SELECT 1 FROM ${table('login_tokens')} WHERE user_id IN (${security.userId}, ${lead.userId})`,
  );
  expect(tokens.rowCount).toBe(0);
  // The same administrator still sends the link to the person's own mailbox and ends their sessions.
  const emailed = await post(
    `/api/admin/people/${security.userId}/password-reset`,
    { delivery: 'email' },
    admin,
  );
  expect(emailed.statusCode, emailed.body).toBe(200);
  expect(emailed.json()).toEqual({});
  expect(messages).toHaveLength(1);
  expect(messages[0]!.to).toBe(security.email);
  expect((await post(`/api/admin/people/${security.userId}/sessions/end`, {}, admin)).statusCode).toBe(204);
  for (const target of [security, lead]) {
    const owned = await copy(target, server.owner);
    expect(owned.statusCode, owned.body).toBe(200);
    expect(owned.json<{ link: string }>().link).toContain('#token=');
  }
});

it('offers copied links without email and restricts the audited server command to the sole owner and local shell', async () => {
  server.ctx.mailer = null;
  const member = await addMember();
  expect((await server.app.inject({ url: '/api/auth/password-reset' })).json().email).toBe(false);
  const token = tokenIn(await resetLink(member));
  expect((await post('/api/auth/password-reset/redeem', { token, password: password() })).statusCode).toBe(
    204,
  );
  await expect(ownerResetLink(server.ctx, server.owner.email, false)).rejects.toMatchObject({
    messageKey: 'auth.reset.serverShell',
  });
  await expect(ownerResetLink(server.ctx, member.email, true)).rejects.toMatchObject({
    messageKey: 'auth.reset.soleOwner',
  });
  await server.app.inject({
    method: 'PUT',
    url: '/api/admin/password-reset/policy',
    headers: server.owner.headers,
    payload: { enabled: false },
  });
  const link = await ownerResetLink(server.ctx, server.owner.email, true);
  expect(new URL(link).pathname).toBe('/sign-in/reset');
  const audit = await query(
    server.pool,
    sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'auth.password_reset.server_created'`,
  );
  expect(audit.rowCount).toBe(1);
  expect(JSON.stringify(audit.rows)).not.toContain(tokenIn(link));
  expect(
    (await post('/api/auth/password-reset/redeem', { token: tokenIn(link), password: password() }))
      .statusCode,
  ).toBe(204);
  await query(
    server.pool,
    sql`UPDATE ${table('memberships')} SET kind = 'owner' WHERE user_id = ${member.userId}`,
  );
  await expect(ownerResetLink(server.ctx, server.owner.email, true)).rejects.toMatchObject({
    messageKey: 'auth.reset.soleOwner',
  });
  await expect(
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      fileURLToPath(new URL('../tools/password-reset.ts', import.meta.url)),
      server.owner.email,
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(accountMessages['auth.reset.serverShell']!),
  });
});

it('lists only the person’s sessions, marks the current device, and ends one or every other session', async () => {
  const member = await addMember();
  const before = await sessions(member);
  const another = await signIn(member.email);
  const listed = await sessions(member);
  expect(listed).toHaveLength(before.length + 1);
  expect(listed.filter((session) => session.current)).toHaveLength(1);
  expect(listed.every((session) => session.method === 'password')).toBe(true);
  expect(
    (await sessions(server.owner)).some((session) => listed.some((other) => other.id === session.id)),
  ).toBe(false);
  const otherId = listed.find((session) => !session.current)!.id;
  expect((await post('/api/me/sessions/end', { sessionId: otherId }, member)).statusCode).toBe(204);
  const cookie = (another.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
  expect((await server.app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  await signIn(member.email);
  expect((await post('/api/me/sessions/end', { others: true }, member)).statusCode).toBe(204);
  expect(await sessions(member)).toHaveLength(1);
  expect((await post(`/api/admin/people/${member.userId}/sessions/end`, {}, server.owner)).statusCode).toBe(
    204,
  );
  expect((await server.app.inject({ url: '/api/me/sessions', headers: member.headers })).statusCode).toBe(
    401,
  );
});

it('changes passwords with other-session sign-out selected by default and allows keeping them', async () => {
  const member = await addMember();
  await signIn(member.email);
  const value = password();
  expect(
    (
      await post(
        '/api/me/password',
        { currentPassword: initialPasswords.get(member.email)!, password: value },
        member,
      )
    ).statusCode,
  ).toBe(204);
  expect(await sessions(member)).toHaveLength(1);
  await signIn(member.email, value);
  expect(
    (
      await post(
        '/api/me/password',
        { currentPassword: value, password: password(), endOtherSessions: false },
        member,
      )
    ).statusCode,
  ).toBe(204);
  expect(await sessions(member)).toHaveLength(2);
  expect(
    (await post('/api/me/password', { currentPassword: password(), password: password() }, member))
      .statusCode,
  ).toBe(422);
});

it('refuses an account mutation from a session ended after the request was admitted', async () => {
  const actor = await server.ctx.sessions.resolve({
    cookies: Object.fromEntries([server.owner.headers.cookie.split('=')]),
    protocol: 'http',
  } as never);
  expect(actor).toBeTruthy();
  await post('/api/me/sessions/end', {}, server.owner);
  await expect(
    runAuthenticationCommand(server.ctx, { kind: 'auth.sessions.end' }, { actor: actor! }),
  ).rejects.toMatchObject({ code: 'unauthenticated' });
});

it('rechecks People authority when a role ends after the request was admitted', async () => {
  const admin = await addMember();
  await query(
    server.pool,
    sql`UPDATE ${table('memberships')} SET admin_roles = ARRAY['people'] WHERE user_id = ${admin.userId}`,
  );
  const person = await addMember();
  const actor = await server.ctx.sessions.resolve({
    cookies: Object.fromEntries([admin.headers.cookie.split('=')]),
    protocol: 'http',
  } as never);
  expect(actor?.adminRoles).toContain('people');
  await query(
    server.pool,
    sql`UPDATE ${table('memberships')} SET admin_roles = '{}' WHERE user_id = ${admin.userId}`,
  );
  await expect(
    runAuthenticationCommand(
      server.ctx,
      { kind: 'auth.reset.admin', userId: person.userId, delivery: 'copy' },
      { actor: actor! },
    ),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('names browser and system families in plain categories', () => {
  expect(accountStore.deviceWords('Mozilla Windows Chrome/140 Safari/537 Edg/140')).toEqual({
    browser: 'edge',
    system: 'windows',
  });
  expect(accountStore.deviceWords('Mozilla iPhone Safari/604')).toEqual({ browser: 'safari', system: 'ios' });
  expect(accountStore.deviceWords('Mozilla Android Chrome/140')).toEqual({
    browser: 'chrome',
    system: 'android',
  });
  expect(accountStore.deviceWords('Mozilla Linux Firefox/143')).toEqual({
    browser: 'firefox',
    system: 'linux',
  });
});

it('refuses protected data when a session ends while its read is running', async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = accountStore.accountSessions;
  vi.spyOn(accountStore, 'accountSessions').mockImplementation(async (...args) => {
    const listed = await original(...args);
    started();
    await blocked;
    return listed;
  });
  const reading = server.app
    .inject({ url: '/api/me/sessions', headers: server.owner.headers })
    .then((response) => response);
  try {
    await ready;
    expect((await post('/api/me/sessions/end', {}, server.owner)).statusCode).toBe(204);
  } finally {
    release();
  }
  const response = await reading;
  expect(response.statusCode).toBe(401);
  expect(response.body).not.toContain('lastSeenAt');
});

it('does not replace a newer reset link when an earlier delivery finishes late', async () => {
  const member = await addMember();
  const requestedAt = new Date();
  const earlier = await accountStore.nextResetRequest(server.pool, server.schemas);
  const later = await accountStore.nextResetRequest(server.pool, server.schemas);
  const newest = await runAuthenticationCommand(server.ctx, {
    kind: 'auth.reset.deliver',
    email: member.email,
    requestedAt,
    requestNumber: later,
  });
  const late = await runAuthenticationCommand(server.ctx, {
    kind: 'auth.reset.deliver',
    email: member.email,
    requestedAt,
    requestNumber: earlier,
  });
  expect(newest.message?.text).toContain('#token=');
  expect(late.message).toBeUndefined();
  const token = /#token=([\w-]+)/.exec(newest.message!.text)![1]!;
  expect((await post('/api/auth/password-reset/redeem', { token, password: password() })).statusCode).toBe(
    204,
  );
});

it('restricts People controls to the administrator’s units', async () => {
  const admin = await addMember();
  const inside = await addMember();
  const outside = await addMember();
  const create = async (name: string) => {
    const response = await post('/api/org/units', { name, parentId: null }, server.owner);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>();
  };
  const unit = await create('Research');
  const other = await create('Operations');
  for (const [person, placement] of [
    [admin, unit],
    [inside, unit],
    [outside, other],
  ] as const) {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/org/members/${person.userId}/unit`,
      headers: server.owner.headers,
      payload: { unitId: placement.id },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const granted = await server.app.inject({
    method: 'PUT',
    url: `/api/org/units/${unit.id}/admins/${admin.userId}`,
    headers: server.owner.headers,
    payload: { roles: ['people'] },
  });
  expect(granted.statusCode, granted.body).toBe(200);
  expect(
    (await post(`/api/admin/people/${inside.userId}/password-reset`, { delivery: 'copy' }, admin)).statusCode,
  ).toBe(200);
  expect(
    (await post(`/api/admin/people/${outside.userId}/password-reset`, { delivery: 'copy' }, admin))
      .statusCode,
  ).toBe(403);
  expect((await post(`/api/admin/people/${outside.userId}/sessions/end`, {}, admin)).statusCode).toBe(403);
  expect((await post(`/api/admin/people/${inside.userId}/sessions/end`, {}, admin)).statusCode).toBe(204);
});

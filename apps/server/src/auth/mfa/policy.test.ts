import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SessionInfo,
  type AuthenticatorSetup,
  type MfaOverview,
  type PasskeyAdded,
  type SecondStepPolicy,
  type SecondStepRequired,
  type SecondStepSetupDone,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { Mailer, MailMessage } from '../../mail/index.js';
import { TestAuthenticator, type CreationOptions, type RequestOptions } from '../../test/authenticator.js';
import { Browser } from '../../test/browser.js';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = 'a long test password';
let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function setup() {
  const server = await startServer(kit, 'mfapolicy', { baseUrl: `${BASE}/` });
  cleanups.push(() => server.close());
  return server;
}

/** A browser holding a session the fixture already opened. */
function holding(server: ServerFixture, person: SignedIn): Browser {
  const browser = new Browser(server.app);
  browser.setCookie('rio_session', person.headers.cookie.split('=')[1]!);
  browser.csrf = person.headers['x-csrf-token'];
  return browser;
}

function signIn(server: ServerFixture, email: string, browser = new Browser(server.app)) {
  return browser.post('/api/auth/sign-in', { email, password: PASSWORD });
}

async function setPolicy(server: ServerFixture, policy: SecondStepPolicy) {
  const response = await holding(server, server.owner).put('/api/admin/mfa/policy', { policy });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ policy });
}

function nowCode(secret: string, steps = 0): Promise<string> {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + steps * 30 });
}

async function events(server: ServerFixture, action: string) {
  const result = await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = ${action}
    ORDER BY id`,
  );
  return result.rows;
}

describe('the organization policy', () => {
  it('is changed only by owners and Security admins, and every change is recorded', async () => {
    const server = await setup();
    const owner = holding(server, server.owner);
    expect((await owner.get('/api/admin/mfa/policy')).json()).toEqual({ policy: 'off' });
    const member = holding(server, await server.addMember());
    expect((await member.put('/api/admin/mfa/policy', { policy: 'everyone' })).statusCode).toBe(403);
    expect((await member.get('/api/admin/mfa/policy')).statusCode).toBe(403);
    const invalid = await owner.put('/api/admin/mfa/policy', { policy: 'sometimes' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.fields.policy).toMatch(/^validation\./);

    const admin = await server.addMember({ name: 'Security admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${['security']}
      WHERE user_id = ${admin.userId}`,
    );
    const security = holding(server, admin);
    expect((await security.put('/api/admin/mfa/policy', { policy: 'admins' })).statusCode).toBe(200);
    await setPolicy(server, 'everyone');
    await setPolicy(server, 'everyone');
    expect((await owner.get('/api/admin/mfa/policy')).json()).toEqual({ policy: 'everyone' });
    const changes = await events(server, 'org.second_step.policy_updated');
    expect(changes.map((event) => event.metadata)).toEqual([
      { from: 'off', to: 'admins' },
      { from: 'admins', to: 'everyone' },
    ]);
    expect(changes[0]!.actor_id).toBe(admin.userId);
  });

  it('sends admins, or everyone, who have no second step to add one first', async () => {
    const server = await setup();
    const member = await server.addMember();
    const ai = await server.addMember({ name: 'AI admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${['ai']}
      WHERE user_id = ${ai.userId}`,
    );
    await setPolicy(server, 'admins');
    expect(SessionInfo.safeParse((await signIn(server, member.email)).json()).success).toBe(true);
    for (const email of [server.owner.email, ai.email]) {
      const response = await signIn(server, email);
      expect(response.json<SecondStepRequired>().secondStep).toMatchObject({
        stage: 'setup',
        methods: ['passkey', 'authenticator'],
        email,
      });
    }
    await setPolicy(server, 'everyone');
    const everyone = await signIn(server, member.email);
    expect(everyone.json<SecondStepRequired>().secondStep.stage).toBe('setup');
    const required = await holding(server, member).get('/api/me/mfa');
    expect(required.json<MfaOverview>().required).toBe(true);
    await setPolicy(server, 'off');
    expect(SessionInfo.safeParse((await signIn(server, member.email)).json()).success).toBe(true);
  });

  it('lets the setup stage add an authenticator app, and nothing else, before signing in', async () => {
    const server = await setup();
    const member = await server.addMember();
    await setPolicy(server, 'everyone');
    const browser = new Browser(server.app);
    await signIn(server, member.email, browser);
    expect(browser.cookie('rio_session')).toBeUndefined();
    for (const [method, url] of [
      ['GET', '/api/auth/session'],
      ['GET', '/api/me/mfa'],
      ['POST', '/api/me/mfa/authenticator'],
      ['GET', '/api/databases'],
    ] as const)
      expect((await browser.send(method, url)).statusCode).toBe(401);
    // The verify stage's route isn't open to someone with nothing to verify.
    const skipped = await browser.post('/api/auth/second-step', { method: 'recovery', code: 'aaaaa-bbbbb' });
    expect(skipped.statusCode).toBe(401);
    expect(skipped.json().error.messageKey).toBe('mfa.pending.expired');

    const started = await browser.post('/api/auth/second-step/authenticator');
    expect(started.statusCode).toBe(200);
    const { secret } = started.json<AuthenticatorSetup>();
    const wrong = await browser.post('/api/auth/second-step/authenticator/confirm', {
      code: await nowCode(secret, 5),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.messageKey).toBe('mfa.code.invalid');
    const done = await browser.post('/api/auth/second-step/authenticator/confirm', {
      code: await nowCode(secret),
    });
    expect(done.statusCode).toBe(200);
    const body = done.json<SecondStepSetupDone>();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(SessionInfo.parse(body.session).user.email).toBe(member.email);
    expect(browser.cookie('rio_second_step')).toBeUndefined();
    expect((await browser.get('/api/auth/session')).statusCode).toBe(200);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().authenticator.enabled).toBe(true);
    const [signedIn] = (await events(server, 'auth.sign_in')).slice(-1);
    expect(signedIn!.metadata).toMatchObject({ method: 'password', secondStep: 'authenticator' });
  });

  it('lets the setup stage add a passkey instead', async () => {
    const server = await setup();
    const member = await server.addMember();
    await setPolicy(server, 'everyone');
    const browser = new Browser(server.app);
    await signIn(server, member.email, browser);
    const options = await browser.post('/api/auth/second-step/passkeys/options');
    expect(options.statusCode).toBe(200);
    const creation = options.json<CreationOptions>();
    expect(creation.rp.id).toBe('riosoma.example.test');
    const authenticator = new TestAuthenticator(BASE);
    const done = await browser.post('/api/auth/second-step/passkeys', {
      name: 'Laptop',
      response: authenticator.register(creation),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json<SecondStepSetupDone>().recoveryCodes).toHaveLength(10);
    expect((await browser.get('/api/me/mfa')).json<MfaOverview>().passkeys.map((p) => p.name)).toEqual([
      'Laptop',
    ]);
    // Next time the passkey signs in on its own.
    const later = new Browser(server.app);
    const request = (await later.post('/api/auth/passkey/options')).json<{
      challenge: string;
      rpId: string;
    }>();
    expect(
      (await later.post('/api/auth/passkey', { response: authenticator.answer(request) })).statusCode,
    ).toBe(200);
  });

  it('turns the setup stage away once a second step exists some other way', async () => {
    const server = await setup();
    await setPolicy(server, 'everyone');
    const browser = new Browser(server.app);
    await signIn(server, server.owner.email, browser);
    const { secret } = (await browser.post('/api/auth/second-step/authenticator')).json<AuthenticatorSetup>();
    // The owner's session from before the policy adds an app of its own in the meantime.
    const owner = holding(server, server.owner);
    const own = (await owner.post('/api/me/mfa/authenticator')).json<AuthenticatorSetup>();
    expect(
      (await owner.post('/api/me/mfa/authenticator/confirm', { code: await nowCode(own.secret) })).statusCode,
    ).toBe(200);
    const late = await browser.post('/api/auth/second-step/authenticator/confirm', {
      code: await nowCode(secret),
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.messageKey).toBe('mfa.setup.notNeeded');
    expect(browser.cookie('rio_session')).toBeUndefined();
  });

  it('asks someone who accepts an invitation to add a second step first', async () => {
    const server = await setup();
    const mailer = new (class implements Mailer {
      messages: MailMessage[] = [];
      async send(message: MailMessage) {
        this.messages.push(message);
      }
    })();
    server.ctx.mailer = mailer;
    await setPolicy(server, 'everyone');
    const owner = holding(server, server.owner);
    const invited = await owner.post('/api/org/invitations', {
      emails: ['new@example.test'],
      kind: 'member',
    });
    expect(invited.statusCode).toBe(200);
    await vi.waitFor(() => expect(mailer.messages).toHaveLength(1));
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(mailer.messages[0]!.text)![1]!;
    const browser = new Browser(server.app);
    const accepted = await browser.post('/api/auth/invitations/accept', { token, name: 'New person' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<SecondStepRequired>().secondStep).toMatchObject({
      stage: 'setup',
      email: 'new@example.test',
    });
    expect(browser.cookie('rio_session')).toBeUndefined();
    expect((await browser.get('/api/auth/session')).statusCode).toBe(401);
  });
});

describe('resetting a person’s second steps', () => {
  /** A member with a passkey and an app, the app turned on with a recovery code as the proof. */
  async function withSecondSteps(server: ServerFixture) {
    const member = await server.addMember();
    const browser = holding(server, member);
    const options = (await browser.post('/api/me/mfa/passkeys/options')).json<CreationOptions>();
    const authenticator = new TestAuthenticator(BASE);
    const added = await browser.post('/api/me/mfa/passkeys', {
      name: 'Laptop',
      response: authenticator.register(options),
    });
    expect(added.statusCode).toBe(200);
    const [code] = added.json<PasskeyAdded>().recoveryCodes!;
    const { secret } = (await browser.post('/api/me/mfa/authenticator')).json<AuthenticatorSetup>();
    const confirmed = await browser.post('/api/me/mfa/authenticator/confirm', {
      code: await nowCode(secret),
      proof: { method: 'recovery', code },
    });
    expect(confirmed.statusCode).toBe(200);
    return { member, authenticator };
  }

  it('lets an owner clear them, records it, and shows nothing of them', async () => {
    const server = await setup();
    const { member } = await withSecondSteps(server);
    expect((await signIn(server, member.email)).json<SecondStepRequired>().secondStep.stage).toBe('verify');
    const owner = holding(server, server.owner);
    const reset = await owner.delete(`/api/admin/mfa/people/${member.userId}`);
    expect(reset.statusCode).toBe(204);
    expect(reset.body).toBe('');
    const again = new Browser(server.app);
    expect(SessionInfo.safeParse((await signIn(server, member.email, again)).json()).success).toBe(true);
    const overview = (await again.get('/api/me/mfa')).json<MfaOverview>();
    expect(overview).toMatchObject({
      passkeys: [],
      authenticator: { enabled: false },
      recoveryCodes: { remaining: 0 },
    });
    const [event] = await events(server, 'org.second_step.reset');
    expect(event).toEqual({
      actor_id: server.owner.userId,
      metadata: { userId: member.userId, passkeys: 1, authenticator: true, sessionsEnded: 1 },
    });
  });

  it('ends every session the person has, and no one else’s', async () => {
    const server = await setup();
    const { member, authenticator } = await withSecondSteps(server);
    const other = await server.addMember();
    const first = holding(server, member);
    // A passkey sign-in on another device gives the member a second session.
    const second = new Browser(server.app);
    const options = (await second.post('/api/auth/passkey/options')).json<RequestOptions>();
    expect(
      (await second.post('/api/auth/passkey', { response: authenticator.answer(options) })).statusCode,
    ).toBe(200);
    for (const browser of [first, second])
      expect((await browser.get('/api/auth/session')).statusCode).toBe(200);
    const owner = holding(server, server.owner);
    expect((await owner.delete(`/api/admin/mfa/people/${member.userId}`)).statusCode).toBe(204);
    for (const browser of [first, second]) {
      expect((await browser.get('/api/auth/session')).statusCode).toBe(401);
      expect((await browser.get('/api/databases')).statusCode).toBe(401);
    }
    expect((await owner.get('/api/auth/session')).statusCode).toBe(200);
    expect((await holding(server, other).get('/api/auth/session')).statusCode).toBe(200);
    // A second reset finds nothing left to end.
    expect((await owner.delete(`/api/admin/mfa/people/${member.userId}`)).statusCode).toBe(204);
    const resets = await events(server, 'org.second_step.reset');
    expect(resets.map((event) => event.metadata.sessionsEnded)).toEqual([2, 0]);
  });

  it('keeps resets to the Security area, away from owners unless an owner asks, and off yourself', async () => {
    const server = await setup();
    const { member } = await withSecondSteps(server);
    const people = await server.addMember({ name: 'People admin' });
    const admin = await server.addMember({ name: 'Security admin' });
    for (const [person, roles] of [
      [people, ['people']],
      [admin, ['security']],
    ] as const)
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${roles}
        WHERE user_id = ${person.userId}`,
      );
    const plain = await server.addMember();
    for (const who of [plain, people]) {
      const refused = await holding(server, who).delete(`/api/admin/mfa/people/${member.userId}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.messageKey).toBe('errors.adminOnly');
    }
    const security = holding(server, admin);
    const owner = await security.delete(`/api/admin/mfa/people/${server.owner.userId}`);
    expect(owner.statusCode).toBe(403);
    expect(owner.json().error.messageKey).toBe('mfa.reset.owner');
    const self = await security.delete(`/api/admin/mfa/people/${admin.userId}`);
    expect(self.statusCode).toBe(403);
    expect(self.json().error.messageKey).toBe('mfa.reset.self');
    expect((await security.delete('/api/admin/mfa/people/usrUnknown000000')).statusCode).toBe(404);
    expect((await security.delete(`/api/admin/mfa/people/${member.userId}`)).statusCode).toBe(204);
    expect((await events(server, 'org.second_step.reset')).length).toBe(1);
    // Refused resets end no one's sessions, and the admin's own stays open.
    expect((await holding(server, server.owner).get('/api/auth/session')).statusCode).toBe(200);
    expect((await security.get('/api/auth/session')).statusCode).toBe(200);
  });
});

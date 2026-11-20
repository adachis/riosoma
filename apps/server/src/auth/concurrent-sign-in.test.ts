import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type SessionInfo, type SsoProvider } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { TestAuthenticator, type CreationOptions, type RequestOptions } from '../test/authenticator.js';
import { Browser } from '../test/browser.js';
import {
  routeFetch,
  routeProviderRequests,
  startTestProvider,
  type TestProvider,
} from '../test/oidc-provider.js';
import { attemptKey } from './attempts.js';
import { hashPassword } from './passwords.js';
import { auditEvent, randomToken, tokenHash, withSignInTransaction } from './database.js';

const BASE = 'https://riosoma.example.test';
const PASSWORD = randomBytes(24).toString('base64url');
const runs = Number(process.env.RIOSOMA_SIGN_IN_STRESS_RUNS ?? 1);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Stress runs must be a positive integer');
let kit: TestPostgres;
let server: ServerFixture;
let idp: TestProvider;
let provider: SsoProvider;
let people: SignedIn[];
let passkeyPerson: SignedIn;
let authenticator: TestAuthenticator;

function sessionCookie(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) => value?.startsWith('rio_session='));
  expect(cookie, response.body).toBeDefined();
  return cookie!.split(';')[0]!;
}

function password(person: SignedIn) {
  return server.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    payload: { email: person.email, password: PASSWORD },
  });
}

// The browser fixture signs in, reads its session, and saves its preferred feature level.
async function fixtureSignIn(person: SignedIn) {
  const response = await password(person);
  expect(response.statusCode, response.body).toBe(200);
  const cookie = sessionCookie(response);
  const session = await server.app.inject({ url: '/api/auth/session', headers: { cookie } });
  expect(session.statusCode, session.body).toBe(200);
  const saved = await server.app.inject({
    method: 'PATCH',
    url: '/api/me/preferences',
    headers: { cookie, 'x-csrf-token': session.json<SessionInfo>().csrfToken },
    payload: { level: 'advanced' },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return response;
}

async function ssoCallback(person: { email: string }, subject: string) {
  idp.person = { sub: subject, email: person.email, email_verified: true, name: 'Member' };
  const started = await server.app.inject({ url: `/api/auth/sso/${provider.id}/start` });
  expect(started.statusCode, started.body).toBe(302);
  const location = new URL(String(started.headers.location), BASE);
  expect(location.pathname, String(started.headers.location)).toContain('/authorize');
  const callback = await idp.authorize(location.href);
  const header = started.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) => value?.startsWith('rio_sso='))!.split(';')[0]!;
  return () => server.app.inject({ url: `${callback.pathname}${callback.search}`, headers: { cookie } });
}

async function magicLink(person: SignedIn) {
  const token = randomToken();
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".login_tokens
       (id, user_id, email, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, 'magic_link', $4, clock_timestamp() + interval '15 minutes')`,
    [newId('token'), person.userId, person.email, tokenHash(token)],
  );
  return () => server.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { token } });
}

async function passkeySignIn() {
  const browser = new Browser(server.app);
  const options = await browser.post('/api/auth/passkey/options');
  expect(options.statusCode, options.body).toBe(200);
  const response = authenticator.answer(options.json<RequestOptions>());
  return () => browser.post('/api/auth/passkey', { response });
}

beforeAll(async () => {
  kit = await startTestPostgres();
  // Configure only this throwaway database; new pooled connections log the blocking statements.
  const loggingKit: TestPostgres = {
    ...kit,
    async createDatabase(prefix) {
      const database = await kit.createDatabase(prefix);
      const admin = new pg.Client({ connectionString: database.url });
      await admin.connect();
      try {
        const name = database.profile.database.replaceAll('"', '""');
        await admin.query(`ALTER DATABASE "${name}" SET log_lock_waits = on`);
        await admin.query(`ALTER DATABASE "${name}" SET deadlock_timeout = '100ms'`);
      } finally {
        await admin.end();
      }
      return database;
    },
  };
  idp = await startTestProvider({ path: '/realms/acme' });
  routeProviderRequests([idp]);
  server = await startServer(loggingKit, 'signinload', { baseUrl: BASE });
  people = [server.owner];
  for (let i = 0; i < 3; i++) people.push(await server.addMember());
  passkeyPerson = await server.addMember();
  await server.pool.query(`UPDATE "${server.schemas.app}".users SET password_hash = $1 WHERE id = ANY($2)`, [
    await hashPassword(PASSWORD),
    [...people, passkeyPerson].map((person) => person.userId),
  ]);
  authenticator = new TestAuthenticator(BASE, { counter: 1 });
  const browser = new Browser(server.app);
  browser.setCookie('rio_session', passkeyPerson.headers.cookie.split('=')[1]!);
  browser.csrf = passkeyPerson.info.csrfToken;
  const options = await browser.post('/api/me/mfa/passkeys/options');
  expect(options.statusCode, options.body).toBe(200);
  const registered = await browser.post('/api/me/mfa/passkeys', {
    name: 'Laptop',
    response: authenticator.register(options.json<CreationOptions>()),
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch([idp], realFetch));
  const added = await server.app.inject({
    method: 'POST',
    url: '/api/admin/sso',
    headers: server.owner.headers,
    payload: {
      kind: 'oidc',
      name: 'Test sign-on',
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      autoCreate: true,
      linkByEmail: true,
      allowedDomains: ['example.test'],
    },
  });
  expect(added.statusCode, added.body).toBe(200);
  provider = added.json<SsoProvider>();
  expect((await server.pool.query('SHOW log_lock_waits')).rows[0].log_lock_waits).toBe('on');
  expect((await server.pool.query('SHOW deadlock_timeout')).rows[0].deadlock_timeout).toBe('100ms');
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await idp?.close();
  await server?.close();
  await kit?.stop();
});

describe('concurrent sign-in', () => {
  it.each(Array.from({ length: runs }, (_, i) => i + 1))(
    'orders password and passkey attempt locks before updating credentials, run %i',
    async () => {
      const gate = await server.pool.connect();
      const emailKey = attemptKey('email', passkeyPerson.email);
      const passkey = await passkeySignIn();
      let signingIn: ReturnType<typeof password> | undefined;
      let usingPasskey: ReturnType<typeof passkey> | undefined;
      await gate.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [emailKey]);
      try {
        signingIn = password(passkeyPerson);
        const waiting = async () =>
          (
            await server.pool.query(`SELECT count(*) FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'`)
          ).rows[0].count;
        await expect.poll(waiting).toBe('1');
        usingPasskey = passkey();
        await expect.poll(waiting).toBe('2');
        // Both requests must wait for email without holding the shared IP lock or the credential.
        const credential = await server.pool.connect();
        try {
          await credential.query('BEGIN');
          const ip = await credential.query<{ available: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS available',
            [attemptKey('ip', '127.0.0.1')],
          );
          expect(ip.rows[0]!.available).toBe(true);
          await credential.query(
            `SELECT id FROM "${server.schemas.app}".passkeys
            WHERE credential_id = $1 FOR UPDATE NOWAIT`,
            [authenticator.id],
          );
        } finally {
          await credential.query('ROLLBACK');
          credential.release();
        }
        await gate.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [emailKey]);
        const responses = await Promise.all([signingIn, usingPasskey]);
        expect(responses.map((response) => [response.statusCode, response.body])).toEqual([
          [200, expect.any(String)],
          [200, expect.any(String)],
        ]);
        expect(responses[0]!.json().secondStep.stage).toBe('verify');
        sessionCookie(responses[1]!);
      } finally {
        await gate.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [emailKey]);
        await Promise.allSettled([signingIn, usingPasskey].filter(Boolean));
        gate.release();
      }
    },
  );

  it.each(Array.from({ length: runs }, (_, i) => i + 1))(
    'provisions distinct verified SSO identities sharing a new email, run %i',
    async (run) => {
      const app = `"${server.schemas.app}"`;
      const email = `shared-${run}@example.test`;
      const first = await ssoCallback({ email }, `shared-${run}-first`);
      const second = await ssoCallback({ email: email.toUpperCase() }, `shared-${run}-second`);
      const gate = await server.pool.connect();
      let firstSignIn: ReturnType<typeof first> | undefined;
      let secondSignIn: ReturnType<typeof second> | undefined;
      await gate.query('SELECT pg_advisory_lock(7192, 1)');
      try {
        await server.pool.query(`
          CREATE FUNCTION ${app}.hold_provisioning() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.email = '${email}' THEN PERFORM pg_advisory_xact_lock(7192, 1); END IF;
            RETURN NEW;
          END; $$;
          CREATE TRIGGER z_hold_provisioning BEFORE INSERT ON ${app}.users
            FOR EACH ROW EXECUTE FUNCTION ${app}.hold_provisioning();
        `);
        firstSignIn = first();
        const blockedInsertions = async () =>
          (
            await server.pool.query(`SELECT count(*) FROM pg_locks
              WHERE locktype = 'advisory' AND classid = 7192 AND objid = 1 AND NOT granted`)
          ).rows[0].count;
        await expect.poll(blockedInsertions).toBe('1');
        secondSignIn = second();
        await expect
          .poll(
            async () =>
              (
                await server.pool.query(`SELECT count(*) FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND (query LIKE 'INSERT INTO %users%' OR query LIKE 'SELECT pg_advisory_xact_lock%')`)
              ).rows[0].count,
          )
          .toBe('2');
        await gate.query('SELECT pg_advisory_unlock(7192, 1)');
        const responses = await Promise.all([firstSignIn, secondSignIn]);
        const cookies = responses.map(sessionCookie);
        expect(new Set(cookies).size).toBe(2);
        const sessions = await Promise.all(
          cookies.map((cookie) => server.app.inject({ url: '/api/auth/session', headers: { cookie } })),
        );
        const userIds = sessions.map((response) => response.json<SessionInfo>().user.id);
        expect(new Set(userIds).size).toBe(1);
        for (const response of sessions) {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json<SessionInfo>().org.id).toBe(server.owner.info.org.id);
        }
        const counts = await server.pool.query(
          `SELECT
          (SELECT count(*) FROM ${app}.users WHERE lower(email) = $1) AS users,
          (SELECT count(*) FROM ${app}.memberships WHERE user_id = $2) AS memberships,
          (SELECT count(*) FROM ${app}.sso_identities WHERE user_id = $2) AS identities`,
          [email, userIds[0]],
        );
        expect(counts.rows[0]).toEqual({ users: '1', memberships: '1', identities: '2' });
      } finally {
        await gate.query('SELECT pg_advisory_unlock(7192, 1)');
        await Promise.allSettled([firstSignIn, secondSignIn].filter(Boolean));
        gate.release();
        await server.pool.query(`DROP TRIGGER IF EXISTS z_hold_provisioning ON ${app}.users;
          DROP FUNCTION IF EXISTS ${app}.hold_provisioning()`);
      }
    },
  );

  it('finishes password sign-in while a first SSO link holds a foreign-key lock', async () => {
    const app = `"${server.schemas.app}"`;
    const gate = await server.pool.connect();
    let sso: ReturnType<Awaited<ReturnType<typeof ssoCallback>>> | undefined;
    let signingIn: ReturnType<typeof password> | undefined;
    await gate.query('SELECT pg_advisory_lock(7191, 1)');
    try {
      await server.pool.query(`
        CREATE FUNCTION ${app}.hold_first_link() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.subject = 'blocked-owner' THEN PERFORM pg_advisory_xact_lock(7191, 1); END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER z_hold_first_link AFTER INSERT ON ${app}.sso_identities
          FOR EACH ROW EXECUTE FUNCTION ${app}.hold_first_link();
      `);
      sso = (await ssoCallback(server.owner, 'blocked-owner'))();
      await expect
        .poll(
          async () =>
            (
              await server.pool.query(
                `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 7191 AND objid = 1 AND NOT granted`,
              )
            ).rowCount,
        )
        .toBe(1);
      let finished = false;
      signingIn = password(server.owner).then((response) => {
        finished = true;
        return response;
      });
      // On the old lock mode, the password waits for this SSO link while holding the email lock.
      await expect
        .poll(
          async () =>
            finished ||
            (
              await server.pool.query(
                `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
         AND query LIKE '%users%FOR UPDATE%' AND wait_event_type = 'Lock'`,
              )
            ).rowCount! > 0,
        )
        .toBe(true);
      expect(finished, 'a foreign-key check must not block session creation').toBe(true);
      await gate.query('SELECT pg_advisory_unlock(7191, 1)');
      const responses = await Promise.all([signingIn, sso]);
      expect(responses.map((response) => [response.statusCode, response.body])).toEqual([
        [200, expect.any(String)],
        [302, expect.any(String)],
      ]);
      for (const response of responses) sessionCookie(response);
    } finally {
      await gate.query('SELECT pg_advisory_unlock(7191, 1)');
      await Promise.allSettled([signingIn, sso].filter(Boolean));
      gate.release();
      await server.pool.query(`DROP TRIGGER IF EXISTS z_hold_first_link ON ${app}.sso_identities;
        DROP FUNCTION IF EXISTS ${app}.hold_first_link()`);
    }
  });

  it('recovers when an audit writer takes the user lock after the organization audit lock', async () => {
    const audit = `"${server.schemas.audit}"`;
    const gate = await server.pool.connect();
    const writer = await server.pool.connect();
    let signingIn: ReturnType<typeof password> | undefined;
    let writing: Promise<unknown> | undefined;
    try {
      await gate.query('SELECT pg_advisory_lock(7193, 1)');
      await server.pool.query(`
        CREATE FUNCTION ${audit}.hold_signin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'auth.sign_in' THEN PERFORM pg_advisory_xact_lock(7193, 1); END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER a_hold_signin_audit BEFORE INSERT ON ${audit}.events
          FOR EACH ROW EXECUTE FUNCTION ${audit}.hold_signin_audit();
      `);
      await writer.query('BEGIN');
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // The writer's detector must wait beyond the test deadline so only the sign-in can
      // resolve this deliberate cycle, even when scheduling delays either connection.
      await writer.query("SET LOCAL deadlock_timeout = '1min'");
      await auditEvent(writer, audit, 'signin.test.writer', {
        orgId: server.owner.info.org.id,
        userId: server.owner.userId,
      });
      signingIn = password(server.owner);
      await expect
        .poll(
          async () =>
            (
              await server.pool.query(
                `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
         AND query LIKE 'INSERT INTO %events%' AND wait_event_type = 'Lock'`,
              )
            ).rowCount,
        )
        .toBe(1);
      writing = writer.query(`SELECT id FROM "${server.schemas.app}".users WHERE id = $1 FOR UPDATE`, [
        server.owner.userId,
      ]);
      void writing.catch(() => undefined);
      await expect
        .poll(
          async () =>
            (
              await server.pool.query(
                `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
                [writerPid],
              )
            ).rowCount,
        )
        .toBe(1);
      // The user lock is already contested when the sign-in first waits on the audit chain.
      await gate.query('SELECT pg_advisory_unlock(7193, 1)');
      await writing;
      await writer.query('COMMIT');
      const response = await signingIn;
      expect(response.statusCode, response.body).toBe(200);
      sessionCookie(response);
    } finally {
      await gate.query('SELECT pg_advisory_unlock(7193, 1)');
      if (writing) await Promise.allSettled([writing]);
      await writer.query('ROLLBACK');
      writer.release();
      gate.release();
      await signingIn;
      await server.pool.query(`DROP TRIGGER IF EXISTS a_hold_signin_audit ON ${audit}.events;
        DROP FUNCTION IF EXISTS ${audit}.hold_signin_audit()`);
    }
  });

  it.each(['40P01', '40001'])('rolls back all effects before retrying %s', async (code) => {
    const audit = `"${server.schemas.audit}"`;
    let attempts = 0;
    await withSignInTransaction(server.pool, async (db) => {
      attempts++;
      await auditEvent(db, audit, 'signin.test.retry', { orgId: server.owner.info.org.id }, { code });
      if (attempts < 3) throw Object.assign(new Error('transaction aborted'), { code });
    });
    expect(attempts).toBe(3);
    expect(
      (
        await server.pool.query(
          `SELECT 1 FROM ${audit}.events
      WHERE action = 'signin.test.retry' AND metadata->>'code' = $1`,
          [code],
        )
      ).rowCount,
    ).toBe(1);
  });

  it.each(
    ['password', 'link', 'sso', 'passkey'].flatMap((method) =>
      ['40P01', '40001'].map((code) => [method, code] as const),
    ),
  )('retries %s after a late %s without duplicating credentials or audit entries', async (method, code) => {
    const app = `"${server.schemas.app}"`;
    const audit = `"${server.schemas.audit}"`;
    const before = (
      await server.pool.query(`SELECT
      (SELECT count(*) FROM ${app}.sessions) AS sessions,
      (SELECT count(*) FROM ${audit}.events WHERE action = 'auth.sign_in') AS events,
      (SELECT count(*) FROM ${app}.login_tokens WHERE used_at IS NOT NULL) AS used`)
    ).rows[0];
    const signIn =
      method === 'password'
        ? () => password(server.owner)
        : method === 'link'
          ? await magicLink(server.owner)
          : method === 'sso'
            ? await ssoCallback(server.owner, `retry-${code}`)
            : await passkeySignIn();
    const grantsBefore = idp.requests.token;
    await server.pool.query(`
      CREATE SEQUENCE ${app}.sign_in_retries;
      CREATE FUNCTION ${audit}.abort_sign_in() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'auth.sign_in' AND nextval('${app}.sign_in_retries') <= 2 THEN
          RAISE EXCEPTION USING ERRCODE = '${code}', MESSAGE = 'transaction aborted';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER z_abort_sign_in BEFORE INSERT ON ${audit}.events
        FOR EACH ROW EXECUTE FUNCTION ${audit}.abort_sign_in();
    `);
    try {
      const response = await signIn();
      expect(response.statusCode, response.body).toBe(method === 'sso' ? 302 : 200);
      sessionCookie(response);
      const after = (
        await server.pool.query(`SELECT
        (SELECT count(*) FROM ${app}.sessions) AS sessions,
        (SELECT count(*) FROM ${audit}.events WHERE action = 'auth.sign_in') AS events,
        (SELECT count(*) FROM ${app}.login_tokens WHERE used_at IS NOT NULL) AS used,
        (SELECT last_value FROM ${app}.sign_in_retries) AS attempts`)
      ).rows[0];
      expect(after).toEqual({
        sessions: String(Number(before.sessions) + 1),
        events: String(Number(before.events) + 1),
        used: String(Number(before.used) + (method === 'link' ? 1 : 0)),
        attempts: '3',
      });
      expect(idp.requests.token - grantsBefore).toBe(method === 'sso' ? 1 : 0);
      if (method === 'passkey') {
        const stored = await server.pool.query(
          `SELECT sign_count FROM ${app}.passkeys
          WHERE credential_id = $1`,
          [authenticator.id],
        );
        expect(Number(stored.rows[0].sign_count)).toBe(authenticator.counter);
      }
    } finally {
      await server.pool.query(`DROP TRIGGER z_abort_sign_in ON ${audit}.events;
        DROP FUNCTION ${audit}.abort_sign_in(); DROP SEQUENCE ${app}.sign_in_retries`);
    }
  });

  it.each(['40P01', '40001', '23505', '55P03', '08006', 'unauthenticated'])(
    'bounds retries and preserves the original %s failure',
    async (code) => {
      let attempts = 0;
      const error = Object.assign(new Error('sign-in refused'), { code });
      await expect(
        withSignInTransaction(server.pool, async () => {
          attempts++;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(attempts).toBe(['40P01', '40001'].includes(code) ? 3 : 1);
    },
  );

  it.each(Array.from({ length: runs }, (_, i) => i + 1))(
    'signs in shared accounts and organization members through all paths, run %i',
    async (run) => {
      const app = `"${server.schemas.app}"`;
      const audit = `"${server.schemas.audit}"`;
      const before = Number((await server.pool.query(`SELECT count(*) FROM ${app}.sessions`)).rows[0].count);
      const eventsBefore = Number(
        (await server.pool.query(`SELECT count(*) FROM ${audit}.events WHERE action = 'auth.sign_in'`))
          .rows[0].count,
      );
      const tasks: Array<() => Promise<LightMyRequestResponse>> = [];
      for (const person of people) {
        await server.pool.query(`INSERT INTO ${app}.auth_attempts (key) VALUES ($1)`, [
          attemptKey('email', person.email),
        ]);
        for (let i = 0; i < 2; i++) {
          tasks.push(
            () => password(person),
            () => fixtureSignIn(person),
            await magicLink(person),
            await ssoCallback(person, `${person.userId}-${i}`),
          );
        }
      }
      // Provisioning and repeated callbacks for the same identity join the existing members' load.
      const provision = { email: `new-${run}@example.test` };
      tasks.push(
        await passkeySignIn(),
        await ssoCallback(provision, `new-${run}`),
        await ssoCallback(provision, `new-${run}`),
        await ssoCallback(provision, `new-${run}-other`),
      );
      const responses = await Promise.all(tasks.map((task) => task()));
      expect(responses.map((response) => response.statusCode)).toEqual(
        tasks.map((_, i) => (i <= people.length * 8 && i % 4 !== 3 ? 200 : 302)),
      );
      const cookies = responses.map(sessionCookie);
      expect(new Set(cookies).size).toBe(tasks.length);
      const sessions = await Promise.all(
        cookies.map((cookie) => server.app.inject({ url: '/api/auth/session', headers: { cookie } })),
      );
      for (const session of sessions) {
        expect(session.statusCode, session.body).toBe(200);
        expect(session.json<SessionInfo>().org.id).toBe(server.owner.info.org.id);
      }
      const counts = await server.pool.query(
        `SELECT
        (SELECT count(*) FROM ${app}.sessions) AS sessions,
        (SELECT count(*) FROM ${audit}.events WHERE action = 'auth.sign_in') AS events,
        (SELECT count(*) FROM ${app}.auth_attempts WHERE key = ANY($1)) AS failures,
        (SELECT count(*) FROM ${app}.sessions WHERE revoked_at IS NOT NULL
          OR abs(extract(epoch FROM expires_at - (created_at + $2 * interval '24 hours'))) > 10) AS changed_lifetimes`,
        [people.map((person) => attemptKey('email', person.email)), server.config.sessionMaxDays],
      );
      expect(counts.rows[0]).toEqual({
        sessions: String(before + tasks.length),
        events: String(eventsBefore + tasks.length),
        failures: '0',
        changed_lifetimes: '0',
      });
      const active = await server.pool.query(
        `SELECT a.user_id FROM ${app}.rio_active_conversations a
        JOIN ${app}.sessions s ON s.id = a.session_id AND s.user_id = a.user_id
        JOIN ${app}.rio_conversations c ON c.id = a.conversation_id AND c.user_id = a.user_id
        WHERE a.user_id = ANY($1)`,
        [people.map((person) => person.userId)],
      );
      expect(active.rowCount).toBe(people.length);
      const chain = await server.pool.query(
        `SELECT count(*) FROM (
        SELECT chain_seq, hash, ${audit}.event_hash(e) AS expected_hash, prev_hash,
          lag(hash) OVER (ORDER BY chain_seq) AS expected_previous,
          row_number() OVER (ORDER BY chain_seq) AS expected_sequence
        FROM ${audit}.events e WHERE org_id = $1
      ) e WHERE hash IS DISTINCT FROM expected_hash OR prev_hash IS DISTINCT FROM expected_previous
        OR chain_seq <> expected_sequence`,
        [server.owner.info.org.id],
      );
      expect(chain.rows[0].count).toBe('0');
    },
  );
});

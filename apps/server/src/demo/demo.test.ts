import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { newId, type SessionInfo } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { readFixture, numbers } from '../data/snapshots.test-helpers.js';
import { DEMO_COMMAND_CORPUS, DEMO_ROUTE_CORPUS } from '../test/corpora/demo.js';
import { demoRouteDecision, demoRoutes } from './routes.js';
import { registeredCommandKinds } from './command-kinds.js';
import { demoRequest, demoReadOnly, refuseDemo } from './boundary.js';
import { callOut } from '../automations/outbound.js';
import { runCommands } from '../data/commands/index.js';
import { runHomeCommand } from '../data/commands/home.js';
import { runOrganizationCommand } from '../data/commands/organization.js';
import { runAuthenticationCommand } from '../data/commands/authentication.js';
import { runNotificationCommand } from '../data/commands/notifications.js';
import { runSourceCommand } from '../data/commands/sources.js';
import { runKnowledgeCommand } from '../data/commands/knowledge.js';
import { runLibraryCommand } from '../data/commands/libraries.js';
import { runGovernanceCommand } from '../data/commands/governance.js';
import { runPublicSharingCommand } from '../data/commands/public-sharing.js';
import { runIngestSetupCommand } from '../data/commands/ingest-setup.js';
import { runIngestOrganizationCommand, runOriginalCommand } from '../ingest/originals/commands.js';
import { buildApp } from '../app.js';
import { demoIdentity, DEMO_LIFETIME_MS } from './sessions.js';
import type { Actor } from '../http/policy.js';
import * as providers from '../ai/settings.js';
import { tokenHash } from '../auth/database.js';

const liveIngestDecisions: Record<string, 'refuse'> = {};
for (const path of [
  '/files',
  '/files/:fileId',
  '/files/:fileId/study',
  '/questions',
  '/rules',
  '/formats',
  '/summary',
  '/requests/:requestId',
])
  for (const method of ['GET', 'HEAD'])
    liveIngestDecisions[`${method} /api/tables/:tableId/ingest${path}`] = 'refuse';
for (const path of [
  '/files',
  '/files/:fileId/retry',
  '/files/:fileId/read-anyway',
  '/files/:fileId/skip',
  '/files/:fileId/remove-rows',
  '/files/:fileId/study/assumptions/:assumptionId',
  '/files/:fileId/study/approve',
  '/files/:fileId/pass',
  '/questions/:questionId/answer',
  '/requests/:requestId/retry',
  '/rules/:ruleId/off',
])
  liveIngestDecisions[`POST /api/tables/:tableId/ingest${path}`] = 'refuse';
const routeCorpus = { ...DEMO_ROUTE_CORPUS, ...liveIngestDecisions };
for (const method of ['GET', 'HEAD', 'POST'])
  routeCorpus[`${method} /api/tables/:tableId/ingest/formats/:formatId/build`] = 'refuse';
routeCorpus['POST /api/tables/:tableId/ingest/formats/:formatId/build/cancel'] = 'refuse';
routeCorpus['POST /api/tables/:tableId/ingest/formats/:formatId/build/answer'] = 'refuse';
for (const path of ['/drafts', '/drafts/:draftId'])
  for (const method of ['GET', 'HEAD'])
    routeCorpus[`${method} /api/tables/:tableId/ingest${path}`] = 'refuse';
for (const action of ['start', 'correct', 'discard', 'checks', 'answer', 'confirm'])
  routeCorpus[`POST /api/tables/:tableId/ingest/drafts/${action}`] = 'refuse';
const commandCorpus = [
  ...DEMO_COMMAND_CORPUS,
  'ingest.draft.start',
  'ingest.draft.correct',
  'ingest.draft.discard',
  'ingest.draft.checks',
  'ingest.draft.answer',
  'ingest.draft.confirm',
].sort();

let web: string;
let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let headers: Record<string, string>;
let read: Awaited<ReturnType<typeof readFixture>>;
let recordId: string;
let dashboardId: string;
let personalToken: string;
let oauthToken: string;
const actor = (): Actor => ({
  demo: true,
  userId: member.userId,
  orgId: member.info.org.id,
  sessionId: '',
  csrfToken: '',
  kind: 'member',
  adminRoles: [],
});

beforeAll(async () => {
  kit = await startTestPostgres();
  web = mkdtempSync(join(tmpdir(), 'rio-demo-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Riosoma</title>');
  writeFileSync(join(web, 'demo.css'), ':root {}');
  writeFileSync(join(web, 'demo.js'), '/* demo asset */'.repeat(50_000));
  server = await startServer(kit, 'publicdemo', { webDir: web, trustProxy: 'loopback' });
  server.config.baseUrl = 'http://127.0.0.1';
  member = await server.addMember();
  read = await readFixture(server);
  await numbers(server, read, [42]);
  recordId = (await server.pool.query(`SELECT __id FROM "${server.schemas.data}"."${read.table.id}"`)).rows[0]
    .__id;
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     VALUES ($1, 'database', $2, 'user', $3, 'editor')`,
    [member.info.org.id, read.table.databaseId, member.userId],
  );
  dashboardId = newId('dashboard');
  const made = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'dashboard.create',
          dashboard: { id: dashboardId, name: 'Overview' },
        },
      ],
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const token = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: member.headers,
    payload: {
      name: 'Demo member token',
      scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
      databases: 'all',
      expiresInDays: 30,
    },
  });
  expect(token.statusCode, token.body).toBe(200);
  personalToken = token.json<{ token: string }>().token;
  oauthToken = await issueOAuthToken();
  server.config.demoAccount = member.email;
  server.config.demoLink = 'https://riosoma.com';
  server.config.demoMode = true;
  const session = await server.app.inject('/api/auth/session');
  expect(session.statusCode, session.body).toBe(200);
  const cookie = session.headers['set-cookie'];
  headers = {
    cookie: (Array.isArray(cookie) ? cookie[0]! : String(cookie)).split(';')[0]!,
    'x-csrf-token': session.json<SessionInfo>().csrfToken,
  };
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  await kit?.stop();
  if (web) rmSync(web, { recursive: true, force: true });
});

async function snapshot() {
  const tables = await server.pool.query<{ schema: string; name: string }>(
    `SELECT schemaname AS schema, tablename AS name FROM pg_tables
     WHERE schemaname = ANY($1::text[]) AND tablename <> 'sessions' ORDER BY schemaname, tablename`,
    [[server.schemas.app, server.schemas.data, server.schemas.audit]],
  );
  const state: Record<string, unknown> = {};
  for (const table of tables.rows) {
    const result = await server.pool.query(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(r)::text, E'\\n' ORDER BY row_to_json(r)::text), '')) AS checksum
       FROM "${table.schema}"."${table.name}" r`,
    );
    state[`${table.schema}.${table.name}`] = result.rows[0];
  }
  return state;
}

async function issueOAuthToken(): Promise<string> {
  const callback = `https://${randomBytes(8).toString('hex')}.invalid/callback`;
  const scopes = ['schema.bases:read', 'data.records:read', 'data.records:write'];
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/admin/oauth/apps',
    headers: server.owner.headers,
    payload: {
      name: 'Demo member connection',
      icon: 'database',
      homepage: new URL(callback).origin,
      redirectUris: [callback],
      confidential: false,
      scopes,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const clientId = created.json<{ id: string }>().id;
  const verifier = randomBytes(32).toString('base64url');
  const started = await server.app.inject({
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callback,
      scope: scopes.join(' '),
      state: randomBytes(32).toString('base64url'),
      resource: `${server.config.baseUrl}/api/v1`,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    })}`,
  });
  expect(started.statusCode, started.body).toBe(303);
  const request = new URL(started.headers.location!, server.config.baseUrl).searchParams.get('request')!;
  const consent = await server.app.inject({
    url: `/api/oauth/consent?request=${request}`,
    headers: member.headers,
  });
  expect(consent.statusCode, consent.body).toBe(200);
  const approved = await server.app.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: member.headers,
    payload: { request, approve: true, databases: 'all' },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const code = new URL(approved.json<{ redirect: string }>().redirect).searchParams.get('code')!;
  const exchanged = await server.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: `${server.config.baseUrl}/api/v1`,
    }).toString(),
  });
  expect(exchanged.statusCode, exchanged.body).toBe(200);
  return exchanged.json<{ access_token: string }>().access_token;
}

describe('the public demo boundary', () => {
  it.each(['personal', 'OAuth'] as const)(
    'refuses an existing %s token for the reserved member with and without demo cookies before bookkeeping',
    async (kind) => {
      const before = await snapshot();
      for (const cookie of [undefined, headers.cookie, '__Host-rio_demo=invalid']) {
        const tokenHeaders = {
          authorization: `Bearer ${kind === 'personal' ? personalToken : oauthToken}`,
          ...(cookie ? { cookie } : {}),
        };
        for (const request of [
          { url: '/api/v1/databases' },
          {
            method: 'POST' as const,
            url: `/api/v1/tables/${read.table.id}/records`,
            payload: { fieldKey: 'id', records: [{ fields: { [read.fields[0]!.id]: 777 } }] },
          },
        ]) {
          const response = await server.app.inject({ ...request, headers: tokenHeaders });
          expect.soft(response.statusCode, response.body).toBe(403);
          expect.soft(response.json().error?.messageKey).toBe('demo.readOnly');
        }
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['email', 'reserved user'] as const)(
    'refuses invitation tokens targeting the reserved member by %s before previews or authentication attempts',
    async (target) => {
      const token = randomBytes(32).toString('base64url');
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".invitations
         (id, org_id, email, token_hash, invited_by, expires_at, reserved_user_id)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 day', $6)`,
        [
          newId('invitation'),
          member.info.org.id,
          target === 'email' ? member.email.toUpperCase() : `${randomBytes(8).toString('hex')}@invalid`,
          tokenHash(token),
          server.owner.userId,
          target === 'reserved user' ? member.userId : null,
        ],
      );
      const before = await snapshot();
      for (const request of [
        { url: `/api/auth/invitations/${token}` },
        {
          method: 'POST' as const,
          url: '/api/auth/invitations/accept',
          payload: { token, name: 'Demo member' },
        },
      ]) {
        const response = await server.app.inject(request);
        expect.soft(response.statusCode, response.body).toBe(403);
        expect.soft(response.json().error?.messageKey).toBe('demo.readOnly');
        expect.soft(response.headers['set-cookie']).toBeUndefined();
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(['http', 'https'] as const)(
    'clears both demo cookies at sign-in over %s so the operator can sign in after a protocol change',
    async (protocol) => {
      const cookies = new Map([
        headers.cookie!.split('=') as [string, string],
        ['__Host-rio_demo', randomBytes(32).toString('base64url')],
      ]);
      const signIn = await server.app.inject({
        url: '/sign-in',
        headers: {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          'x-forwarded-proto': protocol,
        },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const cleared = [signIn.headers['set-cookie']].flat();
      expect
        .soft(cleared)
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining('rio_demo=;'),
            expect.stringContaining('__Host-rio_demo=;'),
          ]),
        );
      const secure = cleared.find((cookie) => cookie?.startsWith('__Host-rio_demo='));
      expect.soft(secure).toContain('Secure');
      expect.soft(secure).toContain('HttpOnly');
      expect.soft(secure).toContain('Path=/');
      expect.soft(secure).not.toContain('Domain=');
      for (const cookie of cleared) {
        expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
        cookies.delete(cookie!.split('=')[0]!);
      }
      const operator = await server.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          'x-forwarded-proto': protocol,
        },
        payload: { email: server.owner.email, password: 'a long test password' },
      });
      expect(operator.statusCode, operator.body).toBe(200);
      expect(operator.json().demo).toBeUndefined();
    },
  );

  it('issues an ordinary member session without sign-in, with a two-hour lifetime', async () => {
    const response = await server.app.inject({ url: '/api/auth/session', headers });
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json<SessionInfo>();
    expect(session).toMatchObject({
      demo: true,
      demoLink: 'https://riosoma.com',
      membership: { kind: 'member', adminRoles: [] },
    });
    expect(Date.parse(session.expiresAt!) - Date.now()).toBeGreaterThan(DEMO_LIFETIME_MS - 120_000);
    expect(Date.parse(session.expiresAt!) - Date.now()).toBeLessThanOrEqual(DEMO_LIFETIME_MS);
  });

  it('requires a decision for every registered route and enforces refusals before parsing', async () => {
    const registered = [...new Set(demoRoutes(server.app))];
    expect(registered.filter((route) => !Object.hasOwn(routeCorpus, route))).toEqual([]);
    const before = await snapshot();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const route of registered) {
        const space = route.indexOf(' ');
        const method = route.slice(0, space);
        const path = route.slice(space + 1);
        expect(demoRouteDecision(method, path), route).toBe(routeCorpus[route]);
        if (routeCorpus[route] === 'read') continue;
        now += 1000;
        const response = await server.app.inject({
          method: method as NonNullable<InjectOptions['method']>,
          url: path.replace(/:[A-Za-z]+/g, 'demo').replace(/\*/g, 'demo'),
          headers,
        });
        if (routeCorpus[route] === 'internal') {
          expect(response.statusCode, `${route}: ${response.body}`).toBe(404);
          continue;
        }
        expect(response.statusCode, `${route}: ${response.body}`).toBe(403);
        if (method !== 'HEAD')
          expect(response.json().error).toMatchObject({ code: 'forbidden', messageKey: 'demo.readOnly' });
      }
    } finally {
      clock.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('requires a decision for every command kind and refuses at each command bus before preparation', async () => {
    expect(registeredCommandKinds()).toEqual(commandCorpus);
    const before = await snapshot();
    for (const kind of registeredCommandKinds()) {
      expect(() => refuseDemo(actor()), kind).toThrowError(demoReadOnly());
      await expect(
        runCommands(server.app, actor(), read.table.databaseId, {
          clientId: newId('client'),
          commands: [{ kind }],
        }),
        kind,
      ).rejects.toMatchObject({ code: 'forbidden', messageKey: 'demo.readOnly' });
    }
    for (const run of [
      runHomeCommand,
      runOrganizationCommand,
      runNotificationCommand,
      runSourceCommand,
      runKnowledgeCommand,
      runLibraryCommand,
      runGovernanceCommand,
      runPublicSharingCommand,
      runIngestSetupCommand,
    ])
      await expect(run(server.app, actor(), {})).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    await expect(runAuthenticationCommand(server.ctx, {}, { actor: actor() })).rejects.toMatchObject({
      messageKey: 'demo.readOnly',
    });
    for (const command of [
      { kind: 'ingest.originals.readOnly', enabled: true },
      { kind: 'ingest.originals.retention', keepDays: 30 },
      { kind: 'ingest.originals.share', enabled: true, share: { kind: 'view', id: 'missing' } },
    ] as const)
      await expect(runOriginalCommand(server.app, actor(), 'missing', command)).rejects.toMatchObject({
        messageKey: 'demo.readOnly',
      });
    await expect(
      runIngestOrganizationCommand(server.app, actor(), {
        kind: 'organization.ingest',
        settings: { originalKeepDays: 90, probationFiles: 3 },
      }),
    ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    expect(await snapshot()).toEqual(before);
  });

  it('changes no rows or checksums across a tour of reads, including assistant and session bookkeeping tables', async () => {
    const before = await snapshot();
    const tour = [
      { url: '/' },
      { url: '/demo.css' },
      { url: '/demo.js' },
      { url: `/${read.table.databaseId}/${read.table.id}/${read.view.id}` },
      { url: '/api/setup/status' },
      { url: '/api/config' },
      { url: '/api/auth/session' },
      { url: '/api/home' },
      { url: '/api/databases' },
      { url: `/api/databases/${read.table.databaseId}/schema` },
      { url: `/api/views/${read.view.id}/rows` },
      { url: `/api/tables/${read.table.id}/records/${recordId}` },
      { url: `/api/tables/${read.table.id}/records/${recordId}/comments` },
      { method: 'POST' as const, url: `/api/dashboards/${dashboardId}/data`, payload: { timeZone: 'UTC' } },
    ];
    for (const request of tour) {
      const response = await server.app.inject({ ...request, headers });
      expect(response.statusCode, `${request.url}: ${response.body}`).toBe(200);
      if (request.url === '/demo.js') expect(response.body.length).toBe(800_000);
    }
    for (const url of ['/api/notifications', '/api/notifications/unread']) {
      const response = await server.app.inject({ url, headers });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('demo.readOnly');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses outbound requests before DNS or transport and never enters a provider from the assistant route', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    await expect(
      demoRequest(() =>
        callOut(
          { url: 'https://example.com', method: 'GET', headers: {}, body: null },
          { resolve, allowPrivate: false },
        ),
      ),
    ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    expect(resolve).not.toHaveBeenCalled();
    expect(() => demoRequest(() => fetch('https://example.com'))).toThrowError(demoReadOnly());
    const provider = vi.spyOn(providers, 'modelFor');
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/rio/conversations/00000000-0000-4000-8000-000000000000/messages',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(provider).not.toHaveBeenCalled();
    provider.mockRestore();
  });

  it('refuses a database write even inside an approved read context', async () => {
    await expect(
      demoRequest(() =>
        server.pool.query(`UPDATE "${server.schemas.app}".users SET name = 'Changed' WHERE id = $1`, [
          member.userId,
        ]),
      ),
    ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    const current = await server.pool.query(`SELECT name FROM "${server.schemas.app}".users WHERE id = $1`, [
      member.userId,
    ]);
    expect(current.rows[0].name).toBe(member.info.user.name);
  });

  it('refuses changing transaction read-only settings on a borrowed demo connection', async () => {
    await demoRequest(async () => {
      const client = await server.pool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query('SET LOCAL transaction_read_only = off')).rejects.toMatchObject({
          code: 'forbidden',
          messageKey: 'demo.readOnly',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it('refuses startup for owners, organization administrators, unit administrators, guests, deactivated members, and missing accounts', async () => {
    const original = server.config.demoAccount;
    try {
      server.config.demoAccount = server.owner.email;
      await expect(buildApp(server.ctx)).rejects.toMatchObject({
        setting: 'RIOSOMA_DEMO_ACCOUNT',
        messageKey: 'demo.account.invalid',
      });
      server.config.demoAccount = member.email;
      await server.pool.query(
        `UPDATE "${server.schemas.app}".memberships SET admin_roles = ARRAY['people'] WHERE user_id = $1`,
        [member.userId],
      );
      await expect(buildApp(server.ctx)).rejects.toMatchObject({ messageKey: 'demo.account.invalid' });
      await server.pool.query(
        `UPDATE "${server.schemas.app}".memberships SET admin_roles = '{}', kind = 'guest' WHERE user_id = $1`,
        [member.userId],
      );
      await expect(demoIdentity(server.ctx)).rejects.toMatchObject({ messageKey: 'demo.account.invalid' });
      await server.pool.query(
        `UPDATE "${server.schemas.app}".memberships SET kind = 'member' WHERE user_id = $1`,
        [member.userId],
      );
      const unitId = newId('orgUnit');
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".org_units (id, org_id, name) VALUES ($1, $2, 'Demo unit')`,
        [unitId, member.info.org.id],
      );
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".org_unit_admins (org_id, unit_id, user_id, roles) VALUES ($1, $2, $3, ARRAY['people'])`,
        [member.info.org.id, unitId, member.userId],
      );
      await expect(buildApp(server.ctx)).rejects.toMatchObject({ messageKey: 'demo.account.invalid' });
      await server.pool.query(`DELETE FROM "${server.schemas.app}".org_units WHERE id = $1`, [unitId]);
      await server.pool.query(
        `UPDATE "${server.schemas.app}".users SET deactivated_at = now() WHERE id = $1`,
        [member.userId],
      );
      await expect(demoIdentity(server.ctx)).rejects.toMatchObject({ messageKey: 'demo.account.invalid' });
      await server.pool.query(
        `UPDATE "${server.schemas.app}".users SET deactivated_at = NULL WHERE id = $1`,
        [member.userId],
      );
      server.config.demoAccount = 'missing@example.test';
      await expect(buildApp(server.ctx)).rejects.toMatchObject({ messageKey: 'demo.account.invalid' });
    } finally {
      server.config.demoAccount = original;
    }
  });

  it('keeps real sessions writable and real sign-in available at its own address', async () => {
    const response = await server.app.inject({ url: '/api/me/profile', headers: server.owner.headers });
    expect(response.statusCode).toBe(200);
    const session = await server.app.inject({ url: '/api/auth/session', headers: server.owner.headers });
    expect(session.json().demo).toBeUndefined();
    const saved = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/preferences',
      headers: server.owner.headers,
      payload: { level: 'simple' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().level).toBe('simple');
    const signIn = await server.app.inject({ url: '/sign-in', headers });
    expect(signIn.statusCode).toBe(200);
    expect([signIn.headers['set-cookie']].flat()).toContainEqual(expect.stringContaining('rio_demo=;'));
  });

  it('preserves every real sign-in flow after leaving the demo while refusing those flows with either demo cookie', async () => {
    const signIn = await server.app.inject({ url: '/sign-in', headers });
    expect(signIn.statusCode).toBe(200);
    expect([signIn.headers['set-cookie']].flat()).toContainEqual(expect.stringContaining('rio_demo=;'));
    const authRoutes = demoRoutes(server.app).filter((route) => {
      const path = route.slice(route.indexOf(' ') + 1);
      return (
        path.startsWith('/api/auth/') &&
        !path.startsWith('/api/auth/logo/') &&
        !['/api/auth/session', '/api/auth/sign-out'].includes(path)
      );
    });
    expect(authRoutes.length).toBeGreaterThan(20);
    try {
      for (const route of authRoutes) {
        const space = route.indexOf(' ');
        const method = route.slice(0, space) as NonNullable<InjectOptions['method']>;
        const url = route.slice(space + 1).replace(/:[A-Za-z]+/g, 'demo');
        const options = { method, url, ...(method === 'POST' ? { payload: {} } : {}) };
        server.config.demoMode = false;
        const ordinary = await server.app.inject(options);
        server.config.demoMode = true;
        const realSignIn = await server.app.inject(options);
        expect.soft(realSignIn.statusCode, route).toBe(ordinary.statusCode);
        if (method !== 'HEAD' && ordinary.statusCode >= 400)
          expect.soft(realSignIn.json().error?.messageKey, route).toBe(ordinary.json().error?.messageKey);
        expect.soft(String(realSignIn.headers['set-cookie']), route).not.toContain('rio_demo=');
        for (const cookie of ['rio_demo=invalid', '__Host-rio_demo=invalid']) {
          const refused = await server.app.inject({ ...options, headers: { cookie } });
          expect(refused.statusCode, route).toBe(403);
          if (method !== 'HEAD') expect(refused.json().error.messageKey, route).toBe('demo.readOnly');
        }
      }
    } finally {
      server.config.demoMode = true;
    }
  });

  it('takes the published-site request limits and asks visitors to try later', async () => {
    let now = Date.now() + 86_400_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let response = await server.app.inject({ url: '/api/config', headers });
      expect(response.statusCode).toBe(200);
      for (let count = 1; count <= 240; count++)
        response = await server.app.inject({ url: '/api/config', headers });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.messageKey).toBe('demo.tryLater');
      expect(response.headers['retry-after']).toBeDefined();
      now += 60_000;
      expect((await server.app.inject({ url: '/api/config', headers })).statusCode).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it('caps visits by network and total capacity, binds cookies to their network, and refuses expired visits', async () => {
    server.config.demoAddressLimit = 1;
    let response = await server.app.inject('/api/auth/session');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.messageKey).toBe('demo.tryLater');
    expect(response.headers['retry-after']).toBeDefined();
    response = await server.app.inject({ url: '/api/auth/session', headers, remoteAddress: '192.0.2.5' });
    expect(response.statusCode).toBe(429);
    server.config.demoAddressLimit = 10;
    server.config.demoSessionLimit = 1;
    response = await server.app.inject({ url: '/api/auth/session', remoteAddress: '192.0.2.5' });
    expect(response.statusCode).toBe(429);
    response = await server.app.inject({ url: '/api/home', remoteAddress: '192.0.2.5' });
    expect(response.statusCode).toBe(429);
    server.config.demoSessionLimit = 1000;
    await server.pool.query(
      `UPDATE "${server.schemas.app}".sessions SET expires_at = now() - interval '1 second' WHERE demo`,
    );
    response = await server.app.inject({ url: '/api/auth/session', headers });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.messageKey).toBe('demo.tryLater');
  });
});

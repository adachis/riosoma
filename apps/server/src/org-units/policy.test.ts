import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  newId,
  type BookingPage,
  type BookingPageSettings,
  type CalendarFeedCreated,
  type OrgUnit,
  type PublicFormLink,
  type SessionInfo,
  type SharedViewLink,
  type UnitPolicyValues,
  type UnitAuditEntry,
  type UnitPolicyView,
  type UnitPresetPreview,
} from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { createSession, findIdentity } from '../auth/sessions.js';
import { afterFirstStep, completeSignIn } from '../auth/mfa/pending.js';
import { settingsFor } from '../ai/settings.js';
import { unavailableReason } from '../ai-fields/models.js';
import { feedsAllowed } from '../calendar-feeds/store.js';
import { outsideRecipientsAllowed } from '../reports/store.js';
import { effectivePolicy, inheritPolicy, stricter } from './policy.js';

let kit: TestPostgres;
let server: ServerFixture;
let schema: string;
let research: OrgUnit;
let materials: OrgUnit;
let operations: OrgUnit;
/** Placed in Materials, below Research */
let inside: SignedIn;
/** Placed in Operations */
let other: SignedIn;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(who: SignedIn | null, method: Method, url: string, payload?: unknown) {
  return server.app.inject({
    method,
    url,
    ...(who ? { headers: who.headers } : {}),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function ok<T>(
  who: SignedIn,
  method: Method,
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await call(who, method, url, payload);
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return (response.body ? response.json() : undefined) as T;
}

const setUnit = (unit: OrgUnit, policy: Record<string, unknown>, who = server.owner) =>
  call(who, 'PUT', `/api/org/units/${unit.id}/policy`, policy);
const allow = (...overridable: string[]) =>
  ok(server.owner, 'PUT', '/api/admin/unit-policy', { values: {}, overridable });
const policyOf = (person: SignedIn) =>
  effectivePolicy(server.pool, schema, server.owner.info.org.id, { userId: person.userId }, server.config);
const place = (person: SignedIn, unit: OrgUnit | null) =>
  ok(server.owner, 'PUT', `/api/org/members/${person.userId}/unit`, { unitId: unit?.id ?? null });
const sessionStatus = async (who: SignedIn) => (await call(who, 'GET', '/api/auth/session')).statusCode;

/** An identity provider for the organization, so single sign-on can be required */
async function addProvider(): Promise<string> {
  const id = randomBytes(8).toString('hex');
  await server.pool.query(
    `INSERT INTO ${schema}.sso_providers (id, org_id, kind, name, issuer, client_id, sealed_secret)
     VALUES ($1, $2, 'oidc', 'Directory', $5, $3, $4)`,
    [
      id,
      server.owner.info.org.id,
      randomBytes(8).toString('hex'),
      randomBytes(24).toString('hex'),
      `https://id-${id}.example.test`,
    ],
  );
  return id;
}

/** Links someone to a provider, as their first sign-in through it would */
async function link(person: SignedIn, providerId: string): Promise<void> {
  await server.pool.query(
    `INSERT INTO ${schema}.sso_identities (issuer, subject, user_id, provider_id) VALUES ($1, $2, $3, $4)`,
    [`https://id-${providerId}.example.test`, randomBytes(8).toString('hex'), person.userId, providerId],
  );
}

/** Gives someone a confirmed authenticator app, as setting one up would */
async function authenticator(person: SignedIn): Promise<void> {
  await server.pool.query(
    `INSERT INTO ${schema}.authenticator_secrets (user_id, sealed_secret, confirmed_at)
     VALUES ($1, $2, clock_timestamp()) ON CONFLICT (user_id) DO NOTHING`,
    [person.userId, randomBytes(24).toString('hex')],
  );
}

const request = { headers: {}, ip: '127.0.0.1' } as FastifyRequest;

/** A session for someone, proven as `assurance` says, as the cookie a request would send */
async function sessionFor(
  person: SignedIn,
  assurance: Parameters<typeof createSession>[4],
  providerId?: string,
): Promise<{ cookie: string }> {
  const identity = (await findIdentity(server.pool, schema, person.userId))!;
  const created = await withTransaction(server.pool, (db) =>
    createSession(db, server.app.ctx, identity, request, assurance, providerId),
  );
  return { cookie: `${server.owner.headers.cookie.split('=')[0]}=${created.token}` };
}

const statusWith = async (headers: { cookie: string }) =>
  (await server.app.inject({ url: '/api/auth/session', headers })).statusCode;

/** Makes someone an organization admin with these roles */
async function organizationRoles(person: SignedIn, roles: string[]): Promise<void> {
  await server.pool.query(`UPDATE ${schema}.memberships SET admin_roles = $2 WHERE user_id = $1`, [
    person.userId,
    roles,
  ]);
}

/** Ages someone's sessions, as if they'd been open for days */
async function age(person: SignedIn, days: number): Promise<void> {
  await server.pool.query(
    `UPDATE ${schema}.sessions SET created_at = clock_timestamp() - $2 * interval '1 day' WHERE user_id = $1`,
    [person.userId, days],
  );
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'unitpolicy');
  schema = `"${server.schemas.app}"`;
  research = await ok(server.owner, 'POST', '/api/org/units', { name: 'Research', parentId: null }, 201);
  materials = await ok(
    server.owner,
    'POST',
    '/api/org/units',
    { name: 'Materials', parentId: research.id },
    201,
  );
  operations = await ok(server.owner, 'POST', '/api/org/units', { name: 'Operations', parentId: null }, 201);
  inside = await server.addMember({ name: 'Materials person' });
  other = await server.addMember({ name: 'Operations person' });
  await place(inside, materials);
  await place(other, operations);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('Directions', () => {
  it('lets security settings move only the stricter way and preferences either way', () => {
    expect(stricter('passwordMinLength', 14, 16)).toBe(true);
    expect(stricter('passwordMinLength', 14, 12)).toBe(false);
    expect(stricter('sessionMaxDays', 7, 1)).toBe(true);
    expect(stricter('sessionMaxDays', 7, 30)).toBe(false);
    expect(stricter('requireMfa', false, true)).toBe(true);
    expect(stricter('requireMfa', true, false)).toBe(false);
    expect(stricter('publicLinks', true, false)).toBe(true);
    expect(stricter('publicLinks', false, true)).toBe(false);
    expect(stricter('allowedThemes', null, ['nature'])).toBe(true);
    expect(stricter('allowedThemes', ['nature'], ['nature', 'ocean'])).toBe(false);
    expect(stricter('allowedThemes', ['nature'], null)).toBe(false);
    expect(stricter('guestLevel', 'standard', 'simple')).toBe(true);
    expect(stricter('guestLevel', 'standard', 'advanced')).toBe(false);
    expect(stricter('defaultLevel', 'standard', 'advanced')).toBe(true);
    expect(stricter('defaultLocale', 'en-US', 'fr')).toBe(true);
    // Anything that isn't the right kind of value is never stricter.
    expect(stricter('passwordMinLength', 14, '16')).toBe(false);
    expect(stricter('guestLevel', 'standard', 'expert')).toBe(false);
  });

  it('skips an override the organization no longer allows or has tightened past', () => {
    const base = {
      passwordMinLength: 20,
      publicLinks: false,
      defaultLocale: null,
    } as unknown as UnitPolicyValues;
    const chain = [
      {
        id: 'a',
        parentId: null,
        name: 'A',
        policy: { passwordMinLength: 16, publicLinks: true, defaultLocale: 'fr' },
        levels: {},
      },
    ];
    const tightened = inheritPolicy(
      base,
      chain,
      ['passwordMinLength', 'publicLinks', 'defaultLocale'],
      'Org',
    );
    expect(tightened.values.passwordMinLength).toBe(20);
    expect(tightened.values.publicLinks).toBe(false);
    expect(tightened.values.defaultLocale).toBe('fr');
    expect(tightened.origins.defaultLocale).toEqual({ id: 'a', name: 'A' });
    expect(tightened.origins.passwordMinLength).toEqual({ id: null, name: 'Org' });
    const locked = inheritPolicy(base, chain, [], 'Org');
    expect(locked.values.defaultLocale).toBeNull();
  });
});

describe('Inherited policy', () => {
  it('applies a stricter override and refuses a looser or locked one', async () => {
    await allow('passwordMinLength', 'sessionMaxDays', 'defaultLocale', 'publicLinks', 'calendarFeeds');
    expect(
      (await setUnit(research, { passwordMinLength: 16, defaultLocale: 'fr', publicLinks: false }))
        .statusCode,
    ).toBe(200);
    const looser = await setUnit(materials, { passwordMinLength: 14 });
    expect(looser.statusCode).toBe(403);
    expect(looser.body).toContain('orgUnits.policy.looser');
    expect((await setUnit(materials, { publicLinks: true })).statusCode).toBe(403);
    const locked = await setUnit(research, {
      passwordMinLength: 16,
      defaultLocale: 'fr',
      publicLinks: false,
      requireMfa: true,
    });
    expect(locked.statusCode).toBe(403);
    expect(locked.body).toContain('orgUnits.policy.locked');
    // A preference may go either way.
    expect((await setUnit(materials, { defaultLocale: 'de' })).statusCode).toBe(200);
    const view = await ok<UnitPolicyView>(server.owner, 'GET', `/api/org/units/${materials.id}/policy`);
    expect(view.values.passwordMinLength).toBe(16);
    expect(view.origins.passwordMinLength).toEqual({ id: research.id, name: 'Research' });
    expect(view.values.defaultLocale).toBe('de');
    expect(view.origins.defaultLocale).toEqual({ id: materials.id, name: 'Materials' });
    expect(view.origins.sessionMaxDays).toEqual({ id: null, name: 'Test organization' });
    expect(view.own).toEqual({ defaultLocale: 'de' });
    expect(view.inherited?.defaultLocale).toBe('fr');
    expect(view.overridable).toContain('publicLinks');
    expect((await policyOf(inside)).values).toMatchObject({ passwordMinLength: 16, publicLinks: false });
    const session = await ok<SessionInfo>(inside, 'GET', '/api/auth/session');
    expect(session.effectiveSettings?.defaultLocale).toBe('de');
    expect(session.org.settings.defaultLocale).toBeUndefined();
    expect(session.org.settings).not.toHaveProperty('unitPolicy');
  });

  it('lets the organization tighten past an old override, which then counts for nothing', async () => {
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: { passwordMinLength: 20 },
      overridable: ['passwordMinLength', 'sessionMaxDays', 'defaultLocale', 'publicLinks', 'calendarFeeds'],
    });
    const tightened = await policyOf(inside);
    expect(tightened.values.passwordMinLength).toBe(20);
    expect(tightened.origins.passwordMinLength.id).toBeNull();
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: {},
      overridable: ['sessionMaxDays', 'defaultLocale', 'calendarFeeds'],
    });
    const unlisted = await policyOf(inside);
    expect(unlisted.values.passwordMinLength).toBe(12);
    expect(unlisted.values.publicLinks).toBe(true);
    await allow('passwordMinLength', 'sessionMaxDays', 'defaultLocale', 'publicLinks', 'calendarFeeds');
    expect((await policyOf(inside)).values.passwordMinLength).toBe(16);
  });

  it('keeps each setting to its own admin role, in the organization and in a unit', async () => {
    const ai = await server.addMember({ name: 'AI admin' });
    await server.pool.query(`UPDATE ${schema}.memberships SET admin_roles = ARRAY['ai'] WHERE user_id = $1`, [
      ai.userId,
    ]);
    const current = await ok<UnitPolicyView>(ai, 'GET', '/api/admin/unit-policy');
    const put = (overridable: string[], values: Record<string, unknown> = {}) =>
      call(ai, 'PUT', '/api/admin/unit-policy', { values, overridable });
    expect((await put([...current.overridable, 'aiEnabled'])).statusCode).toBe(200);
    expect((await put([...current.overridable, 'aiEnabled', 'requireMfa'])).statusCode).toBe(403);
    // A setting another screen already owns is set there, not here.
    const elsewhere = await put([...current.overridable, 'aiEnabled'], { aiEnabled: false });
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.body).toContain('orgUnits.policy.elsewhere');
    // A unit admin with only the AI role changes only AI settings.
    const lead = await server.addMember({ name: 'Research AI admin' });
    await place(lead, research);
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/admins/${lead.userId}`, { roles: ['ai'] });
    const own = (await ok<UnitPolicyView>(lead, 'GET', `/api/org/units/${research.id}/policy`)).own;
    expect((await setUnit(research, { ...own, aiEnabled: false }, lead)).statusCode).toBe(200);
    expect((await setUnit(research, { ...own, aiEnabled: false, sessionMaxDays: 3 }, lead)).statusCode).toBe(
      403,
    );
    expect((await setUnit(operations, { aiEnabled: false }, lead)).statusCode).toBe(403);
    await setUnit(research, own);
  });

  it('changes a person’s policy the moment they move, sessions included', async () => {
    expect((await setUnit(operations, { sessionMaxDays: 1 })).statusCode).toBe(200);
    await server.pool.query(
      `UPDATE ${schema}.sessions SET created_at = clock_timestamp() - interval '2 days' WHERE user_id = $1`,
      [inside.userId],
    );
    expect(await sessionStatus(inside)).toBe(200);
    await place(inside, operations);
    try {
      expect((await policyOf(inside)).values.sessionMaxDays).toBe(1);
      expect(await sessionStatus(inside)).toBe(401);
    } finally {
      await place(inside, materials);
      await setUnit(operations, {});
    }
  });

  it('ends an open session that lacks a second step once the person’s unit requires one', async () => {
    await allow('requireMfa', 'requireSso', 'publicLinks', 'passwordMinLength');
    const person = await server.addMember({ name: 'Moving person' });
    expect((await setUnit(operations, { requireMfa: true })).statusCode).toBe(200);
    expect(await sessionStatus(person)).toBe(200);
    await place(person, operations);
    expect(await sessionStatus(person)).toBe(401);
    await setUnit(operations, {});
  });

  it('requires an identity provider before single sign-on, and then a provider sign-in', async () => {
    const refused = await setUnit(operations, { requireSso: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('orgUnits.policy.ssoProvider');
    const provider = await addProvider();
    expect((await setUnit(operations, { requireMfa: true, requireSso: true })).statusCode).toBe(200);
    const person = await server.addMember({ name: 'Provider person' });
    await place(person, operations);
    expect(await sessionStatus(person)).toBe(401);
    await link(person, provider);
    const identity = (await findIdentity(server.pool, schema, person.userId))!;
    // A provider sign-in alone doesn't meet a second-step requirement too.
    expect(await statusWith(await sessionFor(person, 'sso', provider))).toBe(401);
    // Nor does a second step alone.
    await expect(
      withTransaction(server.pool, (db) => afterFirstStep(db, server.app.ctx, identity, request, 'password')),
    ).rejects.toThrow('orgUnits.policy.sso');
    const first = await withTransaction(server.pool, (db) =>
      afterFirstStep(db, server.app.ctx, identity, request, 'sso', provider),
    );
    if (!('pending' in first)) throw new Error('A second step should be pending');
    expect(first.secondStep.stage).toBe('setup');
    await authenticator(person);
    const completed = await withTransaction(server.pool, (db) =>
      completeSignIn(db, server.app.ctx, request, first.pending, identity, 'authenticator'),
    );
    const cookie = { cookie: `${server.owner.headers.cookie.split('=')[0]}=${completed.token}` };
    expect(await statusWith(cookie)).toBe(200);
    // The owner always keeps a way in.
    expect(await sessionStatus(server.owner)).toBe(200);
    // How a session was proven stops counting once the proof is gone: the person's link to the
    // provider, or their last second step.
    await server.pool.query(`DELETE FROM ${schema}.sso_identities WHERE user_id = $1`, [person.userId]);
    expect(await statusWith(cookie)).toBe(401);
    await link(person, provider);
    const again = await sessionFor(person, 'sso-second-step', provider);
    expect(await statusWith(again)).toBe(200);
    await server.pool.query(`DELETE FROM ${schema}.authenticator_secrets WHERE user_id = $1`, [
      person.userId,
    ]);
    expect(await statusWith(again)).toBe(401);
    await setUnit(operations, {});
  });

  it('holds a password to the minimum where its person is now, except the owner’s', async () => {
    expect((await setUnit(operations, { passwordMinLength: 24 })).statusCode).toBe(200);
    const email = other.email;
    const password = ['a', 'long', 'test', 'password'].join(' ');
    const refused = await call(null, 'POST', '/api/auth/sign-in', { email, password });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('orgUnits.policy.password');
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: { passwordMinLength: 24 },
      overridable: ['requireMfa', 'requireSso', 'publicLinks', 'passwordMinLength'],
    });
    const owner = await call(null, 'POST', '/api/auth/sign-in', { email: server.owner.email, password });
    expect(owner.statusCode).toBe(200);
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: {},
      overridable: ['requireMfa', 'requireSso', 'publicLinks', 'passwordMinLength'],
    });
    await setUnit(operations, {});
    expect((await call(null, 'POST', '/api/auth/sign-in', { email, password })).statusCode).toBe(200);
  });

  it('pauses public links and refuses new ones where a unit turns them off', async () => {
    const databaseId = newId('database');
    const viewId = newId('view');
    await ok(other, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Operations records',
      table: {
        id: newId('table'),
        name: 'Records',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'All records' },
      },
    });
    const link = await ok<SharedViewLink>(other, 'PUT', `/api/views/${viewId}/shared-view`);
    expect((await call(null, 'GET', `/api/public/views/${link.linkId}`)).statusCode).toBe(200);
    expect((await setUnit(operations, { publicLinks: false })).statusCode).toBe(200);
    expect((await call(null, 'GET', `/api/public/views/${link.linkId}`)).statusCode).toBe(410);
    const again = await call(other, 'PUT', `/api/views/${viewId}/shared-view`);
    expect(again.statusCode).toBe(403);
    expect(again.body).toContain('orgUnits.policy.denied');
    await setUnit(operations, {});
    expect((await call(null, 'GET', `/api/public/views/${link.linkId}`)).statusCode).toBe(200);
  });

  it('pauses published sites and refuses new ones where a unit turns public links off', async () => {
    const databaseId = newId('database');
    const [face, later] = [newId('interface'), newId('interface')];
    await ok(other, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Operations site',
      table: {
        id: newId('table'),
        name: 'Records',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All records' },
      },
    });
    for (const id of [face, later]) {
      const made = await ok<{ results: Array<{ status: string }> }>(
        other,
        'POST',
        `/api/databases/${databaseId}/commands`,
        {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'interface.create',
              interface: {
                id,
                name: 'Home',
                pages: [
                  {
                    id: 'page01',
                    name: 'Home',
                    blocks: [
                      {
                        id: 'text0001',
                        kind: 'text',
                        place: { x: 0, y: 0, w: 6, h: 4 },
                        text: 'Operations news',
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      );
      expect(made.results[0]?.status).toBe('applied');
    }
    const slug = `operations-${randomBytes(3).toString('hex')}`;
    const publish = (id: string, address: string) =>
      call(other, 'PUT', `/api/interfaces/${id}/site`, {
        slug: address,
        title: 'Operations',
        pages: [{ pageId: 'page01', slug: 'home', title: 'Home', description: '' }],
      });
    expect((await publish(face, slug)).statusCode).toBe(200);
    expect((await call(null, 'GET', `/sites/${slug}`)).body).toContain('Operations news');
    expect((await setUnit(operations, { publicLinks: false })).statusCode).toBe(200);
    // An existing site answers as other paused links do, at once, and a new one isn't published.
    for (const path of [`/sites/${slug}`, `/sites/${slug}/home`, `/api/public/sites/${slug}`]) {
      const paused = await call(null, 'GET', path);
      expect(paused.statusCode, path).toBe(410);
      expect(paused.body).not.toContain('Operations news');
    }
    const refused = await publish(later, `${slug}-new`);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('orgUnits.policy.denied');
    expect((await call(null, 'GET', `/sites/${slug}-new`)).statusCode).toBe(404);
    // Unpublishing still works while public links are off.
    expect((await call(other, 'DELETE', `/api/interfaces/${later}/site`)).statusCode).toBe(204);
    await setUnit(operations, {});
    expect((await call(null, 'GET', `/sites/${slug}`)).body).toContain('Operations news');
  });

  it('turns off AI features for people in a unit that turns them off', async () => {
    await server.pool.query(
      `INSERT INTO ${schema}.ai_settings (org_id, settings) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
      [server.owner.info.org.id, JSON.stringify({ enabled: true, models: { everyday: null, power: null } })],
    );
    const orgId = server.owner.info.org.id;
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: {},
      overridable: ['aiEnabled', 'aiFields', 'aiDiagnose', 'automationAi'],
    });
    expect((await setUnit(operations, { aiFields: false, automationAi: false })).statusCode).toBe(200);
    expect(await settingsFor(server.app.ctx, orgId, other.userId)).toMatchObject({
      enabled: true,
      aiFields: false,
      automationAi: false,
    });
    expect(await settingsFor(server.app.ctx, orgId, inside.userId)).toMatchObject({
      enabled: true,
      aiFields: true,
      automationAi: true,
    });
    // A unit that leaves a feature on never turns it back on once the organization turns it off.
    expect((await setUnit(operations, { aiFields: true })).statusCode).toBe(200);
    await server.pool.query(`UPDATE ${schema}.ai_settings SET settings = $2 WHERE org_id = $1`, [
      orgId,
      JSON.stringify({ enabled: true, aiFields: false, models: { everyday: null, power: null } }),
    ]);
    expect(await settingsFor(server.app.ctx, orgId, other.userId)).toMatchObject({ aiFields: false });
    await setUnit(operations, {});
  });

  it('previews a preset’s changes before applying only the permitted ones', async () => {
    await allow('passwordMinLength', 'requireMfa', 'sessionMaxDays', 'publicLinks');
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {});
    await ok(server.owner, 'PUT', `/api/org/units/${materials.id}/policy`, {});
    const preview = await ok<UnitPresetPreview>(
      server.owner,
      'POST',
      `/api/org/units/${research.id}/policy/preview`,
      {
        preset: 'strict',
      },
    );
    expect(preview.diff).toContainEqual({ key: 'passwordMinLength', before: 12, after: 16, allowed: true });
    expect(preview.diff).toContainEqual({ key: 'sessionIdleDays', before: 7, after: 1, allowed: false });
    expect(preview.policy).toMatchObject({ passwordMinLength: 16, requireMfa: true, sessionMaxDays: 7 });
    expect(preview.policy).not.toHaveProperty('sessionIdleDays');
    // Nothing changes until the preview is applied.
    expect(
      (await ok<UnitPolicyView>(server.owner, 'GET', `/api/org/units/${research.id}/policy`)).own,
    ).not.toHaveProperty('requireMfa');
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, preview.policy);
    const applied = await ok<UnitPolicyView>(server.owner, 'GET', `/api/org/units/${materials.id}/policy`);
    expect(applied.values).toMatchObject({ passwordMinLength: 16, requireMfa: true, sessionMaxDays: 7 });
    // A looser preset below keeps what's inherited.
    const open = await ok<UnitPresetPreview>(
      server.owner,
      'POST',
      `/api/org/units/${materials.id}/policy/preview`,
      {
        preset: 'open',
      },
    );
    expect(open.diff).toContainEqual({ key: 'passwordMinLength', before: 16, after: 12, allowed: false });
    expect(open.diff).toContainEqual({ key: 'requireMfa', before: true, after: false, allowed: false });
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {});
  });
});

describe('Who a unit’s values reach', () => {
  it('keeps values set from above when a unit’s own admin clears it, and lets only admins at that level or above change them', async () => {
    await allow('publicLinks', 'externalSharing', 'passwordMinLength', 'defaultLocale');
    const lab = await ok<OrgUnit>(
      server.owner,
      'POST',
      '/api/org/units',
      { name: 'Lab', parentId: research.id },
      201,
    );
    const labAdmin = await server.addMember({ name: 'Lab security admin' });
    await ok(server.owner, 'PUT', `/api/org/units/${lab.id}/admins/${labAdmin.userId}`, {
      roles: ['security', 'people'],
    });
    const researchAdmin = await server.addMember({ name: 'Research security admin' });
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/admins/${researchAdmin.userId}`, {
      roles: ['security', 'people'],
    });
    await ok(server.owner, 'PUT', `/api/org/units/${lab.id}/policy`, {
      publicLinks: false,
      externalSharing: false,
      passwordMinLength: 40,
    });
    const set = await ok<UnitPolicyView>(labAdmin, 'GET', `/api/org/units/${lab.id}/policy`);
    expect(set.setBy.publicLinks).toEqual({ id: null, name: 'Test organization' });
    expect(set.changeable).not.toContain('publicLinks');
    // Clearing the unit leaves what the organization set, and changing it is refused.
    const cleared = await ok<UnitPolicyView>(labAdmin, 'PUT', `/api/org/units/${lab.id}/policy`, {});
    expect(cleared.own).toEqual({ publicLinks: false, externalSharing: false, passwordMinLength: 40 });
    const changed = await setUnit(
      lab,
      { publicLinks: false, externalSharing: false, passwordMinLength: 41 },
      labAdmin,
    );
    expect(changed.statusCode).toBe(403);
    expect(changed.body).toContain('orgUnits.policy.setAbove');
    // The lab's own admin sets and clears what's theirs.
    await ok(labAdmin, 'PUT', `/api/org/units/${lab.id}/policy`, { ...cleared.own, defaultLocale: 'fr' });
    expect(
      (await ok<UnitPolicyView>(labAdmin, 'GET', `/api/org/units/${lab.id}/policy`)).setBy.defaultLocale,
    ).toEqual({
      id: lab.id,
      name: 'Lab',
    });
    // An admin above changes the lab's own value, which then belongs to their level.
    await ok(researchAdmin, 'PUT', `/api/org/units/${lab.id}/policy`, {
      ...cleared.own,
      defaultLocale: 'de',
    });
    const above = await ok<UnitPolicyView>(labAdmin, 'GET', `/api/org/units/${lab.id}/policy`);
    expect(above.setBy.defaultLocale).toEqual({ id: research.id, name: 'Research' });
    expect(above.changeable).not.toContain('defaultLocale');
    await ok(labAdmin, 'PUT', `/api/org/units/${lab.id}/policy`, {});
    expect(
      (await ok<UnitPolicyView>(labAdmin, 'GET', `/api/org/units/${lab.id}/policy`)).own.defaultLocale,
    ).toBe('de');
    const organizationLevel = await ok<UnitPolicyView>(
      server.owner,
      'PUT',
      `/api/org/units/${lab.id}/policy`,
      {},
    );
    expect(organizationLevel.own).toEqual({});
    await ok(server.owner, 'DELETE', `/api/org/units/${lab.id}`, undefined, 204);
  });

  it('applies a unit’s values only to the people its admins could act on', async () => {
    await allow('publicLinks', 'externalSharing', 'sessionMaxDays');
    const unitAdmin = await server.addMember({ name: 'Research unit admin' });
    await place(unitAdmin, research);
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/admins/${unitAdmin.userId}`, {
      roles: ['security', 'people'],
    });
    const peer = await server.addMember({ name: 'Research peer admin' });
    await place(peer, research);
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/admins/${peer.userId}`, {
      roles: ['audit'],
    });
    const below = await server.addMember({ name: 'Materials admin' });
    await place(below, materials);
    await ok(server.owner, 'PUT', `/api/org/units/${materials.id}/admins/${below.userId}`, {
      roles: ['audit'],
    });
    const organizationAdmin = await server.addMember({ name: 'Organization admin in Research' });
    await organizationRoles(organizationAdmin, ['security']);
    await place(organizationAdmin, research);
    // Values below the server's floor never save.
    expect((await setUnit(research, { sessionMaxDays: 1e-9 }, unitAdmin)).statusCode).toBe(422);
    expect((await setUnit(research, { sessionMaxDays: 0.5 }, unitAdmin)).statusCode).toBe(422);
    expect((await setUnit(research, { publicLinks: false, sessionMaxDays: 1 }, unitAdmin)).statusCode).toBe(
      200,
    );
    const reached = async (person: SignedIn) => (await policyOf(person)).values;
    expect(await reached(inside)).toMatchObject({ publicLinks: false, sessionMaxDays: 1 });
    expect(await reached(below)).toMatchObject({ publicLinks: false, sessionMaxDays: 1 });
    for (const person of [unitAdmin, peer, organizationAdmin])
      expect(await reached(person), person.email).toMatchObject({
        publicLinks: true,
        sessionMaxDays: 30,
        // Sync out starts on, like the other sharing switches.
        syncOut: true,
      });
    // Sessions follow: a two-day-old session ends only for someone the unit's admins reach.
    for (const person of [inside, peer, organizationAdmin]) await age(person, 2);
    expect(await sessionStatus(peer)).toBe(200);
    expect(await sessionStatus(organizationAdmin)).toBe(200);
    expect(await sessionStatus(inside)).toBe(401);
    // What the organization sets on a unit reaches its admins and the organization's admins in it.
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {
      publicLinks: false,
      sessionMaxDays: 1,
      externalSharing: false,
    });
    for (const person of [unitAdmin, peer, organizationAdmin])
      expect((await reached(person)).externalSharing, person.email).toBe(false);
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {});
    await place(organizationAdmin, null);
  });

  it('holds the owner only to the server’s own session limits', async () => {
    const security = await server.addMember({ name: 'Organization security admin' });
    await organizationRoles(security, ['security']);
    const current = await ok<UnitPolicyView>(security, 'GET', '/api/admin/unit-policy');
    const put = (values: Record<string, unknown>) =>
      call(security, 'PUT', '/api/admin/unit-policy', { values, overridable: current.overridable });
    expect((await put({ sessionMaxDays: 1e-9 })).statusCode).toBe(422);
    expect((await put({ sessionIdleDays: 0.01 })).statusCode).toBe(422);
    expect((await put({ sessionMaxDays: 1, sessionIdleDays: 1 / 24 })).statusCode).toBe(200);
    const person = await server.addMember({ name: 'Organization member' });
    await age(server.owner, 2);
    await age(person, 2);
    expect(await sessionStatus(server.owner)).toBe(200);
    expect(await sessionStatus(person)).toBe(401);
    expect((await put({})).statusCode).toBe(200);
  });

  it('keeps the organization’s own settings apart from the ones that apply to an admin placed in a unit', async () => {
    await allow('defaultLevel', 'guestLevel');
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {
      guestLevel: 'simple',
      defaultLevel: 'advanced',
    });
    const peopleAdmin = await server.addMember({ name: 'Organization people admin' });
    await organizationRoles(peopleAdmin, ['people']);
    await place(peopleAdmin, materials);
    const session = await ok<SessionInfo>(peopleAdmin, 'GET', '/api/auth/session');
    expect(session.org.settings.defaultLevel).toBeUndefined();
    expect(session.org.settings.guestLevel).toBeUndefined();
    // Organization admins follow what the organization set on the unit.
    expect(session.effectiveSettings).toMatchObject({ defaultLevel: 'advanced', guestLevel: 'simple' });
    // What the organization's level editor sends when the admin changes only the default level
    const saved = await ok<Record<string, unknown>>(peopleAdmin, 'PUT', '/api/admin/levels', {
      defaultLevel: 'simple',
      guestLevel: session.org.settings.guestLevel ?? 'advanced',
    });
    expect(saved).not.toHaveProperty('unitPolicy');
    const stored = await server.pool.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM ${schema}.orgs WHERE id = $1`,
      [server.owner.info.org.id],
    );
    expect(stored.rows[0]!.settings).toMatchObject({ defaultLevel: 'simple', guestLevel: 'advanced' });
    await ok(server.owner, 'PUT', '/api/admin/levels', { defaultLevel: 'standard', guestLevel: 'advanced' });
    await ok(server.owner, 'PUT', `/api/org/units/${research.id}/policy`, {});
    await place(peopleAdmin, null);
  });
});

describe('Requiring single sign-on', () => {
  it('refuses to turn off the last provider while it’s required, and ignores the requirement with a warning when none is on', async () => {
    const current = await ok<UnitPolicyView>(server.owner, 'GET', '/api/admin/unit-policy');
    await server.pool.query(`DELETE FROM ${schema}.sso_providers WHERE org_id = $1`, [
      server.owner.info.org.id,
    ]);
    const first = await addProvider();
    const second = await addProvider();
    await allow(...current.overridable, 'requireSso');
    expect((await setUnit(operations, { requireSso: true })).statusCode).toBe(200);
    // Turning one of two off is fine, and the last one is refused, deleted or turned off.
    await ok(server.owner, 'PATCH', `/api/admin/sso/${first}`, { enabled: false });
    const off = await call(server.owner, 'PATCH', `/api/admin/sso/${second}`, { enabled: false });
    expect(off.statusCode).toBe(409);
    expect(off.body).toContain('orgUnits.policy.ssoStillRequired');
    const deleted = await call(server.owner, 'DELETE', `/api/admin/sso/${second}`);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.body).toContain('orgUnits.policy.ssoStillRequired');
    // A session a provider proved stops counting once that provider is turned off.
    await ok(server.owner, 'PATCH', `/api/admin/sso/${first}`, { enabled: true });
    const person = await server.addMember({ name: 'Provider session person' });
    await place(person, operations);
    await link(person, first);
    const through = await sessionFor(person, 'sso', first);
    expect(await statusWith(through)).toBe(200);
    await ok(server.owner, 'PATCH', `/api/admin/sso/${first}`, { enabled: false });
    expect(await statusWith(through)).toBe(401);
    // With no provider at all, as after an import, the requirement waits and admins see why.
    await server.pool.query(`DELETE FROM ${schema}.sso_providers WHERE org_id = $1`, [
      server.owner.info.org.id,
    ]);
    const view = await ok<UnitPolicyView>(server.owner, 'GET', `/api/org/units/${operations.id}/policy`);
    expect(view.warnings).toEqual(['ssoWithoutProvider']);
    expect(view.values.requireSso).toBe(false);
    const signIn = await call(null, 'POST', '/api/auth/sign-in', {
      email: person.email,
      password: ['a', 'long', 'test', 'password'].join(' '),
    });
    expect(signIn.statusCode).toBe(200);
    await addProvider();
    await setUnit(operations, {});
    await place(person, null);
  });

  it('never holds guests to it', async () => {
    const current = await ok<UnitPolicyView>(server.owner, 'GET', '/api/admin/unit-policy');
    const guest = await server.addMember({ name: 'Visiting guest', kind: 'guest' });
    const member = await server.addMember({ name: 'Signed-in member' });
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
      values: { requireSso: true },
      overridable: current.overridable,
    });
    try {
      expect(await sessionStatus(guest)).toBe(200);
      expect(await sessionStatus(member)).toBe(401);
      const signIn = await call(null, 'POST', '/api/auth/sign-in', {
        email: guest.email,
        password: ['a', 'long', 'test', 'password'].join(' '),
      });
      expect(signIn.statusCode).toBe(200);
    } finally {
      await ok(server.owner, 'PUT', '/api/admin/unit-policy', {
        values: {},
        overridable: current.overridable,
      });
    }
  });

  it('refuses a token while its person’s policy requires a sign-in step they haven’t set up', async () => {
    const current = await ok<UnitPolicyView>(server.owner, 'GET', '/api/admin/unit-policy');
    await allow(...current.overridable, 'requireMfa', 'requireSso');
    const provider = await addProvider();
    const person = await server.addMember({ name: 'Token person' });
    const created = await ok<{ token: string }>(person, 'POST', '/api/tokens', {
      name: 'Reports',
      scopes: ['schema.bases:read'],
      databases: 'all',
    });
    const bearer = { authorization: `Bearer ${created.token}` };
    const api = async () =>
      (await server.app.inject({ url: '/api/v1/databases', headers: bearer })).statusCode;
    expect(await api()).toBe(200);
    expect((await setUnit(operations, { requireMfa: true, requireSso: true })).statusCode).toBe(200);
    await place(person, operations);
    const refused = await server.app.inject({ url: '/api/v1/databases', headers: bearer });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('orgUnits.policy.tokenSetup');
    await authenticator(person);
    expect(await api()).toBe(403);
    await link(person, provider);
    expect(await api()).toBe(200);
    await place(person, null);
    await setUnit(operations, {});
  });
});

describe('Organizations without units', () => {
  let plain: ServerFixture;

  beforeAll(async () => {
    plain = await startServer(kit, 'unitplain');
  }, 120_000);

  afterAll(async () => {
    await plain?.close();
  });

  /** The pool's queries while one request runs */
  async function queriesFor(fixture: ServerFixture, who: SignedIn, url: string): Promise<string[]> {
    const pool = fixture.ctx.pool!;
    const original = pool.query.bind(pool);
    const seen: string[] = [];
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const text = args[0];
      seen.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const response = await fixture.app.inject({ url, headers: who.headers });
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
    return seen;
  }
  const policyQueries = (seen: string[]) => seen.filter((text) => text.includes('second_step_policy')).length;

  it('skips the unit policy entirely, and works a person’s policy out once a request where there are units', async () => {
    const person = await plain.addMember({ name: 'Plain member' });
    expect(policyQueries(await queriesFor(plain, person, '/api/auth/session'))).toBe(0);
    expect(policyQueries(await queriesFor(plain, person, '/api/org/units'))).toBe(0);
    const placed = await server.addMember({ name: 'Placed member' });
    await place(placed, materials);
    expect(policyQueries(await queriesFor(server, placed, '/api/auth/session'))).toBe(1);
  });

  /** What the pool's connections run while `queriesDuring` watches, and each connection watched */
  let watching: string[] | null = null;
  const watched = new WeakSet<object>();

  /** The text of every query any of the pool's connections runs while `work` does */
  async function queriesDuring(work: () => Promise<unknown>): Promise<string[]> {
    if (!watched.has(plain.pool)) {
      watched.add(plain.pool);
      // Each connection is watched from the moment it's first handed out, before it runs anything.
      plain.pool.on('acquire', (client) => {
        if (watched.has(client)) return;
        watched.add(client);
        const query = client.query as (...args: unknown[]) => unknown;
        (client as { query: unknown }).query = function (this: pg.PoolClient, ...args: unknown[]) {
          const text = args[0];
          watching?.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
          return query.apply(this, args);
        };
      });
    }
    const seen: string[] = [];
    watching = seen;
    try {
      await work();
    } finally {
      watching = null;
    }
    return seen;
  }
  /** Queries that work out a policy, whole or in part */
  const permissionQueries = (seen: string[]) => seen.filter((text) => text.includes('AS has_units')).length;

  /**
   * The text of every query one call runs.  Workers share the pool on their own timers, and a pass
   * of one landing inside the window would add its queries to a count of everything the pool sees,
   * so the call is handed a wrapper that only its own queries can be counted through.
   */
  async function queriesOf(work: (db: Queryable) => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const forward = plain.pool.query.bind(plain.pool) as unknown as (...args: unknown[]) => unknown;
    const db: Queryable = {
      query: ((...args: unknown[]) => {
        const text = args[0];
        seen.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
        return forward(...args);
      }) as Queryable['query'],
    };
    await work(db);
    return seen;
  }

  it('answers what a person may do from the organization’s own settings in one query, as before units', async () => {
    const person = await plain.addMember({ name: 'Feed person' });
    const who = { orgId: plain.owner.info.org.id, userId: person.userId };
    for (const check of [feedsAllowed, outsideRecipientsAllowed]) {
      let allowed: boolean | undefined;
      const seen = await queriesOf(async (db) => {
        allowed = await check(db, plain.schemas, who.orgId, who);
      });
      // The same answer as the organization's own switch, from one query that isn't the whole policy.
      expect(allowed).toBe(await check(plain.pool, plain.schemas, who.orgId));
      expect(seen).toHaveLength(1);
      expect(policyQueries(seen)).toBe(0);
    }
  });

  it('costs public links no policy query at all, until the organization sets a unit policy', async () => {
    const owner = plain.owner;
    const inject = (method: Method, url: string, payload?: unknown, who: SignedIn | null = owner) =>
      plain.app.inject({
        method,
        url,
        ...(who ? { headers: who.headers } : {}),
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    const made = async <T>(method: Method, url: string, payload?: unknown): Promise<T> => {
      const response = await inject(method, url, payload);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
      return response.json<T>();
    };
    const f = { name: newId('field'), email: newId('field'), when: newId('field'), notes: newId('field') };
    const databaseId = newId('database');
    const tableId = newId('table');
    const gridId = newId('view');
    const formId = newId('view');
    const calendarId = newId('view');
    await made('POST', '/api/databases', {
      id: databaseId,
      name: 'Appointments',
      table: {
        id: tableId,
        name: 'Appointments',
        fields: [
          { id: f.name, name: 'Name', type: 'text' },
          { id: f.email, name: 'Email', type: 'email' },
          { id: f.when, name: 'When', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
          { id: f.notes, name: 'Notes', type: 'longText' },
        ],
        view: { id: gridId, name: 'Grid' },
        records: [],
      },
    });
    const views = [
      {
        id: formId,
        tableId,
        name: 'Requests',
        type: 'form',
        config: {
          form: {
            title: 'Ask',
            description: '',
            questions: [{ fieldId: f.name, required: true }],
            submitLabel: 'Send',
            thankYou: 'Thanks.',
            allowAnother: true,
          },
        },
      },
      {
        id: calendarId,
        tableId,
        name: 'Calendar',
        type: 'calendar',
        config: { calendar: { startFieldId: f.when } },
      },
    ];
    await made('POST', `/api/databases/${databaseId}/commands`, {
      clientId: newId('client'),
      commands: views.map((view) => ({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'view.create',
        view,
      })),
    });
    const settings: BookingPageSettings = {
      title: 'Office hours',
      description: '',
      timeFieldId: f.when,
      resourceFieldId: null,
      lengthMinutes: 60,
      bufferMinutes: 0,
      timeZone: 'UTC',
      hours: Array.from({ length: 7 }, () => [{ start: '00:00', end: '24:00' }]),
      blockedDays: [],
      maxDaysAhead: 30,
      minNoticeMinutes: 0,
      places: 1,
      nameFieldId: f.name,
      emailFieldId: f.email,
      questions: [{ fieldId: f.notes, required: false }],
      confirmation: 'See you soon.',
      dailyPerEmail: 5,
    };
    const view = await made<SharedViewLink>('PUT', `/api/views/${gridId}/shared-view`);
    const form = await made<PublicFormLink>('PUT', `/api/views/${formId}/public-form`);
    const feed = await made<CalendarFeedCreated>('POST', `/api/views/${calendarId}/calendar-feed`, {
      timeZone: 'UTC',
    });
    const page = await made<BookingPage>('POST', `/api/tables/${tableId}/booking-pages`, {
      settings,
      enabled: true,
    });
    const links = [
      `/api/public/views/${view.linkId}`,
      `/api/public/forms/${form.formId}`,
      feed.path,
      `/api/public/bookings/${page.pageId}`,
    ];
    const loads = async () => {
      const statuses: number[] = [];
      const seen = await queriesDuring(async () => {
        for (const url of links) statuses.push((await inject('GET', url, undefined, null)).statusCode);
      });
      return { statuses, policy: permissionQueries(seen), whole: policyQueries(seen) };
    };
    expect(await loads()).toEqual({ statuses: [200, 200, 200, 200], policy: 0, whole: 0 });
    // A unit policy of the organization's own can turn public links off even with no units.
    await made('PUT', '/api/admin/unit-policy', { values: { publicLinks: false }, overridable: [] });
    const off = await loads();
    expect(off.statuses[0]).toBe(410);
    expect(off.statuses[1]).toBe(410);
    expect(off.statuses[2]).toBe(410);
    expect(off.statuses[3]).not.toBe(200);
    await made('PUT', '/api/admin/unit-policy', { values: {}, overridable: [] });
    // Each link then reads the organization's settings once, and never works out a whole policy.
    expect(await loads()).toEqual({ statuses: [200, 200, 200, 200], policy: links.length, whole: 0 });
  });

  it('leaves AI settings alone for a departed owner, so their field says so rather than AI being off', async () => {
    const orgId = plain.owner.info.org.id;
    await plain.pool.query(
      `INSERT INTO "${plain.schemas.app}".ai_settings (org_id, settings) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
      [orgId, JSON.stringify({ enabled: true, models: { everyday: null, power: null } })],
    );
    const leaver = await plain.addMember({ name: 'Leaver' });
    await plain.pool.query(`DELETE FROM "${plain.schemas.app}".memberships WHERE user_id = $1`, [
      leaver.userId,
    ]);
    const settings = await settingsFor(plain.app.ctx, orgId, leaver.userId);
    expect(settings).toEqual(await settingsFor(plain.app.ctx, orgId));
    expect(await unavailableReason(plain.app.ctx, orgId, settings)).not.toBe('aiFields.off');
  });
});

describe('Deleting or moving a unit', () => {
  const unit = (name: string, parentId: string | null) =>
    ok<OrgUnit>(server.owner, 'POST', '/api/org/units', { name, parentId }, 201);
  const grantRoles = (target: OrgUnit, person: SignedIn, roles: string[]) =>
    ok(server.owner, 'PUT', `/api/org/units/${target.id}/admins/${person.userId}`, { roles });
  const levelsOf = async (target: OrgUnit) =>
    (
      await server.pool.query<{ policy_levels: Record<string, string | null> }>(
        `SELECT policy_levels FROM ${schema}.org_units WHERE id = $1`,
        [target.id],
      )
    ).rows[0]!.policy_levels;

  it('never lets a value set by a deleted unit’s admins bind organization admins or peers placed below it', async () => {
    await allow('sessionMaxDays', 'externalSharing');
    const top = await unit('N1 Top', null);
    const mid = await unit('N1 Mid', top.id);
    const leaf = await unit('N1 Leaf', mid.id);
    const topAdmin = await server.addMember({ name: 'N1 Top admin' });
    await grantRoles(top, topAdmin, ['people', 'security']);
    const midAdmin = await server.addMember({ name: 'N1 Mid admin' });
    await grantRoles(mid, midAdmin, ['security']);
    const organizationAdmin = await server.addMember({ name: 'N1 organization security admin' });
    await organizationRoles(organizationAdmin, ['security']);
    await place(organizationAdmin, leaf);
    const peer = await server.addMember({ name: 'N1 Top audit admin' });
    await place(peer, leaf);
    await grantRoles(top, peer, ['audit']);
    const member = await server.addMember({ name: 'N1 Leaf member' });
    await place(member, leaf);
    await ok(midAdmin, 'PUT', `/api/org/units/${leaf.id}/policy`, {
      sessionMaxDays: 1,
      externalSharing: false,
    });
    expect(await levelsOf(leaf)).toEqual({ sessionMaxDays: mid.id, externalSharing: mid.id });
    for (const person of [organizationAdmin, peer, member]) await age(person, 2);
    expect(await sessionStatus(organizationAdmin)).toBe(200);
    expect(await sessionStatus(peer)).toBe(200);
    expect(await sessionStatus(member)).toBe(401);
    // Top's admin can't reach the organization admin or their own peer, so they can move neither
    // the leaf nor, by deleting Mid, everyone below it.
    const moving = await call(topAdmin, 'PUT', `/api/org/units/${leaf.id}`, {
      name: 'N1 Leaf',
      parentId: top.id,
    });
    expect(moving.statusCode).toBe(403);
    expect((await call(topAdmin, 'DELETE', `/api/org/units/${mid.id}`)).statusCode).toBe(403);
    // With only people they reach below, the delete goes through and re-levels Mid's values to Top.
    await place(organizationAdmin, null);
    await place(peer, null);
    await ok(topAdmin, 'DELETE', `/api/org/units/${mid.id}`, undefined, 204);
    expect(await levelsOf(leaf)).toEqual({ sessionMaxDays: top.id, externalSharing: top.id });
    const view = await ok<UnitPolicyView>(topAdmin, 'GET', `/api/org/units/${leaf.id}/policy`);
    expect(view.setBy.sessionMaxDays).toEqual({ id: top.id, name: 'N1 Top' });
    expect(view.changeable).toContain('sessionMaxDays');
    // The organization admin and the peer, placed back below, still follow the organization.
    await place(organizationAdmin, leaf);
    await place(peer, leaf);
    expect(await sessionStatus(organizationAdmin)).toBe(200);
    expect(await sessionStatus(peer)).toBe(200);
    expect((await policyOf(organizationAdmin)).values).toMatchObject({
      sessionMaxDays: 30,
      externalSharing: true,
    });
    const deleted = (await ok<UnitAuditEntry[]>(server.owner, 'GET', '/api/org/unit-audit')).find(
      (entry) =>
        entry.action === 'org.unit.deleted' && (entry.metadata.before as { id: string }).id === mid.id,
    );
    expect(deleted?.metadata.releveled).toEqual(
      expect.arrayContaining([{ unitId: leaf.id, setting: 'sessionMaxDays', from: mid.id, to: top.id }]),
    );
    for (const person of [organizationAdmin, peer]) await place(person, null);
  });

  it('re-levels what a moved unit leaves behind, and to the unit itself when nothing above stays', async () => {
    await allow('sessionMaxDays', 'externalSharing');
    const top = await unit('N1b Top', null);
    const mid = await unit('N1b Mid', top.id);
    const leaf = await unit('N1b Leaf', mid.id);
    const topAdmin = await server.addMember({ name: 'N1b Top admin' });
    await grantRoles(top, topAdmin, ['people', 'security']);
    const midAdmin = await server.addMember({ name: 'N1b Mid admin' });
    await grantRoles(mid, midAdmin, ['security']);
    await ok(midAdmin, 'PUT', `/api/org/units/${leaf.id}/policy`, { sessionMaxDays: 1 });
    await ok(topAdmin, 'PUT', `/api/org/units/${leaf.id}`, { name: 'N1b Leaf', parentId: top.id });
    expect(await levelsOf(leaf)).toEqual({ sessionMaxDays: top.id });
    const view = await ok<UnitPolicyView>(topAdmin, 'GET', `/api/org/units/${leaf.id}/policy`);
    expect(view.setBy.sessionMaxDays).toEqual({ id: top.id, name: 'N1b Top' });
    expect(view.changeable).toContain('sessionMaxDays');
    // Someone placed there afterward is bound only if Top's admins reach them.
    const organizationAdmin = await server.addMember({ name: 'N1b organization security admin' });
    await organizationRoles(organizationAdmin, ['security']);
    await place(organizationAdmin, leaf);
    const member = await server.addMember({ name: 'N1b Leaf member' });
    await place(member, leaf);
    await age(organizationAdmin, 2);
    await age(member, 2);
    expect(await sessionStatus(organizationAdmin)).toBe(200);
    expect(await sessionStatus(member)).toBe(401);
    // With nothing above left, the value stays with the leaf itself, never the organization.
    await place(organizationAdmin, null);
    await place(member, null);
    await ok(server.owner, 'DELETE', `/api/org/units/${top.id}`, undefined, 204);
    expect(await levelsOf(leaf)).toEqual({ sessionMaxDays: leaf.id });
    await place(organizationAdmin, leaf);
    expect((await policyOf(organizationAdmin)).values.sessionMaxDays).toBe(30);
    await place(organizationAdmin, null);
    for (const item of [leaf, mid])
      await ok(server.owner, 'DELETE', `/api/org/units/${item.id}`, undefined, 204);
  });
});

import {
  newId,
  TELEMETRY_FEATURES,
  TELEMETRY_SIZES,
  TELEMETRY_USE_RANGES,
  TELEMETRY_USES,
  type TelemetryPayload,
  type TelemetryStatus,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { DAY, standIn } from '../updates/updates.test-helpers.js';
import { lastWeek, reportedVersion, sizeOf, useRange } from './collect.js';

/** Anonymous usage counts, sent to a stand-in hub on 127.0.0.1 */

let kit: TestPostgres;
let server: ServerFixture;
let admin: SignedIn;
let hub: Awaited<ReturnType<typeof standIn>>;
let answer = 200;
const DATABASE_NAME = 'Quarterly donors of Wexford';
const SECRET_VALUE = 'margaret.oduya@example.test';

beforeAll(async () => {
  kit = await startTestPostgres();
  hub = await standIn(() => ({ status: answer, body: {} }));
  server = await startServer(kit, 'telemetry', {
    telemetryUrl: `${hub.url}/telemetry`,
    installMethod: 'helm',
    updatesPollMs: 0,
  });
  admin = await server.addMember({ name: 'Admin' });
  await server.pool.query(
    `UPDATE "${server.schemas.app}".memberships SET admin_roles = '{people}' WHERE user_id = $1`,
    [admin.userId],
  );
  // A database whose name and records would identify the organization if any of it were sent.
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: DATABASE_NAME,
      table: {
        id: tableId,
        name: 'Donors',
        fields: [{ id: fieldId, name: 'Email', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const commands = await server.app.inject({
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
          records: Array.from({ length: 3 }, () => ({
            id: newId('record'),
            values: { [fieldId]: SECRET_VALUE },
          })),
        },
      ],
    },
  });
  expect(commands.statusCode, commands.body).toBe(200);
  await server.pool.query(`ANALYZE "${server.schemas.data}"."${tableId}"`);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await hub?.close();
  await kit?.stop();
});

beforeEach(() => {
  answer = 200;
  server.ctx.config.telemetryAllowed = true;
});

async function status(who: SignedIn = server.owner): Promise<TelemetryStatus> {
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/admin/telemetry',
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TelemetryStatus>();
}

async function choose(enabled: boolean) {
  return server.app.inject({
    method: 'PUT',
    url: '/api/admin/telemetry',
    headers: server.owner.headers,
    payload: { enabled },
  });
}

/** The install ID as the database keeps it */
async function storedId(): Promise<string | null> {
  const result = await server.pool.query<{ install_id: string | null }>(
    `SELECT install_id FROM "${server.schemas.app}".telemetry WHERE id = 1`,
  );
  return result.rows[0]!.install_id;
}

async function events(action: string) {
  const result = await server.pool.query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    `SELECT actor_id, metadata FROM "${server.schemas.audit}".events WHERE action = $1 ORDER BY id`,
    [action],
  );
  return result.rows;
}

/** Every string anywhere in a value */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('usage counts', () => {
  it('are off by default, with no install ID, and nothing is sent', async () => {
    const found = await status();
    expect(found).toMatchObject({
      enabled: false,
      forcedOff: false,
      url: `${hub.url}/telemetry`,
      installId: null,
      lastSent: null,
    });
    expect(await storedId()).toBeNull();
    expect(await server.ctx.telemetry!.tick()).toBe(false);
    expect(hub.requests).toEqual([]);
  });

  it('are the owner’s alone to see and choose', async () => {
    const byAdmin = await server.app.inject({
      method: 'GET',
      url: '/api/admin/telemetry',
      headers: admin.headers,
    });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toMatchObject({ error: { messageKey: 'telemetry.ownerOnly' } });
    const member = await server.addMember();
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/admin/telemetry', headers: member.headers }))
        .statusCode,
    ).toBe(403);
  });

  it('hold only counts, ranges, and flags, with nothing that identifies the organization or its people', async () => {
    const { preview } = await status();
    expect(Object.keys(preview)).toEqual([
      'schema',
      'installId',
      'week',
      'version',
      'install',
      'databases',
      'tables',
      'features',
      'uses',
    ]);
    expect(Object.keys(preview.databases)).toEqual([...TELEMETRY_SIZES]);
    expect(Object.keys(preview.tables)).toEqual([...TELEMETRY_SIZES]);
    expect(Object.keys(preview.features)).toEqual([...TELEMETRY_FEATURES]);
    expect(Object.keys(preview.uses)).toEqual([...TELEMETRY_USES]);
    for (const value of [...Object.values(preview.databases), ...Object.values(preview.tables)])
      expect(Number.isInteger(value) && value >= 0).toBe(true);
    // Uses go as ranges, so a small install's week doesn't describe what one person did.
    for (const value of Object.values(preview.uses)) expect(TELEMETRY_USE_RANGES).toContain(value);
    const nextWeek = await server.ctx.telemetry!.payload(preview.installId, new Date(Date.now() + 7 * DAY));
    expect(nextWeek.uses.signIns).toBe('1-9');
    for (const value of Object.values(preview.features)) expect(typeof value).toBe('boolean');
    expect(preview.install).toBe('helm');
    expect(preview.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(preview.tables['1-99']).toBe(1);
    expect(preview.databases['1-99']).toBe(1);
    // The only strings are the payload's own: its install ID, week, version, install method, and
    // the use ranges.
    expect(strings(preview).sort()).toEqual(
      [
        preview.installId,
        preview.week,
        preview.version,
        preview.install,
        ...Object.values(preview.uses),
      ].sort(),
    );
    const text = JSON.stringify(preview);
    for (const identifying of [
      DATABASE_NAME,
      'Donors',
      SECRET_VALUE,
      'Test organization',
      server.owner.email,
      server.owner.info.org.id,
      server.owner.userId,
      '127.0.0.1',
    ])
      expect(text).not.toContain(identifying);
  });

  it('send exactly what the owner was shown, once a week, and keep what was sent', async () => {
    const now = new Date();
    const before = (await status()).preview;
    const on = await choose(true);
    expect(on.statusCode, on.body).toBe(200);
    const chosen = on.json<TelemetryStatus>();
    expect(chosen.enabled).toBe(true);
    // Turning counts on made the install ID, which the preview now carries.
    expect(chosen.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await storedId()).toBe(chosen.installId);
    const shown = chosen.preview;
    expect(shown.installId).toBe(chosen.installId);
    // What was shown before the choice differs only by its example ID.
    expect({ ...before, installId: 'x' }).toEqual({ ...shown, installId: 'x' });
    expect(await events('telemetry.enabled')).toEqual([{ actor_id: server.owner.userId, metadata: {} }]);
    const preview = await server.ctx.telemetry!.payload(chosen.installId!, now);
    expect(preview).toEqual(shown);
    expect(await server.ctx.telemetry!.tick(now)).toBe(true);
    expect(hub.requests).toHaveLength(1);
    const sent = hub.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.body).toBe(JSON.stringify(preview));
    const kept = await status();
    expect(kept.lastSent).toEqual({ at: now.toISOString(), delivered: true, payload: preview });
    // Nothing more goes this week, and the next week's counts go the week after.
    expect(await server.ctx.telemetry!.tick(new Date(now.getTime() + 60 * 60_000))).toBe(false);
    expect(hub.requests).toHaveLength(1);
    const next = new Date(now.getTime() + 7 * DAY);
    expect(await server.ctx.telemetry!.tick(next)).toBe(true);
    expect(JSON.parse(hub.requests[1]!.body) as TelemetryPayload).toMatchObject({
      week: lastWeek(next).label,
    });
    expect((await events('telemetry.sent')).map((event) => event.metadata)).toEqual([
      { week: lastWeek(now).label, delivered: true },
      { week: lastWeek(next).label, delivered: true },
    ]);
  });

  it('try a failed send again later, not every hour', async () => {
    const start = new Date(Date.now() + 21 * DAY);
    answer = 503;
    const before = hub.requests.length;
    expect(await server.ctx.telemetry!.tick(start)).toBe(false);
    expect(hub.requests.length).toBe(before + 1);
    expect((await status()).lastSent).toMatchObject({ delivered: false });
    answer = 200;
    expect(await server.ctx.telemetry!.tick(new Date(start.getTime() + 60 * 60_000))).toBe(false);
    expect(hub.requests.length).toBe(before + 1);
    expect(await server.ctx.telemetry!.tick(new Date(start.getTime() + 7 * 60 * 60_000))).toBe(true);
  });

  it('give a new random install ID on request', async () => {
    const before = (await status()).installId;
    expect(before).not.toBeNull();
    const reset = await server.app.inject({
      method: 'POST',
      url: '/api/admin/telemetry/install-id',
      headers: server.owner.headers,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const after = reset.json<TelemetryStatus>();
    expect(after.installId).not.toBe(before);
    expect(after.preview.installId).toBe(after.installId);
    expect(await storedId()).toBe(after.installId);
    expect(await events('telemetry.install_id_reset')).toHaveLength(1);
  });

  it('stay off when the server’s setting says so, whatever the owner chose', async () => {
    expect(
      loadConfig({ RIOSOMA_TELEMETRY: 'off', RIOSOMA_CONFIG_DIR: server.config.configDir }).telemetryAllowed,
    ).toBe(false);
    server.ctx.config.telemetryAllowed = false;
    const before = hub.requests.length;
    const found = await status();
    expect(found).toMatchObject({ forcedOff: true, enabled: false });
    expect(await server.ctx.telemetry!.tick(new Date(Date.now() + 70 * DAY))).toBe(false);
    expect(hub.requests.length).toBe(before);
    const refused = await choose(true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'telemetry.forcedOff' } });
  });

  it('stop when the owner turns them off, deleting the install ID and the record of what was sent', async () => {
    const was = (await status()).installId;
    expect((await status()).lastSent).not.toBeNull();
    const off = await choose(false);
    const found = off.json<TelemetryStatus>();
    expect(found).toMatchObject({ enabled: false, installId: null, lastSent: null });
    expect(found.preview.installId).not.toBe(was);
    const row = await server.pool.query(
      `SELECT install_id, last_payload, last_sent_at FROM "${server.schemas.app}".telemetry`,
    );
    expect(row.rows).toEqual([{ install_id: null, last_payload: null, last_sent_at: null }]);
    expect(await events('telemetry.disabled')).toHaveLength(1);
    const before = hub.requests.length;
    expect(await server.ctx.telemetry!.tick(new Date(Date.now() + 90 * DAY))).toBe(false);
    expect(hub.requests.length).toBe(before);
    // With counts off there's no ID to replace.
    const reset = await server.app.inject({
      method: 'POST',
      url: '/api/admin/telemetry/install-id',
      headers: server.owner.headers,
    });
    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({ error: { messageKey: 'telemetry.off' } });
    // Turning them on again makes a new ID, never the old one.
    const again = (await choose(true)).json<TelemetryStatus>();
    expect(again.installId).not.toBeNull();
    expect(again.installId).not.toBe(was);
    await choose(false);
  });
});

describe('what usage counts report', () => {
  it('count the whole week before, from Monday in UTC', () => {
    expect(lastWeek(new Date('2026-10-01T12:00:00Z'))).toMatchObject({ label: '2026-09-21' });
    expect(lastWeek(new Date('2026-09-28T00:00:00Z'))).toMatchObject({ label: '2026-09-21' });
    expect(lastWeek(new Date('2026-09-27T23:59:59Z'))).toMatchObject({ label: '2026-09-14' });
  });

  it('put uses and records in ranges, and send only release versions', () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1_000, 50_000].map(useRange)).toEqual([
      '0',
      '1-9',
      '1-9',
      '10-99',
      '10-99',
      '100-999',
      '100-999',
      '1000+',
      '1000+',
    ]);
    expect([0, 1, 99, 100, 9_999, 10_000, 999_999, 1_000_000].map(sizeOf)).toEqual([
      '0',
      '1-99',
      '1-99',
      '100-999',
      '1000-9999',
      '10000-99999',
      '100000-999999',
      '1000000+',
    ]);
    expect(reportedVersion('1.2.3')).toBe('1.2.3');
    expect(reportedVersion('1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(reportedVersion('1.2.3-acme-build')).toBe('custom');
    expect(reportedVersion('wexford-internal')).toBe('custom');
  });
});

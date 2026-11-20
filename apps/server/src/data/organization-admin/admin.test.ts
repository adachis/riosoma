import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  UNIT_ADMIN_ROLES,
  type AuditEntry,
  type AuditPage,
  type OrganizationCommandResult,
  type OrganizationPresetPreview,
} from '@riosoma/contracts';
import { auditEvent } from '../../auth/database.js';
import { notify } from '../../notifications/produce.js';
import { MIGRATIONS } from '../../migrations/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { checkIntegrity } from './store.js';
import { csvCell } from './routes.js';

let kit: TestPostgres;
let server: ServerFixture;
let people: SignedIn;
let security: SignedIn;
let auditor: SignedIn;
let member: SignedIn;

const call = (who: SignedIn, method: 'GET' | 'POST', url: string, payload?: object) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload ? { payload } : {}) });
const command = (who: SignedIn, payload: object) => call(who, 'POST', '/api/org/admin-commands', payload);
async function roles(person: SignedIn, values: readonly string[]) {
  const response = await command(server.owner, {
    kind: 'organization.roles',
    userId: person.userId,
    roles: values,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OrganizationCommandResult>();
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'adminroles');
  people = await server.addMember({ name: 'People admin' });
  security = await server.addMember({ name: 'Security admin' });
  auditor = await server.addMember({ name: 'Audit admin' });
  member = await server.addMember({ name: 'Member' });
  await roles(people, ['people']);
  await roles(security, ['security']);
  await roles(auditor, ['audit']);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('organization admin roles', () => {
  it('rejects a stale upload policy save from concurrent administrators', async () => {
    const initial = (await call(server.owner, 'GET', '/api/org/files')).json();
    const seeded = await command(server.owner, {
      kind: 'organization.files',
      maxUploadBytes: 1024,
      revision: initial.revision,
    });
    expect(seeded.statusCode, seeded.body).toBe(200);
    const owner = (await call(server.owner, 'GET', '/api/org/files')).json();
    const admin = (await call(security, 'GET', '/api/org/files')).json();
    expect(owner.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(admin.revision).toBe(owner.revision);
    const responses = await Promise.all([
      command(server.owner, { kind: 'organization.files', maxUploadBytes: 2048, revision: owner.revision }),
      command(security, { kind: 'organization.files', maxUploadBytes: 4096, revision: admin.revision }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!.json();
    const stored = (await call(server.owner, 'GET', '/api/org/files')).json();
    expect(winner.fileSettings).toEqual(stored);
    expect(stored.revision).not.toBe(owner.revision);
    expect(responses.find((response) => response.statusCode === 409)!.json().error.messageKey).toBe(
      'errors.conflict',
    );
    const audit = (
      await call(server.owner, 'GET', '/api/org/audit?action=organization.files')
    ).json<AuditPage>();
    expect(
      audit.events.filter((event) =>
        [2048, 4096].includes(Number((event.metadata.after as Record<string, unknown>).maxUploadBytes)),
      ),
    ).toHaveLength(1);
    const restored = await command(server.owner, {
      kind: 'organization.files',
      maxUploadBytes: initial.maxUploadBytes,
      revision: stored.revision,
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('lets an audited change notify while an organization command waits for the chain', async () => {
    const client = await server.pool.connect();
    let pending: ReturnType<typeof command> | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '500ms'");
      const connection = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = connection.rows[0]!.pid;
      await auditEvent(client, `"${server.schemas.audit}"`, 'chain.notification', {
        orgId: server.owner.info.org.id,
        userId: server.owner.userId,
      });
      pending = command(server.owner, { kind: 'audit.export', filters: {}, format: 'json' });
      await expect
        .poll(async () => {
          const waiting = await server.pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event = 'advisory'`,
            [pid],
          );
          return waiting.rowCount;
        })
        .toBe(1);
      await notify(client, server.schemas, {
        orgId: server.owner.info.org.id,
        recipientId: member.userId,
        actorId: server.owner.userId,
        kind: 'share',
        subjectId: randomUUID(),
        target: {},
      });
      await client.query('COMMIT');
      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pending;
    }
  });

  it('retries a deadlock after rolling back the whole organization command', async () => {
    const schema = `"${server.schemas.audit}"`;
    await server.pool.query(`
      CREATE SEQUENCE ${schema}.retry_attempt;
      CREATE FUNCTION ${schema}.retry_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'organization.roles' AND nextval('${schema}.retry_attempt') = 1 THEN
          RAISE EXCEPTION 'retry transaction' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER retry_once AFTER INSERT ON ${schema}.events
        FOR EACH ROW EXECUTE FUNCTION ${schema}.retry_once();
    `);
    try {
      const result = await roles(member, ['audit']);
      expect((await server.pool.query(`SELECT last_value::int FROM ${schema}.retry_attempt`)).rows).toEqual([
        { last_value: 2 },
      ]);
      const events = await server.pool.query(
        `SELECT id::text FROM ${schema}.events WHERE action = 'organization.roles' AND target = $1`,
        [member.userId],
      );
      expect(events.rows).toEqual([{ id: result.eventId }]);
      const notices = await server.pool.query(
        `SELECT subject_id FROM "${server.schemas.app}".notifications WHERE kind = 'adminRolesChanged' AND recipient_id = $1`,
        [member.userId],
      );
      expect(notices.rows).toEqual([{ subject_id: result.eventId }]);
    } finally {
      await server.pool.query(`DROP TRIGGER retry_once ON ${schema}.events`);
      await server.pool.query(`DROP FUNCTION ${schema}.retry_once()`);
      await server.pool.query(`DROP SEQUENCE ${schema}.retry_attempt`);
      await roles(member, []);
    }
  });

  it('lets only the owner assign any combination and queues email and bell notices', async () => {
    for (const person of [people, security, auditor, member]) {
      for (const target of [person, member])
        expect(
          (
            await command(person, {
              kind: 'organization.roles',
              userId: target.userId,
              roles: ['people', 'audit'],
            })
          ).statusCode,
        ).toBe(403);
    }
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".notification_preferences (org_id, user_id, email)
      VALUES ($1, $2, $3)`,
      [server.owner.info.org.id, member.userId, { adminRolesChanged: false }],
    );
    const result = await roles(member, UNIT_ADMIN_ROLES);
    const listed = await call(server.owner, 'GET', `/api/org/members/${member.userId}/admin-roles`);
    expect(listed.json().roles).toEqual([...UNIT_ADMIN_ROLES].sort());
    const notice = await server.pool.query(
      `SELECT kind, email FROM "${server.schemas.app}".notifications WHERE subject_id = $1`,
      [result.eventId],
    );
    expect(notice.rows).toEqual([{ kind: 'adminRolesChanged', email: 'pending' }]);
    const undo = await command(server.owner, { kind: 'organization.undo', eventId: result.eventId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await call(server.owner, 'GET', `/api/org/members/${member.userId}/admin-roles`)).json()).toEqual(
      { roles: [] },
    );
    expect(
      (await command(server.owner, { kind: 'organization.undo', eventId: result.eventId })).statusCode,
    ).toBe(409);
  });

  it('refuses guests, owners, unknown roles, and stale undo', async () => {
    const guest = await server.addMember({ kind: 'guest' });
    for (const userId of [guest.userId, server.owner.userId])
      expect(
        (
          await command(server.owner, {
            kind: 'organization.roles',
            userId,
            roles: ['audit'],
          })
        ).statusCode,
      ).toBe(409);
    expect(
      (
        await command(server.owner, {
          kind: 'organization.roles',
          userId: member.userId,
          roles: ['everything'],
        })
      ).statusCode,
    ).toBe(422);
    const first = await roles(member, ['audit']);
    await roles(member, ['security']);
    expect(
      (await command(server.owner, { kind: 'organization.undo', eventId: first.eventId })).statusCode,
    ).toBe(409);
    await roles(member, []);
  });
});

describe('audit access, filters, and streamed exports', () => {
  it('refuses every read and export without the organization Audit area', async () => {
    for (const person of [people, security, member]) {
      for (const url of ['/api/org/audit', '/api/org/audit/integrity', '/api/org/audit/1'])
        expect((await call(person, 'GET', url)).statusCode).toBe(403);
      expect(
        (await call(person, 'POST', '/api/org/audit/export', { filters: {}, format: 'json' })).statusCode,
      ).toBe(403);
      expect((await command(person, { kind: 'audit.export', filters: {}, format: 'json' })).statusCode).toBe(
        403,
      );
    }
    for (const person of [people, auditor, member])
      expect((await call(person, 'GET', '/api/org/presets/balanced')).statusCode).toBe(403);
    expect((await call(people, 'GET', `/api/org/members/${member.userId}/admin-roles`)).statusCode).toBe(403);
  });

  it('exports all filtered pages as an Audit admin and audits the export', async () => {
    const schema = `"${server.schemas.audit}"`;
    const action = `review.${randomUUID()}`;
    await server.pool.query(
      `INSERT INTO ${schema}.events (org_id, actor_id, action, target, metadata, at)
      SELECT $1, $2, $3, $4, jsonb_build_object('recordId', n::text), '2026-09-01T10:00:00Z'::timestamptz
      FROM generate_series(1, 121) n`,
      [server.owner.info.org.id, server.owner.userId, action, '=SUM(1)'],
    );
    await server.pool.query(`INSERT INTO ${schema}.events (org_id, action) VALUES ($1, $2)`, [
      randomUUID(),
      action,
    ]);
    const filters = {
      action,
      person: server.owner.userId,
      resource: '=SUM(1)',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-02T00:00:00Z',
      q: 'recordId',
    };
    const first = await call(auditor, 'GET', `/api/org/audit?${new URLSearchParams(filters)}&limit=25`);
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<AuditPage>();
    expect(page.events).toHaveLength(25);
    expect(page.next).not.toBeNull();
    const second = (
      await call(
        auditor,
        'GET',
        `/api/org/audit?${new URLSearchParams(filters)}&limit=25&before=${page.next}`,
      )
    ).json<AuditPage>();
    expect(second.events.some((event) => page.events.some((entry) => entry.id === event.id))).toBe(false);
    const exported = await call(auditor, 'POST', '/api/org/audit/export', { filters, format: 'json' });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-disposition']).toBe('attachment; filename="audit.json"');
    expect(exported.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(exported.headers['x-content-type-options']).toBe('nosniff');
    const entries = exported.json<AuditEntry[]>();
    expect(entries).toHaveLength(121);
    expect(entries.every((entry) => entry.action === action && entry.actorId === server.owner.userId)).toBe(
      true,
    );
    expect((await call(auditor, 'GET', `/api/org/audit/${entries[0]!.id}`)).json()).toEqual(entries[0]);
    const csv = await call(auditor, 'POST', '/api/org/audit/export', { filters, format: 'csv' });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="audit.csv"');
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.body.split('\r\n')).toHaveLength(123);
    expect(csv.body).toContain('"\'=SUM(1)"');
    const log = (await call(auditor, 'GET', '/api/org/audit?action=audit.export')).json<AuditPage>();
    expect(log.events.slice(0, 2).map((event) => event.metadata.format)).toEqual(['csv', 'json']);
    expect(log.events[0]!.metadata.filters).toEqual(filters);
    expect((await call(auditor, 'GET', '/api/org/audit?from=invalid')).statusCode).toBe(422);
  });
});

describe('organization presets', () => {
  it('applies Open with MFA enabled and can undo the policy change', async () => {
    await server.pool.query(
      `UPDATE "${server.schemas.app}".orgs SET second_step_policy = 'everyone' WHERE id = $1`,
      [server.owner.info.org.id],
    );
    try {
      const preview = (
        await call(security, 'GET', '/api/org/presets/open')
      ).json<OrganizationPresetPreview>();
      expect(preview.diff).toContainEqual({ key: 'requireMfa', before: true, after: false, allowed: true });
      const applied = await command(security, {
        kind: 'organization.preset',
        preset: 'open',
        revision: preview.revision,
      });
      expect(applied.statusCode, applied.body).toBe(200);
      const state = await server.pool.query(
        `SELECT second_step_policy FROM "${server.schemas.app}".orgs WHERE id = $1`,
        [server.owner.info.org.id],
      );
      expect(state.rows[0].second_step_policy).toBe('off');
      const undone = await command(security, {
        kind: 'organization.undo',
        eventId: applied.json<OrganizationCommandResult>().eventId,
      });
      expect(undone.statusCode, undone.body).toBe(200);
      expect(
        (await call(security, 'GET', '/api/org/presets/open')).json<OrganizationPresetPreview>().diff,
      ).toEqual(preview.diff);
    } finally {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET second_step_policy = 'off' WHERE id = $1`,
        [server.owner.info.org.id],
      );
    }
  });

  it('shows every changed value and saves values without retaining a preset link', async () => {
    const before = await call(security, 'GET', '/api/org/presets/balanced');
    expect(before.statusCode, before.body).toBe(200);
    const preview = before.json<OrganizationPresetPreview>();
    expect(preview.diff).toEqual([
      { key: 'passwordMinLength', before: 12, after: 14, allowed: true },
      { key: 'requireMfa', before: false, after: true, allowed: true },
      { key: 'sessionMaxDays', before: 30, after: 14, allowed: true },
      { key: 'publicLinks', before: true, after: false, allowed: true },
      { key: 'newPeopleAdministratorsOnly', before: false, after: true, allowed: true },
    ]);
    const applied = await command(security, {
      kind: 'organization.preset',
      preset: preview.preset,
      revision: preview.revision,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const saved = (
      await server.pool.query(
        `SELECT settings, second_step_policy FROM "${server.schemas.app}".orgs WHERE id = $1`,
        [server.owner.info.org.id],
      )
    ).rows[0];
    expect(saved.settings.unitPolicy.values).toEqual({
      passwordMinLength: 14,
      sessionMaxDays: 14,
      publicLinks: false,
      newPeopleSharing: true,
      newPeopleAdministratorsOnly: true,
      newPeopleRole: 'guest',
    });
    expect(saved.settings).not.toHaveProperty('preset');
    expect(saved.second_step_policy).toBe('everyone');
    expect(
      (
        await command(security, {
          kind: 'organization.preset',
          preset: preview.preset,
          revision: preview.revision,
        })
      ).statusCode,
    ).toBe(409);
    const undo = await command(security, {
      kind: 'organization.undo',
      eventId: applied.json<OrganizationCommandResult>().eventId,
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(
      (await call(security, 'GET', '/api/org/presets/balanced')).json<OrganizationPresetPreview>().diff,
    ).toEqual(preview.diff);
  });

  it('refuses a preset requiring single sign-on until a provider exists', async () => {
    const preview = (
      await call(security, 'GET', '/api/org/presets/regulated')
    ).json<OrganizationPresetPreview>();
    const response = await command(security, {
      kind: 'organization.preset',
      preset: 'regulated',
      revision: preview.revision,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.messageKey).toBe('orgUnits.policy.ssoProvider');
  });
});

describe('audit chain', () => {
  it('isolates system events in views and exports and detects their first broken hash', async () => {
    const schema = `"${server.schemas.audit}"`;
    const orgId = server.owner.info.org.id;
    const action = `background.${randomUUID()}`;
    await auditEvent(server.pool, schema, action, { orgId });
    await auditEvent(server.pool, schema, action, { orgId: randomUUID() });
    await auditEvent(server.pool, schema, action, null);
    const page = (await call(auditor, 'GET', `/api/org/audit?action=${action}`)).json<AuditPage>();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ actorId: null, actorName: null });
    const exported = await call(auditor, 'POST', '/api/org/audit/export', {
      filters: { action },
      format: 'json',
    });
    expect(exported.json()).toEqual(page.events);
    const foreign = await server.pool.query(
      `SELECT id::text FROM ${schema}.events WHERE action = $1 AND org_id IS DISTINCT FROM $2`,
      [action, orgId],
    );
    for (const row of foreign.rows)
      expect((await call(auditor, 'GET', `/api/org/audit/${row.id}`)).statusCode).toBe(404);
    const client = await server.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ${schema}.events DISABLE TRIGGER events_no_update`);
      await client.query(`UPDATE ${schema}.events SET metadata = '{"changed":true}' WHERE id = $1`, [
        page.events[0]!.id,
      ]);
      const integrity = await checkIntegrity({
        db: client,
        schemas: server.schemas,
        actor: {
          orgId,
          userId: auditor.userId,
          kind: 'member',
          adminRoles: ['audit'],
          sessionId: '',
          csrfToken: '',
        },
      });
      expect(integrity.firstBreak).toBe(page.events[0]!.id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('orders concurrent inserts, isolates organizations, and finds the first tampered row', async () => {
    const schema = `"${server.schemas.audit}"`;
    const identity = { orgId: server.owner.info.org.id, userId: server.owner.userId };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        auditEvent(server.pool, schema, 'chain.concurrent', identity, { index }),
      ),
    );
    const good = await call(auditor, 'GET', '/api/org/audit/integrity');
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json().firstBreak).toBeNull();
    const client = await server.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ${schema}.events DISABLE TRIGGER events_no_update`);
      const tampered = await client.query(
        `UPDATE ${schema}.events SET action = 'changed'
        WHERE id = (SELECT id FROM ${schema}.events WHERE org_id = $1 AND action = 'chain.concurrent' ORDER BY chain_seq LIMIT 1) RETURNING id::text`,
        [identity.orgId],
      );
      const result = await checkIntegrity({
        db: client,
        schemas: server.schemas,
        actor: { ...identity, kind: 'owner', adminRoles: [], sessionId: '', csrfToken: '' },
      });
      expect(result.firstBreak).toBe(tampered.rows[0].id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await expect(server.pool.query(`UPDATE ${schema}.events SET action = 'refused'`)).rejects.toThrow(
      'append-only',
    );
    await expect(server.pool.query(`DELETE FROM ${schema}.events`)).rejects.toThrow('append-only');
    await expect(server.pool.query(`TRUNCATE ${schema}.events`)).rejects.toThrow('append-only');
  });

  it('inserts 1,000 chained events in under two seconds', async () => {
    const orgId = randomUUID();
    const started = performance.now();
    await withTransaction(server.pool, async (db) => {
      for (let index = 0; index < 1_000; index++)
        await auditEvent(
          db,
          `"${server.schemas.audit}"`,
          'chain.timing',
          { orgId, userId: server.owner.userId },
          { index },
        );
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    const counted = await server.pool.query(
      `SELECT count(*)::int AS count, max(chain_seq)::int AS last FROM "${server.schemas.audit}".events WHERE org_id = $1`,
      [orgId],
    );
    expect(counted.rows[0]).toEqual({ count: 1_000, last: 1_000 });
  });

  it('adds the audit migration after newer migrations without losing credential notices', async () => {
    const database = await kit.createDatabase('adminupgrade');
    const schemas = { app: 'upgrade_app', data: 'upgrade_data', audit: 'upgrade_audit' };
    const pool = createPool({ ...database.profile, schemas });
    try {
      const ids = MIGRATIONS.map((migration) => migration.id);
      expect(ids).toEqual([...ids].sort());
      await migrate(
        pool,
        schemas,
        MIGRATIONS.filter((migration) => migration.id !== '0066_admin_roles_audit'),
      );
      await pool.query(`
        INSERT INTO upgrade_app.orgs (id, name) VALUES ('organization', 'Organization');
        INSERT INTO upgrade_app.users (id, email, name) VALUES ('person', 'person@example.test', 'Person');
        INSERT INTO upgrade_app.notifications (id, org_id, recipient_id, kind, subject_id, target)
          VALUES ('credential-notice', 'organization', 'person', 'credentialVaultUnavailable', 'vault', '{}');
      `);
      expect((await migrate(pool, schemas, MIGRATIONS)).applied).toEqual(['0066_admin_roles_audit']);
      await pool.query(`
        INSERT INTO upgrade_app.notifications (id, org_id, recipient_id, kind, subject_id, target)
          VALUES ('role-notice', 'organization', 'person', 'adminRolesChanged', 'roles', '{}');
      `);
      const notices = await pool.query('SELECT kind FROM upgrade_app.notifications ORDER BY id');
      expect(notices.rows).toEqual([{ kind: 'credentialVaultUnavailable' }, { kind: 'adminRolesChanged' }]);
    } finally {
      await pool.end();
      await database.drop();
    }
  }, 120_000);

  it('backfills existing history by organization and ID while restoring append-only protection', async () => {
    const database = await kit.createDatabase('adminmigration');
    const schemas = { app: 'migration_app', data: 'migration_data', audit: 'migration_audit' };
    const pool = createPool({ ...database.profile, schemas });
    try {
      await migrate(
        pool,
        schemas,
        MIGRATIONS.filter((migration) => migration.id < '0066'),
      );
      await pool.query(`INSERT INTO migration_audit.events (org_id, action, metadata) VALUES
        (NULL, 'first', '{"b":2,"a":1}'), ('one', 'first', '{}'), ('two', 'first', '{}'), ('one', 'second', '{}'), (NULL, 'second', '{}')`);
      await pool.query(`
        INSERT INTO migration_app.orgs (id, name) VALUES ('one', 'First'), ('two', 'Second');
        INSERT INTO migration_app.databases (id, org_id, name) VALUES ('database-one', 'one', 'First'), ('database-two', 'two', 'Second');
        INSERT INTO migration_audit.events (action, metadata) VALUES
          ('databases.snapshot.automatic', '{"databaseId":"database-one","snapshotId":"expired-snapshot"}'),
          ('databases.snapshot.expired', '{"databaseId":"database-two"}'),
          ('data.file.infected', '{"orgId":"one","fileId":"deleted-file"}'),
          ('databases.snapshot.automatic', '{"databaseId":"unknown"}'),
          ('data.file.infected', '{"orgId":"one","databaseId":"database-two"}');
        INSERT INTO migration_audit.events (org_id, action, metadata) VALUES
          ('one', 'data.report.created', '{"reportId":"deleted-report"}');
        INSERT INTO migration_audit.events (action, metadata) VALUES
          ('data.report.sent', '{"reportId":"deleted-report"}'),
          ('data.report.stopped', '{"databaseId":"database-one"}'),
          ('data.automation.stopped', '{"databaseId":"database-one"}'),
          ('data.webhook.disabled', '{"databaseId":"database-one"}');
      `);
      await migrate(pool, schemas, MIGRATIONS);
      const rows = (
        await pool.query(`SELECT org_id, chain_seq::int, prev_hash, hash,
        migration_audit.event_hash(e) AS expected FROM migration_audit.events e ORDER BY id`)
      ).rows;
      expect(rows.map((row) => row.chain_seq)).toEqual([1, 1, 1, 2, 2, 3, 2, 4, 3, 4, 5, 6, 7, 8, 9]);
      expect(rows.slice(5).map((row) => row.org_id)).toEqual([
        'one',
        'two',
        'one',
        null,
        null,
        'one',
        'one',
        'one',
        'one',
        'one',
      ]);
      expect(rows[3].prev_hash).toBe(rows[1].hash);
      expect(rows[4].prev_hash).toBe(rows[0].hash);
      expect(rows[5].prev_hash).toBe(rows[3].hash);
      expect(rows[6].prev_hash).toBe(rows[2].hash);
      expect(rows.every((row) => row.hash === row.expected && /^[0-9a-f]{64}$/.test(row.hash))).toBe(true);
      await expect(pool.query(`UPDATE migration_audit.events SET action = 'refused'`)).rejects.toThrow(
        'append-only',
      );
    } finally {
      await pool.end();
      await database.drop();
    }
  }, 120_000);
});

it('escapes quotes, lines, and spreadsheet formulas in CSV fields', () => {
  expect(csvCell('a"b\nc')).toBe('"a""b\nc"');
  for (const value of ['=1', '+1', '-1', '@A1', '  =1', '\tplain'])
    expect(csvCell(value)).toBe(`"'${value}"`);
});

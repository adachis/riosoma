import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from './index.js';

let kit: TestPostgres;

beforeAll(async () => {
  kit = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await kit?.stop();
});

/**
 * Embedding once allowed a wildcard host, and an empty list meant any site.  Both stop now, so an
 * upgrade turns those rules off and says so in the audit log rather than letting a link quietly
 * change who may frame it.
 */
it('turns off embed rules that no longer name exact origins, and records each one', async () => {
  const database = await kit.createDatabase('publicsharing');
  const schemas = { app: 'pubshare_app', data: 'pubshare_data', audit: 'pubshare_audit' };
  const pool = createPool({ ...database.profile, schemas });
  const app = `"${schemas.app}"`;
  const audit = `"${schemas.audit}"`;
  try {
    await migrate(
      pool,
      schemas,
      MIGRATIONS.filter((migration) => migration.id < '0073'),
    );
    await pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ('o1', 'One'), ('o2', 'Two')`);
    await pool.query(
      `INSERT INTO ${app}.databases (id, org_id, name) VALUES ('d1', 'o1', 'Garden'), ('d2', 'o2', 'Yard')`,
    );
    await pool.query(
      `INSERT INTO ${app}.tables (id, org_id, database_id, name, primary_field_id, position) VALUES
        ('t1', 'o1', 'd1', 'Projects', 'f1', 1), ('t2', 'o2', 'd2', 'Tasks', 'f2', 1)`,
    );
    await pool.query(
      `INSERT INTO ${app}.views (id, org_id, table_id, name, type, position) VALUES
        ('v1', 'o1', 't1', 'Open projects', 'grid', 1),
        ('v2', 'o1', 't1', 'Timeline', 'grid', 2),
        ('v3', 'o1', 't1', 'Gallery', 'grid', 3),
        ('v4', 'o1', 't1', 'Kanban', 'grid', 4),
        ('v5', 'o2', 't2', 'Board', 'grid', 1),
        ('v6', 'o1', 't1', 'Calendar', 'grid', 5)`,
    );
    const links = [
      // A wildcard host, which only an exact origin fits now.
      ['l1', 'o1', 'd1', 'v1', { enabled: true, sites: ['https://*.example.test'] }],
      // No sites, which used to mean any site.
      ['l2', 'o1', 'd1', 'v2', { enabled: true, sites: [] }],
      // An exact origin, which goes on working.
      ['l3', 'o1', 'd1', 'v3', { enabled: true, sites: ['https://blog.example.test:8443'] }],
      // Already off, so nothing changes for it.
      ['l4', 'o1', 'd1', 'v4', { enabled: false, sites: ['https://*.example.test'] }],
      // Another organization's wildcard rule, recorded under its own organization.
      ['l5', 'o2', 'd2', 'v5', { enabled: true, sites: ['https://a.test', 'https://*.b.test'] }],
      // A port the old rule let through and the parser refuses.
      ['l6', 'o1', 'd1', 'v6', { enabled: true, sites: ['https://ok.test:99999'] }],
    ] as const;
    for (const [id, orgId, databaseId, viewId, embed] of links) {
      await pool.query(
        `INSERT INTO ${app}.shared_views (id, org_id, database_id, view_id, settings)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, orgId, databaseId, viewId, JSON.stringify({ fieldIds: null, allowCopy: true, embed })],
      );
    }

    await migrate(pool, schemas, MIGRATIONS);

    const settings = await pool.query<{ id: string; settings: Record<string, unknown> }>(
      `SELECT id, settings FROM ${app}.shared_views ORDER BY id`,
    );
    const embedOf = (id: string) =>
      (settings.rows.find((row) => row.id === id)!.settings as { embed: unknown }).embed;
    expect(embedOf('l1')).toEqual({ enabled: false, sites: [] });
    expect(embedOf('l2')).toEqual({ enabled: false, sites: [] });
    expect(embedOf('l3')).toEqual({ enabled: true, sites: ['https://blog.example.test:8443'] });
    expect(embedOf('l4')).toEqual({ enabled: false, sites: ['https://*.example.test'] });
    expect(embedOf('l5')).toEqual({ enabled: false, sites: [] });
    expect(embedOf('l6')).toEqual({ enabled: false, sites: [] });
    // Nothing else about a link changes, so a rule turned off here can be turned back on.
    for (const row of settings.rows)
      expect((row.settings as { allowCopy: unknown }).allowCopy, row.id).toBe(true);

    const events = await pool.query<{
      org_id: string | null;
      actor_id: string | null;
      action: string;
      metadata: Record<string, unknown>;
      hash: string | null;
    }>(
      `SELECT org_id, actor_id, action, metadata, hash FROM ${audit}.events
       WHERE action = 'publicSharing.embedReset' ORDER BY org_id, metadata ->> 'linkId'`,
    );
    expect(events.rows.map((event) => [event.org_id, event.metadata.linkId])).toEqual([
      ['o1', 'l1'],
      ['o1', 'l2'],
      ['o1', 'l6'],
      ['o2', 'l5'],
    ]);
    for (const event of events.rows) {
      expect(event.actor_id).toBeNull();
      expect(event.hash, JSON.stringify(event.metadata)).toMatch(/^[0-9a-f]{64}$/);
      expect(event.metadata.viewId).toBeTruthy();
      expect(event.metadata.reason).toBe('exactOriginsOnly');
    }
    expect(events.rows[0]!.metadata.sites).toEqual(['https://*.example.test']);
    expect(events.rows[3]!.metadata.sites).toEqual(['https://a.test', 'https://*.b.test']);
  } finally {
    await pool.end();
    await database.drop();
  }
}, 120_000);

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPool } from '@riosoma/db';
import { startTestPostgres } from '@riosoma/testkit';
import { migration } from './0085_remote_tools.js';

const stubs = `CREATE SCHEMA app;
  CREATE TABLE app.orgs (id text PRIMARY KEY);
  CREATE TABLE app.users (id text PRIMARY KEY);
  CREATE TABLE app.memberships (
    org_id text REFERENCES app.orgs(id) ON DELETE CASCADE,
    user_id text REFERENCES app.users(id) ON DELETE CASCADE,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE TABLE app.rio_conversations (id text PRIMARY KEY, org_id text NOT NULL);
  CREATE TABLE app.memories (id uuid PRIMARY KEY, org_id text NOT NULL);
  CREATE TABLE app.knowledge_libraries (id uuid PRIMARY KEY, org_id text NOT NULL);`;

async function migrated(name: string, work: (pool: ReturnType<typeof createPool>) => Promise<void>) {
  const kit = await startTestPostgres();
  const database = await kit.createDatabase(name);
  const pool = createPool(database.profile);
  try {
    await pool.query(stubs);
    await work(pool);
  } finally {
    await pool.end();
    await database.drop();
    await kit.stop();
  }
}

it('uses only syntax that PostgreSQL 14 accepts', () => {
  // CI runs newer servers, so guard the forms that arrived after PostgreSQL 14.
  expect(migration.sql).not.toMatch(/SET\s+(NULL|DEFAULT)\s*\(/i);
  expect(migration.sql).not.toMatch(/NULLS\s+NOT\s+DISTINCT/i);
  expect(migration.sql).not.toMatch(/\bMERGE\s+INTO\b/i);
});

it('flags older memories and conversations only in organizations with knowledge libraries', async () => {
  await migrated('remote_migration', async (pool) => {
    await pool.query(`INSERT INTO app.orgs (id) VALUES ('libraries'), ('plain')`);
    await pool.query(`INSERT INTO app.knowledge_libraries (id, org_id) VALUES ($1, 'libraries')`, [
      randomUUID(),
    ]);
    for (const org of ['libraries', 'plain']) {
      await pool.query('INSERT INTO app.memories (id, org_id) VALUES ($1, $2)', [randomUUID(), org]);
      await pool.query('INSERT INTO app.rio_conversations (id, org_id) VALUES ($1, $2)', [randomUUID(), org]);
    }
    await pool.query(migration.sql.replaceAll('{{app}}', 'app'));
    for (const table of ['memories', 'rio_conversations'])
      expect(
        (await pool.query(`SELECT org_id, remote_data_blocked FROM app.${table} ORDER BY org_id`)).rows,
      ).toEqual([
        { org_id: 'libraries', remote_data_blocked: true },
        { org_id: 'plain', remote_data_blocked: false },
      ]);
    await pool.query(`INSERT INTO app.memories (id, org_id) VALUES ($1, 'libraries')`, [randomUUID()]);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM app.memories WHERE NOT remote_data_blocked'))
        .rows,
    ).toEqual([{ count: 2 }]);
  });
});

it('keeps a connection when the admin who saved it leaves or is deleted', async () => {
  await migrated('remote_migration_owner', async (pool) => {
    await pool.query(migration.sql.replaceAll('{{app}}', 'app'));
    await pool.query(`INSERT INTO app.orgs (id) VALUES ('org')`);
    await pool.query(`INSERT INTO app.users (id) VALUES ('admin')`);
    await pool.query(`INSERT INTO app.memberships (org_id, user_id) VALUES ('org', 'admin')`);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO app.remote_servers (id, org_id, user_id, config) VALUES ($1, 'org', 'admin', '{}')`,
      [id],
    );
    await pool.query(`DELETE FROM app.memberships WHERE user_id = 'admin'`);
    expect((await pool.query('SELECT org_id, user_id FROM app.remote_servers')).rows).toEqual([
      { org_id: 'org', user_id: 'admin' },
    ]);
    await pool.query(`DELETE FROM app.users WHERE id = 'admin'`);
    expect((await pool.query('SELECT id, org_id, user_id FROM app.remote_servers')).rows).toEqual([
      { id, org_id: 'org', user_id: null },
    ]);
  });
});

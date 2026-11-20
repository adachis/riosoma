import { expect, it } from 'vitest';
import { createPool } from '@riosoma/db';
import { startTestPostgres } from '@riosoma/testkit';
import { m0104 } from './0104_active_link_junctions.js';

it('binds current and historical one-way links to their own junctions', async () => {
  const kit = await startTestPostgres();
  const database = await kit.createDatabase('junction_migration');
  const pool = createPool(database.profile);
  try {
    await pool.query(`CREATE SCHEMA app;
      CREATE TABLE app.fields (id text PRIMARY KEY, type text NOT NULL, options jsonb NOT NULL);
      CREATE TABLE app.links (id text PRIMARY KEY, left_field_id text, right_field_id text,
        left_table_id text, right_table_id text, created_at timestamptz NOT NULL);
      CREATE TABLE app.changes (database_id text, seq bigint, prev jsonb, at timestamptz,
        PRIMARY KEY (database_id, seq));
      INSERT INTO app.fields VALUES ('source', 'link', '{"linkedTableId":"target","inverseFieldId":null}'),
        ('text', 'text', '{}');
      INSERT INTO app.links VALUES ('old', 'source', null, 'projects', 'target', '2026-01-01'),
        ('active', 'source', null, 'projects', 'target', '2026-02-01');
      INSERT INTO app.changes VALUES ('database', 1,
        '{"field":{"id":"source","type":"link","options":{"linkedTableId":"target","inverseFieldId":null}},"other":true}', '2026-01-15'),
        ('database', 2, '{"field":{"id":"source","type":"link","options":{"linkedTableId":"target","inverseFieldId":null}}}', '2026-02-15');`);
    await pool.query(m0104.sql.replaceAll('{{app}}', 'app'));
    expect((await pool.query('SELECT id, link_id FROM app.fields ORDER BY id')).rows).toEqual([
      { id: 'source', link_id: 'active' },
      { id: 'text', link_id: null },
    ]);
    const history = (
      await pool.query<{ prev: { field: { linkId: string }; other?: boolean } }>(
        'SELECT prev FROM app.changes ORDER BY seq',
      )
    ).rows;
    expect(history.map((row) => row.prev.field.linkId)).toEqual(['old', 'active']);
    expect(history[0]!.prev.other).toBe(true);
    // Archive imports insert fields before the junction metadata in the same transaction.
    await pool.query(`BEGIN;
      INSERT INTO app.fields (id, type, options, link_id)
        VALUES ('restored', 'link', '{"linkedTableId":"target"}', 'restored_link');
      INSERT INTO app.links VALUES ('restored_link', 'restored', null, 'projects', 'target', '2026-03-01');
      COMMIT;`);
    expect((await pool.query("SELECT link_id FROM app.fields WHERE id = 'restored'")).rows).toEqual([
      { link_id: 'restored_link' },
    ]);
    await pool.query("DELETE FROM app.links WHERE id = 'old'");
    expect((await pool.query("SELECT link_id FROM app.fields WHERE id = 'source'")).rows).toEqual([
      { link_id: 'active' },
    ]);
    await pool.query("DELETE FROM app.links WHERE id = 'active'");
    expect((await pool.query("SELECT link_id FROM app.fields WHERE id = 'source'")).rows).toEqual([
      { link_id: null },
    ]);
  } finally {
    await pool.end();
    await database.drop();
    await kit.stop();
  }
});

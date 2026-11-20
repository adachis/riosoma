import { expect, it } from 'vitest';
import { createPool } from '@riosoma/db';
import { startTestPostgres } from '@riosoma/testkit';
import { m0130 } from './0130_copied_invitations.js';

it('counts waiting invitations as copied and new ones as emailed', async () => {
  const kit = await startTestPostgres();
  const database = await kit.createDatabase('copied_invitations');
  const pool = createPool(database.profile);
  try {
    await pool.query(`CREATE SCHEMA app;
      CREATE TABLE app.invitations (id text PRIMARY KEY, accepted_at timestamptz);
      INSERT INTO app.invitations VALUES ('waiting', NULL), ('accepted', '2026-01-01');`);
    await pool.query(m0130.sql.replaceAll('{{app}}', 'app'));
    await pool.query("INSERT INTO app.invitations (id) VALUES ('later')");
    expect((await pool.query('SELECT id, copied FROM app.invitations ORDER BY id')).rows).toEqual([
      { id: 'accepted', copied: false },
      { id: 'later', copied: false },
      { id: 'waiting', copied: true },
    ]);
  } finally {
    await pool.end();
    await database.drop();
    await kit.stop();
  }
});

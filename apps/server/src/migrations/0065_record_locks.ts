import type { Migration } from '@riosoma/db';

export const m0065: Migration = {
  id: '0065_record_locks',
  sql: `
ALTER TABLE {{app}}.tables ADD COLUMN record_lock jsonb;
CREATE TABLE {{app}}.record_locks (
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  locked_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  locked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (table_id, record_id)
);
CREATE INDEX record_locks_database ON {{app}}.record_locks (database_id);
`,
};

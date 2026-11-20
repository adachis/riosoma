import type { Migration } from '@riosoma/db';

export const m0008: Migration = {
  id: '0008_comments',
  sql: `
CREATE TABLE {{app}}.comments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  author_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  mentions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  edited_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX comments_record ON {{app}}.comments (table_id, record_id, created_at, id)
  WHERE deleted_at IS NULL;

-- Record IDs are indexed separately because a single change can affect many records.
CREATE TABLE {{app}}.record_changes (
  database_id text NOT NULL,
  table_id text NOT NULL,
  record_id text NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (database_id, table_id, record_id, seq),
  FOREIGN KEY (database_id, seq) REFERENCES {{app}}.changes(database_id, seq) ON DELETE CASCADE
);
INSERT INTO {{app}}.record_changes (database_id, table_id, record_id, seq)
SELECT c.database_id, c.table_id, r.id, c.seq
FROM {{app}}.changes c
CROSS JOIN LATERAL (
  SELECT value->>'id' AS id FROM jsonb_array_elements(c.body->'records')
    WHERE c.kind IN ('table.created', 'record.created', 'record.updated', 'record.restored')
  UNION
  SELECT value #>> '{}' AS id FROM jsonb_array_elements(c.body->'recordIds')
    WHERE c.kind = 'record.trashed'
) r
WHERE c.table_id IS NOT NULL AND r.id IS NOT NULL
ON CONFLICT DO NOTHING;
`,
};

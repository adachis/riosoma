import type { Migration } from '@riosoma/db';

export const m0005: Migration = {
  id: '0005_trash',
  sql: `
CREATE TABLE {{app}}.user_database_state (
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  favorite boolean NOT NULL DEFAULT false,
  opened_at timestamptz,
  PRIMARY KEY (user_id, database_id)
);
-- History outlives the resource so expired actions can still report that they were skipped.
ALTER TABLE {{app}}.changes DROP CONSTRAINT changes_database_id_fkey;
ALTER TABLE {{app}}.undo_groups DROP CONSTRAINT undo_groups_database_id_fkey;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id FROM {{app}}.tables LOOP
    EXECUTE format('ALTER TABLE {{data}}.%I ADD COLUMN __trashed_by text', item.id);
    EXECUTE format('CREATE INDEX %I ON {{data}}.%I (__deleted_at DESC, __id DESC) WHERE __deleted_at IS NOT NULL', item.id || '_trash', item.id);
    EXECUTE format('UPDATE {{data}}.%I SET __trashed_by = __updated_by WHERE __deleted_at IS NOT NULL', item.id);
  END LOOP;
END $$;
`,
};

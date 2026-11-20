import type { Migration } from '@riosoma/db';

export const m0064: Migration = {
  id: '0064_home_folders',
  sql: `
ALTER TABLE {{app}}.folders
  ADD COLUMN IF NOT EXISTS parent_id text,
  ADD COLUMN IF NOT EXISTS organization_folder boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS path text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS trashed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trash_folder_id text,
  ADD FOREIGN KEY (org_id, parent_id) REFERENCES {{app}}.folders(org_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CHECK (cardinality(path) < 10 AND NOT (id = ANY(path)));
UPDATE {{app}}.folders f SET organization_folder = true, owner_id = (
  SELECT user_id FROM {{app}}.memberships m
  WHERE m.org_id = f.org_id AND m.kind = 'owner' ORDER BY user_id LIMIT 1
);
INSERT INTO {{app}}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
  SELECT org_id, 'folder', id, 'user', owner_id, 'owner' FROM {{app}}.folders
  WHERE owner_id IS NOT NULL
  ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = 'owner';
CREATE INDEX IF NOT EXISTS folders_parent ON {{app}}.folders (org_id, parent_id);
CREATE INDEX IF NOT EXISTS folders_ancestors ON {{app}}.folders USING gin (path);
ALTER TABLE {{app}}.databases ADD COLUMN IF NOT EXISTS trash_folder_id text;
-- Migration 0072 adds the SQL access triggers on folders and folder_databases.
`,
};

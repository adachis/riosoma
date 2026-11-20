import type { Migration } from '@riosoma/db';

export const m0078: Migration = {
  id: '0078_home_items',
  sql: `
CREATE TABLE {{app}}.home_shortcuts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  parent_id text,
  target_kind text NOT NULL CHECK (target_kind IN ('dashboard', 'interface', 'view', 'form')),
  target_id text NOT NULL,
  trashed_at timestamptz,
  trash_sources text[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (org_id, parent_id) REFERENCES {{app}}.folders(org_id, id) ON DELETE CASCADE
);
CREATE INDEX home_shortcuts_target ON {{app}}.home_shortcuts (org_id, target_id);
CREATE INDEX home_shortcuts_parent ON {{app}}.home_shortcuts (org_id, parent_id);
CREATE TABLE {{app}}.home_tags (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  visibility text NOT NULL CHECK (visibility IN ('shared', 'private')),
  trashed_at timestamptz,
  UNIQUE (org_id, id)
);
CREATE TABLE {{app}}.home_tag_links (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  tag_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('database', 'folder')),
  resource_id text NOT NULL,
  PRIMARY KEY (tag_id, resource_kind, resource_id),
  FOREIGN KEY (org_id, tag_id) REFERENCES {{app}}.home_tags(org_id, id) ON DELETE CASCADE
);
CREATE TABLE {{app}}.home_tag_colors (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$')
);
-- Polymorphic assignments must leave in the same transaction as their resource.
CREATE FUNCTION {{app}}.delete_home_tag_links() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM {{app}}.home_tag_links
  WHERE org_id = OLD.org_id AND resource_id = OLD.id
    AND resource_kind = CASE WHEN TG_TABLE_NAME = 'folders' THEN 'folder' ELSE 'database' END;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER home_tag_links_delete AFTER DELETE ON {{app}}.folders
  FOR EACH ROW EXECUTE FUNCTION {{app}}.delete_home_tag_links();
CREATE TRIGGER home_tag_links_delete AFTER DELETE ON {{app}}.databases
  FOR EACH ROW EXECUTE FUNCTION {{app}}.delete_home_tag_links();
ALTER TABLE {{app}}.rio_plans ALTER COLUMN database_id DROP NOT NULL;
-- Keep aliases in Trash even when their target is permanently removed.
CREATE FUNCTION {{app}}.trash_home_shortcuts() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  source text := CASE WHEN TG_OP = 'DELETE' THEN 'deleted:' ELSE '' END || TG_TABLE_NAME || ':' || OLD.id;
BEGIN
  IF TG_OP = 'DELETE' OR NEW.trashed_at IS NOT NULL THEN
    UPDATE {{app}}.home_shortcuts s SET trashed_at = COALESCE(s.trashed_at, statement_timestamp()), trash_sources = array_append(s.trash_sources, source)
    WHERE s.org_id = OLD.org_id AND NOT (source = ANY(s.trash_sources)) AND (
      (TG_TABLE_NAME = 'views' AND s.target_kind IN ('view', 'form') AND s.target_id = OLD.id)
      OR (TG_TABLE_NAME = 'dashboards' AND s.target_kind = 'dashboard' AND s.target_id = OLD.id)
      OR (TG_TABLE_NAME = 'interfaces' AND s.target_kind = 'interface' AND s.target_id = OLD.id)
      OR (TG_TABLE_NAME = 'folders' AND s.parent_id = OLD.id)
      OR (TG_TABLE_NAME = 'tables' AND s.target_kind IN ('view', 'form') AND s.target_id IN (SELECT id FROM {{app}}.views WHERE table_id = OLD.id))
      OR (TG_TABLE_NAME = 'databases' AND (
        (s.target_kind IN ('view', 'form') AND s.target_id IN (SELECT v.id FROM {{app}}.views v JOIN {{app}}.tables t ON t.id = v.table_id WHERE t.database_id = OLD.id))
        OR (s.target_kind = 'dashboard' AND s.target_id IN (SELECT id FROM {{app}}.dashboards WHERE database_id = OLD.id))
        OR (s.target_kind = 'interface' AND s.target_id IN (SELECT id FROM {{app}}.interfaces WHERE database_id = OLD.id))
      ))
    );
  ELSE
    UPDATE {{app}}.home_shortcuts SET
      trash_sources = array_remove(trash_sources, source),
      trashed_at = CASE WHEN cardinality(array_remove(trash_sources, source)) = 0 THEN NULL ELSE trashed_at END
    WHERE org_id = OLD.org_id AND source = ANY(trash_sources);
  END IF;
  RETURN NULL;
END
$fn$;
${['views', 'dashboards', 'interfaces', 'tables', 'databases', 'folders'].map((table) => `CREATE TRIGGER home_shortcut_trash AFTER UPDATE OF trashed_at OR DELETE ON {{app}}.${table} FOR EACH ROW EXECUTE FUNCTION {{app}}.trash_home_shortcuts();`).join('\n')}
`,
};

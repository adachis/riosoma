import type { Migration } from '@riosoma/db';

/**
 * Shared view links: a grid, gallery, kanban, or calendar view shared read-only by link.  A view
 * has at most one live link.  Stopping a link keeps its row, and sharing again makes a new one.
 * The settings say which fields go out, whether people may copy and download, and which sites may
 * embed the view.  A password is kept only as a hash.
 */
export const m0018: Migration = {
  id: '0018_shared_views',
  sql: `
CREATE TABLE {{app}}.shared_views (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  view_id text NOT NULL REFERENCES {{app}}.views(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  password_hash text,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  stopped_at timestamptz
);
CREATE UNIQUE INDEX shared_views_live ON {{app}}.shared_views (view_id) WHERE stopped_at IS NULL;
CREATE INDEX shared_views_database ON {{app}}.shared_views (database_id);
`,
};

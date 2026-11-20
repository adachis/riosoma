import type { Migration } from '@riosoma/db';

export const m0003: Migration = {
  id: '0003_links',
  sql: `
CREATE TABLE {{app}}.links (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  left_table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  left_field_id text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  right_table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  right_field_id text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX links_left_field ON {{app}}.links (left_field_id);
CREATE INDEX links_right_field ON {{app}}.links (right_field_id);
`,
};

import type { Migration } from '@riosoma/db';

/**
 * Public form links: a form view shared by link, so anyone can add a record without signing in.
 * A view has at most one live link.  Stopping a link keeps its row, with its count, and sharing
 * again makes a new one.  Submissions from one address to one form are counted for an hour, keyed
 * by a keyed hash of the address rather than the address itself.
 */
export const m0010: Migration = {
  id: '0010_public_forms',
  sql: `
CREATE TABLE {{app}}.public_forms (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  view_id text NOT NULL REFERENCES {{app}}.views(id) ON DELETE CASCADE,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  stopped_at timestamptz,
  submissions bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX public_forms_live ON {{app}}.public_forms (view_id) WHERE stopped_at IS NULL;
CREATE INDEX public_forms_database ON {{app}}.public_forms (database_id);

CREATE TABLE {{app}}.public_form_attempts (
  form_id text NOT NULL REFERENCES {{app}}.public_forms(id) ON DELETE CASCADE,
  address text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX public_form_attempts_address ON {{app}}.public_form_attempts (form_id, address, at);
`,
};

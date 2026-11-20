import type { Migration } from '@riosoma/db';

/**
 * Organization export and import.  Archive jobs and their stored bytes, the pause an imported
 * source waits in, invitations that keep an imported person's ID, the authors an imported row
 * waits to be credited to, and the review list the owner works through after an import.  Groups,
 * folders, and their grants come from 0044.  Starts at 0047, since the numbers before it were taken
 * by work built alongside this.
 */
export const m0047: Migration = {
  id: '0047_organization_archives',
  sql: `
CREATE TABLE {{app}}.organization_archives (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id),
  kind text NOT NULL CHECK (kind IN ('export', 'import')),
  state text NOT NULL CHECK (state IN ('running', 'preview', 'finished', 'failed')),
  progress bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  summary jsonb,
  -- What an uploaded archive would bring in, shown before it's confirmed.
  preview jsonb,
  -- Set once the owner's passphrase proved the archive unchanged since export.
  authenticated boolean NOT NULL DEFAULT false,
  error jsonb,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX organization_archives_expiry ON {{app}}.organization_archives(expires_at);
CREATE TABLE {{app}}.organization_archive_chunks (
  job_id text NOT NULL REFERENCES {{app}}.organization_archives(id) ON DELETE CASCADE,
  position bigint NOT NULL,
  bytes bytea NOT NULL,
  PRIMARY KEY (job_id, position)
);

-- An invitation the owner sends from the import review keeps the person's imported ID, so their
-- shares, record values, and authorship already point at them when they accept.
ALTER TABLE {{app}}.invitations ADD COLUMN reserved_user_id text;
ALTER TABLE {{app}}.invitations ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE {{app}}.sources ADD COLUMN import_paused boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.sources ADD COLUMN import_note text;
CREATE TABLE {{app}}.organization_import_authors (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  catalog text NOT NULL,
  row_id text NOT NULL,
  key_column text NOT NULL,
  author_column text NOT NULL,
  PRIMARY KEY (catalog, row_id, author_column)
);
-- Everyone an import found, and everything it brought in that reaches outside the organization,
-- until the owner invites the person or turns the thing on.
CREATE TABLE {{app}}.organization_import_review (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('person', 'source', 'webhook', 'automation', 'publicLink',
    'publicForm', 'calendarFeeds', 'oauthApp', 'feedback')),
  target_id text NOT NULL,
  database_id text,
  name text NOT NULL,
  destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX organization_import_review_org ON {{app}}.organization_import_review (org_id, kind, created_at);
`,
};

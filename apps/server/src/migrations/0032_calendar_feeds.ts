import type { Migration } from '@riosoma/db';

/**
 * Calendar feeds: a person's private address for a calendar, timeline, or Gantt view, which
 * calendar apps poll.  The address's token is kept only as a SHA-256 hash.  A person has at most
 * one live feed per view.  Turning one off, or making a new address, stops the row and keeps it,
 * so the old address answers "gone" rather than "not found".  For the same reason a view deleted
 * for good leaves its feeds behind with no view, rather than taking them with it.
 *
 * Organizations choose whether people may subscribe at all, which starts on.
 */
export const m0032: Migration = {
  id: '0032_calendar_feeds',
  sql: `
CREATE TABLE {{app}}.calendar_feeds (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  view_id text REFERENCES {{app}}.views(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  -- The zone dates that follow each viewer are read in: the person's, when they made the feed.
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_read_at timestamptz,
  stopped_at timestamptz
);
CREATE UNIQUE INDEX calendar_feeds_token ON {{app}}.calendar_feeds (token_hash);
CREATE UNIQUE INDEX calendar_feeds_live ON {{app}}.calendar_feeds (view_id, user_id) WHERE stopped_at IS NULL;
CREATE INDEX calendar_feeds_org ON {{app}}.calendar_feeds (org_id) WHERE stopped_at IS NULL;

ALTER TABLE {{app}}.orgs ADD COLUMN calendar_feeds boolean NOT NULL DEFAULT true;
`,
};

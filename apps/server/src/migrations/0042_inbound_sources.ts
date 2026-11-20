import type { Migration } from '@riosoma/db';

/**
 * Webhook and feed sources.  A webhook source's address carries a token that's kept only as a
 * SHA-256 hash.  Posts it accepts wait in `source_hook_posts`, exactly as they arrived, until
 * they're written to the tables that sync from it, in the order they came.  A post that meets a
 * passing problem, like a lock that timed out, waits and tries again, and after 10 tries over at
 * least an hour it's marked failed and kept.  Its log keeps the last 100 posts, and any still held,
 * with their bodies only during the hour someone turned that on.  The mapping step's samples are
 * the last 10 posts received while it's open, and go when it closes.  A feed's synced table keeps
 * its last answer's `ETag` and `Last-Modified` in `fetch_state`, so each sync asks only for what
 * changed.  Notifications gain `webhookFailed`, for a webhook's person when a post fails.
 *
 * Starts at 0042, since 0037 through 0041 were taken by work built alongside this.
 */
export const m0042: Migration = {
  id: '0042_inbound_sources',
  sql: `
CREATE TABLE {{app}}.source_hooks (
  source_id text PRIMARY KEY REFERENCES {{app}}.sources(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  token_created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Posts this minute: the window starts with its first post.
  rate_window timestamptz,
  rate_count integer NOT NULL DEFAULT 0,
  last_post_at timestamptz,
  -- Bodies go into the log until this moment, and are forgotten once it passes.
  bodies_until timestamptz,
  -- The mapping step keeps samples until this moment, and asks again to keep them longer.
  samples_until timestamptz
);
CREATE UNIQUE INDEX source_hooks_token ON {{app}}.source_hooks (token_hash);

CREATE TABLE {{app}}.source_hook_deliveries (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES {{app}}.sources(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL,
  status integer NOT NULL,
  -- The plain code a refused post was answered with.
  refusal text,
  bytes integer NOT NULL,
  records integer,
  -- A message key, once written, when a table couldn't take the post.
  error text,
  written boolean NOT NULL DEFAULT false,
  body text
);
CREATE INDEX source_hook_deliveries_log ON {{app}}.source_hook_deliveries (source_id, seq DESC);
CREATE INDEX source_hook_deliveries_bodies ON {{app}}.source_hook_deliveries (source_id) WHERE body IS NOT NULL;

-- Accepted posts waiting to be written.  The body is the text that arrived, not jsonb, so whole
-- numbers too long for a JavaScript number stay exact until the writer reads them.
CREATE TABLE {{app}}.source_hook_posts (
  delivery_id text PRIMARY KEY REFERENCES {{app}}.source_hook_deliveries(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES {{app}}.sources(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  body text NOT NULL,
  -- Where the post kept its records, and whether lists split, as when it was accepted.
  records_path text NOT NULL,
  split boolean NOT NULL,
  received_at timestamptz NOT NULL,
  -- Tries that met a passing problem, when the first did, and when to try next.
  attempts integer NOT NULL DEFAULT 0,
  first_failed_at timestamptz,
  next_attempt_at timestamptz,
  -- Set once it stops trying.  A failed post stays, and no later post waits for it.
  failed_at timestamptz
);
CREATE INDEX source_hook_posts_order ON {{app}}.source_hook_posts (source_id, seq) WHERE failed_at IS NULL;

-- The mapping step's samples, as the text that arrived, for the same reason.
CREATE TABLE {{app}}.source_hook_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL REFERENCES {{app}}.sources(id) ON DELETE CASCADE,
  body text NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE INDEX source_hook_samples_source ON {{app}}.source_hook_samples (source_id, id DESC);

ALTER TABLE {{app}}.table_sources ADD COLUMN fetch_state jsonb;

ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed'));
`,
};

import type { Migration } from '@riosoma/db';

/**
 * Feedback: what people tell their organization's admins, the admins' replies, and the choice
 * to send bug reports to a GitHub repository.  Feedback belongs to its sender and goes when their
 * account does, screenshot and replies with it.  A screenshot is kept beside its message and is
 * never larger than 2 MB.
 *
 * The organization's GitHub choice starts off.  Its token is sealed with the instance key, and
 * the repository and whether it's on sit beside it.  Notifications gain a kind for a reply.
 *
 * Numbered 0027: 0026 was left for work landing alongside this.
 */
export const m0027: Migration = {
  id: '0027_feedback',
  sql: `
CREATE TABLE {{app}}.feedback (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('broken', 'idea', 'question')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'done')),
  message text NOT NULL,
  -- Where the sender was and what their browser said, as the contract checks it.  Never a value.
  context jsonb NOT NULL,
  screenshot bytea CHECK (octet_length(screenshot) <= 2097152),
  screenshot_type text CHECK (screenshot_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CHECK ((screenshot IS NULL) = (screenshot_type IS NULL)),
  -- The GitHub issue an admin sent it to, or added it to as a comment
  issue_number integer,
  issue_url text,
  -- Whole milliseconds, so a page cursor carries the exact value through JavaScript.
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX feedback_inbox ON {{app}}.feedback (org_id, created_at DESC, id DESC);
CREATE INDEX feedback_new ON {{app}}.feedback (org_id) WHERE status = 'new';
CREATE INDEX feedback_sender ON {{app}}.feedback (user_id, created_at DESC);

CREATE TABLE {{app}}.feedback_replies (
  id text PRIMARY KEY,
  feedback_id text NOT NULL REFERENCES {{app}}.feedback(id) ON DELETE CASCADE,
  author_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp())
);
CREATE INDEX feedback_replies_feedback ON {{app}}.feedback_replies (feedback_id, created_at);

ALTER TABLE {{app}}.orgs ADD COLUMN feedback_github_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.orgs ADD COLUMN feedback_github_repository text;
ALTER TABLE {{app}}.orgs ADD COLUMN feedback_github_token text;

ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld', 'reportStopped',
  'feedbackReply'
));
`,
};

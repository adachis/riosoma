import type { Migration } from '@riosoma/db';

/**
 * Notifications and each person's choice of which to get by email.  A notification is written in
 * the same transaction as the change that caused it, so the two commit or roll back together, and
 * its email waits in `email` until the delivery worker takes it after commit.
 */
export const m0015: Migration = {
  id: '0015_notifications',
  sql: `
CREATE TABLE {{app}}.notifications (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld')),
  actor_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  -- What it's about: the comment, database, automation, or table.  Throttles and cleanups find it here.
  subject_id text NOT NULL,
  -- IDs and names as they were, so the bell can word and link it without another request.
  target jsonb NOT NULL,
  -- Whole milliseconds, so a page cursor carries the exact value through JavaScript.
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  read_at timestamptz,
  -- 'none' when the person's choices leave it out, 'pending' until the delivery worker takes it,
  -- then 'sending' and 'sent' or 'failed', or 'skipped' when the server can't send email.
  email text NOT NULL DEFAULT 'none'
    CHECK (email IN ('none', 'pending', 'sending', 'sent', 'failed', 'skipped'))
);
CREATE INDEX notifications_recipient ON {{app}}.notifications (org_id, recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread ON {{app}}.notifications (org_id, recipient_id) WHERE read_at IS NULL;
CREATE INDEX notifications_subject ON {{app}}.notifications (subject_id, recipient_id);
CREATE INDEX notifications_email ON {{app}}.notifications (created_at) WHERE email = 'pending';
CREATE INDEX notifications_age ON {{app}}.notifications (created_at);

-- Kinds a person has turned email on or off for.  Kinds left out follow the defaults.
CREATE TABLE {{app}}.notification_preferences (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  email jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
`,
};

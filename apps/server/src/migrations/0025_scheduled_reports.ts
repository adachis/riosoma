import type { Migration } from '@riosoma/db';

/**
 * Scheduled reports: a view's records, emailed on a schedule.  A schedule belongs to its view and
 * its owner, and goes when either does.  Its recipients are rows of their own, so finding every
 * schedule a person receives is one index away.  Runs keep when they went, to whom, how many
 * records each person got, and what went wrong, and never a record's values.
 *
 * Organizations choose whether reports may go to addresses outside them, which starts off, and
 * notifications gain a kind for a schedule that turned itself off.
 */
export const m0025: Migration = {
  id: '0025_scheduled_reports',
  sql: `
CREATE TABLE {{app}}.report_schedules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  view_id text NOT NULL REFERENCES {{app}}.views(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'none')),
  -- { kind: 'daily' | 'weekly' | 'monthly', at, days?, day? }, checked by the contract
  frequency jsonb NOT NULL,
  time_zone text NOT NULL,
  -- The language numbers and dates are written in for outside addresses: the owner's, when set up.
  locale text NOT NULL DEFAULT 'en-US',
  enabled boolean NOT NULL DEFAULT true,
  -- A server message key saying why it turned itself off
  stopped_because text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_view ON {{app}}.report_schedules (view_id);
CREATE INDEX report_schedules_owner ON {{app}}.report_schedules (org_id, owner_id);
CREATE INDEX report_schedules_due ON {{app}}.report_schedules (next_run_at) WHERE enabled;

-- Exactly one of a member or an address, each at most once per schedule.
CREATE TABLE {{app}}.report_recipients (
  report_id text NOT NULL REFERENCES {{app}}.report_schedules(id) ON DELETE CASCADE,
  position integer NOT NULL,
  user_id text REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  address text,
  CHECK ((user_id IS NULL) <> (address IS NULL)),
  UNIQUE (report_id, user_id),
  UNIQUE (report_id, address)
);
CREATE INDEX report_recipients_user ON {{app}}.report_recipients (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE {{app}}.report_runs (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  report_id text NOT NULL REFERENCES {{app}}.report_schedules(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'retrying', 'sent', 'partial', 'failed', 'skipped')),
  -- Who pressed "Send now", for a manual run
  actor_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  lease_at timestamptz,
  lease_token text,
  -- One entry per recipient: who, where it stands, how many records, and any error's message key
  deliveries jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why a run that sent nothing didn't, as a message key
  error text
);
CREATE INDEX report_runs_report ON {{app}}.report_runs (report_id, seq DESC);
CREATE INDEX report_runs_waiting ON {{app}}.report_runs (seq) WHERE state IN ('queued', 'retrying', 'running');
CREATE INDEX report_runs_age ON {{app}}.report_runs (due_at);

ALTER TABLE {{app}}.orgs ADD COLUMN report_outside_recipients boolean NOT NULL DEFAULT false;

ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld', 'reportStopped'
));
`,
};

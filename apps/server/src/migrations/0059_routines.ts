import type { Migration } from '@riosoma/db';

/**
 * Routines: recurring jobs a person describes in plain words, which Rio carries out on a schedule
 * as that person, in one database.
 *
 * `rio_routines` holds each routine: its owner's words, the plan Rio restated them as and the
 * owner saved, its schedule and time zone, the most one run may cost, and the exact recipient
 * lists the owner lets it email without asking.  A routine its owner paused, or that paused itself,
 * keeps why (`paused_reason`, a message key) and who paused it.  An admin's pause is kept apart
 * (`admin_paused_at`), since only an admin lifts it.  `failures` counts failed runs in a row, and
 * three pause it.
 *
 * `rio_routine_runs` is the queue and the run history.  A due routine queues a run and moves its
 * next run on in the same transaction, and workers claim runs with `SKIP LOCKED` and a lease.  A
 * run keeps its report, its tokens and cost, its estimated energy and carbon (`footprint`, holding
 * `{ "estimate": null }` for a model the estimate method has no data for), how far it got, and the
 * undo group of the changes it made on its own, so the owner can undo them in one step, and
 * `activity`, every email it sent and page it fetched.
 *
 * `rio_routine_approvals` holds what a run prepared and left for the owner: a plan of changes too
 * big to make alone, or an email to someone other than the owner.  The owner approves, changes,
 * or skips each one.  A plan keeps the exact changes the server worked out from its commands.
 *
 * `rio_routine_groups` names every undo group a routine's changes went into, from its runs and from
 * the plans its owner approved.  It outlives the routine and its runs, so a cell a routine wrote
 * is known as one for as long as the database keeps its history, and a routine never fetches a page
 * at an address any routine wrote.
 */
export const m0059: Migration = {
  id: '0059_routines',
  sql: `
CREATE TABLE {{app}}.rio_routines (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  instructions text NOT NULL,
  plan jsonb NOT NULL,
  schedule jsonb NOT NULL,
  time_zone text NOT NULL,
  locale text NOT NULL,
  cost_cap_usd numeric NOT NULL CHECK (cost_cap_usd > 0),
  approved_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  paused_at timestamptz,
  paused_reason text,
  paused_by text,
  admin_paused_at timestamptz,
  admin_paused_by text,
  failures integer NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rio_routines_due ON {{app}}.rio_routines (next_run_at)
  WHERE paused_at IS NULL AND admin_paused_at IS NULL;
CREATE INDEX rio_routines_owner ON {{app}}.rio_routines (org_id, owner_id);
CREATE INDEX rio_routines_database ON {{app}}.rio_routines (database_id);

CREATE TABLE {{app}}.rio_routine_runs (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  routine_id text NOT NULL REFERENCES {{app}}.rio_routines(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'revision')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'done', 'stopped', 'failed', 'skipped')),
  revision jsonb,
  message_key text,
  report text,
  group_id text,
  receipt_summary text,
  steps integer NOT NULL DEFAULT 0,
  provider_id text,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric,
  ms integer,
  footprint jsonb,
  activity jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_at timestamptz,
  lease_token text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX rio_routine_runs_routine ON {{app}}.rio_routine_runs (routine_id, seq DESC);
CREATE INDEX rio_routine_runs_open ON {{app}}.rio_routine_runs (seq) WHERE state IN ('queued', 'running');
CREATE INDEX rio_routine_runs_finished ON {{app}}.rio_routine_runs (finished_at)
  WHERE state IN ('done', 'stopped', 'failed', 'skipped');

CREATE TABLE {{app}}.rio_routine_approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES {{app}}.rio_routine_runs(id) ON DELETE CASCADE,
  routine_id text NOT NULL REFERENCES {{app}}.rio_routines(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  database_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('plan', 'email')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'skipped', 'changed', 'failed', 'expired')),
  summary text NOT NULL,
  detail jsonb NOT NULL,
  group_id text,
  message_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days')
);
CREATE INDEX rio_routine_approvals_run ON {{app}}.rio_routine_approvals (run_id);

CREATE TABLE {{app}}.rio_routine_groups (
  group_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  routine_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rio_routine_groups_database ON {{app}}.rio_routine_groups (database_id);
CREATE INDEX rio_routine_approvals_waiting ON {{app}}.rio_routine_approvals (routine_id)
  WHERE status = 'pending';

-- A routine's owner hears about its reports, what waits for their approval, and why it paused.
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
    'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused'));
`,
};

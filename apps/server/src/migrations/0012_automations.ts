import type { Migration } from '@riosoma/db';

/**
 * Automations and their runs.  An automation belongs to a database and changes through commands
 * like views do.  Each run is one trip through its steps, queued by a trigger and claimed by a
 * worker with a lease, so a run left behind by a stopped server is picked up again.
 */
export const m0012: Migration = {
  id: '0012_automations',
  sql: `
CREATE TABLE {{app}}.automations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  position double precision NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL,
  -- Whoever turned it on last.  Its steps run as this person, with this person's permissions.
  run_as_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  -- The message key saying why it turned itself off, cleared when someone turns it back on.
  stopped_because text,
  -- The webhook address's secret is never stored.  It's derived from the instance key and this
  -- random salt, so people who can change the automation can see the address, and only its
  -- SHA-256 is kept to check calls against.
  webhook_secret_hash text NOT NULL,
  webhook_salt text NOT NULL,
  -- For schedules, when the next run is due.
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX automations_database ON {{app}}.automations (database_id);
CREATE INDEX automations_due ON {{app}}.automations (next_run_at)
  WHERE enabled AND trashed_at IS NULL AND next_run_at IS NOT NULL;

CREATE TABLE {{app}}.automation_runs (
  id text PRIMARY KEY,
  -- Order of queuing: runs of one automation start in this order, and history lists by it.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  automation_id text NOT NULL REFERENCES {{app}}.automations(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  trigger_kind text NOT NULL,
  record_id text,
  -- A webhook call's JSON body, kept with the run for its tokens.
  body jsonb,
  test boolean NOT NULL DEFAULT false,
  -- Test runs act as the person testing, and other runs act as the automation's person.
  actor_id text,
  -- How many automations deep this run is, counting from the change a person made.
  depth integer NOT NULL DEFAULT 1,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_at timestamptz,
  lease_token text
);
CREATE INDEX automation_runs_queued ON {{app}}.automation_runs (automation_id, seq) WHERE state = 'queued';
CREATE INDEX automation_runs_leased ON {{app}}.automation_runs (lease_at) WHERE state = 'running';
CREATE INDEX automation_runs_history ON {{app}}.automation_runs (automation_id, seq DESC);
CREATE INDEX automation_runs_started ON {{app}}.automation_runs (automation_id, started_at)
  WHERE started_at IS NOT NULL AND NOT test;
CREATE INDEX automation_runs_age ON {{app}}.automation_runs (queued_at);
`,
};

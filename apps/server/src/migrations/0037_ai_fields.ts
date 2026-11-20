import type { Migration } from '@riosoma/db';

/**
 * AI fields: fields whose values a model writes from a prompt.  A field's `ai` holds its prompt,
 * tier, trigger, and the person its runs act as.
 *
 * `ai_field_runs` is the queue, one row for each cell a model is asked to fill, and afterward the
 * run's usage record: the model, its tokens and cost, and how it ended.  At most one run per cell
 * waits at a time, so a burst of edits to a record asks the model once.  Workers claim runs one
 * claim at a time under an advisory lock, taking the oldest few of each organization, and hold
 * each with a lease.  A failed run shows as the cell's error, with `message_params` filling in its
 * message, until a later run ends or someone edits the cell (`superseded`).  `depth` counts the
 * automation and AI field runs that led to a run, so the automation depth limit stops a chain of
 * them.  Finished runs are kept for 30 days.
 *
 * `ai_field_jobs` groups the runs a person started from a field's menu, for all its records or only
 * the empty ones, so the field's header can show how far along they are and stop them.
 */
export const m0037: Migration = {
  id: '0037_ai_fields',
  sql: `
ALTER TABLE {{app}}.fields ADD COLUMN ai jsonb;

CREATE TABLE {{app}}.ai_field_jobs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL,
  table_id text NOT NULL,
  field_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('all', 'empty', 'records')),
  requested_by text,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'canceled', 'failed')),
  total integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX ai_field_jobs_table ON {{app}}.ai_field_jobs (table_id, created_at DESC);
CREATE INDEX ai_field_jobs_finished ON {{app}}.ai_field_jobs (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE {{app}}.ai_field_runs (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL,
  table_id text NOT NULL,
  field_id text NOT NULL,
  record_id text NOT NULL,
  job_id text REFERENCES {{app}}.ai_field_jobs(id) ON DELETE SET NULL,
  requested_by text,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'retrying', 'done', 'failed', 'canceled')),
  attempts integer NOT NULL DEFAULT 0,
  depth integer NOT NULL DEFAULT 1,
  retry_at timestamptz,
  lease_at timestamptz,
  lease_token text,
  superseded boolean NOT NULL DEFAULT false,
  message_key text,
  message_params jsonb,
  provider_id text,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric,
  ms integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX ai_field_runs_waiting ON {{app}}.ai_field_runs (field_id, record_id)
  WHERE state IN ('queued', 'retrying');
CREATE INDEX ai_field_runs_open ON {{app}}.ai_field_runs (org_id)
  WHERE state IN ('queued', 'retrying', 'running');
CREATE INDEX ai_field_runs_queued ON {{app}}.ai_field_runs (org_id, seq) WHERE state = 'queued';
CREATE INDEX ai_field_runs_retrying ON {{app}}.ai_field_runs (org_id, retry_at) WHERE state = 'retrying';
CREATE INDEX ai_field_runs_running ON {{app}}.ai_field_runs (org_id, lease_at) WHERE state = 'running';
CREATE INDEX ai_field_runs_live ON {{app}}.ai_field_runs (field_id, record_id, seq DESC)
  WHERE state IN ('queued', 'running', 'retrying') OR (state = 'failed' AND NOT superseded);
CREATE INDEX ai_field_runs_finished ON {{app}}.ai_field_runs (finished_at)
  WHERE state IN ('done', 'failed', 'canceled');
CREATE INDEX ai_field_runs_job ON {{app}}.ai_field_runs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX ai_field_runs_org ON {{app}}.ai_field_runs (org_id, created_at DESC);
`,
};

import type { Migration } from '@riosoma/db';

/** Waiting releases the worker lease while keeping the execution path and its deadline. */
export const m0069: Migration = {
  id: '0069_automation_waits',
  sql: `
ALTER TABLE {{app}}.automation_runs DROP CONSTRAINT automation_runs_state_check;
ALTER TABLE {{app}}.automation_runs
  ADD CONSTRAINT automation_runs_state_check CHECK (state IN ('queued', 'running', 'waiting', 'canceled', 'succeeded', 'failed', 'skipped')),
  ADD COLUMN config_snapshot jsonb,
  ADD COLUMN wake_at timestamptz,
  ADD COLUMN wait_table_id text;
CREATE INDEX automation_runs_waiting ON {{app}}.automation_runs (wake_at) WHERE state = 'waiting';
CREATE INDEX automation_runs_watching ON {{app}}.automation_runs (database_id, wait_table_id, record_id) WHERE state = 'waiting';
`,
};

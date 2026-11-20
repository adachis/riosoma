import type { Migration } from '@riosoma/db';

/**
 * Drafts and versions for automations, and runs that start again from another run.
 *
 * An automation's own row holds its published version, the one that runs, with that version's
 * number.  Changes to its configuration go to the draft beside it until someone publishes them.
 * Publishing moves the version it replaces into `automation_versions`, which keeps the last 20, so
 * any of them can come back as a draft.  Messaging credentials stay in the automation's one sealed
 * map, and each configuration names the ones it uses, so a draft, a kept version, and an undo all
 * send where they did.  Existing automations become version 1, published, with no draft.
 *
 * A run records the version it ran, or that it was a test of the draft.  A rerun or a resumed run
 * names the run it came from, and a resumed run the step it went on from.  Runs from before this
 * have no version, since what they ran can't be told apart from what's published now.
 */
export const m0048: Migration = {
  id: '0048_automation_versions',
  sql: `
ALTER TABLE {{app}}.automations
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  ADD COLUMN draft_config jsonb,
  ADD COLUMN draft_updated_at timestamptz,
  ADD COLUMN draft_updated_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL;
UPDATE {{app}}.automations SET published_at = updated_at;

CREATE TABLE {{app}}.automation_versions (
  automation_id text NOT NULL REFERENCES {{app}}.automations(id) ON DELETE CASCADE,
  version integer NOT NULL,
  config jsonb NOT NULL,
  published_at timestamptz,
  published_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  PRIMARY KEY (automation_id, version)
);

ALTER TABLE {{app}}.automation_runs
  ADD COLUMN version integer,
  ADD COLUMN draft boolean NOT NULL DEFAULT false,
  ADD COLUMN source_run_id text,
  ADD COLUMN source_kind text CHECK (source_kind IN ('rerun', 'resume')),
  ADD COLUMN resume_step_id text;
`,
};

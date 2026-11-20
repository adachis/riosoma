import type { Migration } from '@riosoma/db';

export const m0132: Migration = {
  id: '0132_outbound_syncs',
  sql: `
CREATE TABLE {{app}}.outbound_syncs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  view_id text NOT NULL REFERENCES {{app}}.views(id) ON DELETE CASCADE,
  -- Every run reads the view as this person.  The sync goes when they do.
  created_by text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- A destination kind, checked by the contract, so a new kind needs no migration
  kind text NOT NULL,
  -- OutboundDestination: where rows go, and never a credential
  destination jsonb NOT NULL,
  -- OutboundSyncSettings: { everyMinutes, removeMissing, createColumns, timeZone, locale }
  settings jsonb NOT NULL,
  -- JSON { token }, sealed with the context 'outbound-sync:' || id
  sealed_credential text NOT NULL,
  -- SyncOutColumn[]: each field's outside column
  mapping jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The outside column that holds record IDs, by the service's own ID, once known
  key_column_id text,
  enabled boolean NOT NULL DEFAULT true,
  -- A server message key saying why it turned itself off
  stopped_because text,
  -- SyncOutStatus
  status jsonb NOT NULL,
  next_run_at timestamptz,
  -- Why the next run starts: 'setup', 'manual', or 'retry'.  Null means the schedule.
  queued_trigger text,
  -- Who chose "Sync now"
  queued_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  lease_at timestamptz,
  lease_token text,
  -- "Sync now" was chosen while a run was under way
  queued_again boolean NOT NULL DEFAULT false,
  -- The last run may have left outside rows the map doesn't know, so the next one reads the key column first
  needs_reconcile boolean NOT NULL DEFAULT true,
  -- Consecutive runs that were not 'succeeded', for the backoff and the stop count
  failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_syncs_view ON {{app}}.outbound_syncs (view_id);
CREATE INDEX outbound_syncs_creator ON {{app}}.outbound_syncs (org_id, created_by);
CREATE INDEX outbound_syncs_due ON {{app}}.outbound_syncs (next_run_at)
  WHERE enabled AND next_run_at IS NOT NULL;
CREATE INDEX outbound_syncs_leased ON {{app}}.outbound_syncs (lease_at) WHERE lease_at IS NOT NULL;

-- One row for each record the outside table holds a row for.
CREATE TABLE {{app}}.outbound_sync_rows (
  sync_id text NOT NULL REFERENCES {{app}}.outbound_syncs(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  -- The outside row, by the service's own ID.  Null when it has to be made again.
  external_id text,
  -- A hash of the cells last sent.  Null makes the next run send the row.
  sent_hash text,
  -- The last run that found the record in the view
  seen_run text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_id, record_id)
);

-- When each run went, why, what it did by count, and what went wrong.  Never a record's values.
CREATE TABLE {{app}}.outbound_sync_runs (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  sync_id text NOT NULL REFERENCES {{app}}.outbound_syncs(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('setup', 'manual', 'schedule', 'retry')),
  actor_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text NOT NULL
    CHECK (outcome IN ('running', 'succeeded', 'partial', 'failed', 'stopped', 'canceled')),
  -- SyncOutStats
  stats jsonb,
  error_key text,
  error_params jsonb,
  -- SyncOutMessage[]
  notes jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX outbound_sync_runs_sync ON {{app}}.outbound_sync_runs (sync_id, seq DESC);
`,
};

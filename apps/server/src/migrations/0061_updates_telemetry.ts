import type { Migration } from '@riosoma/db';

/**
 * Update checks, update runs, and anonymous usage counts.  They belong to the server rather than
 * to any organization, so none of these tables names one.
 *
 * `update_checks` is one row: when the feed was last looked at and what that found, and the last
 * feed that verified, kept as it was signed so the updater sidecar can check the signature itself.
 * `attempted_at` lets one replica claim the day's check.
 *
 * `update_runs` keeps each one-click update: the versions, who started it, where the updater has
 * got to, and how it ended.  The updater uses the run's ID as its own job's, and checks that the
 * backup service's database holds the row before it backs anything up.  The audit log records the
 * same moments.
 *
 * `telemetry` is one row, made here and off.  The install ID exists only while counts are on: it's
 * made when the owner turns them on and deleted, with the record of the last send, when they turn
 * them off.  While on, the row keeps the week last sent and the last payload exactly as it went.
 */
export const m0061: Migration = {
  id: '0061_updates_telemetry',
  sql: `
CREATE TABLE {{app}}.update_checks (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  attempted_at timestamptz,
  checked_at timestamptz,
  status text NOT NULL DEFAULT 'unchecked',
  feed text,
  issued_at timestamptz,
  key_id text
);
INSERT INTO {{app}}.update_checks (id) VALUES (1);

CREATE TABLE {{app}}.update_runs (
  id text PRIMARY KEY,
  from_version text NOT NULL,
  to_version text NOT NULL,
  started_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  org_id text REFERENCES {{app}}.orgs(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'requested',
  backup text,
  problem text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  contacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX update_runs_started ON {{app}}.update_runs (started_at DESC);

CREATE TABLE {{app}}.telemetry (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  install_id text,
  changed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  changed_at timestamptz,
  attempted_at timestamptz,
  last_week date,
  last_sent_at timestamptz,
  last_delivered boolean,
  last_payload text,
  CHECK (enabled = (install_id IS NOT NULL))
);
INSERT INTO {{app}}.telemetry (id) VALUES (1);
`,
};

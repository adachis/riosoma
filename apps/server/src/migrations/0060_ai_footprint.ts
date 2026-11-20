import type { Migration } from '@riosoma/db';

/**
 * AI footprint estimates, kept beside what AI work costs.  `ai_usage` adds up each month's calls
 * for each person, kind of work, model, estimate method, and electricity zone, the way `ai_spend`
 * adds up the month's cost, so totals by month, feature, and model are one small read.  A call with
 * no estimate counts with an empty method and zone.  The person is only a label here, with no link
 * to their account, so the organization's totals stay whole after someone leaves.
 *
 * Each AI field run also keeps its own estimate beside its cost.
 */
export const m0060: Migration = {
  id: '0060_ai_footprint',
  sql: `
CREATE TABLE {{app}}.ai_usage (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  month date NOT NULL,
  user_id text NOT NULL DEFAULT '',
  feature text NOT NULL CHECK (feature IN ('rio', 'aiFields', 'diagnose', 'routines')),
  provider_id text NOT NULL,
  model text NOT NULL,
  method text NOT NULL DEFAULT '',
  zone text NOT NULL DEFAULT '',
  calls bigint NOT NULL DEFAULT 0,
  estimated_calls bigint NOT NULL DEFAULT 0,
  priced_calls bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  energy_wh_min double precision NOT NULL DEFAULT 0,
  energy_wh_max double precision NOT NULL DEFAULT 0,
  gwp_g_min double precision NOT NULL DEFAULT 0,
  gwp_g_max double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month, user_id, feature, provider_id, model, method, zone)
);
CREATE INDEX ai_usage_person ON {{app}}.ai_usage (org_id, user_id, month);
ALTER TABLE {{app}}.ai_field_runs
  ADD COLUMN energy_wh_min double precision,
  ADD COLUMN energy_wh_max double precision,
  ADD COLUMN gwp_g_min double precision,
  ADD COLUMN gwp_g_max double precision,
  ADD COLUMN footprint_method text,
  ADD COLUMN footprint_zone text;
`,
};

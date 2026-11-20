import type { Migration } from '@riosoma/db';

export const m0102: Migration = {
  id: '0102_feedback_hub',
  sql: `
ALTER TABLE {{app}}.orgs ADD COLUMN feedback_hub_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.telemetry ADD COLUMN hub_install_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE {{app}}.feedback ADD COLUMN upstream_issue_url text;
ALTER TABLE {{app}}.feedback ADD COLUMN upstream_sent_at timestamptz;
ALTER TABLE {{app}}.feedback ADD COLUMN upstream_pending_fingerprint text;
`,
};

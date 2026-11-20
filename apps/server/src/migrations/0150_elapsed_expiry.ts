import type { Migration } from '@riosoma/db';

export const m0150: Migration = {
  id: '0150_elapsed_expiry',
  sql: `
-- PostgreSQL calendar-day intervals follow DST; expiry lifetimes use elapsed hours.
ALTER TABLE {{app}}.sso_domain_verifications
  ALTER COLUMN expires_at SET DEFAULT clock_timestamp() + interval '24 hours';
ALTER TABLE {{app}}.organization_archives
  ALTER COLUMN expires_at SET DEFAULT now() + interval '168 hours';
ALTER TABLE {{app}}.rio_routine_approvals
  ALTER COLUMN expires_at SET DEFAULT clock_timestamp() + interval '168 hours';
`,
};

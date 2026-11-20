import type { Migration } from '@riosoma/db';

/**
 * Routines read pages from records only at the root of a site their owner approved.
 *
 * `approved_hosts` lists the sites, each as an origin (scheme, host, and port), whose root a
 * routine may fetch when a field its plan reads pages from names them.  `declined_hosts` keeps the
 * sites its owner skipped, so a run doesn't ask about them again.  A run that meets a site in no
 * list leaves a `hosts` approval, "Read these new sites?", and fetches nothing from it until then.
 *
 * Since a routine no longer tells apart who wrote an address, `rio_routine_groups`, which recorded
 * the undo groups routines wrote in, goes.
 */
export const m0062: Migration = {
  id: '0062_routine_hosts',
  sql: `
ALTER TABLE {{app}}.rio_routines ADD COLUMN approved_hosts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE {{app}}.rio_routines ADD COLUMN declined_hosts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE {{app}}.rio_routine_approvals DROP CONSTRAINT rio_routine_approvals_kind_check;
ALTER TABLE {{app}}.rio_routine_approvals ADD CONSTRAINT rio_routine_approvals_kind_check
  CHECK (kind IN ('plan', 'email', 'hosts'));
DROP TABLE {{app}}.rio_routine_groups;
`,
};

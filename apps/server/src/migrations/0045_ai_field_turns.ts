import type { Migration } from '@riosoma/db';

/**
 * When each organization last had an AI field run claimed, so claims take turns across claims and
 * not only within one.  `last_served` counts claimed turns across every organization: a claim
 * gives each organization it serves the next number, in the order it served them, so the
 * organization with the lowest number, or none yet, is the one served longest ago.  Claims hold an
 * advisory lock, so no two ever hand out the same number.
 */
export const m0045: Migration = {
  id: '0045_ai_field_turns',
  sql: `
CREATE TABLE {{app}}.ai_field_turns (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  last_served bigint NOT NULL
);
CREATE INDEX ai_field_turns_served ON {{app}}.ai_field_turns (last_served);
`,
};

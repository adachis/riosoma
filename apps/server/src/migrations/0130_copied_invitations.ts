import type { Migration } from '@riosoma/db';

export const m0130: Migration = {
  id: '0130_copied_invitations',
  sql: `
ALTER TABLE {{app}}.invitations ADD COLUMN copied boolean NOT NULL DEFAULT false;
-- Nothing recorded how earlier links were delivered, so each one still waiting counts as copied.
UPDATE {{app}}.invitations SET copied = true WHERE accepted_at IS NULL;
`,
};

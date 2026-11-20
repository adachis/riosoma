import type { Migration } from '@riosoma/db';

/** Restored configurations were already published before drafts became a creation option. */
export const m0081: Migration = {
  id: '0081_automation_publication',
  sql: `
UPDATE {{app}}.automations SET published_at = updated_at
WHERE published_at IS NULL;
`,
};

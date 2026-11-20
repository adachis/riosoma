import type { Migration } from '@riosoma/db';

export const m0094: Migration = {
  id: '0094_form_edit_links',
  // Keep revocation outside undoable view settings so undo cannot reactivate old links.
  sql: `ALTER TABLE {{app}}.public_forms ADD COLUMN edit_version integer NOT NULL DEFAULT 0;`,
};

import type { Migration } from '@riosoma/db';

/**
 * An imported OAuth registration stays paused until the owner turns it on from the import review,
 * where imported booking pages wait too.
 */
export const m0056: Migration = {
  id: '0056_archive_review',
  sql: `
ALTER TABLE {{app}}.oauth_clients ADD COLUMN import_paused boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.organization_import_review DROP CONSTRAINT organization_import_review_kind_check;
ALTER TABLE {{app}}.organization_import_review ADD CONSTRAINT organization_import_review_kind_check
  CHECK (kind IN ('person', 'source', 'webhook', 'automation', 'publicLink', 'publicForm',
    'calendarFeeds', 'oauthApp', 'feedback', 'bookingPage', 'oauthClient'));
`,
};

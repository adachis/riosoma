import type { Migration } from '@riosoma/db';

/**
 * Teable and SeaTable join NocoDB, Baserow, and Grist as tools a whole database can be migrated
 * from.  They share the `platform_imports` table, so only the list of tools it accepts grows, and
 * the imports already recorded keep their rows and reports untouched.
 */
export const m0076: Migration = {
  id: '0076_platform_import_tools',
  sql: `
ALTER TABLE {{app}}.platform_imports DROP CONSTRAINT platform_imports_platform_check;
ALTER TABLE {{app}}.platform_imports ADD CONSTRAINT platform_imports_platform_check
  CHECK (platform IN ('nocodb', 'baserow', 'grist', 'teable', 'seatable'));
`,
};

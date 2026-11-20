import type { Migration } from '@riosoma/db';

export const m0096: Migration = {
  id: '0096_import_platforms',
  sql: `
ALTER TABLE {{app}}.platform_imports DROP CONSTRAINT platform_imports_platform_check;
ALTER TABLE {{app}}.platform_imports ADD CONSTRAINT platform_imports_platform_check
  CHECK (platform IN ('nocodb', 'baserow', 'grist', 'teable', 'seatable', 'clickup', 'asana', 'notion', 'monday', 'smartsheet'));
`,
};

import type { Migration } from '@riosoma/db';

/** Inherited access changes must drop external views in the same transaction as direct grants. */
export const m0072: Migration = {
  id: '0072_sql_access_paths',
  sql: ['folders', 'folder_databases', 'group_members']
    .map(
      (table) => `
CREATE TRIGGER sql_access_changed BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON {{app}}.${table} FOR EACH STATEMENT EXECUTE FUNCTION {{app}}.invalidate_sql_views();
`,
    )
    .join('\n'),
};

import type { Migration } from '@riosoma/db';

/**
 * Field and record permissions.  A field has at most one row of rules: who may see it
 * (`restricted`) and who may change its values (`locked`), each `{ roles, users }` or null for no
 * such rule.  A table has an ordered list of record rules, each naming roles and people and the
 * condition, in the filter model, that the records they see must meet.  Both go with their field,
 * table, or database, and both keep while a field or table is in the trash, so restoring it brings
 * its rules back.
 */
export const m0028: Migration = {
  id: '0028_permissions',
  sql: `
CREATE TABLE {{app}}.field_permissions (
  field_id text PRIMARY KEY REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  -- { roles, users } or null, checked by the contract
  restricted jsonb,
  locked jsonb,
  updated_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (restricted IS NOT NULL OR locked IS NOT NULL)
);
CREATE INDEX field_permissions_database ON {{app}}.field_permissions (database_id);

CREATE TABLE {{app}}.record_rules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  position integer NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  users text[] NOT NULL DEFAULT '{}',
  -- A filter group, checked by the contract
  condition jsonb NOT NULL,
  updated_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX record_rules_database ON {{app}}.record_rules (database_id);
CREATE INDEX record_rules_table ON {{app}}.record_rules (table_id, position);
`,
};

import type { Migration } from '@riosoma/db';

/**
 * Views disappear in the permission change's transaction, before a worker can rebuild them.
 * Deleting a login's person, or the admin who enabled it, turns the login off first and drops its
 * role and schema when it may.  Otherwise a later update of the login during the delete's cascade
 * would still name the deleted person, and the foreign key would refuse the delete.
 */
export const m0040: Migration = {
  id: '0040_sql_access',
  sql: `
CREATE TABLE {{app}}.sql_settings (
  database_id text PRIMARY KEY REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE {{app}}.sql_history (
  id uuid PRIMARY KEY,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  query text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  error text,
  result jsonb,
  scope_key text,
  backend_pid integer,
  canceled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sql_history_person ON {{app}}.sql_history (database_id, user_id, created_at DESC);
CREATE TABLE {{app}}.sql_logins (
  database_id text PRIMARY KEY REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  person_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  enabled_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  role_name text NOT NULL UNIQUE,
  schema_name text NOT NULL UNIQUE,
  verifier text,
  sealed_password text,
  verified boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  ready boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  rebuilt_at timestamptz
);
CREATE FUNCTION {{app}}.invalidate_sql_views() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE access_row record;
DECLARE view_row record;
BEGIN
  FOR access_row IN SELECT * FROM {{app}}.sql_logins ORDER BY database_id FOR UPDATE LOOP
    UPDATE {{app}}.sql_logins SET ready = false WHERE database_id = access_row.database_id;
    FOR view_row IN SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = access_row.schema_name AND c.relkind = 'v'
    LOOP
      EXECUTE pg_catalog.format('DROP VIEW %I.%I', access_row.schema_name, view_row.relname);
    END LOOP;
  END LOOP;
  RETURN NULL;
END
$body$;
REVOKE ALL ON FUNCTION {{app}}.invalidate_sql_views() FROM PUBLIC;
CREATE FUNCTION {{app}}.detach_sql_logins() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE login_row record;
BEGIN
  FOR login_row IN SELECT * FROM {{app}}.sql_logins WHERE person_id = OLD.id OR enabled_by = OLD.id
    ORDER BY database_id FOR UPDATE
  LOOP
    UPDATE {{app}}.sql_logins SET enabled = false, ready = false, verified = false, verifier = NULL,
      sealed_password = NULL, person_id = NULLIF(person_id, OLD.id), enabled_by = NULLIF(enabled_by, OLD.id)
      WHERE database_id = login_row.database_id;
    INSERT INTO {{audit}}.events (org_id, actor_id, action, metadata)
      SELECT org_id, NULL, 'databases.sql.loginDisabled', pg_catalog.jsonb_build_object('databaseId',
        login_row.database_id, 'personId', login_row.person_id, 'enabledBy', login_row.enabled_by,
        'reason', 'deleted')
      FROM {{app}}.databases WHERE id = login_row.database_id;
    BEGIN
      EXECUTE pg_catalog.format('DROP SCHEMA IF EXISTS %I CASCADE', login_row.schema_name);
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login_row.role_name) THEN
        EXECUTE pg_catalog.format('REVOKE CONNECT ON DATABASE %I FROM %I', pg_catalog.current_database(),
          login_row.role_name);
        EXECUTE pg_catalog.format('DROP ROLE %I', login_row.role_name);
      END IF;
      DELETE FROM {{app}}.sql_logins WHERE database_id = login_row.database_id;
    EXCEPTION WHEN OTHERS THEN
      -- Without the privilege to drop them, the role and schema wait for the cleanup SQL admins see.
      NULL;
    END;
  END LOOP;
  RETURN OLD;
END
$body$;
REVOKE ALL ON FUNCTION {{app}}.detach_sql_logins() FROM PUBLIC;
${['fields', 'field_permissions', 'record_rules', 'grants', 'memberships', 'table_sources', 'links'].map((table) => `CREATE TRIGGER sql_access_changed BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON {{app}}.${table} FOR EACH STATEMENT EXECUTE FUNCTION {{app}}.invalidate_sql_views();`).join('\n')}
CREATE TRIGGER sql_access_changed BEFORE UPDATE OF name, primary_field_id, trashed_at OR DELETE OR TRUNCATE ON {{app}}.tables FOR EACH STATEMENT EXECUTE FUNCTION {{app}}.invalidate_sql_views();
CREATE TRIGGER sql_access_changed BEFORE UPDATE OF org_id, trashed_at OR DELETE OR TRUNCATE ON {{app}}.databases FOR EACH STATEMENT EXECUTE FUNCTION {{app}}.invalidate_sql_views();
CREATE TRIGGER sql_access_changed BEFORE UPDATE OF deactivated_at OR DELETE OR TRUNCATE ON {{app}}.users FOR EACH STATEMENT EXECUTE FUNCTION {{app}}.invalidate_sql_views();
CREATE TRIGGER sql_logins_detached BEFORE DELETE ON {{app}}.users FOR EACH ROW EXECUTE FUNCTION {{app}}.detach_sql_logins();
`,
};

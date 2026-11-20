import type { Migration } from '@riosoma/db';

/**
 * A session of an outside login that reads a view holds a lock on it for as long as its transaction
 * stays open, and dropping the view waits for that lock.  Every view reads its login's row first,
 * so marking the login not ready is what closes its views.  Dropping them here is tidying: it gives
 * way at once to a session in its path, and the refresh that rebuilds the views removes them.
 * Dropping a deleted person's login gives way the same, and first drops what its role owns, since a
 * role that owns anything can't be dropped.
 *
 * PostgreSQL drops a role while sessions of it are connected, and such a session stays connected
 * with no role for the server to end it by.  So the role's sessions end before the role goes, and
 * the role stays, with its row, while it has a session the account deleting the person may not end.
 */
export const m0131: Migration = {
  id: '0131_sql_views_give_way',
  sql: `
CREATE OR REPLACE FUNCTION {{app}}.invalidate_sql_views() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE access_row record;
DECLARE view_row record;
DECLARE usual_wait text := pg_catalog.current_setting('lock_timeout');
BEGIN
  FOR access_row IN SELECT * FROM {{app}}.sql_logins ORDER BY database_id FOR UPDATE LOOP
    UPDATE {{app}}.sql_logins SET ready = false WHERE database_id = access_row.database_id;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = access_row.schema_name AND c.relkind = 'v')
    THEN
      BEGIN
        PERFORM pg_catalog.set_config('lock_timeout', '1', true);
        FOR view_row IN SELECT c.relname FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = access_row.schema_name AND c.relkind = 'v'
        LOOP
          EXECUTE pg_catalog.format('DROP VIEW %I.%I', access_row.schema_name, view_row.relname);
        END LOOP;
        PERFORM pg_catalog.set_config('lock_timeout', usual_wait, true);
      EXCEPTION WHEN lock_not_available THEN
        -- A session holds one of the views.  Leaving the block puts the usual wait back.
        NULL;
      END;
    END IF;
  END LOOP;
  RETURN NULL;
END
$body$;
CREATE OR REPLACE FUNCTION {{app}}.detach_sql_logins() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE login_row record;
DECLARE usual_wait text := pg_catalog.current_setting('lock_timeout');
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
      PERFORM pg_catalog.set_config('lock_timeout', '1', true);
      PERFORM CASE WHEN pg_catalog.pg_has_role(current_user, usesysid, 'USAGE')
        THEN pg_catalog.pg_terminate_backend(pid) END
        FROM pg_catalog.pg_stat_activity WHERE usename = login_row.role_name;
      EXECUTE pg_catalog.format('DROP SCHEMA IF EXISTS %I CASCADE', login_row.schema_name);
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login_row.role_name) THEN
        EXECUTE pg_catalog.format('REVOKE CONNECT ON DATABASE %I FROM %I', pg_catalog.current_database(),
          login_row.role_name);
        BEGIN
          EXECUTE pg_catalog.format('DROP OWNED BY %I', login_row.role_name);
        EXCEPTION WHEN insufficient_privilege THEN
          -- An account without the role's privileges can still drop a role that owns nothing.
          NULL;
        END;
        -- A tool that reconnects at once has a session again by now.
        PERFORM CASE WHEN pg_catalog.pg_has_role(current_user, usesysid, 'USAGE')
          THEN pg_catalog.pg_terminate_backend(pid) END
          FROM pg_catalog.pg_stat_activity WHERE usename = login_row.role_name;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename = login_row.role_name
          AND NOT pg_catalog.pg_has_role(current_user, usesysid, 'USAGE'))
        THEN
          RAISE insufficient_privilege;
        END IF;
        EXECUTE pg_catalog.format('DROP ROLE %I', login_row.role_name);
      END IF;
      DELETE FROM {{app}}.sql_logins WHERE database_id = login_row.database_id;
      PERFORM pg_catalog.set_config('lock_timeout', usual_wait, true);
    EXCEPTION WHEN OTHERS THEN
      -- Without the privilege to drop them or to end the role's sessions, or while a session holds
      -- a view, the role and schema wait for the refresh or for the cleanup SQL admins see.
      NULL;
    END;
  END LOOP;
  RETURN OLD;
END
$body$;
`,
};

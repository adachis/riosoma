import type { Migration } from '@riosoma/db';

/** Policies live with their organization and database so deletion cannot leave orphan rules. */
export const m0074: Migration = {
  id: '0074_governance',
  sql: `
ALTER TABLE {{app}}.orgs ADD COLUMN classification_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE {{app}}.rio_messages ADD COLUMN classification_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE {{app}}.orgs ADD COLUMN classification_labels jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(classification_labels) = 'array' AND jsonb_array_length(classification_labels) <= 12);
ALTER TABLE {{app}}.orgs ADD COLUMN retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{app}}.orgs ADD COLUMN retired_database_retention jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{app}}.databases ADD COLUMN history_floor bigint NOT NULL DEFAULT 0;
ALTER TABLE {{app}}.databases ADD COLUMN classification_label text;
ALTER TABLE {{app}}.databases ADD COLUMN retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{app}}.databases ADD COLUMN legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.tables ADD COLUMN classification_label text;
ALTER TABLE {{app}}.tables ADD COLUMN purged_at timestamptz;
ALTER TABLE {{app}}.databases ADD COLUMN purged_at timestamptz;
ALTER TABLE {{app}}.fields ADD COLUMN classification_label text;
ALTER TABLE IF EXISTS {{app}}.comments ADD COLUMN record_deleted_at timestamptz;
DO $$
BEGIN
  IF to_regclass('{{app}}.comments') IS NOT NULL THEN
    -- Comments keep their database ID for retention and detach from tables that are purged.
    ALTER TABLE {{app}}.comments DROP CONSTRAINT comments_database_id_fkey;
    ALTER TABLE {{app}}.comments DROP CONSTRAINT comments_table_id_fkey;
    ALTER TABLE {{app}}.comments ALTER COLUMN table_id DROP NOT NULL;
    ALTER TABLE {{app}}.comments ADD CONSTRAINT comments_table_id_fkey
      FOREIGN KEY (table_id) REFERENCES {{app}}.tables(id) ON DELETE SET NULL;
    CREATE INDEX comments_deleted_record ON {{app}}.comments (table_id, record_deleted_at) WHERE record_deleted_at IS NOT NULL;
    CREATE INDEX comments_retention ON {{app}}.comments (org_id, database_id, record_deleted_at);
  END IF;
END;
$$;
-- History and execution logs keep their database identity after their parents leave the trash.
ALTER TABLE {{app}}.automation_runs DROP CONSTRAINT automation_runs_database_id_fkey;
ALTER TABLE {{app}}.automation_runs DROP CONSTRAINT automation_runs_automation_id_fkey;
ALTER TABLE {{app}}.rio_routine_runs ADD COLUMN database_id text;
UPDATE {{app}}.rio_routine_runs r SET database_id = t.database_id
  FROM {{app}}.rio_routines t WHERE t.id = r.routine_id;
ALTER TABLE {{app}}.rio_routine_runs ALTER COLUMN database_id SET NOT NULL;
ALTER TABLE {{app}}.rio_routine_runs DROP CONSTRAINT rio_routine_runs_routine_id_fkey;
CREATE FUNCTION {{app}}.routine_run_database() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT database_id INTO NEW.database_id FROM {{app}}.rio_routines WHERE id = NEW.routine_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER routine_run_database BEFORE INSERT ON {{app}}.rio_routine_runs
  FOR EACH ROW EXECUTE FUNCTION {{app}}.routine_run_database();
CREATE INDEX routine_runs_retention ON {{app}}.rio_routine_runs (database_id, finished_at);
CREATE INDEX automation_runs_retention ON {{app}}.automation_runs (database_id, queued_at);

CREATE INDEX databases_legal_hold ON {{app}}.databases (org_id) WHERE legal_hold;

-- Retention removes audit events, and the chain has to survive that: each removed event leaves its
-- place and its hash here, so an integrity check still walks an unbroken chain and an event that
-- went missing some other way is still a break.  This is chain state of one installation, so it
-- never travels in an organization archive.  An import re-chains the events it brings in.
CREATE TABLE {{audit}}.purged (
  org_id text NOT NULL,
  chain_seq bigint NOT NULL,
  hash text NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, chain_seq)
);
CREATE FUNCTION {{audit}}.refuse_purged_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the record of expired audit events is append-only';
END;
$$;
CREATE TRIGGER purged_no_change BEFORE UPDATE OR DELETE ON {{audit}}.purged
  FOR EACH ROW EXECUTE FUNCTION {{audit}}.refuse_purged_change();
CREATE TRIGGER purged_no_truncate BEFORE TRUNCATE ON {{audit}}.purged
  FOR EACH STATEMENT EXECUTE FUNCTION {{audit}}.refuse_purged_change();

CREATE OR REPLACE FUNCTION {{audit}}.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keep_days integer;
  database_policy jsonb;
  minimum_days integer;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('riosoma.retention_purge', true) = 'on' THEN
    SELECT (retention_policy->>'auditDays')::integer,
      GREATEST(365, COALESCE((settings->'unitPolicy'->'values'->>'auditRetentionDays')::integer, 365),
        COALESCE((SELECT max((u.policy->>'auditRetentionDays')::integer) FROM {{app}}.org_units u
          WHERE u.org_id = o.id AND o.settings->'unitPolicy'->'overridable' ? 'auditRetentionDays'), 365))
      INTO keep_days, minimum_days FROM {{app}}.orgs o WHERE id = OLD.org_id;
    IF keep_days IS NOT NULL THEN
      SELECT retention_policy INTO database_policy FROM {{app}}.databases
        WHERE org_id = OLD.org_id AND id = OLD.metadata->>'databaseId';
      IF database_policy IS NULL THEN
        SELECT retired_database_retention->(OLD.metadata->>'databaseId') INTO database_policy
          FROM {{app}}.orgs WHERE id = OLD.org_id;
      END IF;
      IF database_policy ? 'auditDays' THEN
        IF database_policy->>'auditDays' IS NULL THEN
          RAISE EXCEPTION 'the audit log is append-only';
        END IF;
        keep_days := GREATEST(keep_days, (database_policy->>'auditDays')::integer);
      END IF;
      IF OLD.at < clock_timestamp() - GREATEST(keep_days, minimum_days) * interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM {{app}}.databases d WHERE d.org_id = OLD.org_id AND d.legal_hold
          AND (OLD.metadata->>'databaseId' IS NULL OR d.id = OLD.metadata->>'databaseId')) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'the audit log is append-only';
END;
$$;

`,
};

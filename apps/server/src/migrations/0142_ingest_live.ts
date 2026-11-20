import type { Migration } from '@riosoma/db';

export const m0142: Migration = {
  id: '0142_ingest_live',
  sql: `
CREATE TABLE {{app}}.ingest_live_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  table_id text NOT NULL,
  file_id text NOT NULL,
  user_id text NOT NULL REFERENCES {{app}}.users(id),
  action text NOT NULL CHECK (action IN ('answer', 'remove')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'complete', 'failed')),
  message_id text,
  undo_group_id text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files(org_id, table_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_live_requests_pending ON {{app}}.ingest_live_requests(created_at)
  WHERE state IN ('queued', 'running');
CREATE INDEX ingest_answers_version ON {{app}}.ingest_answers(org_id, table_id, question_id, question_version);
CREATE INDEX ingest_questions_file ON {{app}}.ingest_questions(org_id, table_id, (document->'target'->>'file'), created_at);

-- All producers, including background reads, announce committed states without carrying evidence.
CREATE FUNCTION {{app}}.ingest_live_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  database_id text;
  item_kind text;
  item_state text;
  item_id text;
BEGIN
  SELECT t.database_id INTO database_id FROM {{app}}.tables t
    WHERE t.org_id = NEW.org_id AND t.id = NEW.table_id;
  IF TG_TABLE_NAME = 'ingest_files' THEN
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state THEN RETURN NEW; END IF;
    item_kind := 'file'; item_state := NEW.state; item_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'ingest_questions' THEN
    IF TG_OP = 'UPDATE' AND NEW.active = OLD.active AND NEW.version = OLD.version THEN RETURN NEW; END IF;
    item_kind := 'question'; item_state := CASE WHEN NEW.active THEN 'open' ELSE 'closed' END; item_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'ingest_answers' THEN
    item_kind := 'question'; item_state := 'answered'; item_id := NEW.question_id;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.enabled = OLD.enabled THEN RETURN NEW; END IF;
    item_kind := 'rule'; item_state := CASE WHEN NEW.enabled THEN 'on' ELSE 'off' END; item_id := NEW.id;
  END IF;
  PERFORM pg_notify(left(TG_TABLE_SCHEMA || '_changes', 63), json_build_object(
    'type', 'ingestChanged', 'databaseId', database_id, 'tableId', NEW.table_id,
    'kind', item_kind, 'id', item_id, 'state', item_state)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER ingest_files_notice AFTER INSERT OR UPDATE ON {{app}}.ingest_files
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_live_notice();
CREATE TRIGGER ingest_questions_notice AFTER INSERT OR UPDATE ON {{app}}.ingest_questions
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_live_notice();
CREATE TRIGGER ingest_answers_notice AFTER INSERT ON {{app}}.ingest_answers
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_live_notice();
CREATE TRIGGER ingest_rules_notice AFTER INSERT OR UPDATE ON {{app}}.ingest_rules
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_live_notice();
`,
};

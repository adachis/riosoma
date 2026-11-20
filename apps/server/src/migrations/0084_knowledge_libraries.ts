import type { Migration } from '@riosoma/db';

export const m0084: Migration = {
  id: '0084_knowledge_libraries',
  sql: `
ALTER TABLE {{app}}.organization_import_review DROP CONSTRAINT organization_import_review_kind_check;
ALTER TABLE {{app}}.organization_import_review ADD CONSTRAINT organization_import_review_kind_check
  CHECK (kind IN ('person', 'source', 'webhook', 'automation', 'publicLink', 'publicForm',
    'calendarFeeds', 'oauthApp', 'feedback', 'bookingPage', 'oauthClient', 'knowledgeLibrary', 'knowledgeDocument'));
CREATE TABLE {{app}}.knowledge_libraries (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('organization', 'unit', 'database', 'personal')),
  target text NOT NULL,
  user_id text GENERATED ALWAYS AS (CASE WHEN scope = 'personal' THEN target END) STORED,
  database_id text GENERATED ALWAYS AS (CASE WHEN scope = 'database' THEN target END) STORED,
  unit_id text GENERATED ALWAYS AS (CASE WHEN scope = 'unit' THEN target END) STORED,
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, database_id) REFERENCES {{app}}.databases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, unit_id) REFERENCES {{app}}.org_units(org_id, id) ON DELETE CASCADE,
  CHECK (scope <> 'organization' OR target = org_id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) <= 300),
  label text NOT NULL CHECK (label IN ('public', 'internal', 'confidential', 'restricted')),
  guidance text NOT NULL DEFAULT '' CHECK (length(guidance) <= 1000),
  UNIQUE (org_id, scope, target),
  CHECK (scope IN ('organization', 'personal') OR guidance = '')
);
ALTER TABLE {{app}}.knowledge_actions ADD COLUMN created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE {{app}}.knowledge_actions ADD COLUMN library_user_id text;
ALTER TABLE {{app}}.knowledge_actions ADD COLUMN library_unit_id text;
ALTER TABLE {{app}}.knowledge_actions ADD FOREIGN KEY (org_id, library_user_id)
  REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE;
ALTER TABLE {{app}}.knowledge_actions ADD FOREIGN KEY (org_id, library_unit_id)
  REFERENCES {{app}}.org_units(org_id, id) ON DELETE CASCADE;
CREATE INDEX knowledge_actions_expiration ON {{app}}.knowledge_actions(created_at);
-- Pending imports have no live library yet, so target erasure also removes their review payloads.
CREATE FUNCTION {{app}}.erase_pending_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  erased_target text;
  target_scope text;
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    erased_target := OLD.user_id;
    target_scope := 'personal';
  ELSE
    erased_target := OLD.id;
    target_scope := CASE WHEN TG_TABLE_NAME = 'org_units' THEN 'unit' ELSE 'database' END;
  END IF;
  WITH libraries AS (
    SELECT id::text FROM {{app}}.knowledge_libraries
      WHERE org_id = OLD.org_id AND scope = target_scope AND target = erased_target
    UNION
    SELECT detail->'row'->>'id' FROM {{app}}.organization_import_review
      WHERE org_id = OLD.org_id AND kind = 'knowledgeLibrary'
        AND detail->'row'->>'scope' = target_scope AND detail->'row'->>'target' = erased_target
  )
  DELETE FROM {{app}}.organization_import_review
    WHERE org_id = OLD.org_id AND (
      (kind = 'knowledgeLibrary' AND target_id IN (SELECT id FROM libraries))
      OR (kind = 'knowledgeDocument' AND detail->'row'->>'library_id' IN (SELECT id FROM libraries))
    );
  RETURN OLD;
END;
$$;
CREATE TRIGGER memberships_erase_knowledge BEFORE DELETE ON {{app}}.memberships
  FOR EACH ROW EXECUTE FUNCTION {{app}}.erase_pending_knowledge();
CREATE TRIGGER org_units_erase_knowledge BEFORE DELETE ON {{app}}.org_units
  FOR EACH ROW EXECUTE FUNCTION {{app}}.erase_pending_knowledge();
CREATE TRIGGER databases_erase_knowledge BEFORE DELETE ON {{app}}.databases
  FOR EACH ROW EXECUTE FUNCTION {{app}}.erase_pending_knowledge();
CREATE TABLE {{app}}.knowledge_documents (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES {{app}}.knowledge_libraries(id) ON DELETE CASCADE,
  name text NOT NULL,
  size integer NOT NULL,
  source_text text NOT NULL CHECK (length(source_text) BETWEEN 1 AND 500000),
  status text NOT NULL CHECK (status IN ('ready', 'failed', 'blocked')),
  error_key text,
  model_key text,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX knowledge_documents_library ON {{app}}.knowledge_documents(library_id);
CREATE TABLE {{app}}.knowledge_chunks (
  document_id uuid NOT NULL REFERENCES {{app}}.knowledge_documents(id) ON DELETE CASCADE,
  position integer NOT NULL,
  section text NOT NULL,
  text text NOT NULL,
  value double precision[],
  PRIMARY KEY (document_id, position),
  CHECK (value IS NULL OR cardinality(value) BETWEEN 1 AND 4096)
);
`,
};

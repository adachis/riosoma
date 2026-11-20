import type { Migration } from '@riosoma/db';

export const m0068: Migration = {
  id: '0068_knowledge',
  sql: `
ALTER TABLE {{app}}.rio_messages ADD COLUMN context_database_id text;
CREATE TABLE {{app}}.knowledge_settings (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  settings jsonb NOT NULL
);
CREATE TABLE {{app}}.memories (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  user_id text REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX memories_scope ON {{app}}.memories(org_id, database_id, user_id);
CREATE TABLE {{app}}.knowledge_actions (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  database_id text REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  undone boolean NOT NULL DEFAULT false
);
CREATE TABLE {{app}}.embedding_tables (
  table_id text PRIMARY KEY REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1,
  indexed_generation bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  cursor bigint NOT NULL DEFAULT 0
);
CREATE TABLE {{app}}.embedding_changes (
  table_id text NOT NULL REFERENCES {{app}}.embedding_tables(table_id) ON DELETE CASCADE,
  record_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  queued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (table_id, record_id)
);
CREATE INDEX embedding_changes_pending ON {{app}}.embedding_changes(table_id, queued_at, record_id);
CREATE TABLE {{app}}.embeddings (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  field_id text NOT NULL DEFAULT '',
  table_id text REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  model_key text NOT NULL,
  digest text NOT NULL,
  value double precision[] NOT NULL CHECK (cardinality(value) BETWEEN 1 AND 4096),
  PRIMARY KEY (org_id, database_id, source_id, field_id)
);
CREATE INDEX embeddings_table ON {{app}}.embeddings(org_id, table_id, model_key);
ALTER TABLE {{app}}.ai_usage DROP CONSTRAINT ai_usage_feature_check;
ALTER TABLE {{app}}.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('rio', 'aiFields', 'diagnose', 'routines', 'embedding', 'search'));
`,
};

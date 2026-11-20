import type { Migration } from '@riosoma/db';

export const m0136: Migration = {
  id: '0136_ingest_decisions',
  sql: `
CREATE UNIQUE INDEX ingest_tables_org_identity ON {{app}}.tables (org_id, id);

CREATE TABLE {{app}}.ingest_questions (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  id text NOT NULL,
  version text NOT NULL,
  document jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE,
  PRIMARY KEY (org_id, table_id, id)
);
CREATE INDEX ingest_questions_active ON {{app}}.ingest_questions (org_id, table_id) WHERE active;

-- Answer history survives a disagreement disappearing and returning.
CREATE TABLE {{app}}.ingest_answers (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  question_document jsonb NOT NULL,
  response jsonb NOT NULL,
  answered_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  seq bigserial NOT NULL,
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, question_id)
    REFERENCES {{app}}.ingest_questions (org_id, table_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_answers_question ON {{app}}.ingest_answers (org_id, table_id, question_id, seq DESC);

CREATE TABLE {{app}}.ingest_rules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  kind text NOT NULL,
  document jsonb NOT NULL,
  answer_id text REFERENCES {{app}}.ingest_answers(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_rules_applicable ON {{app}}.ingest_rules (org_id, table_id, kind) WHERE enabled;
`,
};

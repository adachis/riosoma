import type { Migration } from '@riosoma/db';

export const m0100: Migration = {
  id: '0100_rio_conversations',
  sql: `
CREATE TABLE {{app}}.rio_active_conversations (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  conversation_id text NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (conversation_id, org_id, user_id)
    REFERENCES {{app}}.rio_conversations(id, org_id, user_id) ON DELETE CASCADE
);
ALTER TABLE {{app}}.rio_conversations ADD COLUMN context_usage jsonb;
ALTER TABLE {{app}}.rio_messages ADD COLUMN compaction boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.rio_messages ADD COLUMN screen_context jsonb;
CREATE TABLE {{app}}.rio_conversation_summaries (
  conversation_id text NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  database_id text NOT NULL,
  classification_revision bigint NOT NULL,
  through_position bigint NOT NULL,
  summary text NOT NULL,
  PRIMARY KEY (conversation_id, database_id),
  FOREIGN KEY (conversation_id, org_id, user_id)
    REFERENCES {{app}}.rio_conversations(id, org_id, user_id) ON DELETE CASCADE
);
`,
};

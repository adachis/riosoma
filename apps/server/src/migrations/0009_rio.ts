import type { Migration } from '@riosoma/db';

export const m0009: Migration = {
  id: '0009_rio',
  sql: `
CREATE TABLE {{app}}.ai_settings (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  settings jsonb NOT NULL
);
CREATE TABLE {{app}}.ai_keys (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  sealed text NOT NULL,
  PRIMARY KEY (org_id, provider_id)
);
CREATE TABLE {{app}}.ai_spend (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  month date NOT NULL,
  cost_usd numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);
CREATE TABLE {{app}}.rio_conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, org_id, user_id)
);
CREATE INDEX rio_conversations_owner ON {{app}}.rio_conversations (org_id, user_id, updated_at DESC);
CREATE TABLE {{app}}.rio_messages (
  id text PRIMARY KEY,
  position bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id text NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('person', 'rio')),
  blocks jsonb NOT NULL,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, org_id, user_id)
    REFERENCES {{app}}.rio_conversations(id, org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX rio_messages_conversation ON {{app}}.rio_messages (conversation_id, position);
CREATE TABLE {{app}}.rio_plans (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  database_id text NOT NULL,
  summary text NOT NULL,
  steps jsonb NOT NULL,
  commands jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'failed')),
  group_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  FOREIGN KEY (conversation_id, org_id, user_id)
    REFERENCES {{app}}.rio_conversations(id, org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX rio_plans_owner ON {{app}}.rio_plans (org_id, user_id, conversation_id);
`,
};

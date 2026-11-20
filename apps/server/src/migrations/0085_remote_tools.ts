import type { Migration } from '@riosoma/db';

export const migration: Migration = {
  id: '0085_remote_tools',
  sql: `
ALTER TABLE {{app}}.memories ADD COLUMN remote_data_blocked boolean NOT NULL DEFAULT false;
UPDATE {{app}}.memories m SET remote_data_blocked = true
  WHERE EXISTS (SELECT 1 FROM {{app}}.knowledge_libraries l WHERE l.org_id = m.org_id);
ALTER TABLE {{app}}.rio_conversations ADD COLUMN remote_data_blocked boolean NOT NULL DEFAULT false;
UPDATE {{app}}.rio_conversations c SET remote_data_blocked = true
  WHERE EXISTS (SELECT 1 FROM {{app}}.knowledge_libraries l WHERE l.org_id = c.org_id);
CREATE TABLE {{app}}.remote_servers (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  config jsonb NOT NULL,
  tools jsonb NOT NULL DEFAULT '[]',
  skipped_tools jsonb NOT NULL DEFAULT '[]',
  sealed text,
  revision integer NOT NULL DEFAULT 1,
  refreshed_at timestamptz,
  error_key text
);
CREATE INDEX remote_servers_org ON {{app}}.remote_servers(org_id);
CREATE TABLE {{app}}.remote_actions (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  server_id uuid NOT NULL,
  before jsonb,
  after jsonb,
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE
);
CREATE TABLE {{app}}.remote_calls (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  server_id uuid NOT NULL REFERENCES {{app}}.remote_servers(id) ON DELETE CASCADE,
  conversation_id text REFERENCES {{app}}.rio_conversations(id) ON DELETE CASCADE,
  tool text NOT NULL,
  revision integer NOT NULL,
  sealed text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'denied')),
  result text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '10 minutes'),
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX remote_calls_expiry ON {{app}}.remote_calls(status, expires_at);
CREATE INDEX remote_calls_server_time ON {{app}}.remote_calls(server_id, created_at);
CREATE INDEX remote_calls_actor_time ON {{app}}.remote_calls(org_id, user_id, created_at);
CREATE INDEX remote_calls_person ON {{app}}.remote_calls(org_id, user_id, conversation_id);
`,
};

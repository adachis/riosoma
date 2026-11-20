import type { Migration } from '@riosoma/db';

export const m0125: Migration = {
  id: '0125_pending_shares',
  sql: `
CREATE TABLE {{app}}.invitation_grants (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  invitation_id text NOT NULL REFERENCES {{app}}.invitations(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('database', 'folder')),
  resource_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'creator', 'editor', 'commenter', 'reader')),
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  PRIMARY KEY (invitation_id, resource_kind, resource_id)
);
CREATE INDEX invitation_grants_resource ON {{app}}.invitation_grants (org_id, resource_kind, resource_id);
`,
};

import type { Migration } from '@riosoma/db';

/**
 * Tenancy, people, sessions, and the audit log.  Every row belongs to an organization so a hosted
 * offering stays possible; single-server installs simply have one.
 */
export const m0001: Migration = {
  id: '0001_foundation',
  sql: `
CREATE SCHEMA IF NOT EXISTS {{data}};
CREATE SCHEMA IF NOT EXISTS {{audit}};

CREATE TABLE {{app}}.orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{app}}.org_units (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  parent_id text REFERENCES {{app}}.org_units(id) ON DELETE CASCADE,
  name text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_units_org ON {{app}}.org_units (org_id);

CREATE TABLE {{app}}.users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  -- Identity from single sign-on is matched by (issuer, subject), never by email alone.
  sso_issuer text,
  sso_subject text,
  password_hash text,
  locale text NOT NULL DEFAULT 'en-US',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sso_issuer, sso_subject)
);
CREATE UNIQUE INDEX users_email ON {{app}}.users (lower(email));

CREATE TABLE {{app}}.memberships (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  org_unit_id text REFERENCES {{app}}.org_units(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'member' CHECK (kind IN ('owner', 'member', 'guest')),
  admin_roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE {{app}}.invitations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  email text NOT NULL,
  kind text NOT NULL DEFAULT 'member',
  token_hash text NOT NULL,
  invited_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-side sessions, so signing out really revokes access.
CREATE TABLE {{app}}.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON {{app}}.sessions (user_id);

-- One-time sign-in links and email verification codes.
CREATE TABLE {{app}}.login_tokens (
  id text PRIMARY KEY,
  user_id text REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('magic_link', 'verify_email', 'recover')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Failed sign-in attempts live in the database so throttling works across replicas and restarts.
CREATE TABLE {{app}}.auth_attempts (
  key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key ON {{app}}.auth_attempts (key, at);

-- Append-only audit log.  The triggers refuse any change to history.
CREATE TABLE {{audit}}.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text,
  actor_id text,
  action text NOT NULL,
  target text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_at ON {{audit}}.events (org_id, at DESC);

CREATE FUNCTION {{audit}}.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only';
END;
$$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON {{audit}}.events
  FOR EACH ROW EXECUTE FUNCTION {{audit}}.refuse_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON {{audit}}.events
  FOR EACH STATEMENT EXECUTE FUNCTION {{audit}}.refuse_change();
`,
};

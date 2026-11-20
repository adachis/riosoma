import type { Migration } from '@riosoma/db';

/**
 * Passkeys and two-step sign-in.  A passkey keeps only its public key, so nothing here can sign in
 * by itself.  An authenticator app's secret is sealed with the instance key and bound to its owner,
 * and it remembers the last time step it accepted so a code works once.  Recovery codes are hashed
 * like passwords.  Each organization chooses who must use a second step.
 */
export const m0016: Migration = {
  id: '0016_mfa',
  sql: `
CREATE TABLE {{app}}.passkeys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  -- The credential ID the authenticator chose, base64url.
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  -- The authenticator's signature counter.  Once it reports one, each use must count higher.
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  -- The WebAuthn user handle given at registration, which a sign-in must repeat.
  user_handle text NOT NULL,
  name text NOT NULL,
  synced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user ON {{app}}.passkeys (user_id, created_at);

-- One authenticator app per person.  Setup replaces an unconfirmed secret, and a confirmed one
-- stays until it's turned off.
CREATE TABLE {{app}}.authenticator_secrets (
  user_id text PRIMARY KEY REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  sealed_secret text NOT NULL,
  confirmed_at timestamptz,
  last_step bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);

-- Regenerating replaces the whole set.
CREATE TABLE {{app}}.recovery_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz
);
CREATE INDEX recovery_codes_user ON {{app}}.recovery_codes (user_id);

-- Challenges and pending sign-ins already used, kept until they would have expired anyway, so
-- each one works once.
CREATE TABLE {{app}}.mfa_spent (
  key text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mfa_spent_expires ON {{app}}.mfa_spent (expires_at);

ALTER TABLE {{app}}.orgs ADD COLUMN second_step_policy text NOT NULL DEFAULT 'off'
  CHECK (second_step_policy IN ('off', 'admins', 'everyone'));
`,
};

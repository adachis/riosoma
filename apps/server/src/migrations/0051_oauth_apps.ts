import type { Migration } from '@riosoma/db';

/**
 * OAuth apps.  A person's consent for an app, its scopes and databases, is one record that every
 * installation of the app shares, so a narrower approval narrows them all at once.  Each
 * authorization is an installation grant of its own, with its own refresh tokens, and revoking one
 * ends only it.  Grants stay revoked after a person returns, so restoring membership cannot restore
 * app access.  A webhook an installation made belongs to its grant and turns off when the grant ends.
 */
export const m0051: Migration = {
  id: '0051_oauth_apps',
  sql: `
CREATE TABLE {{app}}.oauth_settings (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  dynamic_registration boolean NOT NULL DEFAULT false
);
CREATE TABLE {{app}}.oauth_clients (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL,
  homepage text NOT NULL,
  redirect_uris text[] NOT NULL,
  scopes text[] NOT NULL,
  secret_hash text,
  refresh_allowed boolean NOT NULL DEFAULT true,
  verified boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- When the app last received tokens.  An unverified app expires unused after 7 days, or idle after 90.
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_clients_org ON {{app}}.oauth_clients(org_id);
CREATE TABLE {{app}}.oauth_consents (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES {{app}}.oauth_clients(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  -- Every database the person can open, now and later, when null.
  databases text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX oauth_consents_live ON {{app}}.oauth_consents(client_id, org_id, user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX oauth_consents_person ON {{app}}.oauth_consents(user_id, org_id);
CREATE TABLE {{app}}.oauth_grants (
  id text PRIMARY KEY,
  consent_id text NOT NULL REFERENCES {{app}}.oauth_consents(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES {{app}}.oauth_clients(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  -- What this installation asked for.  Its tokens reach only what the shared consent still allows.
  scopes text[] NOT NULL,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
CREATE INDEX oauth_grants_person ON {{app}}.oauth_grants(user_id, org_id);
CREATE INDEX oauth_grants_client ON {{app}}.oauth_grants(client_id);
CREATE INDEX oauth_grants_consent ON {{app}}.oauth_grants(consent_id);
CREATE TABLE {{app}}.oauth_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES {{app}}.oauth_clients(id) ON DELETE CASCADE,
  -- The hashed network address that started the request.  Each may have 20 waiting per app.
  address text NOT NULL,
  parameters jsonb NOT NULL,
  session_id text REFERENCES {{app}}.sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  used_at timestamptz
);
CREATE INDEX oauth_requests_expiry ON {{app}}.oauth_requests(expires_at);
CREATE INDEX oauth_requests_address ON {{app}}.oauth_requests(client_id, address, created_at);
CREATE TABLE {{app}}.oauth_credentials (
  hash text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES {{app}}.oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  redirect_uri text,
  challenge text,
  -- An access token from a refresh that asked for less than its grant, or null for the grant's scopes.
  scopes text[],
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX oauth_credentials_grant ON {{app}}.oauth_credentials(grant_id);
CREATE TABLE {{app}}.oauth_webhooks (
  webhook_id text PRIMARY KEY REFERENCES {{app}}.webhooks(id) ON DELETE CASCADE,
  grant_id text NOT NULL REFERENCES {{app}}.oauth_grants(id) ON DELETE CASCADE
);
CREATE INDEX oauth_webhooks_grant ON {{app}}.oauth_webhooks(grant_id);

-- Who is acting, for a revocation a trigger makes.  The application names them in the
-- transaction-local setting riosoma.acting, as {"actorId": ..., "metadata": {...}}.
CREATE FUNCTION {{app}}.oauth_acting() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('riosoma.acting', true), '')::jsonb, '{}'::jsonb)
$$;

CREATE FUNCTION {{app}}.revoke_person_oauth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acting jsonb := {{app}}.oauth_acting();
  person text;
  org text;
  reason text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP = 'UPDATE' AND NEW.deactivated_at IS NULL THEN RETURN OLD; END IF;
    person := OLD.id;
    reason := CASE WHEN TG_OP = 'DELETE' THEN 'person_removed' ELSE 'person_inactive' END;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.kind <> 'guest' THEN RETURN OLD; END IF;
    person := OLD.user_id;
    org := OLD.org_id;
    reason := CASE WHEN TG_OP = 'DELETE' THEN 'membership_removed' ELSE 'became_guest' END;
  END IF;
  UPDATE {{app}}.oauth_consents SET revoked_at = clock_timestamp()
  WHERE user_id = person AND (org IS NULL OR org_id = org) AND revoked_at IS NULL;
  WITH revoked AS (
    UPDATE {{app}}.oauth_grants SET revoked_at = clock_timestamp()
    WHERE user_id = person AND (org IS NULL OR org_id = org) AND revoked_at IS NULL RETURNING *
  ) INSERT INTO {{audit}}.events(org_id, actor_id, action, target, metadata)
    SELECT org_id, acting->>'actorId', 'oauth.grant.revoked', client_id,
      COALESCE(acting->'metadata', '{}'::jsonb) || jsonb_build_object('grantId', id,
        'consentId', consent_id, 'clientId', client_id, 'userId', user_id, 'reason', reason)
    FROM revoked;
  RETURN OLD;
END;
$$;
CREATE TRIGGER oauth_person_inactive AFTER UPDATE OF deactivated_at ON {{app}}.users
  FOR EACH ROW EXECUTE FUNCTION {{app}}.revoke_person_oauth();
CREATE TRIGGER oauth_person_removed BEFORE DELETE ON {{app}}.users
  FOR EACH ROW EXECUTE FUNCTION {{app}}.revoke_person_oauth();
CREATE TRIGGER oauth_membership_changed AFTER UPDATE OF kind ON {{app}}.memberships
  FOR EACH ROW EXECUTE FUNCTION {{app}}.revoke_person_oauth();
CREATE TRIGGER oauth_membership_removed BEFORE DELETE ON {{app}}.memberships
  FOR EACH ROW EXECUTE FUNCTION {{app}}.revoke_person_oauth();

-- However a grant ends, the webhooks it made turn off, and what they haven't sent waits.
CREATE FUNCTION {{app}}.oauth_grant_ended() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acting jsonb := {{app}}.oauth_acting();
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
  WITH stopped AS (
    UPDATE {{app}}.webhooks w SET enabled = false, disabled_reason = 'webhooks.disabled.grantEnded',
      updated_at = now()
    FROM {{app}}.oauth_webhooks o
    WHERE o.grant_id = NEW.id AND w.id = o.webhook_id AND w.enabled
    RETURNING w.id, w.org_id, w.database_id
  ), held AS (
    UPDATE {{app}}.webhook_deliveries d SET next_attempt_at = NULL
    FROM stopped s WHERE d.webhook_id = s.id AND d.state = 'pending' AND NOT d.manual
  ) INSERT INTO {{audit}}.events(org_id, actor_id, action, target, metadata)
    SELECT org_id, acting->>'actorId', 'data.webhook.disabled', id, jsonb_build_object(
      'databaseId', database_id, 'webhookId', id, 'reason', 'webhooks.disabled.grantEnded',
      'grantId', NEW.id, 'clientId', NEW.client_id)
    FROM stopped;
  RETURN NEW;
END;
$$;
CREATE TRIGGER oauth_grant_ended AFTER UPDATE OF revoked_at ON {{app}}.oauth_grants
  FOR EACH ROW EXECUTE FUNCTION {{app}}.oauth_grant_ended();
`,
};

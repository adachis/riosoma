import type { Migration } from '@riosoma/db';

/**
 * Outbound webhooks.  A change that commits writes an event for each subscribed webhook into
 * `webhook_events` in the same transaction, so a change that rolls back never reaches anyone.  A
 * worker gathers each webhook's events into deliveries of up to 100, and every try at sending one
 * is an attempt.  Deliveries and attempts are kept for 7 days.
 */
export const m0017: Migration = {
  id: '0017_webhooks',
  sql: `
CREATE TABLE {{app}}.webhooks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,
  -- Only these tables' changes, or every table's when null.
  table_ids text[],
  enabled boolean NOT NULL DEFAULT true,
  -- The signing secret, sealed with the instance key.  People see it once, when it's made.
  secret text NOT NULL,
  -- The secret it replaced, which keeps signing beside the new one until the time given.
  previous_secret text,
  previous_secret_until timestamptz,
  -- The message key saying why it turned itself off, cleared when someone turns it back on.
  disabled_reason text,
  -- When deliveries started failing with no success since.
  failing_since timestamptz,
  last_success_at timestamptz,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_database ON {{app}}.webhooks (database_id);

-- Events waiting to be gathered into a delivery, oldest first.
CREATE TABLE {{app}}.webhook_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES {{app}}.webhooks(id) ON DELETE CASCADE,
  -- The event as the receiver sees it, kept as written so its keys stay in order.
  event text NOT NULL,
  event_type text NOT NULL,
  queued_at timestamptz NOT NULL
);
CREATE INDEX webhook_events_webhook ON {{app}}.webhook_events (webhook_id, id);

CREATE TABLE {{app}}.webhook_deliveries (
  id text PRIMARY KEY,
  -- Order of gathering: a webhook's deliveries go in this order, and history lists by it.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  webhook_id text NOT NULL REFERENCES {{app}}.webhooks(id) ON DELETE CASCADE,
  -- The exact body sent, so every attempt signs the same bytes.
  payload text NOT NULL,
  event_count integer NOT NULL,
  event_types text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  -- Someone asked for the next attempt, which goes even while the webhook is off.
  manual boolean NOT NULL DEFAULT false,
  -- When a pending delivery goes next.  Null holds it while its webhook is off.
  next_attempt_at timestamptz,
  lease_at timestamptz,
  lease_token text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX webhook_deliveries_due ON {{app}}.webhook_deliveries (webhook_id, next_attempt_at, seq)
  WHERE state = 'pending';
CREATE INDEX webhook_deliveries_leased ON {{app}}.webhook_deliveries (webhook_id, lease_at)
  WHERE lease_at IS NOT NULL;
CREATE INDEX webhook_deliveries_history ON {{app}}.webhook_deliveries (webhook_id, seq DESC);
CREATE INDEX webhook_deliveries_age ON {{app}}.webhook_deliveries (updated_at);

CREATE TABLE {{app}}.webhook_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES {{app}}.webhook_deliveries(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  -- The HTTP status the receiver answered with, or null when no answer came.
  status integer,
  ms integer,
  -- Why no answer came, as a message key.
  error text,
  manual boolean NOT NULL DEFAULT false
);
CREATE INDEX webhook_attempts_delivery ON {{app}}.webhook_attempts (delivery_id, id DESC);
CREATE INDEX webhook_attempts_age ON {{app}}.webhook_attempts (at);
`,
};

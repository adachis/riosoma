import type { Migration } from '@riosoma/db';

export const m0053: Migration = {
  id: '0053_payments',
  sql: `
-- A field whose values only Riosoma writes.  Payment result fields hold what Stripe reported, so
-- no person, visitor, import, or automation may change them, and only the payment service does.
ALTER TABLE {{app}}.fields ADD COLUMN managed text CHECK (managed IN ('payment'));

-- An organization's Stripe account.  Both secrets are sealed.  A replaced or disconnected account
-- stays, disabled, so the payments it took still get their webhooks and refunds.
CREATE TABLE {{app}}.stripe_connections (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  secret_key text NOT NULL,
  webhook_secret text NOT NULL,
  live boolean NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX stripe_connection_active ON {{app}}.stripe_connections(org_id) WHERE enabled;

-- The result fields for one currency on one table.  They go with their fields and table.
CREATE TABLE {{app}}.payment_fields (
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  currency text NOT NULL,
  status_field text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  amount_field text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  reference_field text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  choices jsonb NOT NULL,
  PRIMARY KEY(table_id, currency)
);

-- What a form or booking page charges.  The target is a form view or a booking page.
CREATE TABLE {{app}}.payment_pages (
  target_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('form', 'booking')),
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  settings jsonb NOT NULL
);

-- One payment per record.  The history outlives its record, table, database, and the person the
-- page ran as, since refunds and accounting need the amount, currency, state, and Stripe's IDs.
CREATE TABLE {{app}}.payments (
  record_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text REFERENCES {{app}}.databases(id) ON DELETE SET NULL,
  table_id text REFERENCES {{app}}.tables(id) ON DELETE SET NULL,
  owner_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  connection_id text NOT NULL REFERENCES {{app}}.stripe_connections(id) ON DELETE CASCADE,
  target_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('form', 'booking')),
  description text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'paid', 'expired', 'failed', 'refunded')),
  session_id text UNIQUE,
  intent_id text,
  checkout_url text,
  expires_at timestamptz NOT NULL,
  -- A booking visitor's network address, under a keyed hash, so one address holds one place at once
  address_key text,
  booking_mail text,
  mail_claimed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX payment_intent ON {{app}}.payments(connection_id, intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX payments_pending ON {{app}}.payments(target_id, expires_at) WHERE state = 'pending';

-- Each webhook event is applied once.
CREATE TABLE {{app}}.payment_events (
  connection_id text NOT NULL REFERENCES {{app}}.stripe_connections(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  PRIMARY KEY(connection_id, event_id)
);

-- Refused webhooks, counted per connection and hour.  Each closed hour becomes one audit entry.
CREATE TABLE {{app}}.payment_refusals (
  connection_id text NOT NULL REFERENCES {{app}}.stripe_connections(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(connection_id, hour)
);
`,
};

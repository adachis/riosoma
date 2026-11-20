import type { Migration } from '@riosoma/db';

/**
 * Booking pages: a public page, made from a table, where anyone books an open time, and each
 * booking lands as a record.  A page runs as its owner, the person who last saved its settings.
 *
 * `bookings` keeps one row for each booking made through a page: the record it added, the time it
 * took, and a keyed hash of the booker's email address, never the address itself, for the daily
 * limit.  Its ID is what the cancel link signs.  Booking attempts from one address to one page are
 * counted for an hour, keyed by a keyed hash of the address, as public forms do.
 */
export const m0035: Migration = {
  id: '0035_booking_pages',
  sql: `
CREATE TABLE {{app}}.booking_pages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  owner_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  settings jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX booking_pages_table ON {{app}}.booking_pages (table_id);

CREATE TABLE {{app}}.bookings (
  id text PRIMARY KEY,
  page_id text NOT NULL REFERENCES {{app}}.booking_pages(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  resource_id text,
  email_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  canceled_at timestamptz
);
CREATE INDEX bookings_page ON {{app}}.bookings (page_id, starts_at);
CREATE INDEX bookings_email ON {{app}}.bookings (page_id, email_key, created_at);

CREATE TABLE {{app}}.booking_attempts (
  page_id text NOT NULL REFERENCES {{app}}.booking_pages(id) ON DELETE CASCADE,
  address text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX booking_attempts_address ON {{app}}.booking_attempts (page_id, address, at);
`,
};

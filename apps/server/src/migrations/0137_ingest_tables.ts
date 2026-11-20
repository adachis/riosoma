import type { Migration } from '@riosoma/db';

export const m0137: Migration = {
  id: '0137_ingest_tables',
  sql: `
-- A missing earlier migration may arrive later in an existing installation.
DO $$ BEGIN
  IF to_regclass('{{app}}.ingest_tables_org_identity') IS NULL THEN
    CREATE UNIQUE INDEX ingest_storage_tables_org_identity ON {{app}}.tables (org_id, id);
  END IF;
END $$;
ALTER TABLE {{app}}.tables ADD COLUMN ingest jsonb;
-- Retain the counter after removal so an old revision cannot match a new setup.
ALTER TABLE {{app}}.tables ADD COLUMN ingest_revision integer NOT NULL DEFAULT 0 CHECK (ingest_revision >= 0);
ALTER TABLE {{app}}.tables ADD CONSTRAINT ingest_not_joined CHECK (ingest IS NULL OR joined IS NULL);
ALTER TABLE {{app}}.fields ADD COLUMN ingest jsonb;
CREATE UNIQUE INDEX ingest_field_keys ON {{app}}.fields (org_id, table_id, (ingest->>'key')) WHERE ingest IS NOT NULL;
ALTER TABLE {{app}}.changes ADD COLUMN origin jsonb;

-- Both sides of source attachment lock the table, so concurrent setup cannot create both modes.
CREATE FUNCTION {{app}}.ingest_source_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF NEW.ingest IS NOT NULL AND EXISTS (SELECT 1 FROM {{app}}.table_sources WHERE table_id = NEW.id) THEN
      RAISE EXCEPTION 'ingest.tables.exclusive' USING ERRCODE = '23514';
    END IF;
  ELSE
    PERFORM 1 FROM {{app}}.tables WHERE id = NEW.table_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM {{app}}.tables WHERE id = NEW.table_id AND ingest IS NOT NULL) THEN
      RAISE EXCEPTION 'ingest.tables.exclusive' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingest_table_exclusive BEFORE INSERT OR UPDATE OF ingest ON {{app}}.tables
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_source_exclusive();
CREATE TRIGGER ingest_source_exclusive BEFORE INSERT OR UPDATE OF table_id ON {{app}}.table_sources
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_source_exclusive();

CREATE TABLE {{app}}.ingest_senders (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  id text NOT NULL,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('address', 'domain')),
  value text NOT NULL CHECK (value = lower(value)),
  approved boolean NOT NULL DEFAULT false,
  added_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, table_id, id),
  UNIQUE (org_id, table_id, kind, value),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE
);
CREATE TABLE {{app}}.ingest_formats (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'probation', 'live', 'failing')),
  reading text NOT NULL CHECK (reading IN ('layout', 'reader', 'ai')),
  signature jsonb NOT NULL,
  rules jsonb,
  probation_passed integer NOT NULL DEFAULT 0 CHECK (probation_passed >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, table_id, id),
  CHECK ((reading = 'ai') = (rules IS NULL)),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE
);
CREATE TABLE {{app}}.ingest_files (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  id text NOT NULL,
  parent_id text,
  origin text NOT NULL CHECK (origin IN ('drop', 'email', 'part')),
  name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  stored_file text,
  sender_id text,
  dropped_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  seq bigserial NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'held', 'waiting', 'reading', 'read', 'failed', 'skipped', 'removed')),
  hold_reason text,
  format_id text,
  counts jsonb NOT NULL DEFAULT '{"added":0,"updated":0,"identical":0,"flagged":0,"refused":0}',
  notes jsonb NOT NULL DEFAULT '[]',
  checks jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  is_example boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  leased_by text,
  next_attempt_at timestamptz,
  PRIMARY KEY (org_id, table_id, id),
  CHECK ((origin = 'part') = (parent_id IS NOT NULL)),
  CHECK (parent_id IS DISTINCT FROM id),
  CHECK (NOT is_example OR (expires_at IS NULL AND stored_file IS NOT NULL)),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, parent_id) REFERENCES {{app}}.ingest_files (org_id, table_id, id),
  FOREIGN KEY (org_id, table_id, sender_id) REFERENCES {{app}}.ingest_senders (org_id, table_id, id),
  FOREIGN KEY (org_id, table_id, format_id) REFERENCES {{app}}.ingest_formats (org_id, table_id, id)
);
COMMENT ON COLUMN {{app}}.ingest_files.stored_file IS 'File store reference, cleared when the original expires';
COMMENT ON COLUMN {{app}}.ingest_files.expires_at IS 'An example original never expires.  Creating an example clears this column and marks is_example in the same transaction.';
CREATE INDEX ingest_files_next ON {{app}}.ingest_files (org_id, table_id, seq)
  WHERE state IN ('received', 'waiting', 'reading');
CREATE INDEX ingest_files_hash ON {{app}}.ingest_files (org_id, table_id, sha256);
CREATE INDEX ingest_files_expiry ON {{app}}.ingest_files (expires_at)
  WHERE NOT is_example AND expires_at IS NOT NULL AND stored_file IS NOT NULL;

CREATE TABLE {{app}}.ingest_examples (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  id text NOT NULL,
  format_id text NOT NULL,
  file_id text NOT NULL,
  expected jsonb NOT NULL,
  own boolean NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  last_result jsonb,
  PRIMARY KEY (org_id, table_id, id),
  UNIQUE (org_id, table_id, format_id, file_id),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, format_id) REFERENCES {{app}}.ingest_formats (org_id, table_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files (org_id, table_id, id) ON DELETE CASCADE
);
-- The marker lets the expiry index exclude examples without querying another table.
CREATE FUNCTION {{app}}.ingest_keep_example() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE {{app}}.ingest_files SET is_example = true, expires_at = NULL
    WHERE org_id = NEW.org_id AND table_id = NEW.table_id AND id = NEW.file_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ingest_keep_example BEFORE INSERT OR UPDATE OF file_id ON {{app}}.ingest_examples
  FOR EACH ROW EXECUTE FUNCTION {{app}}.ingest_keep_example();

CREATE TABLE {{app}}.ingest_row_state (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL,
  record_id text NOT NULL,
  file_id text NOT NULL,
  identity text CHECK (identity ~ '^[a-f0-9]{64}$'),
  hashes jsonb NOT NULL,
  PRIMARY KEY (org_id, table_id, record_id),
  UNIQUE (org_id, table_id, identity),
  FOREIGN KEY (org_id, table_id) REFERENCES {{app}}.tables (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files (org_id, table_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_row_state_file ON {{app}}.ingest_row_state (org_id, table_id, file_id);

-- Preserve kinds introduced by a later migration when this migration arrives out of order.
DO $$
DECLARE previous text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous FROM pg_constraint
    WHERE conrelid = '{{app}}.notifications'::regclass AND conname = 'notifications_kind_check';
  ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
  EXECUTE 'ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (' || previous ||
    ' OR kind IN (''ingest.question'', ''ingest.file.read'', ''ingest.file.held'', ''ingest.sender.unapproved'', ''ingest.format.needsApproval'', ''ingest.paused''))';
END $$;
`,
};

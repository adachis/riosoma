import type { Migration } from '@riosoma/db';

export const m0046: Migration = {
  id: '0046_signature_requests',
  sql: `
CREATE TABLE {{app}}.signature_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  field_id text NOT NULL,
  source_id text NOT NULL,
  requester_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  original_hash text NOT NULL,
  final_hash text,
  signed_file_id text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completing', 'completed', 'declined', 'canceled', 'failed')),
  expires_at timestamptz NOT NULL,
  input jsonb NOT NULL,
  pages jsonb NOT NULL,
  signers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signature_requests_record ON {{app}}.signature_requests (table_id, record_id);
CREATE INDEX signature_requests_open ON {{app}}.signature_requests (expires_at) WHERE status = 'open';
CREATE INDEX signature_requests_completing ON {{app}}.signature_requests (created_at) WHERE status = 'completing';
CREATE INDEX signature_requests_requester ON {{app}}.signature_requests (requester_id, created_at);
CREATE TABLE {{app}}.signature_history (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL REFERENCES {{app}}.signature_requests(id) ON DELETE CASCADE,
  signer_id text,
  action text NOT NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{app}}.signature_deliveries (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL REFERENCES {{app}}.signature_requests(id) ON DELETE CASCADE,
  signer_id text,
  recipient text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invitation', 'reminder', 'completed', 'failed', 'undelivered')),
  sent_at timestamptz,
  failed_at timestamptz,
  next_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX signature_deliveries_pending ON {{app}}.signature_deliveries (next_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE TABLE {{app}}.signature_attempts (
  key text PRIMARY KEY,
  starts_at timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE FUNCTION {{app}}.cancel_deleted_signature_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request record;
BEGIN
  FOR request IN UPDATE {{app}}.signature_requests SET status = 'canceled'
    WHERE source_id = OLD.id AND status = 'open' RETURNING *
  LOOP
    INSERT INTO {{app}}.signature_history (request_id, action) VALUES (request.id, 'canceled');
    INSERT INTO {{audit}}.events (org_id, actor_id, action, metadata)
      VALUES (request.org_id, request.requester_id, 'signature.canceled',
        jsonb_build_object('requestId', request.id, 'recordId', request.record_id));
  END LOOP;
  RETURN OLD;
END;
$$;
CREATE TRIGGER signature_source_deleted BEFORE DELETE ON {{app}}.files
  FOR EACH ROW EXECUTE FUNCTION {{app}}.cancel_deleted_signature_source();
`,
};

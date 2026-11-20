import type { Migration } from '@riosoma/db';

/** Chain every insert, including writers that do not use the application audit helper */
export const m0066: Migration = {
  id: '0066_admin_roles_audit',
  sql: `
LOCK TABLE {{audit}}.events IN ACCESS EXCLUSIVE MODE;
ALTER TABLE {{audit}}.events ADD COLUMN chain_seq bigint;
ALTER TABLE {{audit}}.events ADD COLUMN prev_hash text;
ALTER TABLE {{audit}}.events ADD COLUMN hash text;

CREATE FUNCTION {{audit}}.event_hash(e {{audit}}.events) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    e.id::text, e.org_id, e.actor_id, e.action, e.target, e.metadata,
    to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.chain_seq::text, e.prev_hash
  )::text, 'UTF8')), 'hex')
$$;

ALTER TABLE {{audit}}.events DISABLE TRIGGER events_no_update;
-- Recover organization identity before hashing system events that have no actor.
-- Conflicting or missing evidence stays unassigned rather than exposing another organization's events.
WITH resources AS (
  SELECT 'databaseId' AS key, id, org_id FROM {{app}}.databases
  UNION SELECT 'snapshotId', id, org_id FROM {{app}}.database_snapshots
  UNION SELECT 'fileId', id, org_id FROM {{app}}.files
  UNION SELECT 'automationId', id, org_id FROM {{app}}.automations
  UNION SELECT 'webhookId', id, org_id FROM {{app}}.webhooks
  UNION SELECT 'reportId', id, org_id FROM {{app}}.report_schedules
  UNION SELECT 'runId', id, org_id FROM {{app}}.report_runs
  UNION
  SELECT reference.key, reference.value, e.org_id
  FROM {{audit}}.events e CROSS JOIN LATERAL jsonb_each_text(e.metadata) reference
  WHERE e.org_id IS NOT NULL AND (
    (reference.key IN ('databaseId', 'snapshotId') AND e.action LIKE 'databases.%') OR
    (reference.key = 'fileId' AND e.action LIKE 'data.file.%') OR
    (reference.key = 'automationId' AND e.action LIKE 'data.automation.%') OR
    (reference.key = 'webhookId' AND e.action LIKE 'data.webhook.%') OR
    (reference.key IN ('reportId', 'runId') AND e.action LIKE 'data.report.%')
  )
), background AS (
  SELECT * FROM {{audit}}.events WHERE org_id IS NULL AND action IN (
    'databases.snapshot.automatic', 'databases.snapshot.expired',
    'data.file.infected', 'data.file.scanUnavailable', 'data.automation.stopped',
    'data.webhook.disabled', 'data.report.sent', 'data.report.stopped', 'data.report.unsubscribed'
  )
), candidates AS (
  SELECT e.id, r.org_id FROM background e
  CROSS JOIN LATERAL jsonb_each_text(e.metadata) reference
  JOIN resources r ON r.key = reference.key AND r.id = reference.value
  UNION ALL
  SELECT e.id, e.metadata ->> 'orgId' FROM background e
  WHERE e.action IN ('data.file.infected', 'data.file.scanUnavailable')
    AND NULLIF(e.metadata ->> 'orgId', '') IS NOT NULL
), attributed AS (
  SELECT id, min(org_id) AS org_id FROM candidates GROUP BY id HAVING count(DISTINCT org_id) = 1
)
UPDATE {{audit}}.events e SET org_id = attributed.org_id FROM attributed WHERE e.id = attributed.id;

DO $$
DECLARE
  entry {{audit}}.events;
  previous_org text;
  previous_hash text;
  position bigint := 0;
BEGIN
  FOR entry IN SELECT * FROM {{audit}}.events ORDER BY org_id NULLS FIRST, id LOOP
    IF position = 0 OR entry.org_id IS DISTINCT FROM previous_org THEN
      previous_hash := NULL;
      position := 0;
    END IF;
    position := position + 1;
    entry.chain_seq := position;
    entry.prev_hash := previous_hash;
    entry.hash := {{audit}}.event_hash(entry);
    UPDATE {{audit}}.events SET chain_seq = entry.chain_seq,
      prev_hash = entry.prev_hash, hash = entry.hash WHERE id = entry.id;
    previous_hash := entry.hash;
    previous_org := entry.org_id;
  END LOOP;
END;
$$;
ALTER TABLE {{audit}}.events ENABLE TRIGGER events_no_update;
ALTER TABLE {{audit}}.events ALTER COLUMN chain_seq SET NOT NULL;
ALTER TABLE {{audit}}.events ALTER COLUMN hash SET NOT NULL;
CREATE UNIQUE INDEX events_org_chain ON {{audit}}.events ((org_id IS NULL), COALESCE(org_id, ''), chain_seq);
CREATE INDEX events_org_sequence ON {{audit}}.events (org_id, chain_seq DESC);

CREATE FUNCTION {{audit}}.chain_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous {{audit}}.events;
BEGIN
  -- Sequence IDs may be allocated before another transaction commits, so chain order is explicit.
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA || ':audit:' || COALESCE(NEW.org_id, ''), 0));
  SELECT * INTO previous FROM {{audit}}.events
    WHERE (org_id IS NULL) = (NEW.org_id IS NULL) AND COALESCE(org_id, '') = COALESCE(NEW.org_id, '')
    ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := COALESCE(previous.chain_seq, 0) + 1;
  NEW.prev_hash := previous.hash;
  NEW.hash := {{audit}}.event_hash(NEW);
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_chain BEFORE INSERT ON {{audit}}.events
  FOR EACH ROW EXECUTE FUNCTION {{audit}}.chain_event();

ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
  'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
  'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged',
  'credentialVaultUnavailable'
));
`,
};

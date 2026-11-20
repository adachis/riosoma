import type { Migration } from '@riosoma/db';

export const m0052: Migration = {
  id: '0052_custom_domains',
  sql: `
-- Hosts an organization serves its public pages on.  A host answers as a custom domain once it's
-- verified, and still does after it loses verification or is removed, since certificates and links
-- for it may still be out there.  Until then it's the main app's, like any other host.  Verified
-- hosts are rechecked daily, and three failed checks in a row take verification away.
CREATE TABLE {{app}}.custom_domains (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  host text NOT NULL CHECK (host = lower(host)),
  challenge text NOT NULL,
  kinds text[] NOT NULL DEFAULT ARRAY['forms', 'views', 'bookings', 'signing'],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  first_verified_at timestamptz,
  checked_at timestamptz,
  failed_checks integer NOT NULL DEFAULT 0 CHECK (failed_checks >= 0),
  removed_at timestamptz,
  CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['forms', 'views', 'bookings', 'signing']),
  -- A verified host is a custom domain for good, which is what the first verification records.
  CHECK (verified_at IS NULL OR first_verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX custom_domains_claim ON {{app}}.custom_domains (host)
  WHERE verified_at IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX custom_domains_org_host ON {{app}}.custom_domains (org_id, host)
  WHERE removed_at IS NULL;
CREATE INDEX custom_domains_host ON {{app}}.custom_domains (host);

-- The owner and Integrations administrators hear when a verified custom domain loses its verification.
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
    'customDomainUnverified'));
`,
};

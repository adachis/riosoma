import type { Migration } from '@riosoma/db';

/**
 * Public sharing: an organization's policy for embedding public pages and for signed public file
 * links, plus where a form's and a booking page's own embed rule and published files live.
 *
 * Embedding now names exact origins, and a list with nothing in it no longer means every site.
 * A rule that relied on either would silently change who may frame the page, so those rules stop
 * here, each one recorded in the audit log with the sites it held.
 */
export const migration: Migration = {
  id: '0077_public_sharing',
  sql: `
ALTER TABLE {{app}}.orgs ADD COLUMN public_sharing jsonb NOT NULL DEFAULT '{}';
ALTER TABLE {{app}}.public_forms ADD COLUMN embed jsonb NOT NULL DEFAULT '{}', ADD COLUMN files text[] NOT NULL DEFAULT '{}';
ALTER TABLE {{app}}.booking_pages ADD COLUMN embed jsonb NOT NULL DEFAULT '{}';

WITH exact_origin(pattern) AS (
  VALUES ('^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*|\\[[0-9a-fA-F:.]+])(:[0-9]{1,5})?$')
), listed AS (
  SELECT link.id, link.org_id, link.view_id,
    CASE WHEN jsonb_typeof(link.settings -> 'embed' -> 'sites') = 'array'
      THEN link.settings -> 'embed' -> 'sites' ELSE '[]'::jsonb END AS sites
  FROM {{app}}.shared_views link
  WHERE link.stopped_at IS NULL
    AND COALESCE(link.settings #>> '{embed,enabled}', 'false') = 'true'
), stale AS (
  SELECT listed.id, listed.org_id, listed.view_id, listed.sites
  FROM listed CROSS JOIN exact_origin
  WHERE jsonb_array_length(listed.sites) = 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(listed.sites) AS site
      WHERE site !~ exact_origin.pattern
        -- A port outside the range is one the old rule let through and the parser refuses.
        OR COALESCE(substring(site FROM ':([0-9]+)$')::numeric > 65535, false)
    )
), reset AS (
  UPDATE {{app}}.shared_views link
  SET settings = jsonb_set(link.settings, '{embed}', '{"enabled": false, "sites": []}'::jsonb),
    updated_at = statement_timestamp()
  FROM stale
  WHERE link.id = stale.id
  RETURNING stale.id, stale.org_id, stale.view_id, stale.sites
)
INSERT INTO {{audit}}.events (org_id, actor_id, action, metadata)
SELECT org_id, NULL, 'publicSharing.embedReset', jsonb_build_object(
  'linkId', id, 'viewId', view_id, 'sites', sites, 'reason', 'exactOriginsOnly')
FROM reset;
`,
};

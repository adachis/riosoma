import type { Migration } from '@riosoma/db';

/**
 * Organizational units.  A unit, its parent, and each person's placement stay inside one
 * organization, and a reference that crossed into another one, which nothing could make before,
 * is cleared rather than stopping the upgrade.  Unit admins hold scoped roles for a unit, each
 * value a unit's policy sets records the level that set it, and provisioning can place people by a
 * mapped directory attribute.  Each session remembers how it was proven, and through which
 * identity provider, so a unit that requires a second step or single sign-on can end the sessions
 * that don't meet it.
 */
export const m0057: Migration = {
  id: '0057_org_units',
  sql: `
UPDATE {{app}}.org_units u SET parent_id = NULL
  WHERE u.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM {{app}}.org_units p WHERE p.id = u.parent_id AND p.org_id = u.org_id);
UPDATE {{app}}.memberships m SET org_unit_id = NULL
  WHERE m.org_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM {{app}}.org_units u WHERE u.id = m.org_unit_id AND u.org_id = m.org_id);
ALTER TABLE {{app}}.org_units ADD CONSTRAINT org_units_org_id_id UNIQUE (org_id, id);
ALTER TABLE {{app}}.org_units DROP CONSTRAINT org_units_parent_id_fkey;
ALTER TABLE {{app}}.org_units ADD CONSTRAINT org_units_parent_org
  FOREIGN KEY (org_id, parent_id) REFERENCES {{app}}.org_units(org_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE {{app}}.org_units ADD COLUMN policy_levels jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{app}}.memberships DROP CONSTRAINT memberships_org_unit_id_fkey;
ALTER TABLE {{app}}.memberships ADD CONSTRAINT memberships_unit_org
  FOREIGN KEY (org_id, org_unit_id) REFERENCES {{app}}.org_units(org_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX memberships_unit ON {{app}}.memberships (org_id, org_unit_id);
CREATE TABLE {{app}}.org_unit_admins (
  org_id text NOT NULL,
  unit_id text NOT NULL,
  user_id text NOT NULL,
  roles text[] NOT NULL CHECK (roles <@ ARRAY['people', 'security', 'data_sources', 'ai', 'integrations', 'audit']::text[]),
  PRIMARY KEY (org_id, unit_id, user_id),
  FOREIGN KEY (org_id, unit_id) REFERENCES {{app}}.org_units(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX org_unit_admins_person ON {{app}}.org_unit_admins (org_id, user_id);
CREATE TABLE {{app}}.scim_unit_mappings (
  org_id text NOT NULL,
  attribute text NOT NULL CHECK (attribute IN ('department', 'division', 'organization', 'costCenter')),
  value text NOT NULL,
  unit_id text NOT NULL,
  PRIMARY KEY (org_id, attribute, value),
  FOREIGN KEY (org_id, unit_id) REFERENCES {{app}}.org_units(org_id, id) ON DELETE CASCADE
);
ALTER TABLE {{app}}.sessions ADD COLUMN second_step_verified boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.sessions ADD COLUMN sso_verified boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.sessions ADD COLUMN sso_provider_id text
  REFERENCES {{app}}.sso_providers(id) ON DELETE SET NULL;
CREATE INDEX sessions_sso_provider ON {{app}}.sessions (sso_provider_id) WHERE sso_provider_id IS NOT NULL;
`,
};

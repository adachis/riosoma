import type { Migration } from '@riosoma/db';

export const m0104: Migration = {
  id: '0104_active_link_junctions',
  sql: `
ALTER TABLE {{app}}.fields ADD COLUMN link_id text REFERENCES {{app}}.links(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
UPDATE {{app}}.fields f SET link_id = (
  SELECT l.id FROM {{app}}.links l
  WHERE (l.left_field_id = f.id AND l.right_table_id = f.options ->> 'linkedTableId'
      AND l.right_field_id IS NOT DISTINCT FROM f.options ->> 'inverseFieldId')
    OR (l.right_field_id = f.id AND l.left_field_id = f.options ->> 'inverseFieldId'
      AND l.left_table_id = f.options ->> 'linkedTableId')
  ORDER BY l.created_at DESC, l.id DESC LIMIT 1
) WHERE f.type IN ('link', 'lineItems');
WITH historical AS (
  SELECT c.database_id, c.seq, (
    SELECT l.id FROM {{app}}.links l
    WHERE l.created_at <= c.at AND (
      (l.left_field_id = c.prev #>> '{field,id}'
        AND l.right_table_id = c.prev #>> '{field,options,linkedTableId}'
        AND l.right_field_id IS NOT DISTINCT FROM c.prev #>> '{field,options,inverseFieldId}')
      OR (l.right_field_id = c.prev #>> '{field,id}'
        AND l.left_field_id = c.prev #>> '{field,options,inverseFieldId}'
        AND l.left_table_id = c.prev #>> '{field,options,linkedTableId}')
    ) ORDER BY l.created_at DESC, l.id DESC LIMIT 1
  ) AS link_id FROM {{app}}.changes c WHERE c.prev #>> '{field,type}' IN ('link', 'lineItems')
) UPDATE {{app}}.changes c SET prev = jsonb_set(c.prev, '{field,linkId}', to_jsonb(h.link_id))
FROM historical h WHERE c.database_id = h.database_id AND c.seq = h.seq AND h.link_id IS NOT NULL;
`,
};

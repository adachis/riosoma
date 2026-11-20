import type { Migration } from '@riosoma/db';

/**
 * Gives every link field its other side.  A link made inside `table.create` used to be stored
 * without one: no field on the linked table, no pair in `links`, and no junction, so it could hold
 * no links and every write to it failed.  Each such link now gets what `field.create` would have
 * made: a link field on the linked table named after the link's table, the pair, and an empty
 * junction.  The new field starts in the trash when the link is in the trash, so the two come back
 * together.  A link whose linked table is gone, or in another database, is left alone.
 */
export const m0034: Migration = {
  id: '0034_link_inverses',
  sql: `
DO $$
DECLARE
  link record;
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  inverse_id text;
  pair_id text;
  base text;
  candidate text;
  suffix text;
  n integer;
  inverse_options jsonb;
BEGIN
  FOR link IN
    SELECT f.id, f.org_id, f.table_id, f.options, f.created_by, f.trashed_at, f.trashed_by,
      t.name AS table_name, linked.id AS linked_table_id
    FROM {{app}}.fields f
    JOIN {{app}}.tables t ON t.id = f.table_id
    JOIN {{app}}.tables linked ON linked.id = f.options ->> 'linkedTableId'
      AND linked.database_id = t.database_id AND linked.org_id = t.org_id
    WHERE f.type = 'link'
      AND NOT EXISTS (
        SELECT 1 FROM {{app}}.links l WHERE l.left_field_id = f.id OR l.right_field_id = f.id)
      AND to_regclass('{{data}}.' || quote_ident(t.id)) IS NOT NULL
      AND to_regclass('{{data}}.' || quote_ident(linked.id)) IS NOT NULL
    ORDER BY f.created_at, f.id
  LOOP
    -- IDs the way the app makes them: a prefix and 14 base-62 characters.
    LOOP
      SELECT 'fld' || string_agg(substr(alphabet, 1 + floor(random() * 62)::integer, 1), '')
        INTO inverse_id FROM generate_series(1, 14);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM {{app}}.fields WHERE id = inverse_id);
    END LOOP;
    LOOP
      SELECT 'fld' || string_agg(substr(alphabet, 1 + floor(random() * 62)::integer, 1), '')
        INTO pair_id FROM generate_series(1, 14);
      EXIT WHEN pair_id <> inverse_id AND NOT EXISTS (SELECT 1 FROM {{app}}.links WHERE id = pair_id);
    END LOOP;
    -- Named after the link's table, with a number when the linked table already has that name.
    base := left(link.table_name, 255);
    candidate := base;
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM {{app}}.fields WHERE table_id = link.linked_table_id
        AND lower(name) = lower(candidate) AND trashed_at IS NULL
    ) LOOP
      suffix := ' (' || n || ')';
      candidate := left(base, 255 - length(suffix)) || suffix;
      n := n + 1;
    END LOOP;
    inverse_options := jsonb_build_object(
      'linkedTableId', link.table_id, 'inverseFieldId', link.id, 'prefersSingle', false);
    IF link.options ? 'match' THEN
      inverse_options := inverse_options || jsonb_build_object('match', jsonb_build_object(
        'fieldId', link.options -> 'match' ->> 'linkedFieldId',
        'linkedFieldId', link.options -> 'match' ->> 'fieldId'));
    END IF;
    INSERT INTO {{app}}.fields
      (id, org_id, table_id, name, description, type, options, column_name, position, created_by,
       trashed_at, trashed_by)
    VALUES (inverse_id, link.org_id, link.linked_table_id, candidate, '', 'link', inverse_options,
      inverse_id,
      (SELECT COALESCE(max(position), -1) + 1 FROM {{app}}.fields WHERE table_id = link.linked_table_id),
      link.created_by, link.trashed_at, link.trashed_by);
    UPDATE {{app}}.fields
      SET options = options || jsonb_build_object('inverseFieldId', inverse_id), updated_at = now()
      WHERE id = link.id;
    INSERT INTO {{app}}.links (id, org_id, left_table_id, left_field_id, right_table_id, right_field_id)
      VALUES (pair_id, link.org_id, link.table_id, link.id, link.linked_table_id, inverse_id);
    EXECUTE format(
      'CREATE TABLE {{data}}.%I (
        left_rid bigint NOT NULL REFERENCES {{data}}.%I (__rid) ON DELETE CASCADE,
        right_rid bigint NOT NULL REFERENCES {{data}}.%I (__rid) ON DELETE CASCADE,
        left_pos double precision NOT NULL, right_pos double precision NOT NULL,
        PRIMARY KEY (left_rid, right_rid))',
      'lnk_' || pair_id, link.table_id, link.linked_table_id);
    EXECUTE format('CREATE INDEX %I ON {{data}}.%I (right_rid)', 'lnk_' || pair_id || '_right', 'lnk_' || pair_id);
    UPDATE {{app}}.tables SET data_version = data_version + 1
      WHERE id IN (link.table_id, link.linked_table_id);
  END LOOP;
END $$;
`,
};

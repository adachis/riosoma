import type { Migration } from '@riosoma/db';

export const m0080: Migration = {
  id: '0080_select_sources',
  sql: `
CREATE FUNCTION {{data}}.source_choice_id(record_id text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
DECLARE
  digest bytea := sha256(convert_to(record_id, 'UTF8'));
  value numeric := 0;
  alphabet text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  suffix text := '';
BEGIN
  FOR i IN 0..10 LOOP
    value := value * 256 + get_byte(digest, i);
  END LOOP;
  FOR i IN 1..14 LOOP
    suffix := substr(alphabet, mod(value, 62)::integer + 1, 1) || suffix;
    value := div(value, 62);
  END LOOP;
  RETURN 'cho' || suffix;
END
$fn$;
DO $block$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.oid = '{{data}}'::regnamespace AND c.relkind = 'r' AND c.relname ~ '^tbl[0-9A-Za-z]{14}$'
      AND c.relname IN (SELECT options #>> '{source,tableId}' FROM {{app}}.fields
        WHERE type IN ('singleSelect', 'multipleSelect') AND options ? 'source')
  LOOP
    EXECUTE format('CREATE INDEX %I ON {{data}}.%I ({{data}}.source_choice_id(__id))', item.relname || '_choice', item.relname);
  END LOOP;
END
$block$;
`,
};

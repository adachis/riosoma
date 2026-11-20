import type { Migration } from '@riosoma/db';

export const m0133: Migration = {
  id: '0133_notification_kinds',
  sql: `
DO $migration$
DECLARE
  original text;
  definition text;
  notification_kind text;
  allowed boolean;
BEGIN
  LOCK TABLE {{app}}.notifications IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT original
    FROM pg_constraint
    WHERE conrelid = '{{app}}.notifications'::regclass AND conname = 'notifications_kind_check';
  definition := original;
  -- A missing lower-numbered migration can arrive after newer ones.  Preserve the current
  -- expression, and add only missing kinds, so this migration cannot remove a newer kind.
  FOREACH notification_kind IN ARRAY ARRAY['calendarEventKept', 'vaultUnavailable', 'automationNotification']
  LOOP
    EXECUTE format('SELECT %s FROM (SELECT %L::text AS kind) AS candidate', definition, notification_kind)
      INTO allowed;
    IF allowed IS NOT TRUE THEN
      definition := format('(%s) OR kind = %L::text', definition, notification_kind);
    END IF;
  END LOOP;
  IF definition IS DISTINCT FROM original THEN
    ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
    EXECUTE format('ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (%s)', definition);
  END IF;
END
$migration$;
`,
};

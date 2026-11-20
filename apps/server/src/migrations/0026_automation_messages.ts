import type { Migration } from '@riosoma/db';

export const m0026: Migration = {
  id: '0026_automation_messages',
  sql: `
ALTER TABLE {{app}}.automations ADD COLUMN messaging_secrets jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{app}}.orgs ADD COLUMN automation_sms_enabled boolean NOT NULL DEFAULT false;
`,
};

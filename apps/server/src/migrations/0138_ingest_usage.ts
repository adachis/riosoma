import type { Migration } from '@riosoma/db';

export const m0138: Migration = {
  id: '0138_ingest_usage',
  sql: `
ALTER TABLE {{app}}.ai_usage DROP CONSTRAINT ai_usage_feature_check;
ALTER TABLE {{app}}.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('rio', 'aiFields', 'diagnose', 'routines', 'embedding', 'search', 'automations', 'ingest'));
`,
};

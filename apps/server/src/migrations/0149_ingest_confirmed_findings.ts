import type { Migration } from '@riosoma/db';

export const m0149: Migration = {
  id: '0149_ingest_confirmed_findings',
  sql: `
ALTER TABLE {{app}}.ingest_examples ADD COLUMN confirmed_findings jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(confirmed_findings) = 'array');
`,
};

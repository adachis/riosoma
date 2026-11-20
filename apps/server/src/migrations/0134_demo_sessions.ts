import type { Migration } from '@riosoma/db';

export const m0134: Migration = {
  id: '0134_demo_sessions',
  sql: `
ALTER TABLE {{app}}.sessions ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.sessions ADD COLUMN demo_address text;
CREATE INDEX sessions_demo_capacity ON {{app}}.sessions (demo_address, expires_at)
  WHERE demo AND revoked_at IS NULL;
`,
};

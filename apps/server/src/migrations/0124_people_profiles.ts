import type { Migration } from '@riosoma/db';

export const m0124: Migration = {
  id: '0124_people_profiles',
  sql: `
ALTER TABLE {{app}}.users ADD COLUMN profile_picture jsonb;
ALTER TABLE {{app}}.users ADD COLUMN automation_access_retained boolean NOT NULL DEFAULT false;
`,
};

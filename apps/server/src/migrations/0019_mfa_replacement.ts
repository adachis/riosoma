import type { Migration } from '@riosoma/db';

/**
 * Replacing an authenticator app, as when someone moves to a new phone.  The app that's on keeps
 * working while its replacement waits beside it, sealed the same way, until a code from the new
 * app and a fresh second step turn the replacement on.
 */
export const m0019: Migration = {
  id: '0019_mfa_replacement',
  sql: `
ALTER TABLE {{app}}.authenticator_secrets
  ADD COLUMN replacement_sealed_secret text,
  ADD COLUMN replacement_created_at timestamptz;
`,
};

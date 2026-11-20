import type { Migration } from '@riosoma/db';

export const m0093: Migration = {
  id: '0093_file_scanner',
  sql: `
ALTER TABLE {{app}}.files DROP CONSTRAINT files_scan_state_check;
ALTER TABLE {{app}}.files ADD CONSTRAINT files_scan_state_check CHECK
  (scan_state IN ('clean', 'quarantined', 'infected', 'unavailable', 'too_large', 'too_large_allowed'));
`,
};

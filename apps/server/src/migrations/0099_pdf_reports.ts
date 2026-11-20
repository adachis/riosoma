import type { Migration } from '@riosoma/db';

/** The persisted schedule format setting must accept PDF alongside the existing formats. */
export const m0099: Migration = {
  id: '0099_pdf_reports',
  sql: `
ALTER TABLE {{app}}.report_schedules DROP CONSTRAINT report_schedules_format_check;
ALTER TABLE {{app}}.report_schedules ADD CONSTRAINT report_schedules_format_check
  CHECK (format IN ('csv', 'xlsx', 'docx', 'pptx', 'pdf', 'none'));
`,
};

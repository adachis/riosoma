import type { Migration } from '@riosoma/db';

/** Scheduled reports can attach a Word document or a PowerPoint deck as well as CSV and Excel. */
export const m0036: Migration = {
  id: '0036_office_report_formats',
  sql: `
ALTER TABLE {{app}}.report_schedules DROP CONSTRAINT report_schedules_format_check;
ALTER TABLE {{app}}.report_schedules ADD CONSTRAINT report_schedules_format_check
  CHECK (format IN ('csv', 'xlsx', 'docx', 'pptx', 'none'));
`,
};

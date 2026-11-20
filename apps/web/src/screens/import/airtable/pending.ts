/**
 * Databases whose Airtable import report should open with them: the import dialog marks a
 * database just before it opens it, and the database screen shows the report and clears the mark.
 * Nothing is kept past the page, since the report is always a click away in the database's menu.
 */
const pending = new Set<string>();

export function showReportWhenOpened(databaseId: string): void {
  pending.add(databaseId);
}

export function reportPending(databaseId: string): boolean {
  return pending.has(databaseId);
}

export function clearPendingReport(databaseId: string): void {
  pending.delete(databaseId);
}

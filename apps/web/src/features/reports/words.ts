import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { ReportDeliveryState, ReportFormat, ReportFrequency, ReportRunState } from '@riosoma/contracts';

/** The view menu's item, shared by the view tabs and the toolbar's overflow. */
export const reportsMenu = msg({ id: 'reports.menu', message: 'Scheduled reports' });

/** A time of day, `HH:MM`, as the reader's language writes one. */
export function timeLabel(at: string, locale: string): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, 1, hours, minutes),
  );
}

/** A weekday's name, with 0 for Sunday as the contract counts. */
export function weekdayLabel(day: number, locale: string, width: 'long' | 'short' = 'long'): string {
  // The first of January 2023 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(
    Date.UTC(2023, 0, 1 + day),
  );
}

/** Words for the parts of a report: how often it goes, its file, and how its runs went. */
export function useReportWords() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';

  function frequency(value: ReportFrequency): string {
    const time = timeLabel(value.at, locale);
    switch (value.kind) {
      case 'daily':
        return t({ id: 'reports.frequency.daily', message: `Every day at ${time}` });
      case 'weekly': {
        const days = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
          value.days.map((day) => weekdayLabel(day, locale)),
        );
        return t({ id: 'reports.frequency.weekly', message: `Every ${days} at ${time}` });
      }
      case 'monthly': {
        const day = value.day;
        return t({ id: 'reports.frequency.monthly', message: `Monthly on day ${day} at ${time}` });
      }
    }
  }

  const formats: Record<ReportFormat, string> = {
    xlsx: t({ id: 'reports.format.xlsx', message: 'Excel workbook' }),
    csv: t({ id: 'reports.format.csv', message: 'CSV file' }),
    docx: t({ id: 'reports.format.docx', message: 'Word document' }),
    pptx: t({ id: 'reports.format.pptx', message: 'PowerPoint deck' }),
    pdf: t({ id: 'reports.format.pdf', message: 'PDF document' }),
    none: t({ id: 'reports.format.none', message: 'Summary only' }),
  };

  const runStates: Record<ReportRunState, string> = {
    queued: t({ id: 'reports.run.state.queued', message: 'Waiting to send' }),
    running: t({ id: 'reports.run.state.running', message: 'Sending' }),
    retrying: t({ id: 'reports.run.state.retrying', message: 'Trying again soon' }),
    sent: t({ id: 'reports.run.state.sent', message: 'Sent' }),
    partial: t({ id: 'reports.run.state.partial', message: 'Sent to some' }),
    failed: t({ id: 'reports.run.state.failed', message: 'Failed' }),
    skipped: t({ id: 'reports.run.state.skipped', message: 'Not sent' }),
  };

  const deliveryStates: Record<ReportDeliveryState, string> = {
    pending: t({ id: 'reports.delivery.state.pending', message: 'Waiting' }),
    sent: t({ id: 'reports.delivery.state.sent', message: 'Sent' }),
    failed: t({ id: 'reports.delivery.state.failed', message: 'Failed' }),
    skipped: t({ id: 'reports.delivery.state.skipped', message: 'Not sent' }),
  };

  /** A moment in the schedule's own time zone, the one its times are chosen in. */
  function moment(iso: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
      new Date(iso),
    );
  }

  return { locale, frequency, formats, runStates, deliveryStates, moment };
}

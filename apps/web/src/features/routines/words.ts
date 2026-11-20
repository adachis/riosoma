import { useLingui } from '@lingui/react/macro';
import type {
  RoutineApprovalStatus,
  RoutinePlan,
  RoutineRun,
  RoutineRunState,
  RoutineSchedule,
} from '@riosoma/contracts';
import { timeLabel, weekdayLabel } from '../reports/words';

/** Words for the parts of a routine: its schedule, how its runs went, and what waits. */
export function useRoutineWords() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';

  function schedule(value: RoutineSchedule): string {
    switch (value.kind) {
      case 'hourly':
        return t({ id: 'routines.schedule.hourly', message: 'Every hour, on the hour' });
      case 'daily': {
        const time = timeLabel(value.at, locale);
        return t({ id: 'routines.schedule.daily', message: `Every day at ${time}` });
      }
      case 'weekly': {
        const time = timeLabel(value.at, locale);
        const days = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
          value.days.map((day) => weekdayLabel(day, locale)),
        );
        return t({ id: 'routines.schedule.weekly', message: `Every ${days} at ${time}` });
      }
      case 'monthly': {
        const time = timeLabel(value.at, locale);
        const day = value.day;
        return t({ id: 'routines.schedule.monthly', message: `Monthly on day ${day} at ${time}` });
      }
    }
  }

  const runStates: Record<RoutineRunState, string> = {
    queued: t({ id: 'routines.run.state.queued', message: 'Waiting to run' }),
    running: t({ id: 'routines.run.state.running', message: 'Running' }),
    done: t({ id: 'routines.run.state.done', message: 'Finished' }),
    stopped: t({ id: 'routines.run.state.stopped', message: 'Stopped at a limit' }),
    failed: t({ id: 'routines.run.state.failed', message: 'Failed' }),
    skipped: t({ id: 'routines.run.state.skipped', message: 'Skipped' }),
  };

  const triggers: Record<RoutineRun['trigger'], string> = {
    schedule: t({ id: 'routines.run.trigger.schedule', message: 'On schedule' }),
    manual: t({ id: 'routines.run.trigger.manual', message: 'Run by hand' }),
    revision: t({ id: 'routines.run.trigger.revision', message: 'Prepared again with your note' }),
  };

  const approvalStates: Record<RoutineApprovalStatus, string> = {
    pending: t({ id: 'routines.approval.state.pending', message: 'Waiting for you' }),
    approved: t({ id: 'routines.approval.state.approved', message: 'Approved' }),
    skipped: t({ id: 'routines.approval.state.skipped', message: 'Skipped' }),
    changed: t({ id: 'routines.approval.state.changed', message: 'Sent back with a change' }),
    failed: t({ id: 'routines.approval.state.failed', message: 'Couldn’t be done' }),
    expired: t({ id: 'routines.approval.state.expired', message: 'Expired' }),
  };

  /** A moment in the routine's own time zone, the one its schedule is chosen in. */
  function moment(iso: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
      new Date(iso),
    );
  }

  function money(amount: number): string {
    return i18n.number(amount, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  }

  function tokens(count: number): string {
    return i18n.number(count);
  }

  /** A recipient as the owner reads it: themselves, or an address. */
  function recipient(entry: string, ownerEmail?: string): string {
    return entry === 'owner' || (ownerEmail && entry.toLowerCase() === ownerEmail.toLowerCase())
      ? t({ id: 'routines.recipient.you', message: 'you' })
      : entry;
  }

  function list(items: readonly string[]): string {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  }

  /** The fields a plan reads pages from, each with its table: "Website in Leads, and Site in Accounts" */
  function pageSources(
    plan: RoutinePlan,
    tableNames: Readonly<Record<string, string>>,
    fieldNames: Readonly<Record<string, string>>,
  ): string {
    return list(
      plan.fetches.map((fetch) => {
        const field = fieldNames[fetch.fieldId] ?? fetch.fieldId;
        const table = tableNames[fetch.tableId] ?? fetch.tableId;
        return t({ id: 'routines.plan.pageSource', message: `${field} in ${table}` });
      }),
    );
  }

  return {
    locale,
    schedule,
    runStates,
    triggers,
    approvalStates,
    moment,
    money,
    tokens,
    recipient,
    list,
    pageSources,
  };
}

/** Where a routine's page is: `/<databaseId>/routines/<routineId>`. */
export function routineHref(databaseId: string, routineId: string): string {
  return `/${encodeURIComponent(databaseId)}/routines/${encodeURIComponent(routineId)}`;
}

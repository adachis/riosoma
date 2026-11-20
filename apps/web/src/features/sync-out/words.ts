import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { faTableCells, faTableList } from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@riosoma/icons';
import type {
  DestinationKind,
  SyncOutInterval,
  SyncOutRunOutcome,
  SyncOutStats,
  SyncOutTrigger,
} from '@riosoma/contracts';

/** The toolbar control's label and the dialog's title.  Shared so both read alike. */
export const syncOutLabel = msg({ id: 'syncOut.title', message: 'Sync out' });

/** Where a token is made.  Declared here so this feature's chunk never pulls in the import dialog. */
export const AIRTABLE_TOKEN_URL = 'https://airtable.com/create/tokens';

/** Each destination's icon.  SQL kinds join this map when they arrive. */
export const KIND_ICONS: Record<DestinationKind, IconDefinition> = {
  airtable: faTableList,
  smartsheet: faTableCells,
};

/**
 * The outside column type labels, by the service's own type name.  A type the map has no entry for
 * shows the service's own name, which is still readable.
 */
const COLUMN_TYPE_IDS: Record<string, { id: string; message: string }> = {
  singleLineText: { id: 'syncOut.type.text', message: 'Text' },
  multilineText: { id: 'syncOut.type.longText', message: 'Long text' },
  richText: { id: 'syncOut.type.longText', message: 'Long text' },
  TEXT_NUMBER: { id: 'syncOut.type.textNumber', message: 'Text or number' },
  number: { id: 'syncOut.type.number', message: 'Number' },
  currency: { id: 'syncOut.type.currency', message: 'Currency' },
  percent: { id: 'syncOut.type.percent', message: 'Percent' },
  checkbox: { id: 'syncOut.type.checkbox', message: 'Checkbox' },
  CHECKBOX: { id: 'syncOut.type.checkbox', message: 'Checkbox' },
  date: { id: 'syncOut.type.date', message: 'Date' },
  DATE: { id: 'syncOut.type.date', message: 'Date' },
  dateTime: { id: 'syncOut.type.dateTime', message: 'Date and time' },
  singleSelect: { id: 'syncOut.type.singleSelect', message: 'Single select' },
  multipleSelects: { id: 'syncOut.type.multipleSelect', message: 'Multiple select' },
  PICKLIST: { id: 'syncOut.type.dropdown', message: 'Dropdown' },
  MULTI_PICKLIST: { id: 'syncOut.type.multiDropdown', message: 'Multi-select dropdown' },
  email: { id: 'syncOut.type.email', message: 'Email' },
  url: { id: 'syncOut.type.url', message: 'Link' },
  phoneNumber: { id: 'syncOut.type.phone', message: 'Phone' },
  duration: { id: 'syncOut.type.duration', message: 'Duration' },
  rating: { id: 'syncOut.type.rating', message: 'Rating' },
};

/** Words for the parts of a sync: when it next runs, its schedule, its counts, and how a run went. */
export function useSyncOutWords() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';

  /** A future moment, the way reports show "Next goes": a medium date and a short time. */
  function moment(iso: string): string {
    return i18n.date(iso, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function interval(value: SyncOutInterval | null): string {
    switch (value) {
      case 15:
        return t({ id: 'syncOut.every.15', message: 'Every 15 minutes' });
      case 60:
        return t({ id: 'syncOut.every.60', message: 'Every hour' });
      case 1440:
        return t({ id: 'syncOut.every.1440', message: 'Every day' });
      default:
        return t({ id: 'syncOut.every.manual', message: 'Only when asked' });
    }
  }

  /** The last run's counts in plain words.  Shows the "not sent" clause only when a row failed. */
  function counts(stats: SyncOutStats): string {
    const { created, updated, removed, unchanged, failed } = stats;
    return failed > 0
      ? t({
          id: 'syncOut.counts.failed',
          message: `${created} added, ${updated} updated, ${removed} removed, ${unchanged} unchanged, and ${failed} not sent`,
        })
      : t({
          id: 'syncOut.counts.clean',
          message: `${created} added, ${updated} updated, ${removed} removed, and ${unchanged} unchanged`,
        });
  }

  const outcomes: Record<SyncOutRunOutcome, string> = {
    running: t({ id: 'syncOut.run.outcome.running', message: 'Running' }),
    succeeded: t({ id: 'syncOut.run.outcome.succeeded', message: 'Completed' }),
    partial: t({ id: 'syncOut.run.outcome.partial', message: 'Completed with problems' }),
    failed: t({ id: 'syncOut.run.outcome.failed', message: 'Failed' }),
    stopped: t({ id: 'syncOut.run.outcome.stopped', message: 'Stopped' }),
    canceled: t({ id: 'syncOut.run.outcome.canceled', message: 'Canceled' }),
  };

  function trigger(value: SyncOutTrigger, actorName: string | null): string {
    switch (value) {
      case 'setup':
        return t({ id: 'syncOut.run.trigger.setup', message: 'First sync' });
      case 'manual':
        return actorName
          ? t({ id: 'syncOut.run.trigger.manual', message: `Started by ${actorName}` })
          : t({ id: 'syncOut.run.trigger.manualUnknown', message: 'Started by hand' });
      case 'schedule':
        return t({ id: 'syncOut.run.trigger.schedule', message: 'On schedule' });
    }
  }

  /** The outside column type's label, or its own service name when the map has none. */
  function columnType(serviceType: string): string {
    const entry = COLUMN_TYPE_IDS[serviceType];
    return entry ? i18n._({ id: entry.id, message: entry.message }) : serviceType;
  }

  /** The type line under a preview column: the plain type, or that it is sent as text. */
  function columnTypeLine(serviceType: string, write: 'typed' | 'text' | null): string {
    const type = columnType(serviceType);
    return write === 'text' ? t({ id: 'syncOut.columns.asText', message: `${type}, sent as text` }) : type;
  }

  return { locale, moment, interval, counts, outcomes, trigger, columnType, columnTypeLine };
}

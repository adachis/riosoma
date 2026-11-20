import { useLingui } from '@lingui/react/macro';
import type { WebhookEventType } from '@riosoma/contracts';

/** Plain words for each event.  The list and the form both show these, so one hook keeps them in step. */
export function useEventLabels(): Record<WebhookEventType, string> {
  const { t } = useLingui();
  return {
    'record.created': t({ id: 'webhooks.event.recordCreated', message: 'Records created' }),
    'record.updated': t({ id: 'webhooks.event.recordUpdated', message: 'Records updated' }),
    'record.deleted': t({ id: 'webhooks.event.recordDeleted', message: 'Records deleted' }),
    'field.changed': t({ id: 'webhooks.event.fieldChanged', message: 'Fields changed' }),
    'table.changed': t({ id: 'webhooks.event.tableChanged', message: 'Tables changed' }),
  };
}

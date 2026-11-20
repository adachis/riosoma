import type {
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveriesPage,
  WebhookDelivery,
  WebhookList,
  WebhookMeta,
  WebhookSecret,
  WebhookUpdate,
} from '@riosoma/contracts';
import { api } from '../../../api';
import { isDemoSession } from '../../../demo';

/** The app's own webhook routes, the same the REST API offers under `/api/v1`. */
function base(databaseId: string, webhookId?: string): string {
  const root = `/api/databases/${encodeURIComponent(databaseId)}/webhooks`;
  return webhookId === undefined ? root : `${root}/${encodeURIComponent(webhookId)}`;
}

export const webhooksKey = (databaseId: string) => ['databases', databaseId, 'webhooks'] as const;
export const deliveriesKey = (databaseId: string, webhookId: string) =>
  [...webhooksKey(databaseId), webhookId, 'deliveries'] as const;

export const listWebhooks = async (databaseId: string, signal?: AbortSignal): Promise<WebhookList> =>
  isDemoSession() ? { webhooks: [] } : api<WebhookList>(base(databaseId), { ...(signal ? { signal } : {}) });

export const createWebhook = (databaseId: string, body: WebhookCreate) =>
  api<WebhookCreated>(base(databaseId), { body });

export const updateWebhook = (databaseId: string, webhookId: string, body: WebhookUpdate) =>
  api<WebhookMeta>(base(databaseId, webhookId), { method: 'PATCH', body });

export const deleteWebhook = (databaseId: string, webhookId: string) =>
  api<void>(base(databaseId, webhookId), { method: 'DELETE' });

export const replaceSecret = (databaseId: string, webhookId: string) =>
  api<WebhookSecret>(`${base(databaseId, webhookId)}/secret`, { method: 'POST' });

export const listDeliveries = (databaseId: string, webhookId: string, cursor: string, signal?: AbortSignal) =>
  api<WebhookDeliveriesPage>(
    `${base(databaseId, webhookId)}/deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { ...(signal ? { signal } : {}) },
  );

export const redeliver = (databaseId: string, webhookId: string, deliveryId: string) =>
  api<WebhookDelivery>(
    `${base(databaseId, webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
    { method: 'POST' },
  );

import { notificationPath, type Notification, type NotificationKind } from '@riosoma/contracts';
import type { MailMessage } from '../mail/index.js';
import { NOTIFICATION_COPY } from '../reports/email.js';
import { formatMessage } from '../reports/messages.js';
import type { PushPayload } from './push.js';

type MessageKey = keyof typeof NOTIFICATION_COPY;
/** Fails to compile when a notification kind has no name in the catalog. */
export const KIND_COPY: Record<`notifications.kind.${NotificationKind}`, { id: string }> = NOTIFICATION_COPY;
const catalogs: Record<string, Partial<Record<MessageKey, string>>> = {};
export function notificationMessage(
  locale: string,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const template = catalogs[locale]?.[key] ?? NOTIFICATION_COPY[key].message;
  return formatMessage(template, values, { locale, html: false });
}
export function privatePayload(
  notification: Pick<Notification, 'kind' | 'target'>,
  locale: string,
  base: string,
): PushPayload {
  const path = notificationPath(notification);
  return {
    title: notificationMessage(locale, 'notifications.delivery.title'),
    body: notificationMessage(locale, `notifications.kind.${notification.kind}`),
    url: path.startsWith('/') ? `${base.replace(/\/+$/, '')}${path}` : path,
  };
}
export function digestEmail(
  notifications: Notification[],
  to: string,
  locale: string,
  base: string,
): MailMessage {
  const groups = new Map<NotificationKind, Notification[]>();
  for (const notification of notifications)
    groups.set(notification.kind, [...(groups.get(notification.kind) ?? []), notification]);
  const lines = [notificationMessage(locale, 'notifications.digest.summary')];
  for (const [kind, items] of groups) {
    lines.push(
      notificationMessage(locale, 'notifications.digest.group', {
        kind: notificationMessage(locale, `notifications.kind.${kind}`),
        count: items.length,
      }),
    );
    lines.push(...new Set(items.map((item) => privatePayload(item, locale, base).url)));
  }
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = lines
    .map(
      (line) =>
        `<p>${line.startsWith(base) ? `<a href="${escape(line)}">${escape(line)}</a>` : escape(line)}</p>`,
    )
    .join('');
  return {
    to,
    subject: notificationMessage(locale, 'notifications.digest.title'),
    text: lines.join('\n\n'),
    html,
  };
}

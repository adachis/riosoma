import { useId, type MouseEvent, type UIEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { notificationPath, type Notification } from '@riosoma/contracts';
import { Button, Heading, Spinner } from '@riosoma/ui';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { NotificationItem } from './NotificationItem';
import { listQuery, markRead } from './queries';
import { anchor } from '../../demos/anchors';
import './notifications.css';

const LOAD_AHEAD = 96;

export function NotificationList({ title, onLeave }: { title: string; onLeave: () => void }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const navigate = useNavigate();
  // Mounting with the popover asks again, so opening the bell always shows what's new.
  const list = useInfiniteQuery(listQuery);
  const notifications = list.data?.pages.flatMap((page) => page.notifications) ?? [];
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = notifications.filter(
    (notification) => Date.parse(notification.createdAt) >= midnight.getTime(),
  );
  const earlier = notifications.filter(
    (notification) => Date.parse(notification.createdAt) < midnight.getTime(),
  );
  const anyUnread = notifications.some((notification) => !notification.readAt);

  function open(notification: Notification, event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>): void {
    if (!notification.readAt) void markRead(client, { ids: [notification.id] });
    // A new tab or window is the browser's to open.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const path = notificationPath(notification);
    if (!path) return;
    onLeave();
    if (/^https?:/.test(path)) window.location.assign(path);
    else void navigate({ to: path });
  }

  function scrolled(event: UIEvent<HTMLDivElement>): void {
    const box = event.currentTarget;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - LOAD_AHEAD) return;
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }

  return (
    <>
      <div className="rio-notifications__header">
        <Heading level={2} className="rio-notifications__title">
          {title}
        </Heading>
        <Button
          variant="quiet"
          size="sm"
          isDisabled={!anyUnread}
          onPress={() => void markRead(client, { all: true })}
          {...anchor('notifications.read')}
        >
          {t({ id: 'notifications.markAllRead', message: 'Mark all as read' })}
        </Button>
      </div>
      <div className="rio-notifications__scroller" onScroll={scrolled} {...anchor('notifications.list')}>
        {list.isPending ? (
          <div className="rio-notifications__status">
            <Spinner label={t({ id: 'notifications.loading', message: 'Loading notifications' })} />
          </div>
        ) : list.isError && !notifications.length ? (
          <div className="rio-notifications__status">
            <p role="alert">
              {message(list.error instanceof ApiError ? list.error.info.messageKey : 'errors.internal')}
            </p>
            <Button size="sm" onPress={() => void list.refetch()}>
              {t({ id: 'notifications.retry', message: 'Try again' })}
            </Button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="rio-notifications__empty">
            <p className="rio-notifications__empty-title">
              {t({ id: 'notifications.empty.title', message: 'You’re all caught up' })}
            </p>
            <p className="rio-notifications__empty-body">
              {t({
                id: 'notifications.empty.body',
                message:
                  'Mentions, shares, and news about your automations and synced tables will show up here.',
              })}
            </p>
          </div>
        ) : (
          <>
            <Section
              title={t({ id: 'notifications.today', message: 'Today' })}
              notifications={today}
              onOpen={open}
            />
            <Section
              title={t({ id: 'notifications.earlier', message: 'Earlier' })}
              notifications={earlier}
              onOpen={open}
            />
            {list.isFetchingNextPage ? (
              <div className="rio-notifications__status">
                <Spinner size="sm" label={t({ id: 'notifications.loadingMore', message: 'Loading more' })} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Section({
  title,
  notifications,
  onOpen,
}: {
  title: string;
  notifications: readonly Notification[];
  onOpen: (notification: Notification, event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => void;
}) {
  const id = useId();
  if (!notifications.length) return null;
  return (
    <section className="rio-notifications__section" aria-labelledby={id}>
      <h3 id={id} className="rio-notifications__section-title">
        {title}
      </h3>
      <ul className="rio-notifications__items">
        {notifications.map((notification) => (
          <li key={notification.id}>
            <NotificationItem notification={notification} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useEffect } from 'react';
import {
  infiniteQueryOptions,
  queryOptions,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  NotificationChannelPreferences,
  MarkNotificationsRead,
  NotificationPreferences,
  NotificationsPage,
  UnreadCount,
} from '@riosoma/contracts';
import { api } from '../../api';

/**
 * The bell's data.  The realtime connection opens only while a database is open, and it carries
 * each database's changes to the people subscribed to that database, with no message addressed to
 * one person.  So the bell asks for the unread count instead: every minute while the page is
 * visible, and again whenever the person comes back to it.
 */

/** How often the unread count is asked for while the page is visible */
export const POLL_MS = 60_000;

export const unreadQuery = queryOptions({
  queryKey: ['notifications', 'unread'],
  queryFn: ({ signal }) => api<UnreadCount>('/api/notifications/unread', { signal }),
});

export const listQuery = infiniteQueryOptions({
  queryKey: ['notifications', 'list'],
  queryFn: ({ pageParam, signal }) =>
    api<NotificationsPage>(
      pageParam ? `/api/notifications?before=${encodeURIComponent(pageParam)}` : '/api/notifications',
      { signal },
    ),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.next,
});

export const preferencesQuery = queryOptions({
  queryKey: ['notifications', 'preferences'],
  queryFn: ({ signal }) => api<NotificationPreferences>('/api/notifications/preferences', { signal }),
});

export const channelsQuery = queryOptions({
  queryKey: ['notifications', 'channels'],
  queryFn: ({ signal }) => api<NotificationChannelPreferences>('/api/notifications/channels', { signal }),
});

type ListData = InfiniteData<NotificationsPage, string | null>;

/** The unread count, kept fresh while the page is in view. */
export function useUnreadCount(): number {
  const client = useQueryClient();
  const query = useQuery({
    ...unreadQuery,
    refetchInterval: POLL_MS,
    // The interval pauses while the page is hidden, and coming back asks at once.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    // Switching back from another window leaves the page visible the whole time, so focus asks too.
    const refresh = () => {
      if (document.visibilityState !== 'hidden')
        void client.refetchQueries({ queryKey: unreadQuery.queryKey }, { cancelRefetch: false });
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [client]);
  return query.data?.count ?? 0;
}

/**
 * Marks notifications read, showing it at once.  The server's answer sets the count, and a failure
 * asks the server again rather than guessing.
 */
export async function markRead(client: QueryClient, body: MarkNotificationsRead): Promise<void> {
  const ids = 'ids' in body ? new Set(body.ids) : null;
  const readAt = new Date().toISOString();
  let marked = 0;
  client.setQueryData<ListData>(listQuery.queryKey, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            notifications: page.notifications.map((notification) => {
              if (notification.readAt || (ids && !ids.has(notification.id))) return notification;
              marked += 1;
              return { ...notification, readAt };
            }),
          })),
        }
      : data,
  );
  client.setQueryData<UnreadCount>(unreadQuery.queryKey, (data) =>
    data ? { count: ids ? Math.max(0, data.count - marked) : 0 } : data,
  );
  try {
    client.setQueryData(
      unreadQuery.queryKey,
      await api<UnreadCount>('/api/notifications/read', { method: 'POST', body }),
    );
  } catch {
    await Promise.all([
      client.invalidateQueries({ queryKey: unreadQuery.queryKey }),
      client.invalidateQueries({ queryKey: listQuery.queryKey }),
    ]);
  }
}

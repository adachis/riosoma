import { useRef, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { faBell } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@riosoma/ui';
import { lazyFeature, LazyBoundary, usePreloadAnchor } from '../../shell/lazy';
const PopoverSurface = lazyFeature(() =>
  import('../../shell/PopoverSurface').then((module) => ({ default: module.PopoverSurface })),
);
const NotificationList = lazyFeature(() =>
  import('./NotificationList').then((module) => ({ default: module.NotificationList })),
);
import { useUnreadCount } from './queries';
import { anchor } from '../../demos/anchors';
import './NotificationBell.css';

/**
 * The bell in the app's header.  Its badge counts what's unread, and pressing it opens the latest
 * notifications, today's first, with more loading as the list scrolls.
 */
export function NotificationBell() {
  const { t, i18n } = useLingui();
  const count = useUnreadCount();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const preload = () => Promise.all([PopoverSurface.preload(), NotificationList.preload()]);
  usePreloadAnchor(trigger, preload);
  const title = t({ id: 'notifications.title', message: 'Notifications' });
  const badge = count > 9 ? t({ id: 'notifications.bell.many', message: '9+' }) : i18n.number(count);
  // The badge is visible text, so the name carries it too, after the count it stands for.
  const label =
    count > 9
      ? t({ id: 'notifications.bell.unreadMany', message: `Notifications, ${count} unread, ${badge}` })
      : count > 0
        ? t({
            id: 'notifications.bell.unread',
            message: plural(count, { one: 'Notifications, # unread', other: 'Notifications, # unread' }),
          })
        : title;
  return (
    <>
      <span
        ref={(element) => {
          trigger.current = element?.querySelector('button') ?? null;
        }}
        className="rio-deferred-menu-trigger"
      >
        <Button
          variant="quiet"
          size="sm"
          icon={faBell}
          aria-label={label}
          className="rio-notification-bell"
          onHoverStart={preload}
          onFocus={preload}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPress={() => setOpen(!open)}
          primaryAction
          {...anchor('notifications.open')}
        >
          {count > 0 ? (
            <span className="rio-notification-bell__badge" aria-hidden="true">
              {badge}
            </span>
          ) : null}
        </Button>
      </span>
      {open && (
        <LazyBoundary size="popover" triggerRef={trigger}>
          <PopoverSurface
            triggerRef={trigger}
            onClose={() => setOpen(false)}
            title={title}
            className="rio-notifications"
            dialogClassName="rio-notifications__dialog"
          >
            <NotificationList title={title} onLeave={() => setOpen(false)} />
          </PopoverSurface>
        </LazyBoundary>
      )}
    </>
  );
}

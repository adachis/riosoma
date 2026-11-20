import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarFeedState } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Link,
  Modal,
  Spinner,
  TextField,
} from '@riosoma/ui';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import {
  calendarFeedKey,
  feedAddress,
  makeCalendarFeed,
  readCalendarFeed,
  stopCalendarFeed,
  webcalAddress,
} from './api';
import './calendar-feeds.css';

export interface CalendarFeedDialogProps {
  viewId: string;
  viewName: string;
  onClose(): void;
}

/**
 * Subscribing to a calendar, timeline, or Gantt view in a calendar app: making a private address,
 * copying it or handing it to the calendar app, making a new one, and turning it off.  The server
 * keeps only a hash of the address, so it's shown once, right after it's made.
 */
export function CalendarFeedDialog(props: CalendarFeedDialogProps) {
  const { t } = useLingui();
  return (
    <Modal
      isOpen
      isDismissable
      size="md"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'calendarFeeds.title', message: 'Subscribe in a calendar app' })}</DialogTitle>
        <DialogBody>
          <FeedPanel {...props} />
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

function FeedPanel({ viewId, viewName }: CalendarFeedDialogProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const key = calendarFeedKey(viewId);
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<'replace' | 'stop' | null>(null);
  const state = useQuery({ queryKey: key, queryFn: ({ signal }) => readCalendarFeed(viewId, signal) });
  const make = useMutation({
    mutationFn: () =>
      makeCalendarFeed(viewId, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    onSuccess: (created) => {
      client.setQueryData<CalendarFeedState>(key, { allowed: true, feed: created.feed });
      setAddress(feedAddress(created.path));
      setCopied(false);
    },
  });
  const stop = useMutation({
    mutationFn: () => stopCalendarFeed(viewId),
    onSuccess: () => {
      client.setQueryData<CalendarFeedState>(key, (current) => current && { ...current, feed: null });
      setAddress(null);
      setCopied(false);
      // The address and its buttons go away, so the one way to start again takes the focus.
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('button')?.focus());
    },
  });
  const failure = make.error ?? stop.error ?? state.error;
  const busy = make.isPending || stop.isPending;
  const feed = state.data?.feed ?? null;
  const when = (value: string) =>
    new Intl.DateTimeFormat(i18n.locale || 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const made = feed ? when(feed.createdAt) : '';
  const lastRead = feed?.lastReadAt ? when(feed.lastReadAt) : '';

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the address, ready to select and copy.
    }
  }

  function start() {
    make.reset();
    stop.reset();
    make.mutate();
  }

  return (
    <div ref={root} className="rio-calendar-feed">
      <p className="rio-calendar-feed__help">
        {t({
          id: 'calendarFeeds.help',
          message: `Add ${viewName} to Apple Calendar, Google Calendar, or Outlook as a calendar that keeps itself up to date.  It shows the records and fields you can see in this view, as you see them.`,
        })}
      </p>
      {state.isPending ? (
        <Spinner label={t({ id: 'calendarFeeds.loading', message: 'Loading your calendar feed' })} />
      ) : state.data && !state.data.allowed ? (
        <p className="rio-calendar-feed__note">
          {t({
            id: 'calendarFeeds.orgOff',
            message: 'Your organization has turned calendar feeds off.  Ask an admin if you need one.',
          })}
        </p>
      ) : state.data ? (
        <>
          {address ? (
            <>
              <div className="rio-calendar-feed__copy">
                <TextField
                  label={t({ id: 'calendarFeeds.address', message: 'Private address' })}
                  value={address}
                  isReadOnly
                />
                <Button
                  onPress={() => void copy(address)}
                  aria-label={t({ id: 'calendarFeeds.copy', message: 'Copy address' })}
                  icon={faCopy}
                />
              </div>
              <p className="rio-calendar-feed__note" role="status">
                {copied ? t({ id: 'calendarFeeds.copied', message: 'Copied the address' }) : ''}
              </p>
              <Link href={webcalAddress(address)} className="rio-calendar-feed__open">
                {t({ id: 'calendarFeeds.open', message: 'Open in your calendar app' })}
              </Link>
              <Banner tone="warning">
                {t({
                  id: 'calendarFeeds.once',
                  message:
                    'Anyone with this address can read these records, so keep it to yourself.  It’s shown only now.  If you lose it, make a new one.',
                })}
              </Banner>
            </>
          ) : feed ? (
            <>
              <p>
                {t({ id: 'calendarFeeds.on', message: `Your calendar feed is on.  You made it on ${made}.` })}{' '}
                {lastRead
                  ? t({
                      id: 'calendarFeeds.lastRead',
                      message: `A calendar app last read it on ${lastRead}.`,
                    })
                  : t({ id: 'calendarFeeds.neverRead', message: 'No calendar app has read it yet.' })}
              </p>
              <p className="rio-calendar-feed__note">
                {t({
                  id: 'calendarFeeds.hidden',
                  message:
                    'The address is shown only when it’s made.  To see one again, make a new address, and the old one stops working.',
                })}
              </p>
            </>
          ) : (
            <Button
              variant="primary"
              className="rio-calendar-feed__start"
              isPending={make.isPending}
              onPress={start}
            >
              {t({ id: 'calendarFeeds.make', message: 'Make a private address' })}
            </Button>
          )}
          {feed ? (
            <div className="rio-calendar-feed__actions">
              <Button isDisabled={busy} onPress={() => setConfirming('replace')}>
                {t({ id: 'calendarFeeds.replace', message: 'Make a new address' })}
              </Button>
              <Button variant="danger" isDisabled={busy} onPress={() => setConfirming('stop')}>
                {t({ id: 'calendarFeeds.stop', message: 'Turn off' })}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <p className="rio-calendar-feed__error" role="alert">
        {failure
          ? failure instanceof ApiError
            ? message(failure.info.messageKey, failure.info.params)
            : message('errors.internal')
          : ''}
      </p>
      <ConfirmDialog
        isOpen={confirming === 'replace'}
        onOpenChange={(open) => setConfirming(open ? 'replace' : null)}
        title={t({ id: 'calendarFeeds.replaceTitle', message: 'Make a new address?' })}
        message={t({
          id: 'calendarFeeds.replaceBody',
          message:
            'The old address stops working at once, so calendar apps subscribed to it stop updating.  Subscribe them to the new one.',
        })}
        confirmLabel={t({ id: 'calendarFeeds.replace', message: 'Make a new address' })}
        // A failure closes the question too, so the reason shows in the panel behind it.
        onConfirm={() => {
          stop.reset();
          return make.mutateAsync().then(
            () => undefined,
            () => undefined,
          );
        }}
      />
      <ConfirmDialog
        isOpen={confirming === 'stop'}
        onOpenChange={(open) => setConfirming(open ? 'stop' : null)}
        title={t({ id: 'calendarFeeds.stopTitle', message: 'Turn off this calendar feed?' })}
        message={t({
          id: 'calendarFeeds.stopBody',
          message:
            'Its address stops working at once, and calendar apps subscribed to it stop updating.  You can make a new one later.',
        })}
        confirmLabel={t({ id: 'calendarFeeds.stop', message: 'Turn off' })}
        tone="danger"
        onConfirm={() => {
          make.reset();
          return stop.mutateAsync().then(
            () => undefined,
            () => undefined,
          );
        }}
      />
    </div>
  );
}

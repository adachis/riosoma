import {
  faArrowLeft,
  faCircleCheck,
  faCircleXmark,
  faHourglassHalf,
  faPause,
  faRotate,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WebhookAttempt, WebhookDelivery, WebhookMeta } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import {
  Button,
  DialogBody,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Spinner,
  toast,
} from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useMinuteClock, useRelativeTime } from '../../../relative-time';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { deliveriesKey, listDeliveries, redeliver } from './api';
import { useEventLabels } from './labels';

type Shown = 'succeeded' | 'failed' | 'waiting' | 'retrying' | 'held';

const ICONS: Record<Shown, IconDefinition> = {
  succeeded: faCircleCheck,
  failed: faCircleXmark,
  waiting: faHourglassHalf,
  retrying: faRotate,
  held: faPause,
};

function shown(delivery: WebhookDelivery): Shown {
  if (delivery.state !== 'pending') return delivery.state;
  // A pending delivery with no time waits for its webhook to be turned back on.
  if (delivery.nextAttemptAt === null) return 'held';
  return delivery.attempts.length ? 'retrying' : 'waiting';
}

/** What an attempt came back with: the HTTP status, or why no answer came, and how long it took. */
function Outcome({ attempt }: { attempt: WebhookAttempt }) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const status = attempt.status;
  const ms = attempt.ms === null ? null : i18n.number(attempt.ms);
  return (
    <>
      <span className="rio-webhooks__result">
        {status === null
          ? message(attempt.error ?? 'webhooks.delivery.failed')
          : t({ id: 'webhooks.attempt.status', message: `HTTP ${status}` })}
      </span>
      {ms === null ? null : (
        <span className="rio-webhooks__muted">{t({ id: 'webhooks.attempt.took', message: `${ms} ms` })}</span>
      )}
    </>
  );
}

function AttemptLine({ attempt }: { attempt: WebhookAttempt }) {
  const { t } = useLingui();
  const when = useRelativeTime(attempt.at);
  return (
    <li className="rio-webhooks__attempt">
      <Outcome attempt={attempt} />
      <time className="rio-webhooks__muted" dateTime={attempt.at}>
        {when}
      </time>
      {attempt.manual ? (
        <span className="rio-webhooks__tag">
          {t({ id: 'webhooks.attempt.manual', message: 'Sent again on request' })}
        </span>
      ) : null}
    </li>
  );
}

function DeliveryItem({
  delivery,
  sending,
  onRedeliver,
}: {
  delivery: WebhookDelivery;
  sending: boolean;
  onRedeliver(): void;
}) {
  const { t, i18n } = useLingui();
  const labels = useEventLabels();
  const when = useRelativeTime(delivery.createdAt);
  const now = useMinuteClock();
  const state = shown(delivery);
  const names: Record<Shown, string> = {
    succeeded: t({ id: 'webhooks.state.succeeded', message: 'Delivered' }),
    failed: t({ id: 'webhooks.state.failed', message: 'Failed' }),
    waiting: t({ id: 'webhooks.state.waiting', message: 'Waiting to send' }),
    retrying: t({ id: 'webhooks.state.retrying', message: 'Retrying' }),
    held: t({ id: 'webhooks.state.held', message: 'On hold' }),
  };
  const list = (items: string[]) => new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(items);
  const count = delivery.eventCount;
  const exact = i18n.date(new Date(delivery.createdAt), { dateStyle: 'medium', timeStyle: 'medium' });
  const [last, ...earlier] = delivery.attempts;
  const next =
    state === 'retrying' && delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > now
      ? i18n.date(new Date(delivery.nextAttemptAt), { dateStyle: 'medium', timeStyle: 'short' })
      : null;
  return (
    <li className="rio-webhooks__delivery" data-state={state}>
      <div className="rio-webhooks__delivery-head">
        <span className="rio-webhooks__summary">
          <Icon icon={ICONS[state]} className="rio-webhooks__icon" />
          <span className="rio-webhooks__state">{names[state]}</span>
          <span>
            {t({
              id: 'webhooks.deliveries.events',
              message: plural(count, { one: '# event', other: '# events' }),
            })}
          </span>
          <time className="rio-webhooks__muted" dateTime={delivery.createdAt} title={exact}>
            {when}
          </time>
        </span>
        <Button size="sm" onPress={onRedeliver} isPending={sending}>
          <Trans id="webhooks.deliveries.redeliver">Redeliver</Trans>
        </Button>
      </div>
      <p className="rio-webhooks__muted">{list(delivery.eventTypes.map((type) => labels[type]))}</p>
      {last || state === 'held' ? (
        <p className="rio-webhooks__line">
          {last ? <Outcome attempt={last} /> : null}
          {next ? (
            <span className="rio-webhooks__muted">
              {t({ id: 'webhooks.attempt.next', message: `Next try at ${next}` })}
            </span>
          ) : null}
          {state === 'held' ? (
            <span className="rio-webhooks__muted">
              {t({ id: 'webhooks.state.heldNote', message: 'Goes out once the webhook is back on' })}
            </span>
          ) : null}
        </p>
      ) : null}
      {earlier.length ? (
        <Disclosure className="rio-webhooks__attempts">
          <DisclosureTrigger level={4}>
            {t({
              id: 'webhooks.deliveries.attempts',
              message: plural(delivery.attempts.length, { one: '# attempt', other: '# attempts' }),
            })}
          </DisclosureTrigger>
          <DisclosurePanel>
            <ol className="rio-webhooks__attempt-list">
              {delivery.attempts.map((attempt, index) => (
                <AttemptLine key={`${attempt.at}-${index}`} attempt={attempt} />
              ))}
            </ol>
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </li>
  );
}

export interface DeliveriesProps {
  databaseId: string;
  webhook: WebhookMeta;
  onBack(): void;
}

/** A webhook's recent deliveries, newest first, a page at a time, each with a way to send it again. */
export function Deliveries({ databaseId, webhook, onBack }: DeliveriesProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const key = deliveriesKey(databaseId, webhook.id);
  const deliveries = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => listDeliveries(databaseId, webhook.id, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (page) => page.next ?? undefined,
    // While a delivery waits to go, look again now and then to show how it went.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.deliveries.some((delivery) => delivery.state === 'pending'))
        ? 5_000
        : false,
  });
  const again = useMutation({
    mutationFn: (deliveryId: string) => redeliver(databaseId, webhook.id, deliveryId),
    onSuccess: async () => {
      toast.show({
        tone: 'info',
        title: t({ id: 'webhooks.deliveries.queued', message: 'Sending it again' }),
      });
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const list = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];
  return (
    <DialogBody className="rio-webhooks__deliveries">
      <div className="rio-webhooks__back">
        <Button variant="quiet" size="sm" icon={faArrowLeft} onPress={onBack}>
          <Trans id="webhooks.back">All webhooks</Trans>
        </Button>
      </div>
      <p className="rio-webhooks__url">{webhook.url}</p>
      <ErrorBanner error={errorInfo(deliveries.error ?? again.error)} />
      {deliveries.isPending ? (
        <Spinner label={t({ id: 'webhooks.deliveries.loading', message: 'Loading deliveries' })} />
      ) : list.length ? (
        <ol className="rio-webhooks__delivery-list">
          {list.map((delivery) => (
            <DeliveryItem
              key={delivery.id}
              delivery={delivery}
              sending={again.isPending && again.variables === delivery.id}
              onRedeliver={() => {
                if (!again.isPending) again.mutate(delivery.id);
              }}
            />
          ))}
        </ol>
      ) : deliveries.isError ? null : (
        <p className="rio-webhooks__muted">
          <Trans id="webhooks.deliveries.empty">
            {'No deliveries in the last 7 days.  Changes go out within a second or two.'}
          </Trans>
        </p>
      )}
      {deliveries.hasNextPage ? (
        <Button isPending={deliveries.isFetchingNextPage} onPress={() => void deliveries.fetchNextPage()}>
          <Trans id="webhooks.deliveries.more">Show more</Trans>
        </Button>
      ) : null}
    </DialogBody>
  );
}

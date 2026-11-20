import { faCopy, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WEBHOOK_SOURCE_LIMITS,
  type SourceMeta,
  type WebhookAddress,
  type WebhookRefusalCode,
  type WebhookSourceLog,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Heading,
  Spinner,
  Switch,
  TextField,
} from '@riosoma/ui';
import { api } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { SOURCES_KEY } from './query';
import './sources.css';

/** What each plain refusal code means, for the delivery log. */
export const REFUSAL_LABELS: Record<WebhookRefusalCode, MessageDescriptor> = {
  not_found: msg({ id: 'sources.webhook.refusal.not_found', message: 'Unknown address' }),
  paused: msg({ id: 'sources.webhook.refusal.paused', message: 'Paused' }),
  rate_limited: msg({ id: 'sources.webhook.refusal.rate_limited', message: 'Too many posts this minute' }),
  payload_too_large: msg({ id: 'sources.webhook.refusal.payload_too_large', message: 'Larger than 1 MB' }),
  unsupported_content_type: msg({
    id: 'sources.webhook.refusal.unsupported_content_type',
    message: 'Not sent as JSON',
  }),
  signature_missing: msg({ id: 'sources.webhook.refusal.signature_missing', message: 'No signature' }),
  signature_invalid: msg({ id: 'sources.webhook.refusal.signature_invalid', message: 'Wrong signature' }),
  timestamp_expired: msg({ id: 'sources.webhook.refusal.timestamp_expired', message: 'Signed too long ago' }),
  invalid_json: msg({ id: 'sources.webhook.refusal.invalid_json', message: 'Not valid JSON' }),
  records_missing: msg({
    id: 'sources.webhook.refusal.records_missing',
    message: 'No records where expected',
  }),
  record_not_object: msg({
    id: 'sources.webhook.refusal.record_not_object',
    message: 'A record isn’t an object',
  }),
  too_many_records: msg({
    id: 'sources.webhook.refusal.too_many_records',
    message: 'More than 1,000 records',
  }),
  bad_request: msg({ id: 'sources.webhook.refusal.bad_request', message: 'Unreadable request' }),
  unavailable: msg({ id: 'sources.webhook.refusal.unavailable', message: 'Riosoma was unavailable' }),
};

/** A webhook's full address, from the path the server gives, on this server's own origin. */
export function webhookUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

/**
 * A webhook's address, shown the one time it's made, with a way to copy it and a post to try it
 * with.  The server keeps only a hash, so once this closes, the address can only be replaced.
 */
export function WebhookAddressShown({ path }: { path: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const url = webhookUrl(path);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the address, ready to select and copy.
    }
  }
  return (
    <div className="rio-sources__hook">
      <div className="rio-sources__share">
        <div className="rio-sources__share-field">
          <TextField
            label={t({ id: 'sources.webhook.address', message: 'Webhook address' })}
            value={url}
            isReadOnly
          />
        </div>
        <Button
          onPress={() => void copy()}
          aria-label={t({ id: 'sources.webhook.copy', message: 'Copy address' })}
          icon={faCopy}
        />
      </div>
      <p className="rio-sources__note" role="status">
        {copied ? t({ id: 'sources.webhook.copied', message: 'Copied the address' }) : ''}
      </p>
      <Banner tone="warning">
        {t({
          id: 'sources.webhook.once',
          message:
            'Anyone with this address can post records, so keep it secret.  It’s shown only now.  If you lose it, make a new one.',
        })}
      </Banner>
      <p className="rio-sources__note">
        <Trans id="sources.webhook.try">Try it with a post like this one:</Trans>
      </p>
      {/* A command to run, which is code rather than words to translate. */}
      <pre className="rio-sources__code">{`curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"id": "1", "name": "First post"}'`}</pre>
    </div>
  );
}

/**
 * A saved webhook's address, log, and log bodies, for its admins.  Making a new address stops the
 * old one at once, so it asks first.
 */
export function WebhookPanel({ source }: { source: SourceMeta }) {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const base = `/api/sources/${encodeURIComponent(source.id)}`;
  const key = [...SOURCES_KEY, source.id, 'webhook-deliveries'];
  const log = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<WebhookSourceLog>(`${base}/webhook-deliveries`, { signal }),
  });
  const address = useMutation({
    mutationFn: () => api<WebhookAddress>(`${base}/webhook-address`, { method: 'POST' }),
    onSuccess: (made) => {
      setShown(made.path);
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
  const bodies = useMutation({
    mutationFn: (on: boolean) =>
      api<WebhookSourceLog>(`${base}/webhook-bodies`, { method: 'PUT', body: { on } }),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  const when = (value: string) =>
    new Intl.DateTimeFormat(i18n.locale || 'en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(
      new Date(value),
    );
  const until = log.data?.bodiesUntil ?? null;

  return (
    <section className="rio-sources__hook">
      <Heading level={4}>
        <Trans id="sources.webhook.heading">Address and deliveries</Trans>
      </Heading>
      {shown ? (
        <WebhookAddressShown path={shown} />
      ) : (
        <p className="rio-sources__note">
          {source.webhook?.lastPostAt
            ? t({
                id: 'sources.webhook.lastPost',
                message: `The address was made ${when(source.webhook.addressAt)}.  The last post came ${when(source.webhook.lastPostAt)}.`,
              })
            : t({
                id: 'sources.webhook.noPostYet',
                message: `The address was made ${when(source.webhook?.addressAt ?? new Date().toISOString())}.  No post has come yet.`,
              })}
        </p>
      )}
      <div className="rio-sources__hook-actions">
        <Button onPress={() => setAsking(true)} isPending={address.isPending}>
          <Trans id="sources.webhook.replace">Make a new address</Trans>
        </Button>
        <Button
          variant="quiet"
          onPress={() => void log.refetch()}
          isPending={log.isFetching}
          aria-label={t({ id: 'sources.webhook.refresh', message: 'Refresh the log' })}
          icon={faRotateRight}
        />
      </div>
      {asking ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'sources.webhook.replace.title', message: 'Make a new address?' })}
          message={t({
            id: 'sources.webhook.replace.body',
            message: 'The current address stops working at once, so every sender needs the new one.',
          })}
          confirmLabel={t({ id: 'sources.webhook.replace', message: 'Make a new address' })}
          onOpenChange={(open) => {
            if (!open) setAsking(false);
          }}
          onConfirm={() => address.mutateAsync()}
        />
      ) : null}
      <Switch
        isSelected={until !== null}
        onChange={(on) => bodies.mutate(on)}
        isDisabled={bodies.isPending || log.isPending}
        description={
          until
            ? t({ id: 'sources.webhook.bodies.until', message: `Keeping bodies until ${when(until)}.` })
            : t({
                id: 'sources.webhook.bodies.hint',
                message:
                  'For an hour, the log keeps what each post said, then stops and forgets it on its own.  Posts can hold personal details, so keep this off unless you need it.',
              })
        }
      >
        <Trans id="sources.webhook.bodies">Keep post bodies in the log for an hour</Trans>
      </Switch>
      <ErrorBanner error={errorInfo(address.error ?? bodies.error ?? log.error)} />
      {log.isPending ? (
        <Spinner label={t({ id: 'sources.webhook.loading', message: 'Loading the delivery log' })} />
      ) : log.data && log.data.deliveries.length ? (
        <table className="rio-sources__table rio-sources__deliveries">
          <caption className="rio-sources__note">
            {t({
              id: 'sources.webhook.log.caption',
              message: `The last ${WEBHOOK_SOURCE_LIMITS.deliveries} posts, and any still held, newest first`,
            })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t({ id: 'sources.webhook.log.at', message: 'Received' })}</th>
              <th scope="col">{t({ id: 'sources.webhook.log.status', message: 'Answer' })}</th>
              <th scope="col">{t({ id: 'sources.webhook.log.size', message: 'Size' })}</th>
              <th scope="col">{t({ id: 'sources.webhook.log.outcome', message: 'What happened' })}</th>
            </tr>
          </thead>
          <tbody>
            {log.data.deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>{when(delivery.at)}</td>
                <td>{delivery.status}</td>
                <td>
                  {t({
                    id: 'sources.webhook.log.bytes',
                    message: plural(delivery.bytes, { one: '# byte', other: '# bytes' }),
                  })}
                </td>
                <td>
                  {delivery.refusal
                    ? i18n._(REFUSAL_LABELS[delivery.refusal])
                    : delivery.error
                      ? serverMessage(i18n, delivery.error)
                      : delivery.written
                        ? t({
                            id: 'sources.webhook.log.written',
                            message: plural(delivery.records ?? 0, {
                              one: 'Wrote # record',
                              other: 'Wrote # records',
                            }),
                          })
                        : t({ id: 'sources.webhook.log.waiting', message: 'Waiting to be written' })}
                  {delivery.body !== null ? (
                    <Disclosure>
                      <DisclosureTrigger level={4}>
                        <Trans id="sources.webhook.log.body">Body</Trans>
                      </DisclosureTrigger>
                      <DisclosurePanel>
                        <pre className="rio-sources__code">{delivery.body}</pre>
                      </DisclosurePanel>
                    </Disclosure>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : log.data ? (
        <p className="rio-sources__note">
          <Trans id="sources.webhook.log.empty">No posts yet.</Trans>
        </p>
      ) : null}
    </section>
  );
}

import { faRotateRight, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
  FEEDBACK_STATUSES,
  type FeedbackGithubSettings,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
} from '@riosoma/contracts';
import {
  Button,
  ConfirmDialog,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  ListBoxItem,
  Select,
  Spinner,
  TextArea,
  toast,
} from '@riosoma/ui';
import { useRelativeTime } from '../../relative-time';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import {
  deleteFeedback,
  feedbackGithubKey,
  feedbackInboxKey,
  listFeedback,
  readGithubSettings,
  replyToFeedback,
  screenshotUrl,
  setFeedbackStatus,
  sendHubReport,
} from './api';
import { ContextList } from './ContextList';
import { ReplyEntry } from './ReplyEntry';
import { GithubSettings } from './GithubSettings';
import { IssueDialog } from './IssueDialog';
import { HubSettings } from './HubSettings';
import { HubDialog } from './HubDialog';
import { feedbackHubKey, readHubSettings } from './api';
import { useFeedbackWords } from './words';
import './feedback.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'feedback',
  label: msg({ id: 'settings.nav.feedback', message: 'Feedback' }),
  roles: ['feedback'],
  keywords: msg({ id: 'settings.search.keywords.feedback', message: 'feedback inbox replies issues' }),
});

/** Everything the inbox holds is under this key, so one change refreshes the list and the count. */
const INBOX = ['admin', 'feedback'] as const;
const ALL = 'all';

/**
 * Settings › Feedback, for owners and feedback admins: everything people in the organization
 * sent, newest first, filtered by kind and status.  Each piece shows its context and screenshot,
 * and can be answered, marked, sent to GitHub when it's broken and that's on, or deleted.
 */
export function FeedbackInbox() {
  const { t } = useLingui();
  const words = useFeedbackWords();
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const inbox = useInfiniteQuery({
    queryKey: feedbackInboxKey({ kind, status }),
    queryFn: ({ pageParam, signal }) =>
      listFeedback({ kind, status, ...(pageParam ? { before: pageParam } : {}) }, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const github = useQuery({
    queryKey: feedbackGithubKey,
    queryFn: ({ signal }) => readGithubSettings(signal),
  });
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  const hub = useQuery({ queryKey: feedbackHubKey, queryFn: ({ signal }) => readHubSettings(signal) });

  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.feedback', message: 'Feedback' })}
    >
      {
        <div className="rio-feedback-inbox">
          <p className="rio-feedback-inbox__intro">
            {t({
              id: 'feedback.inbox.intro',
              message:
                'What people in your organization tell you from the Help menu.  Replies reach the sender in the app and by email.',
            })}
          </p>
          <div className="rio-feedback-inbox__filters">
            <Setting
              page={settingsPage}
              id="kind"
              label={msg({ id: 'feedback.inbox.kind', message: 'Kind' })}
            >
              <Select
                label={t({ id: 'feedback.inbox.kind', message: 'Kind' })}
                selectedKey={kind ?? ALL}
                onSelectionChange={(key) => setKind(FEEDBACK_KINDS.find((item) => item === key) ?? null)}
              >
                <ListBoxItem id={ALL}>
                  {t({ id: 'feedback.inbox.allKinds', message: 'Every kind' })}
                </ListBoxItem>
                {FEEDBACK_KINDS.map((item) => (
                  <ListBoxItem key={item} id={item}>
                    {words.kinds[item]}
                  </ListBoxItem>
                ))}
              </Select>
            </Setting>
            <Setting
              page={settingsPage}
              id="status"
              label={msg({ id: 'feedback.inbox.status', message: 'Status' })}
            >
              <Select
                label={t({ id: 'feedback.inbox.status', message: 'Status' })}
                selectedKey={status ?? ALL}
                onSelectionChange={(key) => setStatus(FEEDBACK_STATUSES.find((item) => item === key) ?? null)}
              >
                <ListBoxItem id={ALL}>
                  {t({ id: 'feedback.inbox.allStatuses', message: 'Any status' })}
                </ListBoxItem>
                {FEEDBACK_STATUSES.map((item) => (
                  <ListBoxItem key={item} id={item}>
                    {words.statuses[item]}
                  </ListBoxItem>
                ))}
              </Select>
            </Setting>
          </div>
          <ErrorBanner error={errorInfo(inbox.error)} />
          {inbox.isPending ? (
            <Spinner label={t({ id: 'feedback.inbox.loading', message: 'Loading feedback' })} />
          ) : items.length === 0 ? (
            <p>
              {kind || status ? (
                <Trans id="feedback.inbox.noneMatch">Nothing matches these filters.</Trans>
              ) : (
                <Trans id="feedback.inbox.empty">Nobody has sent feedback yet.</Trans>
              )}
            </p>
          ) : (
            <ul className="rio-feedback-inbox__list">
              {items.map((item) => (
                <InboxItem
                  key={item.id}
                  item={item}
                  github={github.data ?? null}
                  hubEnabled={Boolean(hub.data?.enabled && hub.data.url)}
                />
              ))}
            </ul>
          )}
          {inbox.hasNextPage ? (
            <div>
              <Button isPending={inbox.isFetchingNextPage} onPress={() => void inbox.fetchNextPage()}>
                <Trans id="feedback.inbox.more">Show older feedback</Trans>
              </Button>
            </div>
          ) : null}
          <section className="rio-feedback-inbox__section" aria-labelledby="feedback-github">
            <h2 id="feedback-github" className="rio-feedback-inbox__heading">
              <Trans id="feedback.github.title">Bug reports on GitHub</Trans>
            </h2>
            <ErrorBanner error={errorInfo(github.error)} />
            {github.data ? <GithubSettings settings={github.data} /> : github.isPending ? <Spinner /> : null}
          </section>
          <section className="rio-feedback-inbox__section" aria-labelledby="feedback-hub">
            <h2 id="feedback-hub" className="rio-feedback-inbox__heading">
              <Trans id="feedback.hub.title">Upstream software bugs</Trans>
            </h2>
            <ErrorBanner error={errorInfo(hub.error)} />
            {hub.data ? <HubSettings settings={hub.data} /> : hub.isPending ? <Spinner /> : null}
          </section>
        </div>
      }
    </Setting>
  );
}

function InboxItem({
  item,
  github,
  hubEnabled,
}: {
  item: FeedbackItem;
  github: FeedbackGithubSettings | null;
  hubEnabled: boolean;
}) {
  const { t } = useLingui();
  const words = useFeedbackWords();
  const queryClient = useQueryClient();
  const sent = useRelativeTime(item.createdAt);
  const [reply, setReply] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [upstream, setUpstream] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: INBOX });
  const mark = useMutation({
    mutationFn: (next: FeedbackStatus) => setFeedbackStatus(item.id, next),
    onSuccess: () => refresh(),
  });
  const answer = useMutation({
    mutationFn: () => replyToFeedback(item.id, reply.trim()),
    onSuccess: () => {
      setReply('');
      toast.show({ tone: 'success', title: t({ id: 'feedback.reply.sent', message: 'Reply sent' }) });
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteFeedback(item.id),
    onSuccess: () => {
      toast.show({ tone: 'success', title: t({ id: 'feedback.deleted', message: 'Feedback deleted' }) });
      return refresh();
    },
  });
  const upstreamRefresh = useMutation({
    mutationFn: () => sendHubReport(item.id),
    onSuccess: () => refresh(),
  });
  const sender = item.sender.name.trim() || t({ id: 'feedback.someone', message: 'Someone' });
  const kind = words.kinds[item.kind];
  const canReport =
    item.kind === 'broken' && Boolean(github?.enabled && github.repository && github.hasToken);

  return (
    <li className="rio-feedback-inbox__item" data-status={item.status}>
      <div className="rio-feedback-inbox__head">
        <strong>{kind}</strong>
        <span className="rio-feedback-inbox__meta">
          <Trans id="feedback.inbox.from">
            From {sender}, <time dateTime={item.createdAt}>{sent}</time>
          </Trans>
        </span>
      </div>
      <p className="rio-feedback-inbox__message">{item.message}</p>
      {item.screenshot ? (
        <figure className="rio-feedback-inbox__shot">
          <img
            src={screenshotUrl(item.id)}
            loading="lazy"
            alt={t({ id: 'feedback.inbox.screenshot', message: 'The screenshot sent with this feedback' })}
          />
        </figure>
      ) : null}
      <Disclosure>
        <DisclosureTrigger level={3}>
          <Trans id="feedback.inbox.context">Where they were</Trans>
        </DisclosureTrigger>
        <DisclosurePanel>
          <ContextList context={item.context} />
        </DisclosurePanel>
      </Disclosure>
      {item.replies.length ? (
        <ul
          className="rio-feedback-inbox__replies"
          aria-label={t({ id: 'feedback.replies', message: 'Replies' })}
        >
          {item.replies.map((entry) => (
            <ReplyEntry
              key={entry.id}
              body={entry.body}
              author={entry.author?.name ?? ''}
              createdAt={entry.createdAt}
            />
          ))}
        </ul>
      ) : null}
      {item.issue ? (
        <a className="rio-feedback-inbox__issue" href={item.issue.url} target="_blank" rel="noreferrer">
          <Trans id="feedback.inbox.issue">On GitHub as #{item.issue.number}</Trans>
        </a>
      ) : null}
      {item.upstreamIssueUrl ? (
        <a href={item.upstreamIssueUrl} target="_blank" rel="noreferrer">
          <Trans id="feedback.hub.issue">Upstream issue</Trans>
        </a>
      ) : null}
      {item.upstreamPending ? (
        <p role="status">
          <Trans id="feedback.hub.pending">
            The hub accepted this report and is waiting to file an issue.
          </Trans>
        </p>
      ) : null}
      <ErrorBanner error={errorInfo(mark.error ?? answer.error ?? remove.error ?? upstreamRefresh.error)} />
      <Setting
        page={settingsPage}
        id="reply"
        label={msg({ id: 'feedback.reply', message: 'Reply' })}
        help={msg({
          id: 'feedback.reply.detail',
          message: 'They get it in the app and by email.',
        })}
      >
        <TextArea
          label={t({ id: 'feedback.reply', message: 'Reply' })}
          description={t({
            id: 'feedback.reply.detail',
            message: 'They get it in the app and by email.',
          })}
          value={reply}
          onChange={setReply}
          rows={2}
          maxLength={FEEDBACK_LIMITS.replyLength}
          isDisabled={answer.isPending}
        />
      </Setting>
      <div className="rio-feedback-inbox__actions">
        <Button
          variant="primary"
          size="sm"
          isPending={answer.isPending}
          isDisabled={!reply.trim()}
          onPress={() => {
            answer.reset();
            answer.mutate();
          }}
        >
          <Trans id="feedback.reply.send">Send reply</Trans>
        </Button>
        <Setting
          page={settingsPage}
          id="status-2"
          label={msg({ id: 'feedback.inbox.status', message: 'Status' })}
        >
          <Select
            size="sm"
            aria-label={t({ id: 'feedback.inbox.status', message: 'Status' })}
            selectedKey={item.status}
            isDisabled={mark.isPending}
            onSelectionChange={(key) => {
              const next = FEEDBACK_STATUSES.find((entry) => entry === key);
              if (next && next !== item.status) {
                mark.reset();
                mark.mutate(next);
              }
            }}
          >
            {FEEDBACK_STATUSES.map((entry) => (
              <ListBoxItem key={entry} id={entry}>
                {words.statuses[entry]}
              </ListBoxItem>
            ))}
          </Select>
        </Setting>
        {canReport ? (
          <Button size="sm" onPress={() => setReporting(true)}>
            <Trans id="feedback.github.send">Send to GitHub</Trans>
          </Button>
        ) : null}
        {hubEnabled && item.kind === 'broken' && !item.upstreamIssueUrl ? (
          item.upstreamPending ? (
            <Button
              size="sm"
              isPending={upstreamRefresh.isPending}
              onPress={() => upstreamRefresh.mutate()}
              aria-label={t({ id: 'feedback.hub.refresh', message: 'Refresh upstream issue' })}
              icon={faRotateRight}
            />
          ) : (
            <Button size="sm" onPress={() => setUpstream(true)}>
              <Trans id="feedback.hub.send">Send upstream</Trans>
            </Button>
          )
        ) : null}
        <Button
          size="sm"
          variant="danger"
          onPress={() => setDeleting(true)}
          aria-label={t({ id: 'feedback.delete', message: 'Delete' })}
          icon={faTrashCan}
        />
      </div>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'feedback.delete.title', message: 'Delete this feedback?' })}
          message={t({
            id: 'feedback.delete.body',
            message: 'Its screenshot and replies go too, and the sender can no longer read the replies.',
          })}
          confirmLabel={t({ id: 'feedback.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(false);
          }}
          onConfirm={() => remove.mutateAsync()}
        />
      ) : null}
      {reporting && github?.repository ? (
        <IssueDialog item={item} onClose={() => setReporting(false)} onSent={() => void refresh()} />
      ) : null}
      {upstream ? (
        <HubDialog item={item} onClose={() => setUpstream(false)} onSent={() => void refresh()} />
      ) : null}
    </li>
  );
}

import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { SentFeedback as Sent } from '@riosoma/contracts';
import { Button, Spinner } from '@riosoma/ui';
import { useRelativeTime } from '../../relative-time';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { shortcutKeys } from '../../shortcuts/registry';
import { listSentFeedback, sentFeedbackKey } from './api';
import { FeedbackDialog } from './FeedbackDialog';
import { ReplyEntry } from './ReplyEntry';
import { useFeedbackWords } from './words';
import './feedback.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'my-feedback',
  label: msg({ id: 'settings.nav.myFeedback', message: 'Feedback you sent' }),
  roles: ['personal'],
  keywords: msg({ id: 'settings.search.keywords.my-feedback', message: 'feedback sent replies' }),
});

/**
 * Settings › Feedback you sent: the person's own feedback, newest first, with where each stands
 * and every reply the admins sent.  A reply's notification opens here.
 */
export function SentFeedback() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const sent = useQuery({ queryKey: sentFeedbackKey, queryFn: ({ signal }) => listSentFeedback(signal) });
  const keys = shortcutKeys('feedback.open');
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.myFeedback', message: 'Feedback you sent' })}
    >
      {
        <div className="rio-feedback-sent">
          <p className="rio-feedback-sent__intro">
            {t({
              id: 'feedback.sent.intro',
              message: `Tell your organization’s admins when something’s broken, share an idea, or ask a question.  Send feedback from the Help menu, from search, or with ${keys}, wherever you are.`,
            })}
          </p>
          <div>
            <Button variant="primary" onPress={() => setOpen(true)}>
              <Trans id="feedback.title">Send feedback</Trans>
            </Button>
          </div>
          <ErrorBanner error={errorInfo(sent.error)} />
          {sent.isPending ? (
            <Spinner label={t({ id: 'feedback.sent.loading', message: 'Loading your feedback' })} />
          ) : sent.data?.items.length ? (
            <ul className="rio-feedback-sent__list">
              {sent.data.items.map((item) => (
                <SentItem key={item.id} item={item} />
              ))}
            </ul>
          ) : sent.data ? (
            <p>
              <Trans id="feedback.sent.empty">You haven’t sent any feedback yet.</Trans>
            </p>
          ) : null}
          <FeedbackDialog isOpen={open} onClose={() => setOpen(false)} />
        </div>
      }
    </Setting>
  );
}

function SentItem({ item }: { item: Sent }) {
  const { t } = useLingui();
  const words = useFeedbackWords();
  const when = useRelativeTime(item.createdAt);
  const kind = words.kinds[item.kind];
  const status = words.statuses[item.status];
  return (
    <li className="rio-feedback-sent__item">
      <div className="rio-feedback-inbox__head">
        <strong>{kind}</strong>
        <span className="rio-feedback-inbox__meta">
          <Trans id="feedback.sent.when">
            Sent <time dateTime={item.createdAt}>{when}</time> · {status}
          </Trans>
        </span>
      </div>
      <p className="rio-feedback-inbox__message">{item.message}</p>
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
    </li>
  );
}

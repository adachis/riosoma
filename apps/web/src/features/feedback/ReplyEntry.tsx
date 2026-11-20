import { Trans, useLingui } from '@lingui/react/macro';
import { useRelativeTime } from '../../relative-time';

/** One reply to a piece of feedback: who wrote it, when, and what it says. */
export function ReplyEntry({ body, author, createdAt }: { body: string; author: string; createdAt: string }) {
  const { t } = useLingui();
  const when = useRelativeTime(createdAt);
  const who = author.trim() || t({ id: 'feedback.someone', message: 'Someone' });
  return (
    <li className="rio-feedback-inbox__reply">
      <span className="rio-feedback-inbox__meta">
        <Trans id="feedback.reply.by">
          {who} replied <time dateTime={createdAt}>{when}</time>
        </Trans>
      </span>
      <p className="rio-feedback-inbox__reply-body">{body}</p>
    </li>
  );
}

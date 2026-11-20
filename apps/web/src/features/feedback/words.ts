import { useLingui } from '@lingui/react/macro';
import type { FeedbackContext, FeedbackKind, FeedbackStatus } from '@riosoma/contracts';

/** The words feedback is shown with, in the reader's language. */
export function useFeedbackWords() {
  const { t } = useLingui();
  const kinds: Record<FeedbackKind, string> = {
    broken: t({ id: 'feedback.kind.broken', message: 'Something’s broken' }),
    idea: t({ id: 'feedback.kind.idea', message: 'An idea' }),
    question: t({ id: 'feedback.kind.question', message: 'A question' }),
  };
  const statuses: Record<FeedbackStatus, string> = {
    new: t({ id: 'feedback.status.new', message: 'New' }),
    seen: t({ id: 'feedback.status.seen', message: 'Seen' }),
    done: t({ id: 'feedback.status.done', message: 'Done' }),
  };
  const contextLabels: Record<Exclude<keyof FeedbackContext, 'errors'>, string> = {
    path: t({ id: 'feedback.context.path', message: 'Page' }),
    appVersion: t({ id: 'feedback.context.version', message: 'Riosoma version' }),
    browser: t({ id: 'feedback.context.browser', message: 'Browser' }),
    platform: t({ id: 'feedback.context.platform', message: 'Platform' }),
    theme: t({ id: 'feedback.context.theme', message: 'Theme' }),
    language: t({ id: 'feedback.context.language', message: 'Language' }),
  };
  const unknown = t({ id: 'feedback.context.unknown', message: 'Not known' });
  return { kinds, statuses, contextLabels, unknown };
}

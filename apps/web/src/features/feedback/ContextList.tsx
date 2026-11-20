import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FeedbackContext } from '@riosoma/contracts';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from '@riosoma/ui';
import { useFeedbackWords } from './words';

const FIELDS = ['path', 'appVersion', 'browser', 'platform', 'theme', 'language'] as const;

/**
 * The context that goes with a piece of feedback, as a list: the same object the dialog sends,
 * so the sender reads exactly what the admins will, and the admins read it the same way.
 */
export function ContextList({ context }: { context: FeedbackContext }) {
  const { t } = useLingui();
  const { contextLabels, unknown } = useFeedbackWords();
  const count = context.errors.length;
  return (
    <div className="rio-feedback-context">
      <dl className="rio-feedback-context__list">
        {FIELDS.map((field) => (
          <div key={field} className="rio-feedback-context__row" data-field={field}>
            <dt>{contextLabels[field]}</dt>
            <dd>{context[field] ? <code>{context[field]}</code> : unknown}</dd>
          </div>
        ))}
        <div className="rio-feedback-context__row" data-field="errors">
          <dt>
            <Trans id="feedback.context.errors">Recent errors</Trans>
          </dt>
          <dd>
            {count
              ? t({
                  id: 'feedback.context.errorCount',
                  message: plural(count, { one: '# error on this page', other: '# errors on this page' }),
                })
              : t({ id: 'feedback.context.noErrors', message: 'None' })}
          </dd>
        </div>
      </dl>
      {count ? (
        <Disclosure className="rio-feedback-context__errors">
          <DisclosureTrigger level={4}>
            <Trans id="feedback.context.showErrors">Show the errors</Trans>
          </DisclosureTrigger>
          <DisclosurePanel>
            <ol className="rio-feedback-context__error-list">
              {context.errors.map((error, index) => (
                <li key={index}>
                  <pre className="rio-feedback-context__error">
                    {error.stack ? `${error.message}\n${error.stack}` : error.message}
                  </pre>
                </li>
              ))}
            </ol>
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </div>
  );
}

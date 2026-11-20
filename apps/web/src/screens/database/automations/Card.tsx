import { anchor } from '../../../demos/anchors';
import { HelpButton } from '../../../docs/HelpButton';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import { useId, type ReactNode } from 'react';
import { PROBLEM_LABELS } from './labels';
import type { Problem } from './problems';

export interface CardProps {
  title: string;
  /** The step's place in the flow, shown beside its title */
  number?: number;
  problems?: ReadonlySet<Problem>;
  actions?: ReactNode;
  stepId?: string;
  children?: ReactNode;
}

/**
 * One card in the flow.  Problems show under the title and describe the card, so they're heard
 * when someone moves into it.
 */
export function Card({ title, number, problems, actions, stepId, children }: CardProps) {
  const { i18n } = useLingui();
  const id = useId();
  const list = [...(problems ?? [])];
  return (
    <section
      className="rio-automation-card"
      {...(stepId ? anchor('automation.steps') : {})}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      aria-describedby={list.length ? `${id}-problem` : undefined}
      data-problem={list.length ? '' : undefined}
      data-step={stepId}
    >
      <div className="rio-automation-card__header">
        {number === undefined ? null : (
          <span className="rio-automation-card__number" aria-hidden="true">
            {number}
          </span>
        )}
        <h3 id={`${id}-title`} className="rio-automation-card__title">
          {title}
        </h3>
        {stepId ? <HelpButton subject={title} moduleId="automations" section="steps" /> : null}
        {actions ? <div className="rio-automation-card__actions">{actions}</div> : null}
      </div>
      {list.length ? (
        <p id={`${id}-problem`} className="rio-automation-card__problem">
          <Icon icon={faTriangleExclamation} />
          <span>{list.map((problem) => i18n._(PROBLEM_LABELS[problem])).join('  ')}</span>
        </p>
      ) : null}
      <div className="rio-automation-card__body">{children}</div>
    </section>
  );
}

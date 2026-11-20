import {
  ProgressBar as AriaProgressBar,
  type ProgressBarProps as AriaProgressBarProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Label } from './Field';
import './ProgressBar.css';

export interface ProgressBarProps extends Omit<
  AriaProgressBarProps,
  'className' | 'style' | 'children' | 'label' | 'valueLabel'
> {
  /** Visible label above the track.  Pass `aria-label` instead when there is no room for one. */
  label?: ReactNode;
  /**
   * Value text shown at the end of the label row and announced with the bar, for example
   * "4 of 10 files".  Without it, the percentage is shown and announced instead.
   */
  valueLabel?: string;
  className?: string;
}

/**
 * Progress of one operation.  The track keeps a fixed height whether the bar is determinate or
 * not, so a value that changes never moves the layout around it.
 */
export function ProgressBar({ label, valueLabel, className, ...rest }: ProgressBarProps) {
  // The label row only exists when there is something to put in it; a bare bar is just a track.
  const hasHeader = label != null || valueLabel != null;
  return (
    <AriaProgressBar {...rest} valueLabel={valueLabel} className={cx('rio-progress-bar', className)}>
      {({ percentage, valueText, isIndeterminate }) => (
        <>
          {hasHeader ? (
            <div className="rio-progress-bar__header">
              {label == null ? null : <Label className="rio-progress-bar__label">{label}</Label>}
              {valueText == null ? null : <span className="rio-progress-bar__value">{valueText}</span>}
            </div>
          ) : null}
          <div className="rio-progress-bar__track">
            {isIndeterminate ? (
              <span className="rio-progress-bar__segment" />
            ) : (
              <span className="rio-progress-bar__fill" style={{ inlineSize: `${percentage ?? 0}%` }} />
            )}
          </div>
        </>
      )}
    </AriaProgressBar>
  );
}

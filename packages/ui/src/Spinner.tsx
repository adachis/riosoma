import { useLingui } from '@lingui/react/macro';
import { cx } from './cx';
import './Spinner.css';

export interface SpinnerProps {
  /** Accessible name.  Defaults to a translated "Loading"; pass one when the wait is specific. */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * The pending indicator on its own, the same ring a busy Button shows.  It is an indeterminate
 * progress bar, so assistive technology announces the label instead of a value.
 */
export function Spinner({ label, size = 'md', className }: SpinnerProps) {
  const { t } = useLingui();
  return (
    <span
      className={cx('rio-spinner', className)}
      data-size={size}
      role="progressbar"
      aria-label={label ?? t({ id: 'ui.spinner.loading', message: 'Loading' })}
    >
      <span className="rio-spinner__ring" aria-hidden="true" />
    </span>
  );
}

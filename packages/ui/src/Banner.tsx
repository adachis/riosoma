import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { useId, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';
import { TONE_ICON, isUrgent, type Tone } from './tone';
import './Banner.css';

export interface BannerProps {
  tone?: Tone;
  /** Short heading for the notice. */
  title?: ReactNode;
  /** Replaces the tone's icon, or leaves it out with `null`.  Icons are decorative here, since
   * the text carries the meaning. */
  icon?: IconDefinition | null;
  /**
   * Shows a dismiss button and is called when the reader presses it.  The banner takes itself off
   * the page; give it a new `key` when the message it shows is replaced.
   */
  onDismiss?: () => void;
  className?: string;
  /** The body of the notice. */
  children?: ReactNode;
}

/**
 * A page-level notice that sits in the flow of the document.  It never floats and never covers
 * content: a warning or danger banner is an assertive live region, so it is read as soon as it
 * appears, while info and success wait for a pause in what the reader is doing.  The tone is the
 * banner's variant, so it styles through `data-variant` like every other component.
 */
export function Banner({ tone = 'info', title, icon, onDismiss, className, children }: BannerProps) {
  const { t } = useLingui();
  const titleId = useId();
  const [isDismissed, setIsDismissed] = useState(false);
  const toneIcon = icon === undefined ? TONE_ICON[tone] : icon;

  if (isDismissed) return null;

  return (
    <div
      className={cx('rio-banner', className)}
      data-variant={tone}
      role={isUrgent(tone) ? 'alert' : 'status'}
      aria-labelledby={title == null ? undefined : titleId}
    >
      {toneIcon == null ? null : <Icon icon={toneIcon} className="rio-banner__icon" />}
      <div className="rio-banner__text">
        {title == null ? null : (
          <span id={titleId} className="rio-banner__title">
            {title}
          </span>
        )}
        {children == null ? null : <div className="rio-banner__body">{children}</div>}
      </div>
      {onDismiss == null ? null : (
        <Button
          variant="quiet"
          size="sm"
          icon={faXmark}
          className="rio-banner__dismiss"
          aria-label={t({ id: 'ui.banner.dismiss', message: 'Dismiss' })}
          onPress={() => {
            setIsDismissed(true);
            onDismiss();
          }}
        />
      )}
    </div>
  );
}

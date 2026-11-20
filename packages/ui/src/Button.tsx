import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { cx } from './cx';
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ButtonTooltipContext } from './button-tooltip-context';
import './Button.css';
const ButtonTooltip = lazy(() => import('./ButtonTooltip'));

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'style' | 'children'> {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Leading icon; decorative, since the label names the button */
  icon?: IconDefinition;
  /**
   * One of the screen's primary actions, such as its navigation or its view controls.  On phones
   * it grows to a comfortable touch target (`--rio-target-primary`), and elsewhere it keeps its
   * size.  Primary buttons and a dialog's footer buttons grow the same way without it.
   */
  primaryAction?: boolean;
  /** Custom visual content can request the same tooltip as a library icon. */
  tooltip?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The standard button.  While `isPending` the label stays in place but hidden, so the button keeps
 * its size, and presses are ignored until the work finishes.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  primaryAction,
  tooltip,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const iconOnly = Boolean(icon && children == null);
  const dragSurface = 'data-sortable-surface' in rest;
  const providedTooltip = useContext(ButtonTooltipContext);
  const label = rest['aria-label'];
  const needsTooltip = Boolean((iconOnly || tooltip) && label && !providedTooltip);
  const anchor = useRef<HTMLButtonElement>(null);
  const attach = useCallback(
    (button: HTMLButtonElement | null) => {
      anchor.current = button;
      const cleanup = typeof ref === 'function' ? ref(button) : undefined;
      if (ref && typeof ref !== 'function') ref.current = button;
      return () => {
        anchor.current = null;
        if (typeof cleanup === 'function') cleanup();
        else if (typeof ref === 'function') ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const hoverDelay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTooltip = useCallback(() => {
    clearTimeout(hoverDelay.current);
    setTooltipOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(hoverDelay.current), []);
  useEffect(() => {
    if (!tooltipOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTooltip();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [tooltipOpen, closeTooltip]);
  const button = (
    <AriaButton
      {...rest}
      ref={attach}
      onPressStart={(event) => {
        if (dragSurface) event.continuePropagation();
        rest.onPressStart?.(event);
      }}
      onPressEnd={(event) => {
        if (dragSurface) event.continuePropagation();
        rest.onPressEnd?.(event);
      }}
      onPress={(event) => {
        closeTooltip();
        rest.onPress?.(event);
      }}
      onHoverStart={(event) => {
        rest.onHoverStart?.(event);
        if (needsTooltip) {
          clearTimeout(hoverDelay.current);
          hoverDelay.current = setTimeout(() => setTooltipOpen(true), 600);
        }
      }}
      onHoverEnd={(event) => {
        rest.onHoverEnd?.(event);
        closeTooltip();
      }}
      onFocus={(event) => {
        rest.onFocus?.(event);
        if (needsTooltip) {
          clearTimeout(hoverDelay.current);
          hoverDelay.current = setTimeout(() => setTooltipOpen(true), 600);
        }
      }}
      onBlur={(event) => {
        rest.onBlur?.(event);
        closeTooltip();
      }}
      className={cx('rio-button', className)}
      data-variant={variant}
      data-size={size}
      data-primary-action={primaryAction || undefined}
      data-icon-only={iconOnly || undefined}
      data-tooltip={iconOnly || tooltip || providedTooltip ? label : undefined}
    >
      {rest.isPending ? <span className="rio-button__spinner" aria-hidden="true" /> : null}
      <span className="rio-button__content">
        {icon ? <Icon icon={icon} /> : null}
        {children}
      </span>
    </AriaButton>
  );
  return (
    <>
      {button}
      {needsTooltip && label && tooltipOpen ? (
        <Suspense fallback={null}>
          <ButtonTooltip anchor={anchor} label={label} close={closeTooltip} />
        </Suspense>
      ) : null}
    </>
  );
}

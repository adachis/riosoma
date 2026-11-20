import {
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipProps as AriaTooltipProps,
  type TooltipTriggerComponentProps as AriaTooltipTriggerProps,
} from 'react-aria-components';
import { cx } from './cx';
import './Tooltip.css';
import { ButtonTooltipContext } from './button-tooltip-context';
import { Children, cloneElement, isValidElement, type ReactElement } from 'react';

/** Long enough that a pointer passing over a control does not pop a tooltip on the way by. */
const DEFAULT_DELAY = 600;

export interface TooltipTriggerProps extends Omit<AriaTooltipTriggerProps, 'delay'> {
  /** Milliseconds of hover or focus before the tooltip appears.  Defaults to 600. */
  delay?: number;
}

/**
 * Pairs a control with its tooltip.  The trigger and the tooltip are the two children, in that
 * order; React Aria wires the hover, focus, and escape behavior between them.
 */
export function TooltipTrigger({ delay = DEFAULT_DELAY, children, ...props }: TooltipTriggerProps) {
  const triggers = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const trigger = child as ReactElement<{ 'aria-label'?: string; 'data-tooltip'?: string }>;
    return trigger.props['aria-label']
      ? cloneElement(trigger, { 'data-tooltip': trigger.props['aria-label'] })
      : child;
  });
  return (
    <ButtonTooltipContext.Provider value>
      <AriaTooltipTrigger {...props} delay={delay}>
        {triggers}
      </AriaTooltipTrigger>
    </ButtonTooltipContext.Provider>
  );
}

export interface TooltipProps extends Omit<AriaTooltipProps, 'className' | 'style'> {
  className?: string;
}

/**
 * A short description of one control.  It floats above every other layer and inverts the theme's
 * colors, so it reads as an annotation of the page rather than a part of it.
 */
export function Tooltip({ className, offset = 4, ...props }: TooltipProps) {
  return (
    <AriaTooltip
      {...props}
      // Rounded overlay coordinates must not overlap a trigger with fractional bounds.
      offset={offset}
      className={cx('rio-tooltip', className)}
      // React Aria gives every positioned overlay an inline z-index of 100000, popovers included, so
      // the token alone left a tooltip behind the popover its control sits in.  The token goes on
      // top of that layer and keeps the tooltip above everything else.
      style={{ zIndex: 'calc(100000 + var(--rio-z-tooltip))' }}
    />
  );
}

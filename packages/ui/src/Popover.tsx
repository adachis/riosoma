import {
  OverlayArrow as AriaOverlayArrow,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  type PopoverRenderProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import './Popover.css';

export interface PopoverProps extends Omit<AriaPopoverProps, 'className' | 'children'> {
  /** Draws the pointer that ties the surface to its trigger.  Decorative. */
  arrow?: boolean;
  className?: string;
  children?: ReactNode | ((values: PopoverRenderProps) => ReactNode);
}

/**
 * A surface anchored to a trigger, for filters, row details, and short forms that don't warrant a
 * modal.  Placement props (`placement`, `offset`, `shouldFlip`, `containerPadding`, and the rest)
 * go straight through, so the surface flips and slides to stay inside the viewport.
 *
 * Use it with a trigger that supplies the anchor and the open state, such as React Aria's
 * `DialogTrigger`.  Without a nested dialog of its own the surface is exposed as one.
 */
export function Popover({ arrow = false, className, children, ...rest }: PopoverProps) {
  return (
    <AriaPopover {...rest} className={cx('rio-popover', className)}>
      {(values: PopoverRenderProps) => (
        <>
          {arrow ? (
            <AriaOverlayArrow className="rio-popover__arrow">
              <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                <path d="M0 12 L6 1 L12 12 Z" />
              </svg>
            </AriaOverlayArrow>
          ) : null}
          <div className="rio-popover__content">
            {typeof children === 'function' ? children(values) : children}
          </div>
        </>
      )}
    </AriaPopover>
  );
}

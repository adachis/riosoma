import {
  Modal as AriaModal,
  ModalOverlay as AriaModalOverlay,
  type ModalOverlayProps as AriaModalProps,
  type ModalRenderProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import './Modal.css';

/** Where the panel sits: in the middle of the viewport, or as a sheet against the inline end. */
export type ModalVariant = 'centered' | 'drawer';

/** Inline size of a centered panel.  The drawer variant uses `--rio-dock-width` instead. */
export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps extends Omit<AriaModalProps, 'className' | 'children'> {
  variant?: ModalVariant;
  size?: ModalSize;
  /**
   * For the drawer variant: the edge it slides in from.  Defaults to the inline end.  `bottom` is a
   * phone's sheet, as wide as the screen and as tall as its content, rising from the block end.
   */
  side?: 'start' | 'end' | 'bottom';
  /** Extra class on the panel. */
  className?: string;
  /** Extra class on the scrim behind the panel. */
  overlayClassName?: string;
  children?: ReactNode | ((values: ModalRenderProps) => ReactNode);
}

/**
 * A panel over a scrim.  React Aria supplies the behavior: focus is trapped inside, focus returns
 * to the trigger on close, Escape dismisses, and `isDismissable` decides whether a press on the
 * scrim dismisses too.  Put a `Dialog` inside so the overlay is exposed as one accessible dialog.
 *
 * `style` lands on the scrim, `className` on the panel.
 */
export function Modal({
  variant = 'centered',
  size = 'md',
  side = 'end',
  className,
  overlayClassName,
  children,
  ...rest
}: ModalProps) {
  return (
    <AriaModalOverlay
      {...rest}
      data-variant={variant}
      data-side={variant === 'drawer' ? side : undefined}
      className={cx('rio-modal-overlay', overlayClassName)}
    >
      <AriaModal
        data-variant={variant}
        data-side={variant === 'drawer' ? side : undefined}
        // The drawer takes its inline size from the dock token, so no size is advertised for it.
        data-size={variant === 'drawer' ? undefined : size}
        className={cx('rio-modal', className)}
      >
        {children}
      </AriaModal>
    </AriaModalOverlay>
  );
}

import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  Dialog as AriaDialog,
  Heading,
  type DialogProps as AriaDialogProps,
  type DialogRenderProps,
  type HeadingProps,
} from 'react-aria-components';
import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { Button } from './Button';
import { cx } from './cx';
import './Dialog.css';

export interface DialogProps extends AriaDialogProps {
  /**
   * Leaves out the close button, for dialogs that have to be answered through their own actions
   * rather than put aside.
   */
  hideCloseButton?: boolean;
}

/**
 * The content of a modal: a title, a body that scrolls when it grows taller than the viewport, and
 * a footer for actions.  Render it inside a `Modal`, which supplies the scrim and the dismissal.
 *
 * A close button sits in the top inline-end corner unless `hideCloseButton` is set.  Children may
 * be a function that receives `close`, the same way React Aria's own Dialog works.
 */
export function Dialog({ className, hideCloseButton, children, ...rest }: DialogProps) {
  const { t } = useLingui();
  return (
    <AriaDialog {...rest} className={cx('rio-dialog', className)}>
      {(values: DialogRenderProps) => (
        <>
          {hideCloseButton ? null : (
            <Button
              className="rio-dialog__close"
              variant="quiet"
              size="sm"
              primaryAction
              icon={faXmark}
              aria-label={t({ id: 'ui.dialog.close', message: 'Close' })}
              onPress={values.close}
            />
          )}
          {typeof children === 'function' ? children(values) : children}
        </>
      )}
    </AriaDialog>
  );
}

export type DialogTitleProps = Omit<HeadingProps, 'slot'>;

/** Names the dialog for assistive technology; `slot="title"` is what wires that up. */
export function DialogTitle({ className, ...rest }: DialogTitleProps) {
  return <Heading {...rest} slot="title" className={cx('rio-dialog__title', className)} />;
}

export type DialogBodyProps = HTMLAttributes<HTMLDivElement>;

/** The scrolling region of a dialog.  Headers and footers stay put while it moves. */
export function DialogBody({ className, tabIndex, children, ...rest }: DialogBodyProps) {
  const body = useRef<HTMLDivElement>(null);
  const [focusable, setFocusable] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || tabIndex !== undefined) return;
    let frame = 0;
    const update = () => {
      const controls = [
        ...element.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]'),
      ];
      const hasControl = controls.some(
        (control) =>
          control.tabIndex >= 0 &&
          !control.matches(':disabled') &&
          !control.closest('[hidden], [aria-hidden="true"], [inert]') &&
          getComputedStyle(control).display !== 'none',
      );
      setFocusable(
        !hasControl &&
          (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const content = new MutationObserver(schedule);
    content.observe(element, { childList: true, subtree: true, attributes: true, characterData: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      content.disconnect();
    };
  }, [tabIndex]);
  return (
    <div
      {...rest}
      ref={body}
      tabIndex={tabIndex ?? (focusable ? 0 : undefined)}
      className={cx('rio-dialog__body', className)}
    >
      {children}
    </div>
  );
}

export type DialogFooterProps = HTMLAttributes<HTMLDivElement>;

/** Actions for a dialog, aligned to the inline end where readers expect the primary one. */
export function DialogFooter({ className, ...rest }: DialogFooterProps) {
  return <div {...rest} className={cx('rio-dialog__footer', className)} />;
}

import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  type UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
  type ToastRegionProps as AriaToastRegionProps,
} from 'react-aria-components';
import { Button } from './Button';
import { cx } from './cx';
import { TONE_ICON } from './tone';
import './Toast.css';

import { toastQueue, type ToastMessage } from './ToastQueue';
export {
  toast,
  toastQueue,
  createToastQueue,
  createToastApi,
  type ToastMessage,
  type ToastShowOptions,
  type ToastApi,
} from './ToastQueue';

export interface ToastRegionProps extends Omit<
  AriaToastRegionProps<ToastMessage>,
  'children' | 'className' | 'queue'
> {
  /** The queue to render.  Defaults to the queue `toast` writes to. */
  queue?: ToastQueue<ToastMessage>;
  className?: string;
}

/**
 * Mounts once, near the root of the app, and renders whatever the queue holds in the block-end
 * inline-end corner.  React Aria pauses a toast's timer while the pointer or the keyboard is on
 * the region, so nothing disappears while it is being read.  The tone is a toast's variant, so it
 * styles through `data-variant` like every other component.
 */
export function ToastRegion({
  queue = toastQueue,
  'aria-label': ariaLabel,
  className,
  ...rest
}: ToastRegionProps) {
  const { t } = useLingui();
  return (
    <AriaToastRegion
      {...rest}
      queue={queue}
      aria-label={ariaLabel ?? t({ id: 'ui.toast.region', message: 'Notifications' })}
      className={cx('rio-toast-region', className)}
    >
      {({ toast: queued }) => (
        <AriaToast toast={queued} className="rio-toast" data-variant={queued.content.tone}>
          <AriaToastContent className="rio-toast__content">
            <Icon icon={TONE_ICON[queued.content.tone]} className="rio-toast__icon" />
            <span className="rio-toast__text">
              <Text slot="title" className="rio-toast__title">
                {queued.content.title}
              </Text>
              {queued.content.description == null ? null : (
                <Text slot="description" className="rio-toast__description">
                  {queued.content.description}
                </Text>
              )}
            </span>
          </AriaToastContent>
          {queued.content.action ? (
            <Button
              size="sm"
              className="rio-toast__action"
              onPress={() => {
                queued.content.action?.onPress();
                queue.close(queued.key);
              }}
            >
              {queued.content.action.label}
            </Button>
          ) : null}
          <Button
            slot="close"
            variant="quiet"
            size="sm"
            icon={faXmark}
            className="rio-toast__close"
            aria-label={t({ id: 'ui.toast.close', message: 'Dismiss' })}
          />
        </AriaToast>
      )}
    </AriaToastRegion>
  );
}

import type { ReactNode } from 'react';
import { UNSTABLE_ToastQueue as ToastQueue } from 'react-aria-components';
import { isUrgent, type Tone } from './tone';

/** What one toast shows. */
export interface ToastMessage {
  title: ReactNode;
  description?: ReactNode;
  tone: Tone;
  /** One optional button, such as Update or Undo.  Pressing it also dismisses the toast. */
  action?: { label: ReactNode; onPress: () => void };
}

export interface ToastShowOptions extends ToastMessage {
  /**
   * Milliseconds before the toast dismisses itself.  Info and success default to 5 s; warning and
   * danger stay until the reader dismisses them.  Pass 0 to keep any toast.
   */
  timeout?: number;
}

export interface ToastApi {
  /** Queues a toast and returns the key that dismisses it. */
  show(options: ToastShowOptions): string;
  /** Removes the toast with this key. */
  dismiss(key: string): void;
}

/** Info and success are news about something that already worked; the reader can miss them. */
const AUTO_DISMISS_AFTER = 5000;

/** Enough to follow a run of events, few enough that the stack stays inside its corner. */
const MAX_VISIBLE_TOASTS = 4;

/** The queue the whole app shares.  Mount one `<ToastRegion />` to show what lands in it. */
export const toastQueue = new ToastQueue<ToastMessage>({ maxVisibleToasts: MAX_VISIBLE_TOASTS });

/** A queue with the app's limits, for a screen that wants its own corner of toasts. */
export function createToastQueue(): ToastQueue<ToastMessage> {
  return new ToastQueue<ToastMessage>({ maxVisibleToasts: MAX_VISIBLE_TOASTS });
}

/**
 * Binds the toast API to a queue.  Callers use the exported `toast`; the gallery and tests bind
 * their own queue so their toasts stay out of the app's.
 */
export function createToastApi(queue: ToastQueue<ToastMessage>): ToastApi {
  return {
    show({ title, description, tone, timeout, action }) {
      const ms = timeout ?? (isUrgent(tone) ? 0 : AUTO_DISMISS_AFTER);
      return queue.add({ title, description, tone, ...(action ? { action } : {}) }, { timeout: ms });
    },
    dismiss(key) {
      queue.close(key);
    },
  };
}

/** Shows a toast in the corner of the screen and returns the key that dismisses it. */
export const toast = createToastApi(toastQueue);

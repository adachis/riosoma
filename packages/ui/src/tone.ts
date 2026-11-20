import {
  faCircleCheck,
  faCircleExclamation,
  faCircleInfo,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@riosoma/icons';

/**
 * The meanings a feedback surface can carry.  Toasts and banners share them, so the same news
 * looks and behaves the same wherever it shows up.
 */
export type Tone = 'info' | 'success' | 'warning' | 'danger';

/** Every tone has its own icon, so the meaning survives when color cannot carry it. */
export const TONE_ICON: Record<Tone, IconDefinition> = {
  info: faCircleInfo,
  success: faCircleCheck,
  warning: faTriangleExclamation,
  danger: faCircleExclamation,
};

/**
 * Whether a tone demands attention: warning and danger stay until the reader dismisses them and
 * are announced as soon as they appear, while info and success are transient.
 */
export function isUrgent(tone: Tone): boolean {
  return tone === 'warning' || tone === 'danger';
}

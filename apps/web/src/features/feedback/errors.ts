import { FEEDBACK_LIMITS, type FeedbackClientError } from '@riosoma/contracts';
import { isAssetLoadError, isPageLeaving } from '../../asset-recovery';

/**
 * The page's last few errors, kept in memory so feedback can say what went wrong just before
 * someone wrote in.  Only an error's message and stack are kept, never the error itself or
 * anything it carried, and the message loses anything quoted, any address, and any number long
 * enough to be someone's data before it's kept.  Nothing here outlives the page.
 */

const kept: FeedbackClientError[] = [];

/** An email address, a quoted run of text, or a long number, each of which could be a value. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const QUOTED = /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g;
const NUMBER = /\d{5,}/g;

function clip(text: string, length: number): string {
  const characters = Array.from(text);
  return characters.length <= length ? text : `${characters.slice(0, length - 1).join('')}…`;
}

/** A message with anything that could be someone's data taken out. */
export function scrubMessage(message: string): string {
  return clip(
    message.replace(EMAIL, '[email]').replace(QUOTED, '[…]').replace(NUMBER, '[number]').trim(),
    FEEDBACK_LIMITS.errorMessageLength,
  );
}

/** A stack's frames, with each script's address cut down to its path so no search or fragment goes. */
export function scrubStack(stack: string): string {
  const lines = stack
    .split('\n')
    .map((line) => line.replace(/\b(https?:\/\/[^\s)?#]+)[?#][^\s):]*/g, '$1').replace(EMAIL, '[email]'))
    // The first line of a V8 stack repeats the message, which is kept already and scrubbed there.
    .filter((line) => /^\s*at\s|@/.test(line));
  return clip(lines.join('\n'), FEEDBACK_LIMITS.errorStackLength);
}

/** Keeps an error's message and stack, dropping the oldest once there are 20. */
export function recordClientError(error: unknown): void {
  let message: string;
  let stack: string | undefined;
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`;
    stack = typeof error.stack === 'string' ? error.stack : undefined;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = typeof error;
  }
  const entry: FeedbackClientError = { message: scrubMessage(message) };
  const frames = stack ? scrubStack(stack) : '';
  if (frames) entry.stack = frames;
  kept.push(entry);
  if (kept.length > FEEDBACK_LIMITS.errors) kept.splice(0, kept.length - FEEDBACK_LIMITS.errors);
}

/** The errors kept so far, oldest first, as copies. */
export function recentClientErrors(): FeedbackClientError[] {
  return kept.map((entry) => ({ ...entry }));
}

/** Forgets every error kept, for tests. */
export function clearClientErrors(): void {
  kept.length = 0;
}

let installed = false;

/** Starts keeping the page's uncaught errors and unhandled rejections. */
export function installErrorCapture(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (event: Event) => {
    const { error, message } = event as ErrorEvent;
    if (isPageLeaving() && isAssetLoadError(error)) return;
    recordClientError(error ?? message);
  });
  target.addEventListener('unhandledrejection', (event: Event) => {
    const { reason } = event as PromiseRejectionEvent;
    if (isPageLeaving() && isAssetLoadError(reason)) return;
    recordClientError(reason);
  });
}

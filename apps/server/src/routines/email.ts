import { AppError } from '@riosoma/contracts';
import type { Mailer, MailMessage } from '../mail/index.js';

/**
 * Email a routine sends.  The subject and body are written by the model, so they're treated as
 * plain text: the body is escaped, never read as Markdown or markup, so nothing it read can add a
 * link or markup that looks like it came from anyone else.  Every message says which routine sent
 * it and whose it is.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

export interface RoutineEmail {
  to: string[];
  subject: string;
  body: string;
}

export function routineMessage(
  email: RoutineEmail,
  to: string,
  routine: { name: string; ownerName: string },
): MailMessage {
  const subject = email.subject
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 200);
  const footer = `Rio sent this for “${routine.name},” a routine ${routine.ownerName} set up in Riosoma.`;
  const text = `${email.body.trim()}\n\n--\n${footer}`;
  const paragraphs = email.body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`);
  // Paragraph text and the entire footer are escaped before adding fixed markup.
  // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
  const html = `<div>${paragraphs.join('')}<hr><p>${escapeHtml(footer)}</p></div>`;
  return { to, subject, text, html };
}

/** The longest one message may take to send before it's given up on */
export const SEND_TIMEOUT_MS = 30_000;

/** A send that stopped partway, saying who already got the message. */
export class RoutineEmailError extends AppError {
  constructor(
    messageKey: string,
    readonly sent: string[],
    total: number,
  ) {
    super('unavailable', messageKey, { params: { sent: sent.length, total } });
  }
}

/**
 * Resolves as `work` does, unless `signal` aborts first or `ms` passes, which rejects: with the
 * signal's reason, or with a timeout.  The work itself may go on, but nothing waits for it.
 */
export function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => reject(new AppError('unavailable', 'routines.email.timeout')), ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/**
 * Sends one message to each recipient in turn, each bounded by `timeoutMs` and by `signal`.  A
 * failure stops there and says who already got it, so nobody is sent it twice by trying again.
 */
export async function sendRoutineEmail(
  mailer: Mailer | null | undefined,
  email: RoutineEmail,
  routine: { name: string; ownerName: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  if (!mailer) throw new AppError('unavailable', 'routines.email.unavailable');
  const sent: string[] = [];
  for (const address of email.to) {
    const limit = Math.max(1, Math.min(SEND_TIMEOUT_MS, options.timeoutMs ?? SEND_TIMEOUT_MS));
    try {
      await bounded(mailer.send(routineMessage(email, address, routine)), options.signal, limit);
    } catch (error) {
      // Stopped by the run's time limit, or a slow or failed send: either way, say who got it.
      throw new RoutineEmailError(
        error instanceof AppError && error.messageKey === 'routines.email.timeout'
          ? 'routines.email.timeout'
          : 'routines.email.failed',
        sent,
        email.to.length,
      );
    }
    sent.push(address);
  }
  return sent;
}

/** Whether two recipient lists name exactly the same addresses. */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((address) => address.toLowerCase()).sort();
  const right = [...b].map((address) => address.toLowerCase()).sort();
  return left.every((address, index) => address === right[index]);
}

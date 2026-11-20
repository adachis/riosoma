/**
 * What the Google live suites share: the settings a person puts in the environment, read here once,
 * so each suite runs when its own are set and skips when they aren't.  Nothing here, and no suite
 * that reads them, prints a key or a webhook address, since both are credentials of a sort:
 *
 * - `RIOSOMA_TEST_GOOGLE_SA_KEY`: a service account's whole JSON key, as Google hands it out, whose
 *   Google Workspace domain delegates the Gmail send scope to it
 * - `RIOSOMA_TEST_GMAIL_SENDER`: a mailbox in that domain the service account acts for, which the
 *   mail suite sends from and, since it sends to nobody else, to
 * - `RIOSOMA_TEST_GOOGLE_CHAT_WEBHOOK_URL`: an incoming webhook a person added to a Chat space,
 *   since only a person can add one
 */

/** The text every message a suite sends starts with, so a stray one is easy to find and delete. */
export const TEST_PREFIX = 'rio_test_';

const value = (name: string) => process.env[name]?.trim() || undefined;

export const liveGoogleKey = () => value('RIOSOMA_TEST_GOOGLE_SA_KEY');
export const liveGmailSender = () => value('RIOSOMA_TEST_GMAIL_SENDER');
export const liveChatWebhook = () => value('RIOSOMA_TEST_GOOGLE_CHAT_WEBHOOK_URL');

/** Waits `ms`, for services that finish their work a moment after they answer. */
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks `check` until it gives a value, or gives up after `ms`. */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  ms: number,
  every = 3_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error(`gave up waiting after ${ms} ms`);
    await pause(every);
  }
}

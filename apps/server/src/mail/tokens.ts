/**
 * The short-lived tokens three of the transports sign in with, kept in memory until shortly before
 * they expire so a send never carries a dead one and a burst of messages asks for a token once.
 */

/** A token and the moment it stops working, in milliseconds since the epoch. */
export interface TokenGrant {
  value: string;
  expiresAt: number;
}

/** How much earlier a token is fetched again than its expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long a token lasts when the service doesn't say: the hour they all hand out. */
const DEFAULT_LIFETIME_MS = 3_600_000;

/** A call that answers with a token, fetching a new one when the one it holds is nearly spent. */
export function cachedToken(
  getToken: () => Promise<TokenGrant>,
  now: () => number = Date.now,
): () => Promise<string> {
  let current: TokenGrant | null = null;
  let pending: Promise<TokenGrant> | null = null;
  return async () => {
    if (current && current.expiresAt - REFRESH_MARGIN_MS > now()) return current.value;
    // One request at a time, so a hundred messages waiting don't ask for a hundred tokens.
    pending ??= getToken()
      .then((grant) => {
        current = grant;
        return grant;
      })
      .finally(() => {
        pending = null;
      });
    return (await pending).value;
  };
}

/**
 * A token answer's value and expiry, from the `access_token` and `expires_in` every service here
 * answers with, or null when it gave no token.
 */
export function tokenGrantOf(answer: Record<string, unknown>, now: number): TokenGrant | null {
  const value = answer.access_token;
  if (typeof value !== 'string' || !value) return null;
  const seconds = Number(answer.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_LIFETIME_MS;
  return { value, expiresAt: now + lifetime };
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The token the server shares with the service.  It's given outright, or read from a file the
 * server writes on its first start into storage both share.  Until that file exists the service
 * isn't ready, and it refreshes the token before checking requests, at most once a second,
 * so a token the server replaces takes effect without a restart.
 */
export interface TokenSource {
  /** The token, or null while there isn't one yet */
  current(): string | null;
  /** Whether a request's bearer token is the shared one */
  accepts(presented: string | undefined): boolean;
}

/** The shortest token the service accepts, so a stray empty file never opens it up. */
export const MINIMUM_TOKEN_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function matches(presented: string, token: string): boolean {
  return timingSafeEqual(digest(presented), digest(token));
}

export function fixedToken(token: string): TokenSource {
  if (token.length < MINIMUM_TOKEN_LENGTH) throw new Error('connector service token too short');
  return {
    current: () => token,
    accepts: (presented) => presented !== undefined && matches(presented, token),
  };
}

export function fileToken(path: string, now: () => number = Date.now): TokenSource {
  let token: string | null = null;
  let checked = Number.NEGATIVE_INFINITY;
  const read = () => {
    checked = now();
    try {
      const text = readFileSync(path, 'utf8').trim();
      token = text.length >= MINIMUM_TOKEN_LENGTH ? text : null;
    } catch {
      token = null;
    }
  };
  read();
  return {
    current() {
      if (now() - checked >= 1000) read();
      return token;
    },
    accepts(presented) {
      if (now() - checked >= 1000) read();
      return presented !== undefined && token !== null && matches(presented, token);
    },
  };
}

/** The bearer token in an authorization header, if it has one. */
export function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

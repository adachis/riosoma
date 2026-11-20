import { message } from './messages.js';
import { RioClientError } from './errors.js';

/**
 * The small pieces of encoding and waiting the SDK needs, written against the Web platform's own
 * objects so one build runs in Node.js and in a browser.  Nothing here reaches for a Node.js
 * module: a browser has no `Buffer`, and a library that needs one needs a bundler's polyfill too.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdef';

export function encodeText(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Base64 without padding, and with the two characters that are safe in an address. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let held = 0;
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(held >> bits) & 0x3f]!;
    }
  }
  if (bits > 0) out += ALPHABET[(held << (6 - bits)) & 0x3f]!;
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  return out;
}

/**
 * Whether two hex signatures are the same, reading every character of both whichever way the
 * answer goes, so how long the comparison takes says nothing about where they start to differ.
 */
export function sameHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** The platform's cryptographic randomness, which Node.js 20 and every browser now carry. */
function webCrypto(): Crypto {
  const found = globalThis.crypto;
  if (!found?.getRandomValues)
    throw new RioClientError('This SDK needs the Web Crypto API, which this runtime does not offer.', {
      code: 'client_error',
    });
  return found;
}

/** Random bytes, for a code verifier, a state, and anything else that must not be guessable. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  webCrypto().getRandomValues(bytes);
  return bytes;
}

export async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await subtle().digest('SHA-256', encodeText(value));
  return new Uint8Array(digest);
}

function subtle(): SubtleCrypto {
  const found = webCrypto().subtle;
  if (!found)
    throw new RioClientError('This SDK needs Web Crypto signatures, which this runtime does not offer.', {
      code: 'client_error',
    });
  return found;
}

/** An HMAC-SHA256 of `value` keyed with `secret`, in hex, which is how a webhook signs a call. */
export async function hmacSha256Hex(secret: string, value: string | Uint8Array): Promise<string> {
  const key = await subtle().importKey('raw', encodeText(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hexEncode(
    new Uint8Array(
      await subtle().sign('HMAC', key, typeof value === 'string' ? encodeText(value) : new Uint8Array(value)),
    ),
  );
}

/**
 * Waits, and stops early when the caller gives up.  A wait that ignores its signal would hold a
 * canceled request open for as long as a rate limit asked.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((settle, fail) => {
    if (signal?.aborted) return fail(abortError(signal));
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail(abortError(signal));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      settle();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(message('sdk.request.canceled'), 'AbortError');
}

/** Fails at once when a caller has already given up, before any work is done for them. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

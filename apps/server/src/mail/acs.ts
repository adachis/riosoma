import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { azureServiceToken } from '@riosoma/db';
import { ConfigurationError } from '../configuration-error.js';
import { addressOf } from './addresses.js';
import {
  callOptions,
  jsonOf,
  MailTransportError,
  retryAfterMs,
  sendWithRetries,
  type MailAnswer,
  type MailTransportOptions,
} from './http.js';
import type { AcsSettings } from './settings.js';
import type { Mailer } from './types.js';

/**
 * Azure Communication Services Email, which takes a JSON message and answers with an operation to
 * follow until the send succeeds or fails.  A call is signed with the resource's access key, or
 * carries a token for the server's managed identity when no key is configured, from the same
 * identity code the database and the blob store sign in with.
 */

/** The email API version every call asks for. */
export const ACS_API_VERSION = '2023-03-31';

/** The scope a managed identity token for the email service asks for. */
export const ACS_SCOPE = 'https://communication.azure.com/.default';

/** The headers an access key signature covers, in the order the service reads them. */
export const ACS_SIGNED_HEADERS = 'x-ms-date;host;x-ms-content-sha256';

/** How long a send's operation is followed before the message is given up on. */
export const ACS_POLL_TIMEOUT_MS = 60_000;

/** How often the operation is asked when it doesn't ask to be left longer. */
const ACS_POLL_MS = 1_000;

/**
 * The headers that sign a call with an access key.  The signed string is the method, then the path
 * with its query, then the date, the host, and the body's base64 SHA-256 joined with semicolons:
 *
 *     POST
 *     /emails:send?api-version=2023-03-31
 *     Fri, 26 Sep 2025 12:00:00 GMT;resource.communication.azure.com;47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
 *
 * The key is itself base64, and the signature is the base64 HMAC-SHA256 of that string.  A call
 * with no body signs the hash of an empty one.
 */
export function acsHeaders(
  method: string,
  url: URL,
  body: string,
  date: Date,
  accessKey: string,
): Record<string, string> {
  const hash = createHash('sha256').update(body, 'utf8').digest('base64');
  // The path and query exactly as they're sent, since reading the query back out would re-encode it.
  const path = `${url.pathname}${url.search}`;
  const stamp = date.toUTCString();
  const signed = `${method.toUpperCase()}\n${path}\n${stamp};${url.host};${hash}`;
  const signature = createHmac('sha256', Buffer.from(accessKey, 'base64'))
    .update(signed, 'utf8')
    .digest('base64');
  return {
    'x-ms-date': stamp,
    'x-ms-content-sha256': hash,
    authorization: `HMAC-SHA256 SignedHeaders=${ACS_SIGNED_HEADERS}&Signature=${signature}`,
  };
}

/** An operation document's failure code, which Azure reports inside its error, or nothing. */
function failureCode(document: Record<string, unknown> | null): string {
  const error =
    document && typeof document.error === 'object' && document.error !== null
      ? (document.error as Record<string, unknown>)
      : {};
  const code = typeof error.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9._-]{1,60}$/.test(code) ? ` ${code}` : '';
}

export function acsMailer(settings: AcsSettings, options: MailTransportOptions = {}): Mailer {
  const endpoint = settings.endpoint.replace(/\/+$/, '');
  const sender = addressOf(settings.from);
  // The service sends as a bare address from a verified domain, so a sender it can't use stops here.
  if (!sender)
    throw new ConfigurationError(
      'RIOSOMA_MAIL_FROM',
      'invalid',
      'names no address for the acs mail transport',
    );
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const pollMs = options.pollMs ?? ACS_POLL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? ACS_POLL_TIMEOUT_MS;
  const token = settings.accessKey ? null : (options.token ?? azureServiceToken(ACS_SCOPE));

  /** The managed identity's token, or an error that says the sign-in failed and not what it said. */
  async function identityToken(): Promise<string> {
    try {
      return await token!();
    } catch (error) {
      if (error instanceof MailTransportError) throw error;
      throw new MailTransportError(
        'acs',
        'sign in',
        'the managed identity gave no token for the email service',
        { code: 'no_token', cause: error },
      );
    }
  }

  async function call(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    ok: readonly number[],
    task?: string,
  ): Promise<MailAnswer> {
    return sendWithRetries(
      async () => {
        const target = new URL(url);
        const headers: Record<string, string> = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (settings.accessKey)
          Object.assign(headers, acsHeaders(method, target, body ?? '', new Date(now()), settings.accessKey));
        else headers.authorization = `Bearer ${await identityToken()}`;
        return { method, url: target.href, headers, ...(body === undefined ? {} : { body }) };
      },
      ok,
      'acs',
      callOptions(options, task),
    );
  }

  /** Follows a send's operation until it ends, or until the minute it's allowed to take is up. */
  async function followed(operation: string): Promise<void> {
    const deadline = now() + pollTimeoutMs;
    for (;;) {
      const answer = await call('GET', operation, undefined, [200], 'learn whether the message went');
      const document = jsonOf(answer);
      const status = typeof document?.status === 'string' ? document.status : '';
      if (status === 'Succeeded') return;
      if (status === 'Failed' || status === 'Canceled')
        throw new MailTransportError(
          'acs',
          'send the message',
          `the service reported the send as ${status.toLowerCase()}${failureCode(document)}`,
          { code: 'operation_failed' },
        );
      const left = deadline - now();
      if (left <= 0)
        throw new MailTransportError(
          'acs',
          'send the message',
          `the send was still ${status ? status.toLowerCase() : 'unreported'} after ${Math.round(pollTimeoutMs / 1_000)} seconds`,
          { code: 'operation_timeout' },
        );
      await wait(Math.min(retryAfterMs(answer.headers, now()) ?? pollMs, left));
    }
  }

  return {
    async send(message) {
      const recipient = addressOf(message.to);
      if (!recipient)
        throw new MailTransportError('acs', 'send the message', 'the message names no recipient address');
      const body = JSON.stringify({
        senderAddress: sender.address,
        recipients: {
          to: [
            {
              address: recipient.address,
              ...(recipient.displayName ? { displayName: recipient.displayName } : {}),
            },
          ],
        },
        content: { subject: message.subject, plainText: message.text, html: message.html },
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map(({ filename, contentType, content }) => ({
                name: filename,
                contentType,
                contentInBase64: content.toString('base64'),
              })),
            }
          : {}),
        ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
      });
      const answer = await call(
        'POST',
        `${endpoint}/emails:send?api-version=${ACS_API_VERSION}`,
        body,
        [202],
      );
      const location = answer.headers.get('operation-location');
      // The service names the operation by its whole address, and a path alone is read against the
      // endpoint, the way HTTP reads a relative location.
      const operation =
        location && URL.canParse(location, `${endpoint}/`) ? new URL(location, `${endpoint}/`).href : null;
      if (!operation)
        throw new MailTransportError(
          'acs',
          'send the message',
          'the service accepted the message without an operation to follow',
          { status: answer.status, code: 'no_operation' },
        );
      await followed(operation);
    },
  };
}

import { createHmac } from 'node:crypto';
import { callOptions, sendWithRetries, type MailTransportOptions } from './http.js';
import type { RelaySettings } from './settings.js';
import type { Mailer } from './types.js';

/**
 * A relay of the operator's own: each message is posted to one address as JSON, signed so the relay
 * knows it came from this server and hasn't been altered on the way.  It suits an installation that
 * can open one outbound HTTPS address and nothing else, and a gateway that already talks to a mail
 * service Riosoma has no transport for.
 *
 * The post carries two headers.  `x-riosoma-timestamp` is when it was signed, in Unix seconds, and
 * `x-riosoma-signature` is `v1=` followed by the lowercase hex HMAC-SHA256 of the timestamp, a
 * period, and the exact bytes of the body, keyed with the shared secret as UTF-8:
 *
 *     signature = HMAC-SHA256(secret, "<timestamp>.<body>")
 *
 * A relay checks it by recomputing the same value over the body it received, and refuses a post
 * whose timestamp is further from its own clock than it allows, since the signature alone can't
 * stop a captured post from being sent again.
 */

/** The headers a post is signed with, and the prefix that names the signing scheme. */
export const RELAY_TIMESTAMP_HEADER = 'x-riosoma-timestamp';
export const RELAY_SIGNATURE_HEADER = 'x-riosoma-signature';
export const RELAY_SIGNATURE_PREFIX = 'v1=';

/** The statuses that mean a relay took the message. */
const RELAY_OK = [200, 201, 202, 204];

/** The signature header's value: the scheme, then the hex digest of the timestamp and body. */
export function relaySignature(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `${RELAY_SIGNATURE_PREFIX}${digest}`;
}

export function relayMailer(settings: RelaySettings, options: MailTransportOptions = {}): Mailer {
  const now = options.now ?? Date.now;
  return {
    async send(message) {
      await sendWithRetries(
        async () => {
          const body = JSON.stringify({
            from: settings.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
            ...(message.attachments?.length
              ? {
                  attachments: message.attachments.map(({ filename, contentType, content }) => ({
                    filename,
                    contentType,
                    content: content.toString('base64'),
                  })),
                }
              : {}),
          });
          // Each attempt signs again, so a retry carries the time it's actually sent at.
          const timestamp = String(Math.floor(now() / 1_000));
          return {
            method: 'POST' as const,
            url: settings.url,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'user-agent': 'Riosoma-Mail',
              [RELAY_TIMESTAMP_HEADER]: timestamp,
              [RELAY_SIGNATURE_HEADER]: relaySignature(settings.secret, timestamp, body),
            },
            body,
          };
        },
        RELAY_OK,
        'relay',
        callOptions(options),
      );
    },
  };
}

import {
  callOptions,
  jsonOf,
  MailTransportError,
  sendWithRetries,
  type MailTransportOptions,
} from './http.js';
import { mimeMessage } from './mime.js';
import type { GraphSettings } from './settings.js';
import { cachedToken, tokenGrantOf, type TokenGrant } from './tokens.js';
import type { Mailer } from './types.js';

/**
 * Microsoft Graph, for a mailbox in Exchange Online.  The message goes as its MIME base64-encoded
 * in a `text/plain` body, which is how Graph takes a whole message with its headers and attachment
 * parts, and the call carries an app-only token from the client credentials flow.  The token is
 * kept until shortly before it expires, so a burst of messages asks for one once.
 */

/** The service calls go to, and the address tokens come from. */
export const GRAPH_URL = 'https://graph.microsoft.com';

/**
 * The scope an app-only token asks for: Graph's own, whose `.default` carries the application
 * permissions consented to the app, `Mail.Send` among them.  It names Graph itself even when calls
 * go to another address, since the token is for Graph wherever it's carried.
 */
export const GRAPH_SCOPE = `${GRAPH_URL}/.default`;

/** The token address of a tenant, where the client credentials flow is answered. */
export function graphTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function graphMailer(settings: GraphSettings, options: MailTransportOptions = {}): Mailer {
  const service = (options.endpoint ?? GRAPH_URL).replace(/\/+$/, '');
  const tokenUrl = options.tokenUrl ?? graphTokenUrl(settings.tenantId);
  const now = options.now ?? Date.now;
  const token =
    options.token ??
    cachedToken(async (): Promise<TokenGrant> => {
      const body = new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: GRAPH_SCOPE,
        grant_type: 'client_credentials',
      }).toString();
      const answer = await sendWithRetries(
        async () => ({
          method: 'POST',
          url: tokenUrl,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
        }),
        [200],
        'graph',
        callOptions(options, 'sign in'),
      );
      const grant = tokenGrantOf(jsonOf(answer) ?? {}, now());
      if (!grant)
        throw new MailTransportError('graph', 'sign in', 'the token answer carried no access token', {
          status: answer.status,
          code: 'no_token',
        });
      return grant;
    }, now);
  return {
    async send(message) {
      const mime = await mimeMessage(message, settings.from, new Date(now()));
      await sendWithRetries(
        async () => ({
          method: 'POST',
          url: `${service}/v1.0/users/${encodeURIComponent(settings.sender)}/sendMail`,
          headers: {
            'content-type': 'text/plain',
            accept: 'application/json',
            authorization: `Bearer ${await token()}`,
          },
          body: mime.toString('base64'),
        }),
        [202],
        'graph',
        callOptions(options),
      );
    },
  };
}

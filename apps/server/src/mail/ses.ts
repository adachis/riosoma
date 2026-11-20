import { payloadHash, signAwsRequest } from '@riosoma/connectors/s3';
import {
  awsCredentials,
  AwsCredentialsError,
  type AwsCredentialOptions,
  type AwsCredentialSource,
} from '../shared/aws-credentials.js';
import { addressOf } from './addresses.js';
import { callOptions, MailTransportError, sendWithRetries, type MailTransportOptions } from './http.js';
import { mimeMessage } from './mime.js';
import type { SesSettings } from './settings.js';
import type { Mailer } from './types.js';

/**
 * Amazon SES v2, which sends the message as raw MIME inside one JSON call to its regional
 * endpoint, signed with Signature Version 4.  The keys come from the settings, or from the task's or
 * instance's own role when they're absent, so an installation on AWS needs no long-lived secret.
 */

/** The service name requests are signed for, and the path its send call is at. */
export const SES_SERVICE = 'ses';
export const SES_SEND_PATH = '/v2/email/outbound-emails';

/** The address of the region's email service. */
export function sesEndpoint(region: string): string {
  return `https://email.${region}.amazonaws.com`;
}

function credentialOptions(settings: SesSettings, options: MailTransportOptions): AwsCredentialOptions {
  // The environment comes from the settings, which the server's configuration module captured.
  const env = options.env ?? settings.roleEnvironment;
  return {
    ...(env ? { env } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.containerUrl ? { containerUrl: options.containerUrl } : {}),
    ...(options.metadataUrl ? { metadataUrl: options.metadataUrl } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

export function sesMailer(settings: SesSettings, options: MailTransportOptions = {}): Mailer {
  const endpoint = (options.endpoint ?? sesEndpoint(settings.region)).replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const keys: AwsCredentialSource =
    options.credentials ??
    awsCredentials(
      { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      credentialOptions(settings, options),
    );
  const sender = addressOf(settings.from)?.address ?? settings.from;
  return {
    async send(message) {
      const mime = await mimeMessage(message, settings.from, new Date(now()));
      // The call's own addresses are bare, since SES refuses a name that isn't MIME-encoded there.
      // The names people see ride in the MIME's own From and To, which the composer encodes.
      const body = JSON.stringify({
        Content: { Raw: { Data: mime.toString('base64') } },
        Destination: { ToAddresses: [addressOf(message.to)?.address ?? message.to] },
        FromEmailAddress: sender,
      });
      await sendWithRetries(
        async () => {
          const url = new URL(`${endpoint}${SES_SEND_PATH}`);
          const credentials = await keys().catch((error: unknown) => {
            // The chain's own reason names the place it looked and never a key, so it's said too.
            const reason = error instanceof AwsCredentialsError ? ` (${error.reason})` : '';
            throw new MailTransportError(
              'ses',
              'send the message',
              `the server has no AWS keys to sign with${reason}`,
              { code: 'no_credentials', cause: error },
            );
          });
          return {
            method: 'POST' as const,
            url: url.href,
            body,
            headers: signAwsRequest({
              method: 'POST',
              url,
              region: settings.region,
              service: SES_SERVICE,
              credentials,
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              now: new Date(now()),
              hash: payloadHash(body),
            }),
          };
        },
        [200],
        'ses',
        callOptions(options),
      );
    },
  };
}

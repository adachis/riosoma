import { isIP } from 'node:net';
import { AppError, webhookUrlProblem } from '@riosoma/contracts';
import { allowsPrivate as allowsPrivateUnder, bare, isLocalhost, isPublicAddress } from '@riosoma/connectors';
import type { RuntimeConfig } from '../config.js';

/**
 * Where webhooks may send.  Addresses use https, except `http://localhost` while developing, and
 * never point at a private network unless the operator allows private hosts.  Delivery checks
 * every address a name resolves to as well, since a public name can point anywhere.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export { bare, isLocalhost };

/** Whether a call to this address may reach a private network. */
export function allowsPrivate(url: string, config: Config): boolean {
  return allowsPrivateUnder(url, config);
}

function refuse(key: string): never {
  throw new AppError('validation_failed', key, { fields: { url: key } });
}

/** The address to store, or a refusal saying what's wrong with it. */
export function checkedUrl(value: string, config: Config): string {
  const problem = webhookUrlProblem(value);
  if (problem === 'credentials') refuse('webhooks.url.credentials');
  if (problem) refuse('webhooks.url.invalid');
  const url = new URL(value.trim());
  const local = isLocalhost(url.hostname);
  if (url.protocol !== 'https:' && !(local && !config.production)) refuse('webhooks.url.https');
  const host = bare(url.hostname);
  if (!allowsPrivate(url.href, config) && (local || (isIP(host) && !isPublicAddress(host))))
    refuse('webhooks.url.private');
  // A fragment never reaches the receiver, so it isn't kept.
  url.hash = '';
  return url.href;
}

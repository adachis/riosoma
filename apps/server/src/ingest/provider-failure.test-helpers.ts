import { ProviderError, type ProviderFailure } from '@riosoma/ai';
import { expect } from 'vitest';

export const failureCases = [
  { label: '401', messageKey: 'ai.provider.unauthorized', status: 401, cause: 'ProviderError' },
  { label: '403', messageKey: 'ai.provider.unauthorized', status: 403, cause: 'ProviderError' },
  { label: 'rate limit', messageKey: 'ai.provider.rateLimited', status: 429, cause: 'ProviderError' },
  { label: 'server failure', messageKey: 'ai.provider.unavailable', status: 503, cause: 'ProviderError' },
  { label: 'connection refused', messageKey: 'ai.provider.unavailable', cause: 'ECONNREFUSED' },
  { label: 'name lookup', messageKey: 'ai.provider.unavailable', cause: 'ENOTFOUND' },
  { label: 'socket timeout', messageKey: 'ai.provider.unavailable', cause: 'ETIMEDOUT' },
  { label: 'network isolation', messageKey: 'ai.provider.unavailable', cause: 'TEST_NETWORK_ISOLATED' },
  { label: 'idle timeout', messageKey: 'ai.provider.timeout', cause: 'TimeoutError' },
  { label: 'unexpected error', messageKey: 'ai.provider.unavailable', cause: 'TypeError' },
  {
    label: 'gateway request size',
    messageKey: 'ai.gateway.requestTooLarge',
    status: 413,
    cause: 'ProviderError',
  },
  {
    label: 'gateway request buffer',
    messageKey: 'ai.gateway.requestBufferTooSmall',
    status: 400,
    cause: 'ProviderError',
  },
  {
    label: 'gateway model restriction',
    messageKey: 'ai.gateway.modelRestricted',
    status: 400,
    cause: 'ProviderError',
  },
] satisfies Array<ProviderFailure & { label: string }>;

export function failureFor(test: ProviderFailure, privateText: string): Error {
  if (test.cause === 'TypeError') return new TypeError(privateText);
  const cause =
    test.cause === 'ProviderError'
      ? undefined
      : new TypeError(privateText, {
          cause:
            test.cause === 'TimeoutError'
              ? new DOMException(privateText, 'TimeoutError')
              : Object.assign(new Error(privateText), { code: test.cause }),
        });
  return new ProviderError(test.messageKey, test.status, privateText, false, undefined, { cause });
}

export function expectPrivateLog(
  calls: readonly unknown[][],
  feature: 'builder' | 'study' | 'aiReader',
  providerId: string,
  test: ProviderFailure,
  privateValues: string[],
): void {
  expect(calls).toEqual([
    [
      {
        feature,
        providerId,
        messageKey: test.messageKey,
        cause: test.cause,
        ...('status' in test ? { status: test.status } : {}),
      },
      'ingest.modelCallFailed',
    ],
  ]);
  const log = JSON.stringify(calls);
  for (const value of privateValues) expect(log).not.toContain(value);
}

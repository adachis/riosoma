import type { ProviderFailure } from '@riosoma/ai';
import type { FastifyBaseLogger } from 'fastify';

/** Diagnostics contain identifiers only, never provider details or model input. */
export function logModelFailure(
  logger: Pick<FastifyBaseLogger, 'warn'>,
  feature: 'builder' | 'study' | 'aiReader',
  providerId: string,
  failure: ProviderFailure,
): void {
  logger.warn({ feature, providerId, ...failure }, 'ingest.modelCallFailed');
}

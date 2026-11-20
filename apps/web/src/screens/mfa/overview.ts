import { queryOptions } from '@tanstack/react-query';
import type { MfaOverview } from '@riosoma/contracts';
import { api } from '../../api';

/**
 * The signed-in person's own second steps.  Sign-in and security shows them, and anything that
 * adds a way in reads them to know whether to ask for a fresh one first.
 */
export const mfaOverviewQuery = queryOptions({
  queryKey: ['me', 'mfa'],
  queryFn: ({ signal }) => api<MfaOverview>('/api/me/mfa', { signal }),
});

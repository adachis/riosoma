import { queryOptions } from '@tanstack/react-query';
import type { SecondStepStatus } from '@riosoma/contracts';
import { api } from '../../api';

/**
 * The sign-in waiting on a second step in this browser, if any.  The sign-in page reads it, so a
 * reload, an emailed link, or an invitation all land on the same second step.
 */
export const secondStepQuery = queryOptions({
  queryKey: ['auth', 'second-step'],
  queryFn: ({ signal }) => api<SecondStepStatus>('/api/auth/second-step', { signal }),
  retry: false,
});

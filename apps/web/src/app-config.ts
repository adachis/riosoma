import { queryOptions } from '@tanstack/react-query';
import type { AppConfig } from '@riosoma/contracts';
import { api } from './api';

/**
 * Settings from the server's environment, such as the map style.  They change only when the
 * server restarts with new settings, so the app reads them once.
 */
export const appConfigQuery = queryOptions({
  queryKey: ['app-config'],
  queryFn: () => api<AppConfig>('/api/config'),
  staleTime: Infinity,
});

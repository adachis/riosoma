import type { DatabaseSummary } from '@riosoma/contracts';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Every database the person can open.  Home lists them and the palette offers them, so both read
 * the same cache entry and a database created in one place shows up in the other.
 */
export const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: ({ signal }) => api<DatabaseSummary[]>('/api/databases', { signal }),
});

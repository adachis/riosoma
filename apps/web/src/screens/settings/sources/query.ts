import { queryOptions } from '@tanstack/react-query';
import type { SourceMeta } from '@riosoma/contracts';
import { api } from '../../../api';

/**
 * One cache entry for the organization's sources.  The list reads it and every dialog that saves,
 * tests, or deletes one invalidates it, so the last test and the table count stay true.
 */
export const SOURCES_KEY = ['sources'] as const;

export const sourcesQuery = queryOptions({
  queryKey: SOURCES_KEY,
  queryFn: () => api<SourceMeta[]>('/api/sources'),
});

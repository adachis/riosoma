import { useQuery } from '@tanstack/react-query';
import type { AiFieldsStatus } from '@riosoma/contracts';
import { api } from '../../api';

/**
 * Why AI fields can't run in the organization, as a server message key, or null when they can.
 * Undefined while it's being asked, so nothing is offered or refused before the answer arrives.
 */
export function useAiUnavailable(tableId: string): string | null | undefined {
  const query = useQuery({
    queryKey: ['ai-fields', 'status', tableId],
    queryFn: () => api<AiFieldsStatus>(`/api/tables/${tableId}/ai-fields`),
    staleTime: 30_000,
    retry: false,
  });
  return query.data?.unavailable;
}

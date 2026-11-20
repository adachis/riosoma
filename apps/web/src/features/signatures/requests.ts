import type { SignatureRequestSummary } from '@riosoma/contracts';
import { api } from '../../api';
import { isDemoSession } from '../../demo';

/** Both record consumers use the same list, including its empty demo state. */
export function signatureRequestsQuery(tableId: string, recordId: string) {
  return {
    queryKey: ['signature-requests', tableId, recordId],
    queryFn: async (): Promise<{ requests: SignatureRequestSummary[] }> =>
      isDemoSession()
        ? { requests: [] }
        : api(`/api/tables/${tableId}/records/${recordId}/signature-requests`),
  };
}

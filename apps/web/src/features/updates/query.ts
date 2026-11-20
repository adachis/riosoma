import type { SessionInfo, UpdateStatus } from '@riosoma/contracts';
import { api } from '../../api';

export const UPDATES_KEY = ['admin', 'updates'];
/**
 * Whether someone runs the server: the owner or an organization admin.  Only they see update
 * notices.  The server also checks that it's the organization that set it up.
 */
export function runsServer(session: SessionInfo | null): boolean {
  return session?.membership.kind === 'owner' || Boolean(session?.membership.adminRoles.length);
}

export const updatesQuery = {
  queryKey: UPDATES_KEY,
  queryFn: ({ signal }: { signal?: AbortSignal }) =>
    api<UpdateStatus>('/api/admin/updates', signal ? { signal } : {}),
};

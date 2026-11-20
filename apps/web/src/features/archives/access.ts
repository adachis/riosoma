import type { SessionInfo } from '@riosoma/contracts';

/**
 * Organization admins: the owner, and anyone holding an administrator's role.  They save
 * templates for everyone and choose how automatic snapshots work, as the server decides too.
 */
export function isOrgAdmin(session: SessionInfo | null): boolean {
  const membership = session?.membership as SessionInfo['membership'] | undefined;
  return membership?.kind === 'owner' || Boolean(membership?.adminRoles.length);
}

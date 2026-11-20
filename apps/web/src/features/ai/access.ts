import type { SessionInfo } from '@riosoma/contracts';

export function canManageAi(session: SessionInfo | null): boolean {
  return session?.membership.kind === 'owner' || Boolean(session?.membership.adminRoles.includes('ai'));
}

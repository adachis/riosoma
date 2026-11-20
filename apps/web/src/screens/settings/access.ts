import type { SessionInfo } from '@riosoma/contracts';

export function canManageSso(session: SessionInfo | null): boolean {
  return session?.membership.kind === 'owner' || Boolean(session?.membership.adminRoles.includes('security'));
}

export function canManageSources(session: SessionInfo | null): boolean {
  return (
    session?.membership.kind === 'owner' ||
    Boolean(
      session?.membership.adminRoles.includes('data_sources') ||
      session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('data_sources')),
    )
  );
}

export function canManageIntegrations(session: SessionInfo | null): boolean {
  return (
    session?.membership.kind === 'owner' || Boolean(session?.membership.adminRoles.includes('integrations'))
  );
}

export const canManageSignInPolicy = canManageSso;

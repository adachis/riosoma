import { demoPreferences, setDemoSession } from './demo';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { OrgSettings, SessionInfo, SetupStatus } from '@riosoma/contracts';
import { api, ApiError, setCsrfToken } from './api';
import { createContext, useContext } from 'react';

const retryStartup = (count: number, error: Error) =>
  !(error instanceof ApiError && (error.status === 0 || error.info.userFault)) && count < 2;

export const setupStatusQuery = queryOptions({
  queryKey: ['setup', 'status'],
  queryFn: () => api<SetupStatus>('/api/setup/status'),
  // Startup must reach its recovery screen even when the browser already knows it is offline.
  networkMode: 'always',
  retry: retryStartup,
  staleTime: Infinity,
});

/** The signed-in person, or null when nobody is. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  networkMode: 'always',
  retry: retryStartup,
  queryFn: async (): Promise<SessionInfo | null> => {
    try {
      const session = await api<SessionInfo>('/api/auth/session');
      setDemoSession(session);
      if (session.demo) session.preferences = await demoPreferences(session.preferences);
      setCsrfToken(session.csrfToken);
      return session;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setDemoSession(null);
        setCsrfToken(null);
        return null;
      }
      throw error;
    }
  },
  staleTime: 5 * 60_000,
});

// The expired page keeps its identity and draft until the same person signs back in.
export const RetainedSession = createContext<SessionInfo | null>(null);

export function sameSessionIdentity(left: SessionInfo, right: SessionInfo): boolean {
  return (
    left.user.id === right.user.id &&
    left.org.id === right.org.id &&
    Boolean(left.demo) === Boolean(right.demo)
  );
}

export function useSession(): SessionInfo | null {
  const retained = useContext(RetainedSession);
  const live = useQuery(sessionQuery).data;
  // A retained page cannot render another identity while the shell clears and reloads it.
  if (retained && live && !sameSessionIdentity(retained, live)) return retained;
  return live ?? retained;
}

/**
 * The settings that apply to the signed-in person: their unit's defaults and limits where the
 * organization has units, and otherwise the organization's own.  Only the organization's own, in
 * `org.settings`, are ever shown or saved as the organization's.
 */
export function appliedSettings(session: SessionInfo | null | undefined): OrgSettings | undefined {
  return session?.effectiveSettings ?? session?.org.settings;
}

/**
 * Managing people is for an organization's owner and the members it gives that role to.  It lives
 * here rather than on the screen that shows the list, so anything that hides the way in (the
 * settings navigation, the palette) asks the same question.
 */
export function canManagePeople(session: SessionInfo | null): boolean {
  return (
    session?.membership.kind === 'owner' ||
    Boolean(
      session?.membership.adminRoles.includes('people') ||
      session?.membership.unitAdminGrants?.some((grant) => grant.roles.includes('people')),
    )
  );
}

/**
 * Everyone signed in with an account of their own can hold personal access tokens.  A guest
 * doesn't have one, so there is nothing for the API to act as.  Settings and the palette both ask
 * this, so neither offers a way in that leads nowhere.
 */
export function canUseTokens(session: SessionInfo | null): boolean {
  return session !== null && !session.demo && session.membership.kind !== 'guest';
}

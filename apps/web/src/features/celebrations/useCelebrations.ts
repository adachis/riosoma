import { useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { SessionInfo } from '@riosoma/contracts';
import { sessionQuery } from '../../session';
import { celebrations, type CelebrationOutcome, type CelebrationRequest } from './engine';
import type { CelebrationName } from './registry';
import { celebrationLevel } from './settings';

type Extra = Pick<CelebrationRequest, 'anchor' | 'cause'>;

export interface Celebrate {
  /** Something the app watched happen */
  celebrate(name: CelebrationName, key: string, extra?: Extra): CelebrationOutcome;
  /** A state the app read, and whether it has reached the celebration's line */
  observe(name: CelebrationName, key: string, reached: boolean, extra?: Extra): CelebrationOutcome;
  /** A line crossed some other way, which uses the celebration up without showing it */
  retire(name: CelebrationName, key: string): CelebrationOutcome;
}

/**
 * The signed-in person as the app last heard, read when it's needed rather than watched, so a
 * screen doesn't render again for it.  Null where nobody is signed in, and where there's no query
 * client at all, as in a test of one component.
 */
export function useSignedIn(): () => SessionInfo | null {
  const client = useContext(QueryClientContext);
  return useMemo(
    () => () => client?.getQueryData<SessionInfo | null>(sessionQuery.queryKey) ?? null,
    [client],
  );
}

/**
 * How a screen reports milestones.  It speaks for the signed-in person with their setting as it is
 * at that moment, and does nothing where nobody is signed in, such as a page shared by link.
 */
export function useCelebrations(): Celebrate {
  const signedIn = useSignedIn();
  return useMemo<Celebrate>(() => {
    const person = () => {
      const session = signedIn();
      const userId = session?.user?.id;
      return userId ? { userId, level: celebrationLevel(session.preferences) } : null;
    };
    return {
      celebrate: (name, key, extra) => {
        const who = person();
        return who ? celebrations.celebrate(name, { ...who, key, ...extra }) : 'off';
      },
      observe: (name, key, reached, extra) => {
        const who = person();
        return who ? celebrations.observe(name, { ...who, key, reached, ...extra }) : 'off';
      },
      retire: (name, key) => {
        const who = person();
        return who ? celebrations.retire(name, { userId: who.userId, key }) : 'off';
      },
    };
  }, [signedIn]);
}

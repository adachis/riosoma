import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderSharing, session } from './screens/database/share/testing';
import { RetainedSession, sessionQuery, useSession } from './session';

afterEach(cleanup);

function Identity() {
  const current = useSession();
  return <output>{`${current?.org.id}:${current?.user.id}`}</output>;
}

it.each(['person', 'organization'])(
  'does not adopt a different %s into a retained page',
  async (difference) => {
    const { client } = renderSharing(
      <RetainedSession.Provider value={session}>
        <Identity />
      </RetainedSession.Provider>,
    );
    await act(async () => client.setQueryData(sessionQuery.queryKey, null));
    const other =
      difference === 'person'
        ? { ...session, user: { ...session.user, id: 'other-user' } }
        : { ...session, org: { ...session.org, id: 'other-organization' } };
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, other);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('status').textContent).toBe(`${session.org.id}:${session.user.id}`);
  },
);

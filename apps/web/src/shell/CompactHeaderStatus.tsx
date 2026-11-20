import { useQuery } from '@tanstack/react-query';
import { UpdateNotice } from '../features/updates/UpdateNotice';
import { runsServer, updatesQuery } from '../features/updates/query';
import { useSession } from '../session';
import { HeaderOverflow } from './HeaderOverflow';

/** The compact header offers an overflow only when it has a status control to show. */
export function CompactHeaderStatus() {
  const session = useSession();
  const allowed = runsServer(session);
  const updates = useQuery({
    ...updatesQuery,
    enabled: allowed,
    staleTime: 60 * 60_000,
    refetchInterval: 60 * 60_000,
  });
  if (!(allowed && updates.data?.available.length)) return null;
  return (
    <HeaderOverflow>
      <UpdateNotice />
    </HeaderOverflow>
  );
}

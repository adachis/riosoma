import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SummaryBlock } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { DashboardDataStore, personTimeZone, REFRESH_DELAY } from '../dashboards/data';

/**
 * A page's number and chart blocks, loaded and refreshed the way a dashboard's tiles are, from the
 * interface's own data route.
 */
export function useSummaryData(
  session: DatabaseSession,
  interfaceId: string,
  pageId: string,
  blocks: readonly SummaryBlock[],
  delay = REFRESH_DELAY,
) {
  const store = useMemo(
    () =>
      new DashboardDataStore(session, interfaceId, personTimeZone(), delay, (blockIds, timeZone, signal) =>
        session
          .interfaceData(interfaceId, { pageId, blockIds, timeZone }, signal)
          .then((data) => ({ tiles: data.blocks })),
      ),
    [session, interfaceId, pageId, delay],
  );
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  useEffect(() => {
    store.setTiles(blocks);
  }, [store, blocks]);
  const states = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { states, retry: (blockId: string) => store.retry(blockId) };
}

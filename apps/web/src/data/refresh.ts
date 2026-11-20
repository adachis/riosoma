import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Invalidates a query and reads it again, so a change shows at once instead of waiting for the
 * query's next scheduled read.
 *
 * An invalidation that lands while a query with nothing read yet is being fetched is answered from
 * that fetch, which began before the change and so cannot carry it.  Asking again once it lands
 * reads what the change left behind.  A query that already holds something is canceled and read
 * again by the first invalidation, so this asks only once.
 */
export async function invalidateNow(cache: QueryClient, queryKey: QueryKey): Promise<void> {
  // Three asks are enough for a read that another change keeps landing inside, and the loop ends
  // even if a query is fetched by something else the whole time.
  for (let ask = 0; ask < 3; ask++) {
    const fetching = cache.isFetching({ queryKey }) > 0;
    await cache.invalidateQueries({ queryKey });
    if (!fetching) return;
  }
}

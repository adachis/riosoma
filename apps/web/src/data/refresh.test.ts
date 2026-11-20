import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { invalidateNow } from './refresh';

/** Lets a query's notifications and cache writes land before the test looks at them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A query someone watches, whose every read the test answers when it chooses, so a read can still
 * be running while a change lands.
 */
function watched(cache: QueryClient, key: readonly string[]) {
  const answers: Array<(value: string) => void> = [];
  const observer = new QueryObserver(cache, {
    queryKey: key,
    queryFn: () =>
      new Promise<string>((settle) => {
        answers.push(settle);
      }),
  });
  const stop = observer.subscribe(() => undefined);
  return { answers, reads: () => answers.length, stop };
}

it('reads a query again when its first read began before the change', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { answers, reads, stop } = watched(cache, ['home']);
  expect(reads()).toBe(1);

  const refreshed = invalidateNow(cache, ['home']);
  // The read already running answers the invalidation with what it fetched before the change, so a
  // second read has to follow it.
  answers[0]!('before the change');
  await settle();
  expect(reads()).toBe(2);
  answers[1]!('after the change');
  await refreshed;
  expect(cache.getQueryData(['home'])).toBe('after the change');
  expect(cache.getQueryState(['home'])?.fetchStatus).toBe('idle');
  stop();
});

it('reads a query once when nothing is running', async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cache.setQueryData(['home'], 'what the last read found');
  const { answers, reads, stop } = watched(cache, ['home']);
  expect(reads()).toBe(0);
  const refreshed = invalidateNow(cache, ['home']);
  answers[0]!('after the change');
  await refreshed;
  expect(reads()).toBe(1);
  expect(cache.getQueryData(['home'])).toBe('after the change');
  stop();
});

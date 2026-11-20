import { act, cleanup, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHomeDropPreview } from './HomeArrangement';
import { renderHome } from './test-support';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('batches hundreds of preflights, publishes refusals, and discards obsolete results', async () => {
  vi.useFakeTimers();
  const pending: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  const revision = {};
  const requests = vi.fn(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
  function Previews({ version }: { version: object }) {
    const check = useHomeDropPreview();
    return (
      <>
        {Array.from({ length: 300 }, (_, index) => {
          const result = check(version, String(index), requests, String);
          return (
            <span key={index} data-testid={`preview-${index}`}>
              {result.pending ? 'Pending' : (result.reason ?? 'Allowed')}
            </span>
          );
        })}
      </>
    );
  }
  const committed = vi.fn();
  const tree = (version: object) => (
    <Profiler id="previews" onRender={committed}>
      <Previews version={version} />
    </Profiler>
  );
  const view = renderHome(tree(revision));
  expect(requests).toHaveBeenCalledTimes(300);
  await act(async () => {
    for (const request of pending.slice(0, 100)) request.resolve();
  });
  expect(committed).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(committed).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('preview-0').textContent).toBe('Allowed');
  await act(async () => {
    pending[100]!.reject('Access changed');
    for (const request of pending.slice(101, 299)) request.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByTestId('preview-100').textContent).toBe('Access changed');
  expect(requests).toHaveBeenCalledTimes(300);
  view.rerender(tree({}));
  expect(requests).toHaveBeenCalledTimes(600);
  await act(async () => {
    pending[299]!.resolve();
  });
  expect(screen.getByTestId('preview-299').textContent).toBe('Pending');
  await act(async () => {
    for (const request of pending.slice(300)) request.resolve();
  });
  expect(screen.getByTestId('preview-299').textContent).toBe('Allowed');
});

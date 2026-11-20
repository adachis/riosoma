import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readChartLocation, useChartLocation } from './location';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

it('writes only the final camera after a trailing pause and survives history refusals', () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/database/table/view');
  const replace = vi.spyOn(window.history, 'replaceState');
  const { result } = renderHook(() => useChartLocation('view'));
  for (let x = 0; x < 180; x++) {
    act(() => result.current[1]({ x }));
    act(() => vi.advanceTimersByTime(17));
  }
  expect(replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(300));
  expect(replace).toHaveBeenCalledTimes(1);
  expect(readChartLocation(window.location.search, 'view').x).toBe(179);
  replace.mockImplementation(() => {
    throw new DOMException('Rate limit', 'SecurityError');
  });
  act(() => result.current[1]({ x: 200 }));
  expect(() => act(() => vi.advanceTimersByTime(300))).not.toThrow();
});

it('bounds saved collapse state for a chart with thousands of managers', () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/database/table/view');
  const { result } = renderHook(() => useChartLocation('view'));
  act(() =>
    result.current[1]({
      collapsed: Array.from({ length: 3000 }, (_, i) => `rec${String(i).padStart(20, '0')}`),
    }),
  );
  act(() => vi.advanceTimersByTime(300));
  expect(window.location.href.length).toBeLessThan(6000);
});

it('restores public cameras across random stand-in view IDs', () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/v/link123');
  const first = renderHook(() => useChartLocation('viewFirst'));
  act(() => first.result.current[1]({ x: -800, y: 200, zoom: 0.7, search: 'Person' }));
  act(() => vi.advanceTimersByTime(300));
  first.unmount();
  const second = renderHook(() => useChartLocation('viewSecond'));
  expect(second.result.current[0]).toMatchObject({ x: -800, y: 200, zoom: 0.7, search: 'Person' });
});

it('keeps a chart drawn over another page out of that address until it has one of its own', () => {
  vi.useFakeTimers();
  // A plan preview draws a planned view over the page the person is on.
  window.history.replaceState({}, '', '/database/table/viewOne?org=%7B%22view%22%3A%22viewOne%22%7D');
  const { result, rerender } = renderHook(() => useChartLocation('viewTwo'));
  act(() => result.current[1]({ x: -300, zoom: 0.5, search: 'Person' }));
  act(() => vi.advanceTimersByTime(300));
  expect(window.location.search).toBe('?org=%7B%22view%22%3A%22viewOne%22%7D');
  expect(result.current[0]).toMatchObject({ x: -300, zoom: 0.5, search: 'Person' });
  act(() => window.history.pushState({}, '', '/database/table/viewTwo'));
  rerender();
  act(() => vi.advanceTimersByTime(300));
  expect(readChartLocation(window.location.search, 'viewTwo')).toMatchObject({ x: -300, zoom: 0.5 });
});

it('keeps the chart address when record navigation removes the query', () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/database/table/view');
  const { result, rerender } = renderHook(() => useChartLocation('view'));
  act(() => result.current[1]({ x: -900, search: 'Person' }));
  act(() => vi.advanceTimersByTime(300));
  const saved = window.location.search;
  act(() => window.history.pushState({}, '', '/database/table/view/record'));
  rerender();
  act(() => vi.advanceTimersByTime(300));
  expect(window.location.pathname).toBe('/database/table/view/record');
  expect(window.location.search).toBe(saved);
  act(() => window.history.pushState({}, '', '/database/table/view'));
  rerender();
  act(() => vi.advanceTimersByTime(300));
  expect(window.location.search).toBe(saved);
});

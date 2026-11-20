import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveIndicator } from './SaveIndicator';
import { renderShell } from './test-support';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SaveIndicator', () => {
  it('offers a keyboard retry after authentication recovers with pending changes', async () => {
    const retry = vi.fn();
    renderShell(
      <SaveIndicator state={{ status: 'error', pending: 1, retryRequired: true }} onRetry={retry} />,
    );
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Retry unsaved changes' })).toBe(document.activeElement);
    await userEvent.keyboard('{Enter}');
    expect(retry).toHaveBeenCalledOnce();
  });
  it('announces saving and retries politely, keeps idle empty', () => {
    const { rerender } = renderShell(<SaveIndicator state={{ status: 'saving', pending: 1 }} />);
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('progressbar', { hidden: true })).toBeDefined();
    rerender(<SaveIndicator state={{ status: 'error', pending: 1 }} />);
    expect(screen.getByRole('status').textContent).toBe('Retrying…');
    rerender(<SaveIndicator state={{ status: 'idle', pending: 0 }} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('fades saved after two seconds and starts fresh for the next save', () => {
    vi.useFakeTimers();
    const { rerender, container } = renderShell(<SaveIndicator state={{ status: 'saved', pending: 0 }} />);
    const message = () => container.querySelector('.rio-db-save__message');
    expect(screen.getByRole('status').textContent).toBe('Saved');
    act(() => vi.advanceTimersByTime(1999));
    expect(message()?.hasAttribute('data-faded')).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(message()?.getAttribute('data-faded')).toBe('true');
    expect(container.querySelectorAll('.rio-db-save__measure')).toHaveLength(5);
    rerender(<SaveIndicator state={{ status: 'saving', pending: 1 }} />);
    rerender(<SaveIndicator state={{ status: 'saved', pending: 0 }} />);
    expect(message()?.hasAttribute('data-faded')).toBe(false);
  });

  it.each([1, 3])('shows a keyboard-accessible tooltip for %i pending changes', async (pending) => {
    renderShell(<SaveIndicator state={{ status: 'offline', pending }} />);
    expect(screen.getByRole('status').textContent).toBe('Offline');
    await userEvent.tab();
    expect(screen.getByRole('tooltip').textContent).toBe(
      pending === 1 ? '1 change waits to be saved.' : '3 changes wait to be saved.',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

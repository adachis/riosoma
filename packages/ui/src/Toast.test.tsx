import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toast, toastQueue } from './Toast';
import { render } from './test/render';

/** Moves the clock and lets React flush what the timers did. */
async function elapse(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Toast', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    user = userEvent.setup({ delay: null });
    act(() => {
      toastQueue.clear();
    });
  });

  afterEach(() => {
    act(() => {
      toastQueue.clear();
    });
    vi.useRealTimers();
  });

  it('renders nothing while the queue is empty', () => {
    render(<ToastRegion />);
    expect(screen.queryByRole('region')).toBe(null);
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('shows the title, the description, and a way out', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({
        title: 'Query saved',
        description: 'It runs every night at 02:00.',
        tone: 'success',
      });
    });

    const shown = screen.getByRole('alertdialog', { name: 'Query saved' });
    expect(shown.getAttribute('data-variant')).toBe('success');
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('It runs every night at 02:00.');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    // The icon repeats the tone, so the text alone carries the meaning.
    expect(shown.querySelector('.rio-toast__icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('dismisses from the keyboard', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Query saved', tone: 'success', timeout: 0 });
    });

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('dismisses info and success on their own after five seconds', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Nightly backup finished', tone: 'success' });
    });

    await elapse(4999);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await elapse(1);
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('waits for the reader on warning and danger', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disk almost full', tone: 'warning' });
      toast.show({ title: 'Replication stopped', tone: 'danger' });
    });

    await elapse(60_000);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(2);
  });

  it('takes the timeout from the caller', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Replica caught up', tone: 'danger', timeout: 1000 });
    });

    await elapse(999);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await elapse(1);
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('holds the timer while the pointer is over the toast', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Nightly backup finished', tone: 'info', timeout: 2000 });
    });

    await user.hover(screen.getByRole('alertdialog'));
    await elapse(10_000);
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await user.unhover(screen.getByRole('alertdialog'));
    await elapse(2000);
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('holds the timer while the toast has focus', async () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Nightly backup finished', tone: 'info', timeout: 2000 });
    });

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));
    await elapse(10_000);
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    // Focus leaving the region lets the timer run down.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await elapse(2000);
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('dismisses by key', () => {
    render(<ToastRegion />);
    let key = '';
    act(() => {
      key = toast.show({ title: 'Nightly backup finished', tone: 'info', timeout: 0 });
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    act(() => {
      toast.dismiss(key);
    });
    expect(screen.queryByRole('alertdialog')).toBe(null);
  });

  it('stacks the newest toast first and caps the stack', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'First event', tone: 'info', timeout: 0 });
      toast.show({ title: 'Second event', tone: 'danger', timeout: 0 });
    });

    const shown = screen.getAllByRole('alertdialog');
    expect(shown).toHaveLength(2);
    expect(shown[0]?.textContent).toContain('Second event');
    expect(shown[1]?.textContent).toContain('First event');

    act(() => {
      for (let i = 0; i < 6; i += 1) toast.show({ title: `Event ${i}`, tone: 'info', timeout: 0 });
    });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(4);
  });
});

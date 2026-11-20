import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { createRef } from 'react';

describe('Button', () => {
  it('shares its mounted button with an object ref and clears it on unmount', () => {
    const ref = createRef<HTMLButtonElement>();
    const { unmount } = render(<Button ref={ref} icon={faPlus} aria-label="Add" />);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Add' }));
    unmount();
    expect(ref.current).toBeNull();
  });

  it('shares its mounted button with a callback ref and runs its cleanup', () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const { unmount } = render(<Button ref={ref} icon={faPlus} aria-label="Add" />);
    expect(ref).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Add' }));
    unmount();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('clears callback refs that do not return cleanup on unmount', () => {
    const ref = vi.fn();
    const { unmount } = render(<Button ref={ref}>Cancel</Button>);
    expect(ref).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Cancel' }));
    unmount();
    expect(ref).toHaveBeenLastCalledWith(null);
  });

  it('cancels pending tooltips after a hovered control receives focus and is pressed', async () => {
    vi.useFakeTimers();
    try {
      await import('./ButtonTooltip');
      const user = userEvent.setup({ delay: null });
      render(<Button icon={faPlus} aria-label="Add" />);
      const button = screen.getByRole('button', { name: 'Add' });
      fireEvent.pointerMove(button);
      await user.hover(button);
      await user.click(button);
      await user.unhover(button);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('is named by its label and fires onPress', async () => {
    const onPress = vi.fn();
    render(
      <Button icon={faPlus} onPress={onPress}>
        Add
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Add' });
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledOnce();
    // The icon is decorative next to a visible label.
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks a primary action, which grows to a touch target on phones, and nothing else', () => {
    render(
      <>
        <Button primaryAction icon={faPlus} aria-label="Add" />
        <Button>Cancel</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('data-primary-action')).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('data-primary-action')).toBe(false);
  });

  it('ignores presses while pending and keeps its label for assistive tech', async () => {
    const onPress = vi.fn();
    render(
      <Button isPending onPress={onPress}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    await userEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-pending')).toBe(true);
  });
});

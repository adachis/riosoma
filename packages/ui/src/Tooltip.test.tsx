import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Tooltip, TooltipTrigger, type TooltipTriggerProps } from './Tooltip';
import { render } from './test/render';

type TriggerProps = Omit<TooltipTriggerProps, 'children'>;

function Example(props: TriggerProps = {}) {
  return (
    <TooltipTrigger {...props}>
      <Button>Run</Button>
      <Tooltip>Runs the query</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * React Aria only counts a hover as a pointer interaction once the pointer has moved, which a
 * synthetic enter event on its own does not do.
 */
function pointAt(element: Element) {
  fireEvent.pointerMove(element);
}

/** Lets the shared warm-up between tooltips expire, so each case starts from a cold tooltip. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
}

describe('Tooltip', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    user = userEvent.setup({ delay: null });
  });

  afterEach(async () => {
    await settle();
    vi.useRealTimers();
  });

  it('stays hidden until the pointer rests on the trigger', async () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    expect(screen.queryByRole('tooltip')).toBe(null);

    pointAt(trigger);
    await user.hover(trigger);
    expect(screen.queryByRole('tooltip')).toBe(null);

    // 600ms is long enough that a pointer crossing the control does not open the tooltip.
    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    expect(screen.queryByRole('tooltip')).toBe(null);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Runs the query');
  });

  it('opens at once for the keyboard and describes the trigger', async () => {
    render(<Example />);
    await user.tab();

    const trigger = screen.getByRole('button', { name: 'Run' });
    const tooltip = screen.getByRole('tooltip');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('closes on Escape and keeps focus on the trigger', async () => {
    render(<Example />);
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBe(null);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run' }));
  });

  it('closes when the pointer leaves', async () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    pointAt(trigger);
    await user.hover(trigger);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();

    await user.unhover(trigger);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBe(null);
  });

  it('takes the delay from the caller', async () => {
    render(<Example delay={100} />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    pointAt(trigger);
    await user.hover(trigger);

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('can open on focus alone', async () => {
    render(<Example trigger="focus" />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    pointAt(trigger);
    await user.hover(trigger);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole('tooltip')).toBe(null);

    await user.tab();
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('places the tooltip where the caller asks', async () => {
    render(
      <TooltipTrigger>
        <Button>Compact</Button>
        <Tooltip placement="bottom">Rewrites the table in place</Tooltip>
      </TooltipTrigger>,
    );
    await user.tab();

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.getAttribute('data-placement')).toBe('bottom');
    // The token goes above the layer React Aria gives popovers, so a tooltip inside one shows.
    expect(tooltip.style.zIndex).toBe('calc(100000 + var(--rio-z-tooltip))');
  });

  it('can be switched off without touching the trigger', async () => {
    render(<Example isDisabled />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    pointAt(trigger);
    await user.hover(trigger);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBe(null);
    expect(trigger.getAttribute('aria-describedby')).toBe(null);
  });
});

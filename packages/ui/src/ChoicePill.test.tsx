import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChoicePill } from './ChoicePill';
import { gallery } from './ChoicePill.gallery';

// The pill names its own remove button, which comes from the message catalog, and a case here
// renders it a second time, which the shared render helper does not carry over.
function renderPill(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

const LONG_NAME = 'Deployed to production';

/** The label the pill clips.  It carries the whole name and triggers the tooltip. */
function label(name: string): HTMLElement {
  return screen.getByRole('img', { name });
}

/** happy-dom does no layout, so a test that wants a clipped label gives it widths of its own. */
function clip(element: HTMLElement, textWidth: number, boxWidth: number) {
  Object.defineProperty(element, 'scrollWidth', { value: textWidth, configurable: true });
  Object.defineProperty(element, 'clientWidth', { value: boxWidth, configurable: true });
}

/** Lets the warm-up a tooltip leaves behind expire, so the next case starts from a cold one. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
}

describe('ChoicePill', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    user = userEvent.setup({ delay: null });
  });

  afterEach(async () => {
    await settle();
    vi.useRealTimers();
  });

  it('shows the option name on its color, and no button until one is asked for', () => {
    renderPill(<ChoicePill name="Deployed" color="green" />);

    expect(label('Deployed').textContent).toBe('Deployed');
    const pill = label('Deployed').closest<HTMLElement>('.rio-choice-pill');
    expect(pill?.dataset.color).toBe('green');
    expect(pill?.dataset.size).toBe('md');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('takes the dense size of a grid cell', () => {
    renderPill(<ChoicePill size="sm" name="Deployed" color="blue" />);
    expect(label('Deployed').closest<HTMLElement>('.rio-choice-pill')?.dataset.size).toBe('sm');
  });

  it('removes from the keyboard and from the pointer', async () => {
    const onRemove = vi.fn();
    renderPill(<ChoicePill name="Deployed" color="green" onRemove={onRemove} />);
    const remove = screen.getByRole('button', { name: 'Remove Deployed' });
    // The mark is decorative next to the name the button already carries.
    expect(remove.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    // The label stays out of the tab order, so the button is the pill's one stop.
    await user.tab();
    expect(document.activeElement).toBe(remove);
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledOnce();

    await user.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(2);
  });

  it('keeps the whole name in a tooltip only while the label is cut off', async () => {
    const { rerender } = renderPill(<ChoicePill name={LONG_NAME} color="green" />);
    const trigger = label(LONG_NAME);

    // A name that fits has no reason to repeat itself.
    fireEvent.pointerMove(trigger);
    await user.hover(trigger);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // user-event keeps track of where the pointer is, so it has to leave before it can arrive again.
    await user.unhover(trigger);

    // The same pill in a narrower cell: the text is now wider than the box that clips it.
    clip(trigger, 180, 120);
    rerender(<ChoicePill name={LONG_NAME} color="green" />);
    await settle();
    fireEvent.pointerMove(label(LONG_NAME));
    await user.hover(label(LONG_NAME));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe(LONG_NAME);
    expect(label(LONG_NAME).getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('renders every gallery example', () => {
    for (const example of gallery.examples) {
      const { unmount } = renderPill(<>{example.render()}</>);
      unmount();
    }
    expect(gallery.examples.length).toBeGreaterThan(0);
  });
});

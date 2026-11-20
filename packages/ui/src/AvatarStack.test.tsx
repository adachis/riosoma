import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarStack, type AvatarStackPerson } from './AvatarStack';
import { PersonDirectory } from './Avatar';
import { gallery } from './AvatarStack.gallery';

// The chip names the people behind it, which comes from the message catalog, and a case here
// renders the stack a second time, which the shared render helper does not carry over.
function renderStack(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

const PEOPLE: AvatarStackPerson[] = [
  { id: 'usr1', name: 'Ada Lovelace', color: 'gray' },
  { id: 'usr2', name: 'Grace Hopper', color: 'red' },
  { id: 'usr3', name: 'Alan Turing', color: 'orange' },
  { id: 'usr4', name: 'Katherine Johnson', color: 'yellow' },
  { id: 'usr5', name: 'Edsger Dijkstra', color: 'green' },
  { id: 'usr6', name: 'Barbara Liskov', color: 'teal' },
];

/** The stack itself, the box whose width the examples below talk about. */
function stack(): HTMLElement {
  const found = document.querySelector<HTMLElement>('.rio-avatar-stack');
  if (found == null) throw new Error('No avatar stack was drawn');
  return found;
}

/** The avatars the stack draws, in order; the chip for the rest is not one of them. */
function avatars(): HTMLElement[] {
  return screen
    .getAllByRole('img')
    .filter((element) => !element.classList.contains('rio-avatar-stack__more'));
}

/** The chip that stands in for the people who did not fit. */
function chip(): HTMLElement {
  return screen.getByRole('img', { name: /more/ });
}

/** Lets the warm-up a tooltip leaves behind expire, so the next case starts from a cold one. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
}

/** Rests the pointer on an item until its tooltip opens. */
async function pointAt(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  fireEvent.pointerMove(element);
  await user.hover(element);
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
}

describe('AvatarStack', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers();
    user = userEvent.setup({ delay: null });
  });

  afterEach(async () => {
    await settle();
    vi.useRealTimers();
  });

  it('draws four people and a chip for the rest', () => {
    renderStack(<AvatarStack people={PEOPLE} />);

    expect(avatars().map((avatar) => avatar.getAttribute('aria-label'))).toEqual([
      'AL: Ada Lovelace',
      'GH: Grace Hopper',
      'AT: Alan Turing',
      'KJ: Katherine Johnson',
    ]);
    // The chip says how many are behind it and names every one of them.
    expect(chip().textContent).toBe('+2');
    expect(chip().getAttribute('aria-label')).toBe('2 more: Edsger Dijkstra and Barbara Liskov');
  });

  it('takes the number to show from the caller and drops the chip when everyone fits', () => {
    const { rerender } = renderStack(<AvatarStack people={PEOPLE} max={2} />);
    expect(avatars()).toHaveLength(2);
    expect(chip().textContent).toBe('+4');

    rerender(<AvatarStack people={PEOPLE.slice(0, 3)} />);
    expect(avatars()).toHaveLength(3);
    expect(screen.queryByRole('img', { name: /more/ })).toBeNull();
  });

  it('updates visible and hidden names and status from the live directory', async () => {
    const { rerender } = renderStack(<AvatarStack people={PEOPLE.slice(0, 2)} max={1} />);
    rerender(
      <PersonDirectory.Provider
        value={
          new Map([
            ['usr1', { name: 'Ada Updated', deactivated: true }],
            ['usr2', { name: 'Grace Updated', deactivated: true }],
          ])
        }
      >
        <AvatarStack people={PEOPLE.slice(0, 2)} max={1} />
      </PersonDirectory.Provider>,
    );
    expect(avatars()[0]?.getAttribute('aria-label')).toBe('AU: Ada Updated (deactivated)');
    expect(chip().getAttribute('aria-label')).toBe('1 more: Grace Updated (deactivated)');
    await pointAt(user, avatars()[0]!);
    expect(screen.getByRole('tooltip').textContent).toBe('Ada Updated (deactivated)');
  });

  it('names every avatar in a tooltip of its own', async () => {
    renderStack(<AvatarStack people={PEOPLE} max={2} />);

    await pointAt(user, avatars()[1] as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe('Grace Hopper');
  });

  it('lists the people behind the chip in its tooltip', async () => {
    renderStack(<AvatarStack people={PEOPLE} max={2} />);

    await pointAt(user, chip());
    const tooltip = screen.getByRole('tooltip');
    expect(
      within(tooltip)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Alan Turing', 'Katherine Johnson', 'Edsger Dijkstra', 'Barbara Liskov']);
    expect(chip().getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('keeps every avatar out of the tab order, since each one is named already', async () => {
    renderStack(<AvatarStack people={PEOPLE} />);
    for (const item of stack().children) {
      expect(item.getAttribute('tabindex')).toBe('-1');
    }
    await user.tab();
    expect(stack().contains(document.activeElement)).toBe(false);
  });

  it('draws the same boxes whatever the names are, so the stack never jumps', () => {
    const { rerender } = renderStack(<AvatarStack people={PEOPLE} max={2} />);
    // Every item is a circle of a fixed size, and nothing about a name reaches the layout, so the
    // boxes are the same for short names and for long ones.
    const boxes = () =>
      Array.from(stack().children as HTMLCollectionOf<HTMLElement>).map((item) => [
        item.className,
        item.dataset.color ?? '',
        item.getAttribute('style'),
      ]);
    const before = boxes();

    rerender(
      <AvatarStack
        max={2}
        people={PEOPLE.map((person) => ({
          ...person,
          name: `${person.name}, whose name runs well past the column it sits in`,
        }))}
      />,
    );

    expect(boxes()).toEqual(before);
    expect(avatars()).toHaveLength(2);
  });

  it('renders every gallery example', () => {
    for (const example of gallery.examples) {
      const { unmount } = renderStack(<>{example.render()}</>);
      unmount();
    }
    expect(gallery.examples.length).toBeGreaterThan(0);
  });
});

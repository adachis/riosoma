import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ChoiceColor } from '@riosoma/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { gallery } from './ColorSwatchPicker.gallery';

// Every swatch is named by its color, which comes from the message catalog.
function renderPicker(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

const GROUP = 'Choice color';

const COLORS = ['Gray', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Brown'];

/** The inputs that carry the semantics; the circles a pointer aims at are drawn around them. */
function inputs(): HTMLInputElement[] {
  const group = screen.getByRole('radiogroup', { name: GROUP });
  return Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
}

/** Which color holds the selection, as the group reports it. */
function chosen(): string[] {
  return inputs()
    .filter((input) => input.checked)
    .map((input) => input.value);
}

/** The circle a pointer aims at, next to the radio that carries the name. */
function control(name: string): HTMLElement {
  const found = screen.getByRole('radio', { name }).closest<HTMLElement>('.rio-color-swatch-picker__control');
  if (found == null) throw new Error(`No swatch named ${name}`);
  return found;
}

/** A picker that keeps its own choice, so a case can watch the selection move. */
function Controlled({ onChoose }: { onChoose?: (color: ChoiceColor) => void }) {
  const [color, setColor] = useState<ChoiceColor>('gray');
  return (
    <ColorSwatchPicker
      label={GROUP}
      value={color}
      onChange={(next) => {
        setColor(next);
        onChoose?.(next);
      }}
    />
  );
}

describe('ColorSwatchPicker', () => {
  it('reads as a radio group of the ten colors, each named by its color', () => {
    renderPicker(<ColorSwatchPicker label={GROUP} value="green" />);

    const group = screen.getByRole('radiogroup', { name: GROUP });
    expect(within(group).getAllByRole('radio')).toHaveLength(COLORS.length);
    for (const color of COLORS) {
      expect(screen.getByRole('radio', { name: color })).toBeTruthy();
    }
    expect(chosen()).toEqual(['green']);
  });

  it('is one tab stop that lands on the chosen color', async () => {
    const user = userEvent.setup();
    renderPicker(<ColorSwatchPicker label={GROUP} value="green" />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Green' }));
    await user.tab();
    expect(screen.getByRole('radiogroup', { name: GROUP }).contains(document.activeElement)).toBe(false);
  });

  it('chooses a color from the pointer', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker(<ColorSwatchPicker label={GROUP} value="gray" onChange={onChange} />);

    await user.click(control('Teal'));

    expect(onChange).toHaveBeenCalledWith('teal');
  });

  it('moves the choice with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    renderPicker(<Controlled onChoose={onChoose} />);
    screen.getByRole('radio', { name: 'Gray' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(chosen()).toEqual(['red']);
    expect(onChoose).toHaveBeenLastCalledWith('red');

    await user.keyboard('{ArrowLeft}');
    expect(chosen()).toEqual(['gray']);

    // The group wraps around at both ends, as every radio group does.
    await user.keyboard('{ArrowLeft}');
    expect(chosen()).toEqual(['brown']);
    expect(onChoose).toHaveBeenLastCalledWith('brown');
  });

  it('marks the chosen swatch with a tick, and only that one', () => {
    renderPicker(<ColorSwatchPicker label={GROUP} value="blue" />);

    const controls = inputs().map((input) => input.closest('.rio-color-swatch-picker__control'));
    expect(controls.filter((control) => control?.hasAttribute('data-selected'))).toHaveLength(1);
    expect(control('Blue').hasAttribute('data-selected')).toBe(true);
    // The tick is decorative: the radio already says which color is chosen.
    expect(control('Blue').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(control('Blue').querySelectorAll('svg')).toHaveLength(1);
  });

  it('paints each swatch in its own color', () => {
    renderPicker(<ColorSwatchPicker label={GROUP} value="gray" />);
    expect(
      COLORS.map(
        (color) =>
          control(color).querySelector<HTMLElement>('.rio-color-swatch-picker__swatch')?.dataset.color,
      ),
    ).toEqual(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown']);
  });

  it('disables every swatch at once', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker(<ColorSwatchPicker label={GROUP} value="gray" onChange={onChange} isDisabled />);

    expect(screen.getByRole('radiogroup', { name: GROUP }).dataset.disabled).toBe('true');
    await user.click(control('Teal'));

    expect(onChange).not.toHaveBeenCalled();
    expect(chosen()).toEqual(['gray']);
  });

  it('renders every gallery example', () => {
    for (const example of gallery.examples) {
      const { unmount } = renderPicker(<>{example.render()}</>);
      unmount();
    }
    expect(gallery.examples.length).toBeGreaterThan(0);
  });
});

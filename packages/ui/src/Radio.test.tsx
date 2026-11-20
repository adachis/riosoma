import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Radio } from './Radio';
import { RadioGroup } from './RadioGroup';

function radio(name: string): HTMLInputElement {
  return screen.getByRole('radio', { name }) as HTMLInputElement;
}

function control(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-radio__control');
}

/** The element the state attributes are styled from. */
function field(name: string): HTMLElement | null {
  return screen.getByText(name).closest<HTMLElement>('.rio-radio');
}

describe('Radio', () => {
  it('is named by its label and shows the selected state on its circle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Schedule" onChange={onChange}>
        <Radio value="hourly">Hourly</Radio>
        <Radio value="daily">Daily</Radio>
      </RadioGroup>,
    );
    const hourly = control('Hourly');
    expect(hourly).not.toBeNull();
    expect(hourly?.dataset.selected).toBeUndefined();

    await user.click(screen.getByText('Daily'));

    expect(radio('Daily').checked).toBe(true);
    expect(control('Daily')?.dataset.selected).toBe('true');
    expect(onChange).toHaveBeenLastCalledWith('daily');
  });

  it('selects with the space bar while it has focus', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Schedule" onChange={onChange}>
        <Radio value="hourly">Hourly</Radio>
        <Radio value="daily">Daily</Radio>
      </RadioGroup>,
    );

    radio('Hourly').focus();
    await user.keyboard(' ');

    expect(radio('Hourly').checked).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('hourly');
  });

  it('draws its dot inside one circle, so no state changes its size', () => {
    render(
      <RadioGroup label="Schedule" defaultValue="daily">
        <Radio value="hourly">Hourly</Radio>
        <Radio value="daily">Daily</Radio>
      </RadioGroup>,
    );
    const boxes = Array.from(document.querySelectorAll('.rio-radio__box'));
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      // The dot is a pseudo-element, so the circle never gains or loses a child.
      expect(box.childNodes).toHaveLength(0);
    }
  });

  it('links its description to the radio', () => {
    render(
      <RadioGroup label="Schedule">
        <Radio value="hourly" description="Runs at the top of every hour.">
          Hourly
        </Radio>
      </RadioGroup>,
    );
    const description = screen.getByText('Runs at the top of every hour.');
    expect(description.id).not.toBe('');
    expect(radio('Hourly').getAttribute('aria-describedby')).toContain(description.id);
  });

  it('stays put when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Schedule" defaultValue="hourly" onChange={onChange}>
        <Radio value="hourly">Hourly</Radio>
        <Radio value="daily" isDisabled>
          Daily
        </Radio>
      </RadioGroup>,
    );
    expect(radio('Daily').disabled).toBe(true);
    expect(field('Daily')?.dataset.disabled).toBe('true');

    await user.click(screen.getByText('Daily'));

    expect(radio('Daily').checked).toBe(false);
    expect(radio('Hourly').checked).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an invalid group on every radio', () => {
    render(
      <RadioGroup label="Schedule" isInvalid>
        <Radio value="hourly">Hourly</Radio>
      </RadioGroup>,
    );
    expect(control('Hourly')?.dataset.invalid).toBe('true');
    expect(field('Hourly')?.dataset.invalid).toBe('true');
  });
});

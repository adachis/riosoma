import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Radio } from './Radio';
import { RadioGroup } from './RadioGroup';

function radios(name: string): HTMLInputElement[] {
  const group = screen.getByRole('radiogroup', { name });
  return Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
}

/** Which option holds the selection, as the value the group reports. */
function selected(name: string): Array<string> {
  return radios(name)
    .filter((radio) => radio.checked)
    .map((radio) => radio.value);
}

describe('RadioGroup', () => {
  it('names the group and reports the one chosen option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Write mode" onChange={onChange}>
        <Radio value="append">Append</Radio>
        <Radio value="overwrite">Overwrite</Radio>
        <Radio value="replace">Replace</Radio>
      </RadioGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Write mode' })).not.toBeNull();
    expect(selected('Write mode')).toEqual([]);

    await user.click(screen.getByText('Overwrite'));

    expect(selected('Write mode')).toEqual(['overwrite']);
    expect(onChange).toHaveBeenLastCalledWith('overwrite');

    // Choosing another option moves the selection instead of adding to it.
    await user.click(screen.getByText('Replace'));
    expect(selected('Write mode')).toEqual(['replace']);
  });

  it('moves the selection with the arrow keys', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Write mode" defaultValue="append" onChange={onChange}>
        <Radio value="append">Append</Radio>
        <Radio value="overwrite">Overwrite</Radio>
        <Radio value="replace">Replace</Radio>
      </RadioGroup>,
    );
    radios('Write mode')[0]?.focus();

    await user.keyboard('{ArrowDown}');
    expect(selected('Write mode')).toEqual(['overwrite']);

    await user.keyboard('{ArrowRight}');
    expect(selected('Write mode')).toEqual(['replace']);

    // The group wraps around at both ends.
    await user.keyboard('{ArrowDown}');
    expect(selected('Write mode')).toEqual(['append']);

    await user.keyboard('{ArrowLeft}');
    expect(selected('Write mode')).toEqual(['replace']);

    await user.keyboard('{ArrowUp}');
    expect(selected('Write mode')).toEqual(['overwrite']);
    expect(onChange).toHaveBeenLastCalledWith('overwrite');
  });

  it('skips a disabled option when the arrow keys move', async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup label="Write mode" defaultValue="append">
        <Radio value="append">Append</Radio>
        <Radio value="overwrite" isDisabled>
          Overwrite
        </Radio>
        <Radio value="replace">Replace</Radio>
      </RadioGroup>,
    );
    radios('Write mode')[0]?.focus();

    await user.keyboard('{ArrowDown}');

    expect(selected('Write mode')).toEqual(['replace']);
  });

  it('selects the focused option with the space bar', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Write mode" onChange={onChange}>
        <Radio value="append">Append</Radio>
        <Radio value="overwrite">Overwrite</Radio>
      </RadioGroup>,
    );

    await user.tab();
    expect(document.activeElement).toBe(radios('Write mode')[0]);
    await user.keyboard(' ');

    expect(selected('Write mode')).toEqual(['append']);
    expect(onChange).toHaveBeenLastCalledWith('append');
  });

  it('links its description and shows its error only while invalid', () => {
    const { rerender } = render(
      <RadioGroup label="Write mode" description="Applies to the next run only.">
        <Radio value="append">Append</Radio>
      </RadioGroup>,
    );
    const description = screen.getByText('Applies to the next run only.');
    expect(screen.getByRole('radiogroup', { name: 'Write mode' }).getAttribute('aria-describedby')).toContain(
      description.id,
    );
    expect(screen.queryByText('Pick a write mode.')).toBeNull();

    rerender(
      <RadioGroup
        label="Write mode"
        description="Applies to the next run only."
        isInvalid
        errorMessage="Pick a write mode."
      >
        <Radio value="append">Append</Radio>
      </RadioGroup>,
    );
    const error = screen.getByText('Pick a write mode.');
    expect(screen.getByRole('radiogroup', { name: 'Write mode' }).dataset.invalid).toBe('true');
    expect(screen.getByRole('radiogroup', { name: 'Write mode' }).getAttribute('aria-describedby')).toContain(
      error.id,
    );
  });

  it('lays its radios out in a row or a column', () => {
    render(
      <RadioGroup label="Write mode" orientation="horizontal">
        <Radio value="append">Append</Radio>
      </RadioGroup>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Write mode' });
    expect(group.dataset.orientation).toBe('horizontal');
    expect(group.getAttribute('aria-orientation')).toBe('horizontal');
    expect(group.querySelector<HTMLElement>('.rio-radio-group__items')?.dataset.orientation).toBe(
      'horizontal',
    );
  });

  it('disables every radio at once', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioGroup label="Write mode" isDisabled onChange={onChange}>
        <Radio value="append">Append</Radio>
        <Radio value="overwrite">Overwrite</Radio>
      </RadioGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Write mode' }).dataset.disabled).toBe('true');

    await user.click(screen.getByText('Append'));

    for (const radio of radios('Write mode')) {
      expect(radio.disabled).toBe(true);
      expect(radio.checked).toBe(false);
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});

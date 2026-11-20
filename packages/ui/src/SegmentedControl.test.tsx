import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';
import { gallery } from './SegmentedControl.gallery';

const ITEMS = [
  { id: 'asc', label: 'A → Z' },
  { id: 'desc', label: 'Z → A' },
  { id: 'none', label: 'None' },
];

function Controlled({ onChange }: { onChange: (id: string) => void }) {
  const [selected, setSelected] = useState('asc');
  return (
    <SegmentedControl
      label="Direction"
      items={ITEMS}
      selectedId={selected}
      onChange={(id) => {
        setSelected(id);
        onChange(id);
      }}
    />
  );
}

describe('SegmentedControl', () => {
  it('reads as one named group with the chosen segment pressed', () => {
    render(<SegmentedControl label="Direction" items={ITEMS} selectedId="desc" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Z → A' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'A → Z' }).getAttribute('aria-checked')).toBe('false');
  });

  it('changes on click and with the arrow keys', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Z → A' }));
    expect(onChange).toHaveBeenLastCalledWith('desc');
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('none');
    expect(screen.getByRole('radio', { name: 'None' }).getAttribute('aria-checked')).toBe('true');
  });

  it('never leaves nothing chosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'A → Z' }));
    expect(screen.getByRole('radio', { name: 'A → Z' }).getAttribute('aria-checked')).toBe('true');
    expect(onChange).not.toHaveBeenCalledWith('');
  });

  it('has gallery examples', () => {
    expect(gallery.examples.length).toBeGreaterThan(0);
  });
});

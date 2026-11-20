import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';
import { render } from './test/render';

/** The visual track carries no meaning of its own; the progressbar role does. */
function track(container: HTMLElement, part: 'fill' | 'segment') {
  return container.querySelector<HTMLElement>(`.rio-progress-bar__${part}`);
}

describe('ProgressBar', () => {
  it('is named by its label and reports its value', () => {
    const { container } = render(<ProgressBar label="Uploading dump" value={40} />);
    const bar = screen.getByRole('progressbar', { name: 'Uploading dump' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('40%');
    expect(screen.getByText('40%')).toBeTruthy();
    expect(track(container, 'fill')?.style.inlineSize).toBe('40%');
    expect(track(container, 'segment')).toBe(null);
  });

  it('honors its own range', () => {
    const { container } = render(<ProgressBar label="Rows copied" value={5} minValue={0} maxValue={10} />);
    const bar = screen.getByRole('progressbar', { name: 'Rows copied' });
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    expect(track(container, 'fill')?.style.inlineSize).toBe('50%');
  });

  it('shows and announces the value text from the caller', () => {
    render(<ProgressBar label="Restoring" value={40} valueLabel="4 of 10 files" />);
    const bar = screen.getByRole('progressbar', { name: 'Restoring' });
    expect(bar.getAttribute('aria-valuetext')).toBe('4 of 10 files');
    expect(screen.getByText('4 of 10 files')).toBeTruthy();
    expect(screen.queryByText('40%')).toBe(null);
  });

  it('stays a bare track when it is labeled by aria-label', () => {
    const { container } = render(<ProgressBar aria-label="Compacting" value={70} />);
    const bar = screen.getByRole('progressbar', { name: 'Compacting' });
    expect(bar.getAttribute('aria-valuenow')).toBe('70');
    expect(container.querySelector('.rio-progress-bar__header')).toBe(null);
    expect(track(container, 'fill')?.style.inlineSize).toBe('70%');
  });

  it('clamps a value outside its range', () => {
    const { container } = render(<ProgressBar aria-label="Rebuilding index" value={150} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(track(container, 'fill')?.style.inlineSize).toBe('100%');
  });

  it('slides a segment instead of a value when indeterminate', () => {
    const { container } = render(<ProgressBar label="Connecting" isIndeterminate />);
    const bar = screen.getByRole('progressbar', { name: 'Connecting' });
    expect(bar.getAttribute('aria-valuenow')).toBe(null);
    expect(bar.getAttribute('aria-valuetext')).toBe(null);
    expect(track(container, 'segment')).toBeTruthy();
    expect(track(container, 'fill')).toBe(null);
    // No value to show, so the label stands alone.
    expect(screen.queryByText(/%/)).toBe(null);
  });

  it('renders an empty fill at zero rather than hiding the track', () => {
    const { container } = render(<ProgressBar label="Waiting for a worker" value={0} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('0%')).toBeTruthy();
    expect(track(container, 'fill')?.style.inlineSize).toBe('0%');
  });
});

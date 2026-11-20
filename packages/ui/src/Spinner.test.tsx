import { describe, expect, it } from 'vitest';
import { render } from './test/render';
import { screen } from '@testing-library/react';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('announces itself as loading without a value', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('progressbar', { name: 'Loading' });
    // Indeterminate: a value would promise progress nobody can measure.
    expect(spinner.getAttribute('aria-valuenow')).toBe(null);
    expect(spinner.getAttribute('data-size')).toBe('md');
  });

  it('takes a specific label from the caller', () => {
    render(<Spinner label="Restoring backup" />);
    expect(screen.getByRole('progressbar', { name: 'Restoring backup' })).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Loading' })).toBe(null);
  });

  it('keeps the ring out of the accessibility tree at every size', () => {
    const { container } = render(
      <>
        <Spinner size="sm" />
        <Spinner size="lg" />
      </>,
    );
    const rings = container.querySelectorAll('.rio-spinner__ring');
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ring.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByRole('progressbar')[0]?.getAttribute('data-size')).toBe('sm');
    expect(screen.getAllByRole('progressbar')[1]?.getAttribute('data-size')).toBe('lg');
  });

  it('is not focusable, so it never interrupts the keyboard path', () => {
    render(<Spinner />);
    expect(screen.getByRole('progressbar').getAttribute('tabindex')).toBe(null);
  });
});

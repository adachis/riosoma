import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Separator } from './Separator';

describe('Separator', () => {
  it('divides two blocks as a horizontal rule', () => {
    render(
      <>
        <p>Primary</p>
        <Separator />
        <p>Replicas</p>
      </>,
    );
    const separator = screen.getByRole('separator');
    expect(separator.tagName).toBe('HR');
    // Horizontal is the default orientation, so it is left implicit.
    expect(separator.hasAttribute('aria-orientation')).toBe(false);
  });

  it('divides two controls vertically and says so', () => {
    render(
      <>
        <button type="button">Cut</button>
        <Separator orientation="vertical" />
        <button type="button">Copy</button>
      </>,
    );
    const separator = screen.getByRole('separator');
    expect(separator.tagName).toBe('DIV');
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('stays a separator when a caller picks the element', () => {
    render(<Separator elementType="div" />);
    const separator = screen.getByRole('separator');
    expect(separator.tagName).toBe('DIV');
    expect(separator.className).toBe('rio-separator');
  });

  it('keeps the styles a caller adds', () => {
    render(<Separator orientation="vertical" className="toolbar-divider" />);
    expect(screen.getByRole('separator').className.split(' ')).toEqual(['rio-separator', 'toolbar-divider']);
  });
});

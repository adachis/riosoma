import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Heading } from './Heading';

describe('Heading', () => {
  it('renders the level it is given, on the matching element', () => {
    render(
      <>
        <Heading level={1}>Riosoma</Heading>
        <Heading level={2}>Databases</Heading>
        <Heading level={3}>orders</Heading>
        <Heading level={4}>Columns</Heading>
      </>,
    );
    const headings = screen.getAllByRole('heading');
    expect(headings.map((heading) => heading.tagName)).toEqual(['H1', 'H2', 'H3', 'H4']);
    expect(screen.getByRole('heading', { level: 1, name: 'Riosoma' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 4, name: 'Columns' })).toBeDefined();
  });

  it('defaults to a section heading', () => {
    render(<Heading>Replicas</Heading>);
    expect(screen.getByRole('heading', { level: 2, name: 'Replicas' }).tagName).toBe('H2');
  });

  it('keeps the styles a caller adds', () => {
    render(
      <Heading level={3} className="screen-title" id="screen-title">
        Replicas
      </Heading>,
    );
    const heading = screen.getByRole('heading', { name: 'Replicas' });
    expect(heading.className.split(' ')).toEqual(['rio-heading', 'screen-title']);
    expect(heading.id).toBe('screen-title');
  });
});

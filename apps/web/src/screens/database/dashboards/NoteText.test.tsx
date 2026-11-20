import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NoteText } from './NoteText';

afterEach(cleanup);

it('renders headings, emphasis, code, lists, and web links from a note', () => {
  const { container } = render(
    <NoteText
      text={
        '# Weekly goals\n\nShip **dashboards** and *charts* with `code`.\n\n- First\n- Second\n\n1. One\n2. Two\n\n[Docs](https://example.com/docs)'
      }
    />,
  );
  expect(screen.getByRole('heading', { level: 4, name: 'Weekly goals' })).toBeDefined();
  expect(container.querySelector('strong')?.textContent).toBe('dashboards');
  expect(container.querySelector('em')?.textContent).toBe('charts');
  expect(container.querySelector('code')?.textContent).toBe('code');
  expect(screen.getAllByRole('list')).toHaveLength(2);
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'First',
    'Second',
    'One',
    'Two',
  ]);
  const link = screen.getByRole('link', { name: 'Docs' });
  expect(link.getAttribute('href')).toBe('https://example.com/docs');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('never runs markup or opens unsafe links', () => {
  const { container } = render(
    <NoteText
      text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Click](javascript:alert(1))'}
    />,
  );
  expect(container.querySelector('script, img')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
  expect(container.textContent).toContain('Click');
});

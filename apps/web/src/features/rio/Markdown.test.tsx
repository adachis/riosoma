import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSharing } from '../../screens/database/share/testing';
import { Markdown } from './Markdown';

const start = vi.fn();
vi.mock('../../demos/DemoHost', () => ({ useDemos: () => ({ start, running: false }) }));
afterEach(() => {
  cleanup();
  start.mockClear();
});

it('renders a comparison table in a focusable labeled scroll region with full value names', () => {
  const value = 'Long comparison value '.repeat(30);
  const app = renderSharing(<Markdown text={`| Name | Notes |\n| --- | --- |\n| First | ${value} |`} />);
  const region = screen.getByRole('region', { name: 'Comparison: Name, Notes' });
  expect(region.getAttribute('tabindex')).toBe('0');
  const table = within(region).getByRole('table');
  expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
  const span = within(table).getByLabelText(value.trim());
  expect(span.getAttribute('title')).toBe(value.trim());
  expect(span.className).toBe('rio-assistant__value');
  app.client.clear();
});

it('starts the existing sandbox runner from a Show-me link without navigating', async () => {
  const app = renderSharing(<Markdown text="[Show me search](/?showMe=palette)" />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show me search' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'palette', demo: 'palette' })),
  );
  expect(screen.queryByRole('link')).toBeNull();
  app.client.clear();
});

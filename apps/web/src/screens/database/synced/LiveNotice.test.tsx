import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { FieldMeta } from '@riosoma/contracts';
import type { LiveState, ViewRows, ViewRowsChange } from '../../../data';
import { renderShell } from '../shell/test-support';
import { LiveNotice } from './LiveNotice';

afterEach(cleanup);

function fakeRows(initial: LiveState) {
  const listeners = new Set<(change: ViewRowsChange) => void>();
  let state = initial;
  const rows = {
    subscribe(listener: (change: ViewRowsChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: () => state,
    retryLive: vi.fn(),
  } as unknown as ViewRows;
  return {
    rows,
    set(next: LiveState) {
      state = next;
      for (const listener of listeners) listener({ live: true });
    },
  };
}

const fields = [
  { id: 'fldNotes000000001', name: 'Notes' },
  { id: 'fldAmount00000002', name: 'Amount' },
] as unknown as FieldMeta[];

it('names what the source left out of the view, and why', () => {
  const { rows } = fakeRows({
    note: {
      skipped: [
        { part: 'filter', fieldId: 'fldNotes000000001', reason: 'localField' },
        { part: 'sort', fieldId: 'fldAmount00000002', reason: 'overridden' },
        { part: 'filter', fieldId: 'fldHidden00000003', reason: 'unsupported' },
      ],
      sourceOrder: true,
      truncatedAt: 250000,
      readAt: '2026-09-28T00:00:00.000Z',
    },
  });
  renderShell(<LiveNotice rows={rows} fields={fields} />);
  expect(
    screen.getByText('The filter on Notes: a field of this table’s own, which the source doesn’t have'),
  ).toBeDefined();
  expect(screen.getByText('The sort by Amount: some records override it here')).toBeDefined();
  // A field the reader can't see is never named.
  expect(screen.queryByText(/fldHidden/)).toBeNull();
  expect(
    screen.getByText('Showing the first 250,000 records. Add a filter to reach the rest.'),
  ).toBeDefined();
  expect(screen.getByText('Text sorts follow the source’s own alphabetical order.')).toBeDefined();
});

it('shows nothing for a read that left nothing out', () => {
  const { rows } = fakeRows({
    note: { skipped: [], sourceOrder: false, truncatedAt: null, readAt: '2026-09-28T00:00:00.000Z' },
  });
  const { container } = renderShell(<LiveNotice rows={rows} fields={fields} />);
  expect(container.querySelector('.rio-live-notice')).toBeNull();
});

it('shows a source that can’t be read as an error, and tries again', async () => {
  const { rows, set } = fakeRows({});
  renderShell(<LiveNotice rows={rows} fields={fields} />);
  expect(screen.queryByRole('alert')).toBeNull();
  set({ error: { messageKey: 'sources.live.unreachable' } });
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(screen.getByText('The source couldn’t be read')).toBeDefined();
  expect(
    screen.getByText(
      'The source can’t be reached right now. Check that it’s running, or test its connection in Settings.',
    ),
  ).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(rows.retryLive).toHaveBeenCalledOnce();
});

it('says a kind of view that needs every record can’t show a live table', () => {
  const { rows } = fakeRows({});
  renderShell(<LiveNotice rows={rows} fields={fields} viewType="kanban" />);
  expect(
    screen.getByText(
      'This kind of view needs every record at hand, so a live table can’t show it. Grid, gallery, and list views work.',
    ),
  ).toBeDefined();
});

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer } from '../../../data/testing';
import { openDatabase } from '../../../data/session';
import type { DatabaseSession } from '../../../data/types';
import type { RecordCardProps } from '../record/RecordCard';
import { RecordOverlay } from './RecordOverlay';

const card = vi.hoisted(() => vi.fn());
vi.mock('../record/RecordCard', () => ({
  RecordCard: (props: RecordCardProps) => {
    card(props);
    return (
      <>
        <output data-testid="position">
          {props.position ? `${props.position.index + 1} of ${props.position.total}` : 'Unknown'}
        </output>
        <button disabled={!props.onPrevious}>Previous</button>
        <button disabled={!props.onNext}>Next</button>
      </>
    );
  },
}));
let session: DatabaseSession | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  session?.close();
  card.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function settle() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}

describe('record overlay position', () => {
  it('updates when a ranged page load finds the open record without changing the row count', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(450);
    session = await openDatabase(fixture.databaseId, server.deps());
    const rows = session.openView(fixture.viewId);
    rows.ensureRows(0, 1);
    await settle();
    expect(rows.rowCount()).toBe(450);
    const recordId = fixture.recordId(250);
    expect(rows.indexOf(recordId)).toBe(-1);
    // The independent record request can still be pending when its view page arrives.
    vi.spyOn(session, 'getRecord').mockImplementation(() => new Promise(() => {}));
    const changed = vi.fn();
    const unsubscribe = rows.subscribe(changed);
    render(
      <RecordOverlay
        session={session}
        rows={rows}
        recordId={recordId}
        tableId={fixture.tableId}
        fields={[]}
        primaryFieldId={fixture.textFieldId}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onMissing={vi.fn()}
      />,
    );
    await act(settle);
    expect(screen.getByTestId('position').textContent).toBe('Unknown');
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      rows.ensureRows(250, 251);
      await settle();
    });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ rows: [200, 400], count: false }));
    expect(rows.rowCount()).toBe(450);
    expect(screen.getByTestId('position').textContent).toBe('251 of 450');
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
    card.mockClear();
    await act(async () => {
      await session!.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Changed' } }],
        },
      ]).done;
      await settle();
    });
    expect(card).not.toHaveBeenCalled();
    unsubscribe();
  });
});

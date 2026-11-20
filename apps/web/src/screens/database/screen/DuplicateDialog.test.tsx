import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../data';
import { DuplicateDialog } from './DuplicateDialog';
import { field, renderField } from '../fields/fieldTestUtils';
import { FieldDialog } from '../fields/FieldDialog';
import { json } from '../share/testing';

vi.mock('../../../grid/view/actions', () => ({ undoToast: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function dialog(kind: 'field' | 'table', existingNames: string[] = [], rejected = false) {
  const run = vi.fn((_commands: unknown, _options?: unknown) => ({
    groupId: 'group',
    done: Promise.resolve({
      applied: rejected ? 0 : 1,
      rejected: rejected ? 1 : 0,
      results: [
        {
          id: 'command',
          status: rejected ? 'rejected' : 'applied',
          ...(rejected ? { error: { messageKey: 'data.access.denied' } } : {}),
        },
      ],
    }),
  }));
  const onClose = vi.fn();
  renderField(
    <DuplicateDialog
      kind={kind}
      id="source"
      name="Amount"
      existingNames={existingNames}
      session={{ run } as unknown as DatabaseSession}
      onClose={onClose}
    />,
  );
  return { run, onClose };
}

describe('duplicate dialogs', () => {
  it.each(['finished', 'canceled'] as const)(
    'shows background progress and handles a %s copy',
    async (outcome) => {
      let state = 'running';
      const jobId = 'job12345678901234';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith('/cancel')) state = 'canceled';
          return json({
            id: jobId,
            state,
            copied: state === 'finished' ? 1200 : 500,
            total: 1200,
            result: null,
          });
        }),
      );
      const run = vi.fn(() => ({
        groupId: 'background-group',
        done: Promise.resolve({
          applied: 1,
          rejected: 0,
          results: [{ id: 'command', status: 'applied', output: { jobId } }],
        }),
      }));
      const adoptAction = vi.fn();
      const onClose = vi.fn();
      renderField(
        <DuplicateDialog
          kind="table"
          id="source"
          name="Amount"
          existingNames={[]}
          session={{ run, adoptAction } as unknown as DatabaseSession}
          onClose={onClose}
        />,
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Include records' }));
      await userEvent.click(screen.getByRole('button', { name: 'Duplicate table' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied 500 of 1200 records'));
      expect(adoptAction).not.toHaveBeenCalled();
      if (outcome === 'finished') {
        state = 'finished';
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(adoptAction).toHaveBeenCalledWith('background-group', {
          kind: 'table.duplicate',
          count: 1,
          name: 'Amount',
        });
      } else {
        await userEvent.click(screen.getByRole('button', { name: 'Cancel copy' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('canceled'));
        expect(onClose).not.toHaveBeenCalled();
        expect(adoptAction).not.toHaveBeenCalled();
      }
    },
  );
  for (const kind of ['field', 'table'] as const)
    for (const include of [false, true])
      it(`submits ${kind} with contents=${include} and a new name`, async () => {
        const { run, onClose } = dialog(kind);
        expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Amount copy');
        await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Second amount');
        if (include) await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(
          screen.getByRole('button', { name: kind === 'field' ? 'Duplicate field' : 'Duplicate table' }),
        );
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(run.mock.calls[0]![0]).toEqual([
          expect.objectContaining({
            kind: `${kind}.duplicate`,
            name: 'Second amount',
            [kind === 'field' ? 'withValues' : 'withRecords']: include,
          }),
        ]);
      });
  it('keeps duplicate names and empty names from submitting', async () => {
    const { run } = dialog('field', ['AMOUNT COPY']);
    const submit = screen.getByRole('button', { name: 'Duplicate field' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This name is already used.')).not.toBeNull();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it('supports cancellation from the keyboard', async () => {
    const { run, onClose } = dialog('table');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
  it('announces a refusal and keeps the dialog open', async () => {
    const { onClose } = dialog('field', [], true);
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
  it('offers duplication from an existing field dialog', async () => {
    const onDuplicate = vi.fn();
    renderField(
      <FieldDialog
        mode="edit"
        initial={field()}
        existingNames={['Title']}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDuplicate={onDuplicate}
        isSaving={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));
    expect(onDuplicate).toHaveBeenCalledOnce();
  });
});

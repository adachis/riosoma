import { createRef, useState } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, type CommandResult, type TextConflict } from '@riosoma/contracts';
import type { DatabaseSession } from '../data';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { parseError } from '../response-error';
import { TextCellInput, type TextCellHandle } from './TextCellInput';
import { RecordShell } from '../screens/database/record/RecordShell';

afterEach(cleanup);
const field = FieldMeta.parse({
  id: 'fld00000000000001',
  tableId: 'tbl00000000000001',
  name: 'Notes',
  type: 'longText',
  options: {},
  position: 0,
  description: '',
  createdAt: '',
  updatedAt: '',
});
const recordId = 'rec00000000000001';
const conflict: TextConflict = {
  tableId: field.tableId,
  fieldId: field.id,
  recordId,
  base: 'red green blue',
  ours: 'red purple blue',
  theirs: 'red yellow blue',
  updatedBy: 'usr00000000000001',
  name: 'Sam',
  updatedAt: '2026-10-02T12:00:00Z',
  proposal: 'red <<<<<<<\npurple\n=======\nyellow\n>>>>>>> blue',
};

function session(answer: CommandResult) {
  const run = vi.fn<DatabaseSession['run']>(() => ({
    groupId: 'act00000000000001',
    done: Promise.resolve({
      applied: answer.status === 'rejected' ? 0 : 1,
      rejected: answer.status === 'rejected' ? 1 : 0,
      results: [answer],
    }),
  }));
  const presence = vi.fn();
  const peers: ReturnType<DatabaseSession['peers']> = [];
  return {
    run,
    presence,
    session: {
      run,
      setPresence: presence,
      subscribePeers: () => () => {},
      peers: () => peers,
    } as unknown as DatabaseSession,
  };
}

describe('a text draft awaiting the command bus', () => {
  it('keeps the draft keyboard reachable while a save makes its fields inert', async () => {
    const answer: CommandResult = { id: 'cmd00000000000001', status: 'applied' };
    const s = session(answer);
    type Result = Awaited<ReturnType<DatabaseSession['run']>['done']>;
    let finish!: (result: Result) => void;
    s.run.mockImplementation(() => ({
      groupId: 'act00000000000001',
      done: new Promise<Result>((resolve) => {
        finish = resolve;
      }),
    }));
    renderField(<TextCellInput session={s.session} recordId={recordId} field={field} value="Draft" grid />);
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Updated draft');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(input.closest('.rio-text-edit'));
    expect(input.closest('fieldset')?.disabled).toBe(true);
    finish({ applied: 1, rejected: 0, results: [answer] });
    await waitFor(() => expect(input.closest('fieldset')?.disabled).toBe(false));
  });

  it('reverts a rejected JSON draft on Escape before closing the record', async () => {
    const s = session({
      id: 'cmd00000000000001',
      status: 'rejected',
      error: { code: 'validation_failed', messageKey: 'errors.internal', userFault: true },
    });
    const handle = createRef<TextCellHandle>();
    const close = vi.fn();
    const json = FieldMeta.parse({ ...field, type: 'json', options: {} });
    renderField(
      <RecordShell layout="panel" titleId="title" wide={false} onClose={close}>
        <h2 id="title">Record</h2>
        <TextCellInput ref={handle} session={s.session} recordId={recordId} field={json} value={'{"a":1}'} />
      </RecordShell>,
    );
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, '{{"a":2}');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('alert');
    expect(handle.current?.canClose()).toBe(false);
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    expect(JSON.parse((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value)).toEqual(
      { a: 1 },
    );
    expect(handle.current?.canClose()).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
  });
  it('reverts a dirty plain record draft on the first Escape and closes on the second', async () => {
    const s = session({ id: 'cmd00000000000001', status: 'applied' });
    const close = vi.fn();
    renderField(
      <RecordShell layout="panel" titleId="title" wide={false} onClose={close}>
        <h2 id="title">Record</h2>
        <TextCellInput session={s.session} recordId={recordId} field={field} value="red green blue" />
      </RecordShell>,
    );
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, 'red purple blue');
    await userEvent.keyboard('{Escape}');
    expect((input as HTMLTextAreaElement).value).toBe('red green blue');
    expect(close).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
  });
  it('preserves the starting value when realtime changes arrive while typing', async () => {
    const s = session({ id: 'cmd00000000000001', status: 'applied' });
    function Editor() {
      const [value, setValue] = useState('red green blue');
      return (
        <>
          <TextCellInput session={s.session} recordId={recordId} field={field} value={value} grid />
          <button onClick={() => setValue('RED green blue')}>Remote update</button>
        </>
      );
    }
    renderField(<Editor />);
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, 'red green BLUE');
    await userEvent.click(screen.getByRole('button', { name: 'Remote update' }));
    expect((input as HTMLTextAreaElement).value).toBe('red green BLUE');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(s.run).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          records: [
            {
              id: recordId,
              values: { [field.id]: 'red green BLUE' },
              baseValues: { [field.id]: 'red green blue' },
            },
          ],
        }),
      ],
      expect.objectContaining({ handlesRefusal: true }),
    );
    expect(s.presence).toHaveBeenCalledWith(
      expect.objectContaining({ editing: true, cell: { fieldId: field.id, recordId } }),
    );
  });
  it('retains a rejected draft and retries Keep mine with the returned stored value', async () => {
    const s = session({
      id: 'cmd00000000000001',
      status: 'rejected',
      error: {
        code: 'conflict',
        messageKey: 'data.textEdit.conflict',
        userFault: true,
        conflicts: [conflict],
      },
    });
    renderField(
      <TextCellInput session={s.session} recordId={recordId} field={field} value={conflict.base} grid />,
    );
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, conflict.ours!);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Resolve text conflict' });
    expect(s.run).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(s.run).toHaveBeenCalledTimes(2));
    expect(s.run.mock.calls[1]![0]).toEqual([
      expect.objectContaining({
        records: [
          {
            id: recordId,
            values: { [field.id]: conflict.ours },
            baseValues: { [field.id]: conflict.theirs },
          },
        ],
      }),
    ]);
  });
  it('shows the merged result and quiet note without closing the editor', async () => {
    const s = session({
      id: 'cmd00000000000001',
      status: 'applied',
      output: { textMerges: [{ ...conflict, value: 'RED green BLUE' }] },
    });
    const done = vi.fn();
    renderField(
      <TextCellInput
        session={s.session}
        recordId={recordId}
        field={field}
        value="red green blue"
        grid
        onDone={done}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, 'red green BLUE');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText("Merged with Sam's edit");
    expect((input as HTMLTextAreaElement).value).toBe('RED green BLUE');
    expect(done).not.toHaveBeenCalled();
  });
  it('keeps an edited combination if another save conflicts with the chosen resolution', async () => {
    const rejection: CommandResult = {
      id: 'cmd00000000000001',
      status: 'rejected',
      error: {
        code: 'conflict',
        messageKey: 'data.textEdit.conflict',
        userFault: true,
        conflicts: [conflict],
      },
    };
    const s = session(rejection);
    renderField(
      <TextCellInput session={s.session} recordId={recordId} field={field} value={conflict.base} grid />,
    );
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.clear(input);
    await userEvent.type(input, conflict.ours!);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Resolve text conflict' });
    const combined = screen.getByRole('textbox', { name: 'Combined text' });
    await userEvent.clear(combined);
    await userEvent.type(combined, 'red purple and yellow blue');
    const later = {
      ...conflict,
      base: conflict.theirs,
      ours: 'red purple and yellow blue',
      theirs: 'red orange blue',
      updatedAt: '2026-10-02T12:01:00Z',
    };
    s.run.mockImplementationOnce(() => ({
      groupId: 'act00000000000002',
      done: Promise.resolve({
        applied: 0,
        rejected: 1,
        results: [{ ...rejection, error: { ...rejection.error!, conflicts: [later] } }],
      }),
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Save combined text' }));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Their text' }) as HTMLTextAreaElement).value).toBe(
        later.theirs,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe(later.ours);
  });
  it('retains conflict details when parsing a form HTTP error', () => {
    expect(
      parseError({
        error: {
          code: 'conflict',
          messageKey: 'data.textEdit.conflict',
          userFault: true,
          conflicts: [conflict],
        },
      })?.conflicts,
    ).toEqual([conflict]);
    expect(
      parseError({
        error: {
          code: 'conflict',
          messageKey: 'data.textEdit.conflict',
          userFault: true,
          conflicts: [{ ...conflict, theirs: 2 }],
        },
      }),
    ).toBeNull();
  });
});

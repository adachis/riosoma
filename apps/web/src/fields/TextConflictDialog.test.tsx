import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, type TextConflict } from '@riosoma/contracts';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { TextConflictDialog } from './TextConflictDialog';

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
const conflict: TextConflict = {
  tableId: field.tableId,
  fieldId: field.id,
  recordId: 'rec00000000000001',
  base: 'red green blue',
  ours: 'red purple blue',
  theirs: 'red yellow blue',
  updatedBy: 'usr00000000000001',
  name: 'Sam',
  updatedAt: '2026-10-02T12:00:00Z',
  proposal: 'red <<<<<<<\npurple\n=======\nyellow\n>>>>>>> blue',
};
function setup(type: 'longText' | 'json' = 'longText') {
  const choose = vi.fn();
  const close = vi.fn();
  renderField(
    <TextConflictDialog
      field={FieldMeta.parse({ ...field, type })}
      conflict={conflict}
      onChoose={choose}
      onClose={close}
    />,
  );
  return { choose, close };
}
describe('text conflict dialog', () => {
  it('labels both versions, attributes the other edit, and stores nothing until a choice', () => {
    const { choose } = setup();
    expect(screen.getByRole('dialog', { name: 'Resolve text conflict' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Your text' }) as HTMLTextAreaElement).value).toBe(
      conflict.ours,
    );
    expect((screen.getByRole('textbox', { name: 'Their text' }) as HTMLTextAreaElement).value).toBe(
      conflict.theirs,
    );
    expect(screen.getByText(/Sam changed this cell on/)).toBeTruthy();
    expect(choose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save combined text' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it.each([
    ['Keep mine', conflict.ours],
    ['Use theirs', conflict.theirs],
  ])('chooses %s by keyboard', async (button, value) => {
    const { choose } = setup();
    screen.getByRole('button', { name: button! }).focus();
    await userEvent.keyboard('{Enter}');
    expect(choose).toHaveBeenCalledWith(value);
  });
  it('saves an edited proposal after the conflicting markers are removed', async () => {
    const { choose } = setup();
    const combined = screen.getByRole('textbox', { name: 'Combined text' });
    await userEvent.clear(combined);
    await userEvent.type(combined, 'red purple and yellow blue');
    await userEvent.click(screen.getByRole('button', { name: 'Save combined text' }));
    expect(choose).toHaveBeenCalledWith('red purple and yellow blue');
  });
  it('retains the draft when Escape closes the dialog', async () => {
    const { choose, close } = setup();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  });
  it('refuses an invalid JSON proposal', async () => {
    const { choose } = setup('json');
    const combined = screen.getByRole('textbox', { name: 'Combined text' });
    await userEvent.clear(combined);
    await userEvent.type(combined, '{{invalid');
    expect((screen.getByRole('button', { name: 'Save combined text' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(choose).not.toHaveBeenCalled();
  });
});

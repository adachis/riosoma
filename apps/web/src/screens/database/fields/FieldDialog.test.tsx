import { useState } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSpec, newId, type ConversionPreview } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { FieldDialog, type FieldDialogProps } from './FieldDialog';
import { field, renderField, selectOption } from './fieldTestUtils';

afterEach(cleanup);

function dialog(overrides: Partial<FieldDialogProps> = {}) {
  const props: FieldDialogProps = {
    mode: 'create',
    existingNames: [],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    isSaving: false,
    ...overrides,
  };
  renderField(<FieldDialog {...props} />);
  return props;
}

const conversion: ConversionPreview = {
  total: 10,
  converted: 8,
  emptied: 2,
  samples: ['missing', 'unknown'],
  newChoices: ['One', 'Two', 'Three'],
  tooManyChoices: false,
};

describe('FieldDialog', () => {
  it('restores the initial default when reverting an incompatible type change', async () => {
    const { onSubmit } = dialog({
      mode: 'edit',
      initial: field(
        FieldSpec.parse({
          type: 'number',
          options: { defaultValue: { kind: 'value', value: 7 } },
        }),
      ),
    });
    await selectOption('Type', 'Long text');
    await selectOption('Type', 'Number');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          options: expect.objectContaining({ defaultValue: { kind: 'value', value: 7 } }),
        }),
      }),
    );
  });

  it.each(['Currency', 'Percent', 'Rating'])('keeps a numeric default when changing to %s', async (type) => {
    const { onSubmit, onTypeChange } = dialog({
      mode: 'edit',
      initial: field(
        FieldSpec.parse({ type: 'number', options: { defaultValue: { kind: 'value', value: 3 } } }),
      ),
      onTypeChange: vi.fn(),
    });
    await selectOption('Type', type);
    expect(onTypeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ defaultValue: { kind: 'value', value: 3 } }),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          options: expect.objectContaining({ defaultValue: { kind: 'value', value: 3 } }),
        }),
      }),
    );
  });

  it('creates a number field with two decimal places and a description', async () => {
    const { onSubmit } = dialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    await selectOption('Type', 'Number');
    await selectOption('Decimal places', '2 (1.00)');
    await userEvent.click(screen.getByRole('button', { name: 'Add description' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Amount owed');
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Number',
      description: 'Amount owed',
      spec: { type: 'number', options: { precision: 2, thousands: true, allowNegative: true } },
    });
  });

  it('saves a default value with the field, and holds a save whose default doesn’t fit', async () => {
    const { onSubmit } = dialog();
    await selectOption('Type', 'Number');
    await userEvent.type(screen.getByRole('textbox', { name: 'Value' }), '5');
    await userEvent.click(screen.getByRole('switch', { name: 'Negative numbers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      name: 'Number',
      description: '',
      spec: {
        type: 'number',
        options: {
          precision: null,
          thousands: true,
          allowNegative: false,
          defaultValue: { kind: 'value', value: 5 },
        },
      },
    });
    cleanup();
    const held = dialog({
      mode: 'edit',
      initial: field(
        FieldSpec.parse({ type: 'rating', options: { max: 3, defaultValue: { kind: 'value', value: 5 } } }),
      ),
    });
    expect(screen.getByRole('alert').textContent).toContain('doesn’t fit');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(held.onSubmit).not.toHaveBeenCalled();
  });

  it('numbers suggested names and stops suggesting once a person types', async () => {
    dialog({ existingNames: ['number', 'Number 2'] });
    await selectOption('Type', 'Number');
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(name.value).toBe('Number 3');
    await userEvent.clear(name);
    await userEvent.type(name, 'Cost');
    await selectOption('Type', 'Date');
    expect(name.value).toBe('Cost');
    await userEvent.clear(name);
    await selectOption('Type', 'Text');
    expect(name.value).toBe('');
  });

  it('blocks empty and duplicate names with the specified messages', async () => {
    const { onSubmit } = dialog({ existingNames: ['Title'] });
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(screen.getByText('Enter a name.')).toBeDefined();
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' title ');
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(screen.getByText('Another field already has this name.')).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('allows the unchanged name while editing and expands an existing description', async () => {
    const initial = { ...field(), description: 'Original description' };
    const { onSubmit } = dialog({ mode: 'edit', initial, existingNames: ['Title', 'Number'] });
    expect(screen.getByRole('dialog', { name: 'Edit field' })).toBeDefined();
    expect((screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe(
      initial.description,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Title',
      description: initial.description,
      spec: { type: 'text', options: {} },
    });
  });

  it.each(['Single select', 'Multiple select'])(
    'blocks duplicate %s choices and drops blank names on save',
    async (type) => {
      const { onSubmit } = dialog();
      await selectOption('Type', type);
      await userEvent.click(screen.getByRole('button', { name: 'Add option' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Option name' }), ' Ready ');
      await userEvent.click(screen.getByRole('button', { name: 'Add option' }));
      const second = screen.getAllByRole('textbox', { name: 'Option name' })[1]!;
      await userEvent.type(second, 'ready');
      expect(screen.getAllByText('Another option already has this name.')).toHaveLength(2);
      await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
      expect(onSubmit).not.toHaveBeenCalled();
      await userEvent.clear(second);
      await userEvent.type(second, '   ');
      await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
      expect(onSubmit).toHaveBeenCalledWith({
        name: type,
        description: '',
        spec: {
          type: type === 'Single select' ? 'singleSelect' : 'multipleSelect',
          options: {
            choices: [{ id: expect.stringMatching(/^cho[0-9A-Za-z]{14}$/), name: 'Ready', color: 'gray' }],
          },
        },
      });
    },
  );

  it('restricts primary field types inside the dialog', async () => {
    dialog({ isPrimary: true });
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    const checkbox = screen.getByRole('option', { name: 'Checkbox' });
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(checkbox);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /Type/ }).textContent).toBe('Text');
  });

  it('requests previews for changed specs, displays counts and examples, and hides them on reverting', async () => {
    const onTypeChange = vi.fn();
    dialog({ mode: 'edit', initial: field(), conversion, onTypeChange });
    expect(screen.queryByRole('alert')).toBeNull();
    await selectOption('Type', 'Number');
    expect(onTypeChange).toHaveBeenLastCalledWith(FieldSpec.parse({ type: 'number' }));
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain('10 values checked.');
    expect(notice.textContent).toContain('2 values can’t be converted and will be cleared.');
    expect(notice.textContent).toContain('For example: missing, unknown');
    expect(notice.textContent).toContain('Adds 3 options.');
    await selectOption('Decimal places', '2 (1.00)');
    expect(onTypeChange).toHaveBeenLastCalledWith({
      type: 'number',
      options: { precision: 2, thousands: true, allowNegative: true },
    });
    await selectOption('Type', 'Text');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onTypeChange).toHaveBeenLastCalledWith({ type: 'text', options: {} });
  });

  it.each([
    { emptied: 0, newChoices: [], tooManyChoices: false, expected: 'Every value converts.' },
    {
      emptied: 1,
      newChoices: ['One'],
      tooManyChoices: false,
      expected: '1 value can’t be converted and will be cleared.',
    },
    {
      emptied: 0,
      newChoices: [],
      tooManyChoices: true,
      expected: 'There are more than 1,000 different values, too many to make options from.',
    },
  ])('renders conversion state: $expected', async ({ expected, ...preview }) => {
    const { onSubmit } = dialog({
      mode: 'edit',
      initial: field(),
      conversion: { ...conversion, ...preview, samples: [] },
    });
    await selectOption('Type', 'Single select');
    expect(screen.getByText(expected)).toBeDefined();
    if (preview.newChoices.length) expect(screen.getByText('Adds 1 option.')).toBeDefined();
    if (preview.tooManyChoices) {
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSubmit).not.toHaveBeenCalled();
    }
  });

  it('preserves choices between select types', async () => {
    const choices = [{ id: newId('choice'), name: 'Ready', color: 'blue' as const }];
    const { onSubmit } = dialog({
      mode: 'edit',
      initial: field({ type: 'singleSelect', options: { choices } }),
    });
    await selectOption('Type', 'Multiple select');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Title',
      description: '',
      spec: { type: 'multipleSelect', options: { choices } },
    });
  });

  it('shows caller errors and disables submission and dismissal while saving', async () => {
    const { onSubmit, onCancel } = dialog({ isSaving: true, error: 'Could not save this field.' });
    expect(screen.getByRole('alert').textContent).toContain('Could not save this field.');
    const save = screen.getByRole('button', { name: 'Create field' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.hasAttribute('data-pending')).toBe(true);
    await userEvent.click(save);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('traps focus, restores it after cancellation, and never renders a native dialog', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onPress={() => setOpen(true)}>Open fields</Button>
          {open ? (
            <FieldDialog
              mode="create"
              existingNames={[]}
              isSaving={false}
              onCancel={() => setOpen(false)}
              onSubmit={vi.fn()}
            />
          ) : null}
        </>
      );
    }
    renderField(<Host />);
    const trigger = screen.getByRole('button', { name: 'Open fields' });
    await userEvent.click(trigger);
    const modal = screen.getByRole('dialog', { name: 'New field' });
    expect(modal.tagName).not.toBe('DIALOG');
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    for (let index = 0; index < 10; index++) {
      await userEvent.tab();
      expect(modal.contains(document.activeElement)).toBe(true);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

it('uses singular wording for one dropped or orphaned selection', async () => {
  dialog({ mode: 'edit', initial: field(), conversion: { ...conversion, dropped: 1, orphaned: 1 } });
  await selectOption('Type', 'Single select');
  expect(screen.getByText('1 selection will be dropped.')).toBeDefined();
  expect(screen.getByText('1 selection will keep its ID without an available label.')).toBeDefined();
});

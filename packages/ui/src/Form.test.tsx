import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input, TextField } from 'react-aria-components';
import type { FormEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Description, FieldError, Label } from './Field';
import { Form, FormActions } from './Form';

function CreateDatabaseForm({
  onSubmit,
  validationErrors,
}: {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  validationErrors?: Record<string, string>;
}) {
  return (
    <Form aria-label="Create a database" onSubmit={onSubmit} validationErrors={validationErrors}>
      <TextField name="name">
        <Label>Name</Label>
        <Input />
        <Description>Lowercase letters, digits, and dashes.</Description>
        <FieldError />
      </TextField>
      <FormActions>
        <Button>Cancel</Button>
        <Button type="submit" variant="primary">
          Create
        </Button>
      </FormActions>
    </Form>
  );
}

describe('Form', () => {
  it('is a landmark that holds its fields and its actions row', () => {
    render(<CreateDatabaseForm />);
    const form = screen.getByRole('form', { name: 'Create a database' });
    expect(within(form).getByRole('textbox', { name: 'Name' })).toBeDefined();
    const actions = within(form).getByRole('button', { name: 'Create' }).parentElement;
    expect(actions?.className).toContain('rio-form__actions');
    expect(actions?.parentElement).toBe(form);
  });

  it('submits from its submit button', async () => {
    const onSubmit = vi.fn();
    render(<CreateDatabaseForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('submits from the keyboard', async () => {
    const onSubmit = vi.fn();
    render(<CreateDatabaseForm onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.type(input, 'orders');
    screen.getByRole('button', { name: 'Create' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(input.getAttribute('value')).toBe('orders');
  });

  it('does not submit from a button that is not the submit one', async () => {
    const onSubmit = vi.fn();
    render(<CreateDatabaseForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the error a caller passes down to the field it belongs to', () => {
    render(<CreateDatabaseForm validationErrors={{ name: 'That name is already taken.' }} />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('That name is already taken.')).toBeDefined();
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const error = screen.getByText('That name is already taken.');
    expect(describedBy).toContain(error.id);
    expect(error.className).toContain('rio-field-error');
  });

  it('shows no error for a field the caller did not flag', () => {
    render(<CreateDatabaseForm validationErrors={{ region: 'Unknown region.' }} />);
    expect(screen.getByRole('textbox', { name: 'Name' }).hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByText('Unknown region.')).toBeNull();
  });

  it('keeps the styles a caller adds', () => {
    render(
      <Form aria-label="Rename" className="inline-form">
        <FormActions className="sticky-actions" />
      </Form>,
    );
    expect(screen.getByRole('form', { name: 'Rename' }).className.split(' ')).toEqual([
      'rio-form',
      'inline-form',
    ]);
    expect(screen.getByRole('form', { name: 'Rename' }).firstElementChild?.className.split(' ')).toEqual([
      'rio-form__actions',
      'sticky-actions',
    ]);
  });
});

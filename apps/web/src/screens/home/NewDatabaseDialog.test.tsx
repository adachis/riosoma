import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewDatabaseDialog } from './NewDatabaseDialog';
import { renderHome } from './test-support';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('selects the default name, starts with a non-gray color, and submits with Enter', async () => {
  const onSubmit = vi.fn();
  renderHome(<NewDatabaseDialog onSubmit={onSubmit} onClose={vi.fn()} isCreating={false} />);
  const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(name.value).toBe('Untitled database');
  expect(name.selectionStart).toBe(0);
  expect(name.selectionEnd).toBe(name.value.length);
  expect((screen.getByRole('radio', { name: 'Gray' }) as HTMLInputElement).checked).toBe(false);
  await userEvent.keyboard('Budget{Enter}');
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Budget', color: expect.any(String) });
  expect(onSubmit.mock.calls[0]![0].color).not.toBe('gray');
});
it('allows keyboard color selection and cancellation', async () => {
  const onClose = vi.fn();
  renderHome(<NewDatabaseDialog onSubmit={vi.fn()} onClose={onClose} isCreating={false} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  await userEvent.tab();
  expect(screen.getAllByRole('radio')).toContain(document.activeElement);
  await userEvent.keyboard('{ArrowRight}');
  expect((document.activeElement as HTMLInputElement).checked).toBe(true);
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  await userEvent.keyboard('{Enter}');
  expect(onClose).toHaveBeenCalledOnce();
});
it('prevents blank submissions and preserves the typed name when errors arrive', async () => {
  const props = { onSubmit: vi.fn(), onClose: vi.fn(), isCreating: false };
  const { rerender } = renderHome(<NewDatabaseDialog {...props} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.keyboard('   {Enter}');
  expect(props.onSubmit).not.toHaveBeenCalled();
  await userEvent.clear(input);
  await userEvent.type(input, 'My plans');
  rerender(<NewDatabaseDialog {...props} error="Try again" />);
  expect(input.value).toBe('My plans');
  expect(screen.getByRole('alert').textContent).toContain('Try again');
});
it('keeps pending work from being submitted twice or dismissed', async () => {
  const props = { onSubmit: vi.fn(), onClose: vi.fn(), isCreating: true };
  renderHome(<NewDatabaseDialog {...props} />);
  expect(screen.getByRole('button', { name: 'Create' }).getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await userEvent.keyboard('{Escape}');
  expect(props.onSubmit).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

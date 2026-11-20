import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { SecretArea } from './SecretArea';

// The field names its own reveal button, which comes from the message catalog.
function renderField(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

function fieldOf(input: Element) {
  return input.closest('.rio-field');
}

// A block of text built at run time, so no key lives in the test file.
const edge = (word: string) => `-----${[word, 'PRIVATE', 'KEY'].join(' ')}-----`;
const KEY = [edge('BEGIN'), ['masked', 'secret'].join('-'), edge('END')].join('\n');

describe('SecretArea', () => {
  it('masks a block of text, keeps its name, and turns off spellcheck and password managers', () => {
    renderField(<SecretArea label="Private key (PEM)" />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    // Masked to start: a data attribute drives the text-security masking the screenshots verify.
    expect(input.hasAttribute('data-masked')).toBe(true);
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('data-1p-ignore')).not.toBeNull();
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(input.getAttribute('data-form-type')).toBe('other');
  });

  it('takes typed text and reports it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(<SecretArea label="Private key (PEM)" onChange={onChange} />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard('hunter2');
    expect(input.value).toBe('hunter2');
    expect(onChange).toHaveBeenLastCalledWith('hunter2');
  });

  it('keeps the line breaks of pasted multi-line text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(<SecretArea label="Private key (PEM)" onChange={onChange} />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    await user.click(input);
    await user.paste(KEY);
    expect(input.value).toBe(KEY);
    expect(input.value.split('\n')).toHaveLength(3);
    expect(onChange).toHaveBeenLastCalledWith(KEY);
  });

  it('reveals and masks again, and keeps focus in the textarea', async () => {
    const user = userEvent.setup();
    renderField(<SecretArea label="Private key (PEM)" defaultValue={KEY} />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    const reveal = screen.getByRole('button', { name: 'Show value' });

    await user.click(input);
    await user.click(reveal);
    expect(input.hasAttribute('data-masked')).toBe(false);
    // Now that it is visible it is a plain textbox the reader can read.
    expect(screen.getByRole('textbox', { name: 'Private key (PEM)' })).toBe(input);
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    // The value is never touched by masking, so its line breaks survive a reveal.
    expect(input.value).toBe(KEY);

    await user.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(input.hasAttribute('data-masked')).toBe(true);
    expect(input.value).toBe(KEY);
    expect(screen.getByRole('button', { name: 'Show value' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('reveals from the keyboard and leaves focus on the button', async () => {
    const user = userEvent.setup();
    renderField(<SecretArea label="Private key (PEM)" defaultValue={KEY} />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;

    await user.click(input);
    await user.tab();
    const reveal = screen.getByRole('button', { name: 'Show value' });
    expect(document.activeElement).toBe(reveal);

    await user.keyboard('{Enter}');
    expect(input.hasAttribute('data-masked')).toBe(false);
    expect(document.activeElement).toBe(reveal);
  });

  it('can start out revealed', () => {
    renderField(<SecretArea label="Private key (PEM)" defaultValue={KEY} defaultRevealed />);
    expect(screen.getByLabelText('Private key (PEM)').hasAttribute('data-masked')).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeTruthy();
  });

  it('carries the states a form needs', () => {
    renderField(<SecretArea label="Private key (PEM)" isRequired isDisabled isReadOnly />);
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    const field = fieldOf(input);
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(field?.hasAttribute('data-required')).toBe(true);
    expect(field?.hasAttribute('data-disabled')).toBe(true);
    expect(field?.hasAttribute('data-readonly')).toBe(true);
  });

  it('shows the error message only while the field is invalid', () => {
    renderField(
      <SecretArea
        label="Private key (PEM)"
        errorMessage="Paste the key, starting with -----BEGIN"
        isInvalid
      />,
    );
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    const error = screen.getByText('Paste the key, starting with -----BEGIN');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldOf(input)?.hasAttribute('data-invalid')).toBe(true);
    expect((input.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
  });

  it('keeps the eye icon out of the accessible name', () => {
    renderField(<SecretArea label="Private key (PEM)" />);
    const icons = fieldOf(screen.getByLabelText('Private key (PEM)'))?.querySelectorAll('svg') ?? [];
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Show value' }).textContent).toBe('');
  });
});

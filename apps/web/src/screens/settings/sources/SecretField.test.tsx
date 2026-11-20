import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { SecretField } from './SecretField';

afterEach(cleanup);

function renderField(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

// A block of text built at run time, so no key lives in the test file.
const edge = (word: string) => `-----${[word, 'PRIVATE', 'KEY'].join(' ')}-----`;
const KEY = [edge('BEGIN'), ['source', 'mask', 'integration'].join('-'), edge('END')].join('\n');

const noop = () => {};

describe('SecretField', () => {
  it('masks a new multi-line secret, keeps pasted line breaks, and can be shown', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField(
      <SecretField
        name="privateKeyPem"
        stored={false}
        removed={false}
        replacing={false}
        value=""
        onChange={onChange}
        onReplace={noop}
        onRemove={noop}
      />,
    );
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.hasAttribute('data-masked')).toBe(true);

    await user.click(input);
    await user.paste(KEY);
    expect(onChange).toHaveBeenLastCalledWith(KEY);

    await user.click(screen.getByRole('button', { name: 'Show value' }));
    expect(input.hasAttribute('data-masked')).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeTruthy();
  });

  it('never shows a stored secret, offering only to replace or remove it', () => {
    renderField(
      <SecretField
        name="privateKeyPem"
        stored
        removed={false}
        replacing={false}
        value=""
        onChange={noop}
        onReplace={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText('Private key (PEM)')).toBeTruthy();
    expect(screen.getByText('Stored')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    // No control holds the value, so a saved key can never be read back on screen.
    expect(screen.queryByRole('textbox', { name: 'Private key (PEM)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show value' })).toBeNull();
  });

  it('reopens a stored secret for a new value once Replace is pressed', () => {
    renderField(
      <SecretField
        name="privateKeyPem"
        stored
        removed={false}
        replacing
        value=""
        onChange={noop}
        onReplace={noop}
        onRemove={noop}
      />,
    );
    const input = screen.getByLabelText('Private key (PEM)') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.hasAttribute('data-masked')).toBe(true);
  });
});

import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { indentScript, ScriptField } from './ScriptField';

afterEach(cleanup);

function Fixture() {
  const [value, setValue] = useState('first\nsecond');
  return (
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <ScriptField value={value} onChange={setValue} readOnly={false} errorLine={2} />
      <button>Next</button>
    </I18nProvider>
  );
}

describe('script field', () => {
  it('indents and outdents selected lines without including an unselected trailing line', () => {
    expect(indentScript('\nnext', 0, 0, false)).toEqual({ value: '  \nnext', start: 2, end: 2 });
    expect(indentScript('one\ntwo\nthree', 0, 8, false)).toEqual({
      value: '  one\n  two\nthree',
      start: 2,
      end: 12,
    });
    expect(indentScript('  one\n two', 0, 10, true)).toEqual({ value: 'one\ntwo', start: 0, end: 7 });
  });

  it('handles indentation, cursor position, error lines, and keyboard exit', async () => {
    render(<Fixture />);
    const field = screen.getByRole('textbox', { name: 'JavaScript' }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, field.value.length);
    await userEvent.keyboard('{Tab}');
    await waitFor(() => expect(field.value).toBe('  first\n  second'));
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await waitFor(() => expect(field.value).toBe('first\nsecond'));
    field.setSelectionRange(8, 8);
    fireEvent.select(field);
    expect(screen.getByText('Line 2, column 3')).toBeTruthy();
    expect(document.querySelector('[data-error="true"]')?.textContent).toBe('2');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('autocorrect')).toBe('off');
    await userEvent.keyboard('{Escape}{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
  });
});

import { i18n } from '@lingui/core';
import { I18nProvider as LinguiProvider } from '@lingui/react';
import { I18nProvider } from 'react-aria-components';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { DatePicker } from './DatePicker';
import { render } from './test/render';

const hiddenStyle = document.createElement('style');
hiddenStyle.textContent = '[hidden] { display: none; }';

beforeEach(() => {
  // Match the browser's user-agent stylesheet so hidden form inputs stay out of the tab order.
  document.head.append(hiddenStyle);
  // The emulator exposes a Document constructor from a different realm. React Aria checks this
  // when deciding whether the dialog already contains focus, so use the document's own realm.
  vi.stubGlobal('Document', document.constructor);
  const collapse = Selection.prototype.collapse;
  let collapsing = false;
  // The DOM emulator dispatches selectionchange synchronously. Prevent reentry while preserving
  // the real selection update, which browsers deliver before the asynchronous event.
  vi.spyOn(Selection.prototype, 'collapse').mockImplementation(function (this: Selection, node, offset) {
    if (collapsing) return;
    collapsing = true;
    try {
      collapse.call(this, node, offset);
    } finally {
      collapsing = false;
    }
  });
});
afterEach(() => {
  hiddenStyle.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function segment(name: string) {
  return screen.getByRole('spinbutton', { name: new RegExp(name, 'i') });
}

function ControlledField() {
  const [value, setValue] = useState<string | null>(null);
  return <DatePicker label="Departure" value={value} onChange={setValue} />;
}

describe('DatePicker', () => {
  it('connects its label, help, required state, and validation error', () => {
    render(
      <DatePicker
        label="Departure"
        description="Choose the departure day"
        isRequired
        isInvalid
        errorMessage="Choose a later date"
        validationBehavior="aria"
      />,
    );
    expect(screen.getByRole('group', { name: 'Departure' })).toBeTruthy();
    const month = segment('month');
    expect(month.getAttribute('aria-required')).toBe('true');
    expect(month.getAttribute('aria-invalid')).toBe('true');
    const descriptions = month
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(descriptions).toContain('Choose the departure day');
    expect(descriptions).toContain('Choose a later date');
  });

  it.each([
    ['en-US', ['month', 'day', 'year'], '9272026'],
    ['de', ['Tag', 'Monat', 'Jahr'], '27092026'],
  ])('enters a full date in %s order', async (locale, names, keys) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <DatePicker label="Departure" onChange={onChange} />
      </I18nProvider>,
    );
    const segments = screen.getAllByRole('spinbutton');
    names.forEach((name, index) => expect(segments[index]).toBe(segment(name)));
    await user.tab();
    await user.keyboard(keys);
    expect(onChange).toHaveBeenLastCalledWith('2026-09-27');
  });

  it('supports controlled entry and clearing all segments', async () => {
    const user = userEvent.setup();
    render(<ControlledField />);
    await user.tab();
    await user.keyboard('9272026');
    expect(segment('year').getAttribute('aria-valuenow')).toBe('2026');
    await user.click(segment('month'));
    await user.keyboard(
      '{Backspace}{ArrowRight}{Backspace}{Backspace}{ArrowRight}{Backspace}{Backspace}{Backspace}{Backspace}',
    );
    for (const part of screen.getAllByRole('spinbutton')) {
      expect(part.hasAttribute('data-placeholder')).toBe(true);
    }
  });

  it('emits null after clearing every segment', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker label="Departure" defaultValue="2026-09-27" onChange={onChange} />);
    await user.tab();
    await user.keyboard(
      '{Backspace}{ArrowRight}{Backspace}{Backspace}{ArrowRight}{Backspace}{Backspace}{Backspace}{Backspace}',
    );
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getAllByRole('spinbutton').every((part) => part.hasAttribute('data-placeholder'))).toBe(
      true,
    );
  });

  it('clears with the keyboard button and returns focus to the segments', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker label="Departure" defaultValue="2026-09-27" onChange={onChange} />);
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(document.activeElement).toBe(clear);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Clear' })).toBe(clear);
    expect(clear.hasAttribute('disabled')).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(segment('month'));
    expect(screen.getAllByRole('spinbutton').every((part) => part.hasAttribute('data-placeholder'))).toBe(
      true,
    );
  });

  it.each([12, 24] as const)(
    'enters local time on a %s-hour clock and emits the UTC instant',
    async (hourCycle) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <DatePicker
          label="Departure"
          includeTime
          hourCycle={hourCycle}
          timeZone="America/Los_Angeles"
          onChange={onChange}
        />,
      );
      await user.tab();
      await user.keyboard(hourCycle === 12 ? '92720260305p' : '92720261505');
      expect(onChange).toHaveBeenLastCalledWith('2026-09-27T22:05:00.000Z');
    },
  );

  it.each([12, 24] as const)(
    'displays a stored UTC instant on a %s-hour clock in the supplied zone',
    (hourCycle) => {
      render(
        <DatePicker
          label="Departure"
          includeTime
          hourCycle={hourCycle}
          timeZone="America/Los_Angeles"
          value="2026-09-27T22:05:00.000Z"
        />,
      );
      expect(segment('month').getAttribute('aria-valuenow')).toBe('9');
      expect(segment('day,').getAttribute('aria-valuenow')).toBe('27');
      expect(segment('hour').textContent).toBe(hourCycle === 24 ? '15' : '3');
      expect(segment('minute').textContent).toBe('05');
      if (hourCycle === 12) expect(segment('AM/PM').textContent).toBe('PM');
      else expect(screen.queryByRole('spinbutton', { name: /AM\/PM/ })).toBeNull();
    },
  );

  it('updates the displayed day when the value or time zone changes', () => {
    const { rerender } = render(
      <DatePicker
        label="Departure"
        includeTime
        hourCycle={24}
        timeZone="UTC"
        value="2026-09-28T01:05:00.000Z"
      />,
    );
    expect(segment('day,').getAttribute('aria-valuenow')).toBe('28');
    rerender(
      <LinguiProvider i18n={i18n}>
        <DatePicker
          label="Departure"
          includeTime
          hourCycle={24}
          timeZone="America/Los_Angeles"
          value="2026-09-28T01:05:00.000Z"
        />
      </LinguiProvider>,
    );
    expect(segment('day,').getAttribute('aria-valuenow')).toBe('27');
    expect(segment('hour').getAttribute('aria-valuenow')).toBe('18');
  });

  it.each(['isDisabled', 'isReadOnly'] as const)('prevents edits while %s', async (state) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker label="Departure" defaultValue="2026-09-27" onChange={onChange} {...{ [state]: true }} />,
    );
    const month = segment('month');
    expect(month.getAttribute(state === 'isDisabled' ? 'aria-disabled' : 'aria-readonly')).toBe('true');
    await user.click(month);
    await user.keyboard('{ArrowUp}{Backspace}');
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear.hasAttribute('disabled')).toBe(true);
    await user.click(clear);
    expect(onChange).not.toHaveBeenCalled();
    expect(month.getAttribute('aria-valuenow')).toBe('9');
  });

  it('marks dates outside string bounds invalid', () => {
    render(
      <DatePicker
        label="Departure"
        defaultValue="2026-09-27"
        minValue="2026-09-28"
        maxValue="2026-09-30"
        validationBehavior="aria"
      />,
    );
    expect(segment('month').getAttribute('aria-invalid')).toBe('true');
  });

  it.each(['{ArrowRight}{Enter}', '{Escape}'])(
    'opens its calendar and restores trigger focus after %s',
    async (keys) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DatePicker label="Departure" defaultValue="2026-09-27" onChange={onChange} />);
      const trigger = screen.getByRole('button', { name: /Choose a date/ });
      await user.click(trigger);
      expect(await screen.findByRole('dialog')).toBeTruthy();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: /Sunday, September 27, 2026/ }),
        ),
      );
      await user.keyboard(keys);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      if (keys.includes('Enter')) expect(onChange).toHaveBeenLastCalledWith('2026-09-28');
      else expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('preserves the local time when choosing another day', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        label="Departure"
        includeTime
        timeZone="America/Los_Angeles"
        defaultValue="2026-09-27T22:05:00.000Z"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Choose a date/ }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Sunday, September 27, 2026/ })),
    );
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-09-28T22:05:00.000Z');
  });

  it.each(['isDisabled', 'isReadOnly'] as const)('does not open the calendar while %s', async (state) => {
    const user = userEvent.setup();
    render(<DatePicker label="Departure" {...{ [state]: true }} />);
    await user.click(screen.getByRole('button', { name: /Choose a date/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('clears all date and time segments to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        label="Departure"
        includeTime
        hourCycle={24}
        timeZone="America/Los_Angeles"
        defaultValue="2026-09-27T22:05:00.000Z"
        onChange={onChange}
      />,
    );
    await user.tab();
    await user.keyboard(
      '{Backspace}{ArrowRight}{Backspace}{Backspace}{ArrowRight}{Backspace}{Backspace}{Backspace}{Backspace}{ArrowRight}{Backspace}{Backspace}{ArrowRight}{Backspace}',
    );
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getAllByRole('spinbutton').every((part) => part.hasAttribute('data-placeholder'))).toBe(
      true,
    );
  });

  it('treats an unreadable stored value as empty', () => {
    render(<DatePicker label="Departure" value="not-a-date" />);
    expect(screen.getAllByRole('spinbutton').every((part) => part.hasAttribute('data-placeholder'))).toBe(
      true,
    );
  });

  it('opens from the keyboard and honors calendar bounds from the picker', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        label="Departure"
        defaultValue="2026-09-27"
        minValue="2026-09-26"
        maxValue="2026-09-29"
        isDateUnavailable={(value) => value === '2026-09-28'}
        onChange={onChange}
      />,
    );
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    const trigger = screen.getByRole('button', { name: /Choose a date/ });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Next month' }).hasAttribute('disabled')).toBe(true);
    const unavailable = screen.getByRole('button', { name: /Monday, September 28, 2026/ });
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-09-29');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

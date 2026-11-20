import { i18n } from '@lingui/core';
import { I18nProvider as LinguiProvider } from '@lingui/react';
import { getLocalTimeZone, today } from '@internationalized/date';
import { I18nProvider } from 'react-aria-components';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Calendar } from './Calendar';
import { render } from './test/render';

describe('Calendar', () => {
  it('names its application and month grid and exposes the selected day', () => {
    render(<Calendar aria-label="Departure" defaultValue="2026-09-27" />);
    expect(screen.getByRole('application', { name: /Departure/ })).toBeTruthy();
    expect(screen.getByRole('grid', { name: /September 2026/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /September 2026/ })).toBeTruthy();
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('27');
  });

  it.each([
    ['en-US', 'September 2026', /Sunday, September 27, 2026/],
    ['de', 'September 2026', /Sonntag, 27. September 2026/],
  ])('selects a day with the keyboard in %s', async (locale, month, day) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <Calendar aria-label="Departure" defaultValue="2026-09-27" onChange={onChange} />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { name: new RegExp(month) })).toBeTruthy();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: day }));
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-09-28');
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('28');
  });

  it.each([
    ['en-US', 'October 2026'],
    ['de', 'Oktober 2026'],
  ])('pages through localized months in %s', async (locale, next) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <Calendar aria-label="Departure" defaultValue="2026-09-27" onChange={onChange} />
      </I18nProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: new RegExp(next) })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: /September 2026/ })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks today even when it is selected', () => {
    render(<Calendar aria-label="Departure" defaultValue={today(getLocalTimeZone()).toString()} />);
    const selected = screen.getByRole('gridcell', { selected: true }).querySelector('[role=button]')!;
    expect(selected.hasAttribute('data-today')).toBe(true);
    expect(selected.hasAttribute('data-selected')).toBe(true);
  });

  it('accepts controlled updates and null to clear selection', () => {
    const { rerender } = render(<Calendar aria-label="Departure" value="2026-09-27" />);
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('27');
    rerender(
      <LinguiProvider i18n={i18n}>
        <Calendar aria-label="Departure" value="2026-09-28" />
      </LinguiProvider>,
    );
    expect(screen.getByRole('gridcell', { selected: true }).textContent).toBe('28');
    rerender(
      <LinguiProvider i18n={i18n}>
        <Calendar aria-label="Departure" value={null} />
      </LinguiProvider>,
    );
    expect(screen.queryByRole('gridcell', { selected: true })).toBeNull();
  });

  it('respects string bounds and unavailable days', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const unavailable = vi.fn((value: string) => value === '2026-09-28');
    render(
      <Calendar
        aria-label="Departure"
        defaultValue="2026-09-27"
        minValue="2026-09-26"
        maxValue="2026-09-29"
        isDateUnavailable={unavailable}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous month' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next month' }).hasAttribute('disabled')).toBe(true);
    const blocked = screen.getByRole('button', { name: /Monday, September 28, 2026/ });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    await user.click(blocked);
    await user.click(screen.getByRole('button', { name: /Friday, September 25, 2026/ }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Tuesday, September 29, 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-09-29');
    expect(unavailable).toHaveBeenCalledWith('2026-09-28');
  });

  it.each(['isDisabled', 'isReadOnly'] as const)('prevents selection while %s', async (state) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Calendar
        aria-label="Departure"
        defaultValue="2026-09-27"
        onChange={onChange}
        {...{ [state]: true }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Monday, September 28, 2026/ }));
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Sunday, September 27, 2026/ }).textContent).toBe('27');
  });
});

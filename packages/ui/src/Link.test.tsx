import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render as renderInDom, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it, vi } from 'vitest';
import { Link } from './Link';

/** The link translates the text it adds itself, so it needs the i18n context. */
function render(ui: React.ReactElement) {
  return renderInDom(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

describe('Link', () => {
  it('points at its href and fires onPress', async () => {
    const onPress = vi.fn();
    render(
      <Link href="/databases" onPress={onPress}>
        Databases
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Databases' });
    expect(link.getAttribute('href')).toBe('/databases');
    expect(link.tagName).toBe('A');
    // An internal link opens in this tab and carries no rel the page didn't ask for.
    expect(link.hasAttribute('target')).toBe(false);
    await userEvent.click(link);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('activates from the keyboard', async () => {
    const onPress = vi.fn();
    render(
      <Link href="/databases" onPress={onPress}>
        Databases
      </Link>,
    );
    screen.getByRole('link', { name: 'Databases' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('marks an external link with an arrow, a new tab, and a safe rel', () => {
    render(
      <Link href="https://riosoma.dev/docs" external>
        Documentation
      </Link>,
    );
    // The arrow names itself, so a screen reader hears where the link goes.
    const link = screen.getByRole('link', { name: 'Documentation Opens in a new tab' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.querySelector('svg[role="img"]')).not.toBeNull();
  });

  it('treats a hand-written new-tab target as external', () => {
    render(
      <Link href="https://riosoma.dev/docs" target="_blank" rel="nofollow">
        Documentation
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Documentation Opens in a new tab' });
    expect(link.getAttribute('rel')).toBe('nofollow noopener noreferrer');
  });

  it('keeps a leading icon decorative next to its label', () => {
    render(
      <Link href="/status" icon={faCircleInfo}>
        Status
      </Link>,
    );
    const icon = screen.getByRole('link', { name: 'Status' }).querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks the link for the page the user is on', () => {
    render(
      <Link href="/databases" aria-current="page">
        Databases
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Databases' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.hasAttribute('data-current')).toBe(true);
  });

  it('stays put when disabled', async () => {
    const onPress = vi.fn();
    render(
      <Link href="/databases" isDisabled onPress={onPress}>
        Databases
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Databases' });
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.hasAttribute('data-disabled')).toBe(true);
    await userEvent.click(link);
    expect(onPress).not.toHaveBeenCalled();
  });
});

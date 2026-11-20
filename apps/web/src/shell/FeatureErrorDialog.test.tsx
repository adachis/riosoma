import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StrictMode } from 'react';
import FeatureErrorDialog from './FeatureErrorDialog';

afterEach(cleanup);

function show() {
  return render(
    <I18nProvider i18n={i18n}>
      <FeatureErrorDialog error={new Error('Feature failed')} onDismiss={() => undefined} />
    </I18nProvider>,
  );
}

it('keeps the top recovery dialog interactive when both mount together', () => {
  const view = render(
    <I18nProvider i18n={i18n}>
      <FeatureErrorDialog error={new Error('First feature failed')} onDismiss={() => undefined} />
      <FeatureErrorDialog error={new Error('Second feature failed')} onDismiss={() => undefined} />
    </I18nProvider>,
  );
  const [first, second] = document.querySelectorAll('dialog');
  expect(first!.hasAttribute('inert')).toBe(true);
  expect(first!.getAttribute('aria-hidden')).toBe('true');
  expect(second!.hasAttribute('inert')).toBe(false);
  expect(second!.getAttribute('aria-hidden')).toBeNull();
  expect(second!.contains(document.activeElement)).toBe(true);
  view.unmount();
});

it.each(['oldest', 'newest'] as const)(
  'restores page attributes after sequential dialogs close %s first',
  (order) => {
    const background = document.createElement('main');
    background.setAttribute('aria-hidden', 'false');
    document.body.append(background);
    const alreadyHidden = document.createElement('aside');
    alreadyHidden.setAttribute('aria-hidden', 'true');
    alreadyHidden.setAttribute('inert', '');
    document.body.append(alreadyHidden);
    document.documentElement.style.overflow = 'clip';
    try {
      const first = show();
      const second = show();
      const dialogs = [...document.querySelectorAll('dialog')];
      (order === 'oldest' ? first : second).unmount();
      const remaining = dialogs[order === 'oldest' ? 1 : 0]!;
      expect(remaining.hasAttribute('inert')).toBe(false);
      expect(remaining.getAttribute('aria-hidden')).toBeNull();
      expect(remaining.contains(document.activeElement)).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
      expect(background.hasAttribute('inert')).toBe(true);
      expect(document.documentElement.style.overflow).toBe('hidden');
      (order === 'oldest' ? second : first).unmount();
      expect(background.getAttribute('aria-hidden')).toBe('false');
      expect(background.hasAttribute('inert')).toBe(false);
      expect(alreadyHidden.getAttribute('aria-hidden')).toBe('true');
      expect(alreadyHidden.hasAttribute('inert')).toBe(true);
      expect(document.documentElement.style.overflow).toBe('clip');
    } finally {
      cleanup();
      background.remove();
      alreadyHidden.remove();
      document.documentElement.style.overflow = '';
    }
  },
);

it('restores the page after the oldest dialog unmounts before the newest', () => {
  const background = document.createElement('main');
  document.body.append(background);
  try {
    const first = show();
    const second = show();
    first.unmount();
    second.unmount();
    expect(background.getAttribute('aria-hidden')).toBeNull();
    expect(background.hasAttribute('inert')).toBe(false);
  } finally {
    cleanup();
    background.remove();
  }
});

it('isolates new background content until the last dialog closes', async () => {
  const view = show();
  const background = document.createElement('main');
  document.body.append(background);
  try {
    await waitFor(() => expect(background.getAttribute('aria-hidden')).toBe('true'));
    expect(background.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(background.getAttribute('aria-hidden')).toBeNull();
    expect(background.hasAttribute('inert')).toBe(false);
  } finally {
    cleanup();
    background.remove();
  }
});

it('returns focus to the original control after all dialogs close in strict mode', () => {
  const background = render(
    <I18nProvider i18n={i18n}>
      <button>
        <Trans id="shell.help">Help</Trans>
      </button>
    </I18nProvider>,
  );
  const trigger = background.getByRole('button');
  trigger.focus();
  const dialogs = render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <FeatureErrorDialog error={new Error('First feature failed')} onDismiss={() => undefined} />
        <FeatureErrorDialog error={new Error('Second feature failed')} onDismiss={() => undefined} />
      </I18nProvider>
    </StrictMode>,
  );
  dialogs.unmount();
  expect(document.activeElement).toBe(trigger);
  expect(background.container.hasAttribute('inert')).toBe(false);
  expect(background.container.getAttribute('aria-hidden')).toBeNull();
});

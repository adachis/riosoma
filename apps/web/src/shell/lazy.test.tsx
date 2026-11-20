import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LazyBoundary, lazyFeature } from './lazy';
import { loadFeatureCatalog } from '../i18n';

vi.mock('../i18n', () => ({ loadFeatureCatalog: vi.fn(() => Promise.resolve()) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(children: ReactNode) {
  return render(<I18nProvider i18n={i18n}>{children}</I18nProvider>);
}

it('shares one request across hover, focus, and rendering and waits for active translations', async () => {
  let resolveFeature!: (module: { default: () => ReactNode }) => void;
  let resolveCatalog!: () => void;
  const load = vi.fn(
    () =>
      new Promise<{ default: () => ReactNode }>((resolve) => {
        resolveFeature = resolve;
      }),
  );
  vi.mocked(loadFeatureCatalog).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      resolveCatalog = resolve;
    }),
  );
  const Feature = lazyFeature(load);
  const hover = Feature.preload();
  const focus = Feature.preload();
  show(
    <LazyBoundary>
      <Feature />
    </LazyBoundary>,
  );
  expect(screen.getByRole('status').className).toContain('rio-feature-loading--page');
  await act(async () => {
    resolveFeature({ default: () => <Trans id="shell.nav.home">Home</Trans> });
  });
  expect(screen.getByRole('status')).toBeDefined();
  await act(async () => {
    resolveCatalog();
    await Promise.all([hover, focus]);
  });
  expect(screen.getByText('Home')).toBeDefined();
  expect(load).toHaveBeenCalledOnce();
  expect(loadFeatureCatalog).toHaveBeenCalledOnce();
});

it('keeps the initiating control focused while a dialog chunk loads', async () => {
  let resolveFeature!: (module: { default: () => ReactNode }) => void;
  const Feature = lazyFeature(
    () =>
      new Promise<{ default: () => ReactNode }>((resolve) => {
        resolveFeature = resolve;
      }),
  );
  const view = show(
    <button>
      <Trans id="shell.help">Help</Trans>
    </button>,
  );
  const button = screen.getByRole('button', { name: 'Help' });
  button.focus();
  view.rerender(
    <I18nProvider i18n={i18n}>
      <button>
        <Trans id="shell.help">Help</Trans>
      </button>
      <LazyBoundary size="dialog">
        <Feature />
      </LazyBoundary>
    </I18nProvider>,
  );
  expect(document.activeElement).toBe(button);
  expect(document.querySelector('.rio-feature-loading-dialog')).not.toBeNull();
  await act(async () => {
    resolveFeature({ default: () => <Trans id="shell.nav.home">Home</Trans> });
  });
  expect(document.activeElement).toBe(button);
});

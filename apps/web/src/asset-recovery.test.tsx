import { I18nProvider } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { i18n } from '@lingui/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy } from 'react';
import { runInNewContext } from 'node:vm';
import startupSource from '../public/startup-recovery.js?raw';
import { Button } from '@riosoma/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './shell/AppErrorBoundary';
import { BootError } from './shell/BootError';
import { lazyFeature, LazyBoundary } from './shell/lazy';
import { Menu, MenuTrigger } from './shell/menu';
import { DocsPanel } from './docs/DocsPanel';
import { beforeReload, installAssetRecovery, recoverAssets, recoverImport } from './asset-recovery';
import { clearClientErrors, installErrorCapture, recentClientErrors } from './features/feedback/errors';

vi.mock('./i18n', () => ({ loadFeatureCatalog: async () => {} }));
vi.mock('./shell/menu-runtime', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});
vi.mock('./docs/pdf', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

function Broken(): never {
  throw new Error('render failed');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

let attempt = 0;
function repairService() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + ++attempt * 60_000);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const update = vi.fn(async () => {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => ({ update })) },
  });
  return { update, reload: vi.spyOn(window.location, 'reload').mockImplementation(() => undefined) };
}

describe('departing pages', () => {
  let events: Map<string, EventListener>;
  beforeEach(() => {
    events = new Map();
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      events.set(type, listener as EventListener);
    });
    installAssetRecovery();
  });
  afterEach(async () => {
    events.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each(['pagehide', 'beforeunload'])(
    'leaves an import canceled after %s pending without recovery or reporting',
    async (type) => {
      const service = repairService();
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      const settled = vi.fn();
      let reject!: (error: Error) => void;
      void recoverImport(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      ).then(settled, settled);
      events.get(type)!(new Event(type));
      reject(new TypeError('Importing a module script failed'));
      if (type === 'beforeunload') events.get('pagehide')!(new Event('pagehide'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.reload).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
    },
  );

  it('recovers an import rejected after a persisted pageshow', async () => {
    const service = repairService();
    let reject!: (error: Error) => void;
    void recoverImport(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    events.get('pagehide')!(new Event('pagehide'));
    events.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    reject(new TypeError('Importing a module script failed'));
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it('resumes an import suppressed by a canceled unload without a pageshow', async () => {
    const service = repairService();
    let reject!: (error: Error) => void;
    void recoverImport(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const unload = new Event('beforeunload', { cancelable: true });
    events.get('beforeunload')!(unload);
    unload.preventDefault();
    reject(new TypeError('Importing a module script failed'));
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it('recovers later imports after a canceled unload without a pageshow', async () => {
    const service = repairService();
    const unload = new Event('beforeunload', { cancelable: true });
    events.get('beforeunload')!(unload);
    unload.preventDefault();
    await new Promise((resolve) => setTimeout(resolve, 0));
    void recoverImport(async () => {
      throw new TypeError('Importing a module script failed');
    });
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncanceled unload suppressed while pagehide is still pending', async () => {
    const service = repairService();
    const settled = vi.fn();
    events.get('beforeunload')!(new Event('beforeunload', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    void recoverImport(async () => {
      throw new TypeError('Importing a module script failed');
    }).then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('resumes a lazy import rejected while held in the back/forward cache', async () => {
    const service = repairService();
    let reject!: (error: Error) => void;
    const Feature = lazyFeature(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(
      <I18nProvider i18n={i18n}>
        <LazyBoundary>
          <Feature />
        </LazyBoundary>
      </I18nProvider>,
    );
    events.get('pagehide')!(Object.assign(new Event('pagehide'), { persisted: true }));
    reject(new TypeError('Importing a module script failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    events.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it('shows the lazy recovery control when a restored page is offline', async () => {
    const service = repairService();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    let reject!: (error: Error) => void;
    const Feature = lazyFeature(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(
      <I18nProvider i18n={i18n}>
        <LazyBoundary>
          <Feature />
        </LazyBoundary>
      </I18nProvider>,
    );
    events.get('pagehide')!(Object.assign(new Event('pagehide'), { persisted: true }));
    reject(new TypeError('Importing a module script failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    events.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
  });

  it('suppresses preload events and unhandled import rejections during unload', async () => {
    const service = repairService();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    events.get('pagehide')!(new Event('pagehide'));
    const preload = new Event('vite:preloadError', { cancelable: true });
    events.get('vite:preloadError')!(preload);
    const preventDefault = vi.fn();
    events.get('unhandledrejection')!({
      reason: new TypeError('Importing a module script failed'),
      preventDefault,
    } as unknown as Event);
    expect(await recoverAssets()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preload.defaultPrevented).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not report a health request that fails after the page starts leaving', async () => {
    const service = repairService();
    let rejectHealth!: (error: Error) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectHealth = reject;
        }),
    );
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const settled = vi.fn();
    void recoverImport(async () => {
      throw new TypeError('Importing a module script failed');
    }).then(settled, settled);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    events.get('pagehide')!(new Event('pagehide'));
    rejectHealth(new TypeError('Connection unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    events.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('guards startup, feedback, and recovery listeners together during unload and restores them afterward', async () => {
  const service = repairService();
  const target = new EventTarget();
  Object.defineProperty(navigator.serviceWorker, 'addEventListener', { value: vi.fn() });
  const startupScreen = { hidden: true };
  const failed = vi.fn();
  const dispatch = vi
    .spyOn(window, 'dispatchEvent')
    .mockImplementation((event) => target.dispatchEvent(event));
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    target.addEventListener(type, listener as EventListener, options);
  });
  // Startup and feedback register before asset recovery in the production document.
  runInNewContext(startupSource, {
    window,
    document: Object.assign(new EventTarget(), {
      readyState: 'loading',
      getElementById: () => startupScreen,
    }),
    navigator,
    sessionStorage,
    Date,
    setTimeout,
    clearTimeout,
  });
  installErrorCapture();
  installAssetRecovery();
  target.addEventListener('rio:asset-load-failed', failed);
  clearClientErrors();
  const rejectImport = () =>
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection', { cancelable: true }), {
        reason: new TypeError('Importing a module script failed'),
      }),
    );
  try {
    for (const type of ['pagehide', 'beforeunload']) {
      target.dispatchEvent(new Event(type));
      expect(rejectImport()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect.soft(startupScreen.hidden).toBe(true);
      expect.soft(recentClientErrors()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.reload).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      expect.soft(startupScreen.hidden).toBe(true);
      expect.soft(recentClientErrors()).toEqual([]);
    }
    expect(rejectImport()).toBe(false);
    await waitFor(() => expect(service.reload).toHaveBeenCalledTimes(1));
    expect(startupScreen.hidden).toBe(false);
    expect(recentClientErrors()).toHaveLength(1);
    startupScreen.hidden = true;
    clearClientErrors();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const unload = new Event('beforeunload', { cancelable: true });
    target.dispatchEvent(unload);
    unload.preventDefault();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejectImport()).toBe(false);
    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(startupScreen.hidden).toBe(false);
    expect(recentClientErrors()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.reload).toHaveBeenCalledTimes(1);
  } finally {
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    clearClientErrors();
  }
});

it('repairs a needed plain lazy import through the same registration update', async () => {
  const service = repairService();
  const Feature = lazy(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  render(
    <I18nProvider i18n={i18n}>
      <LazyBoundary>
        <Feature />
      </LazyBoundary>
    </I18nProvider>,
  );
  await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
  expect(service.reload).toHaveBeenCalledTimes(1);
});

it('repairs a required PDF import even when its action catches the failure', async () => {
  const service = repairService();
  const flush = vi.fn();
  const stop = beforeReload(flush);
  try {
    render(
      <I18nProvider i18n={i18n}>
        <DocsPanel moduleId="welcome" onOpen={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(service.reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rio.stale-asset')).toBeTruthy();
  } finally {
    stop();
  }
});

it('reports an offline PDF import through shared recovery even when the action catches it', async () => {
  const service = repairService();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const failed = vi.fn();
  window.addEventListener('rio:asset-load-failed', failed);
  try {
    render(
      <I18nProvider i18n={i18n}>
        <DocsPanel moduleId="welcome" onOpen={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(service.update).not.toHaveBeenCalled();
    expect(service.reload).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('rio:asset-load-failed', failed);
  }
});

it('clears a failed dialog parent and renders a different dialog in the same boundary', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const Feature = lazyFeature(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const onDismiss = vi.fn();
  const view = render(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="dialog" onDismiss={onDismiss}>
        <Feature key="failed" />
      </LazyBoundary>
    </I18nProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  view.rerender(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="dialog" onDismiss={onDismiss}>
        <div key="healthy">Healthy dialog</div>
      </LazyBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByText('Healthy dialog')).toBeTruthy();
});

it('clears an undismissed error when the dialog identity changes', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const view = render(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="dialog">
        <Broken key="failed" />
      </LazyBoundary>
    </I18nProvider>,
  );
  await screen.findByRole('button', { name: 'Reload' });
  view.rerender(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="dialog">
        <div key="healthy">Healthy dialog</div>
      </LazyBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByText('Healthy dialog')).toBeTruthy();
});

it('repairs a needed menu import and shows Reload when the next attempt is blocked', async () => {
  const service = repairService();
  const view = render(
    <I18nProvider i18n={i18n}>
      <MenuTrigger defaultOpen>
        <Button aria-label={i18n._('shell.menu')} />
        <Menu aria-label={i18n._('shell.menu')} />
      </MenuTrigger>
    </I18nProvider>,
  );
  await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1));
  expect(service.reload).toHaveBeenCalledTimes(1);
  view.unmount();
  render(
    <I18nProvider i18n={i18n}>
      <MenuTrigger defaultOpen>
        <Button aria-label={i18n._('shell.menu')} />
        <Menu aria-label={i18n._('shell.menu')} />
      </MenuTrigger>
    </I18nProvider>,
  );
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(service.update).toHaveBeenCalledTimes(1);
});

it('contains recovery dialog focus, isolates the page, and restores the trigger', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const user = userEvent.setup();
  const Feature = lazyFeature(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const view = render(
    <I18nProvider i18n={i18n}>
      <Button>
        <Trans id="shell.help">Help</Trans>
      </Button>
    </I18nProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Help' });
  trigger.focus();
  view.rerender(
    <I18nProvider i18n={i18n}>
      <Button>
        <Trans id="shell.help">Help</Trans>
      </Button>
      <LazyBoundary size="dialog">
        <Feature />
      </LazyBoundary>
    </I18nProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  await user.tab();
  await user.tab();
  await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(trigger.closest('[aria-hidden="true"], [inert]')).toBeTruthy();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('explains an ordinary feature bug without blaming the connection', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="panel">
        <Broken />
      </LazyBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByRole('heading', { name: 'This part ran into a problem' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.queryByText(/Check your connection/)).toBeNull();
});

it('forgets a failed speculative feature request and tries again when rendered', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
    .mockResolvedValue({ default: () => <div>Opened feature</div> });
  const Feature = lazyFeature(load);
  await Feature.preload();
  expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
  render(
    <I18nProvider i18n={i18n}>
      <LazyBoundary size="panel">
        <Feature />
      </LazyBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByText('Opened feature')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it('keeps a failed offline feature inside its panel and leaves the rest of the app mounted', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const Feature = lazyFeature(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  render(
    <I18nProvider i18n={i18n}>
      <AppErrorBoundary>
        <input aria-label="Working grid" defaultValue="Original" />
        <LazyBoundary size="panel">
          <Feature />
        </LazyBoundary>
      </AppErrorBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Working grid' })).toBeTruthy();
  expect(screen.getByRole('alert').closest('.rio-feature-loading--panel')).toBeTruthy();
});

it('keeps a blocked rendered import in its boundary without a second recovery notice', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const failed = vi.fn();
  window.addEventListener('rio:asset-load-failed', failed);
  try {
    const Feature = lazyFeature(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    render(
      <I18nProvider i18n={i18n}>
        <LazyBoundary size="panel">
          <Feature />
        </LazyBoundary>
      </I18nProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('rio:asset-load-failed', failed);
  }
});

it('keeps a visible error and a retry control after rendering fails at the root', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <I18nProvider i18n={i18n}>
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>
    </I18nProvider>,
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('keeps a visible error when a route throws during rendering', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const root = createRootRoute({ component: Outlet, errorComponent: BootError });
  const route = createRoute({ getParentRoute: () => root, path: '/', component: Broken });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory() });
  render(
    <I18nProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nProvider>,
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

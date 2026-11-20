import './recovery-catalog.d.ts';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toastQueue, ToastRegion } from '@riosoma/ui';
import { Trans } from '@lingui/react/macro';
import type { Root } from 'react-dom/client';
import type * as UI from '@riosoma/ui';
import type * as Client from 'react-dom/client';

const boot = vi.hoisted(() => ({ resolve: () => {} }));
const roots = vi.hoisted(() => [] as Root[]);
vi.mock('@riosoma/ui', async (original) => ({ ...(await original<typeof UI>()) }));
vi.mock('react-dom/client', async (original) => {
  const module = await original<typeof Client>();
  return {
    ...module,
    createRoot: (...args: Parameters<typeof module.createRoot>) => {
      const root = module.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});
vi.mock('./App', () => ({
  createAppContext: () => ({ router: { matchRoutes: () => [] } }),
  App: () => (
    <>
      <main>
        <Trans id="shell.nav.home">Home</Trans>
      </main>
      <ToastRegion />
    </>
  ),
}));
vi.mock('./i18n', async () => {
  const { i18n } = await import('@lingui/core');
  return {
    i18n,
    activateLocale: () =>
      new Promise<string>((resolve) => {
        boot.resolve = () => {
          i18n.activate('en-US');
          resolve('en-US');
        };
      }),
  };
});
vi.mock('./session', () => ({ appliedSettings: vi.fn(), sessionQuery: {}, setupStatusQuery: {} }));
vi.mock('./preferences', () => ({
  rememberedLocale: () => 'en-US',
  rememberLocale: vi.fn(),
  themeFor: vi.fn(),
}));
vi.mock('./shell/firstPaintTheme', () => ({ firstPaintTheme: vi.fn() }));
vi.mock('./features/feedback/errors', () => ({ installErrorCapture: vi.fn() }));

let events: Map<string, EventListener[]>;
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  events = new Map();
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => {
    if (name === 'rio:asset-load-failed' || name === 'unhandledrejection') {
      const list = events.get(name) ?? [];
      list.push(listener as EventListener);
      events.set(name, list);
    } else original(name, listener, options);
  });
  const dispatch = window.dispatchEvent.bind(window);
  vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
    if (!events.has(event.type)) return dispatch(event);
    for (const listener of events.get(event.type)!) listener(event);
    return true;
  });
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  cleanup();
  toastQueue.clear();
  vi.restoreAllMocks();
});

async function failedImport() {
  await act(async () => {
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection', { cancelable: true }), {
        reason: new TypeError('Failed to fetch dynamically imported module'),
      }),
    );
  });
}

it('keeps mounted app content and shows a toast for an unhandled offline import', async () => {
  await import('./main');
  await act(async () => boot.resolve());
  const content = await screen.findByRole('main');
  await failedImport();
  await waitFor(() =>
    expect(toastQueue.visibleToasts.map((item) => item.content.title)).toContain("That part couldn't load"),
  );
  expect(screen.getByRole('main')).toBe(content);
  expect(screen.queryByRole('heading', { name: "This screen couldn't load" })).toBeNull();
  expect(toastQueue.visibleToasts[0]?.content.description).toBe('Check your connection and try again.');
  expect(toastQueue.visibleToasts[0]?.content.action?.label).toBe('Reload');
});

it('signals readiness after the app mounts so startup can stop checking', async () => {
  await import('./main');
  expect(vi.mocked(window.dispatchEvent).mock.calls.some(([event]) => event.type === 'rio:app-ready')).toBe(
    false,
  );
  await act(async () => boot.resolve());
  await screen.findByRole('main');
  expect(vi.mocked(window.dispatchEvent).mock.calls.some(([event]) => event.type === 'rio:app-ready')).toBe(
    true,
  );
});

it('shows the startup error for the same failed import before the app mounts', async () => {
  await import('./main');
  await failedImport();
  expect(await screen.findByRole('heading', { name: "This screen couldn't load" })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.queryByRole('main')).toBeNull();
  expect(toastQueue.visibleToasts).toHaveLength(0);
});

it('shows Reload for an offline required import even when its caller catches it', async () => {
  await import('./main');
  await act(async () => boot.resolve());
  const content = await screen.findByRole('main');
  const { AssetLoadError, recoverImport } = await import('./asset-recovery');
  await act(async () => {
    await expect(
      recoverImport(async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      }),
    ).rejects.toBeInstanceOf(AssetLoadError);
  });
  await waitFor(() => expect(toastQueue.visibleToasts[0]?.content.action?.label).toBe('Reload'));
  expect(screen.getByRole('main')).toBe(content);
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  toastQueue.visibleToasts[0]?.content.action?.onPress();
  expect(reload).toHaveBeenCalledTimes(1);
});

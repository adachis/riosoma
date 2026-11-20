import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { installsApp, offerUpdate, onUpdateReady, applyWorkerUpdate } = await import('./pwa');

function container(controlled: boolean, waiting: boolean) {
  const registration = {
    waiting: waiting ? {} : null,
  } as ServiceWorkerRegistration;
  return {
    controller: controlled ? ({} as ServiceWorker) : null,
    getRegistration: vi.fn(async () => registration),
  };
}

describe('offering a new version', () => {
  it('reloads once after an accepted worker takes control of a page from its first installation', async () => {
    const events = new EventTarget();
    const next = {} as ServiceWorker;
    const service = {
      controller: {} as ServiceWorker,
      getRegistration: vi.fn(async () => ({ waiting: next }) as ServiceWorkerRegistration),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
    const reload = vi.fn();
    const activate = vi.fn(async () => {});
    await applyWorkerUpdate(service, activate, reload);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    service.controller = next;
    events.dispatchEvent(new Event('controllerchange'));
    events.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on a first install and when nothing is waiting, and offers a real update', async () => {
    const offered = vi.fn();
    const stop = onUpdateReady(offered);
    const apply = vi.fn(async () => {});
    await offerUpdate(container(false, true), apply);
    await offerUpdate(container(true, false), apply);
    expect(offered).not.toHaveBeenCalled();
    const waiting = container(true, true);
    await offerUpdate(waiting, apply);
    expect(offered).toHaveBeenCalledWith(apply);
    await offerUpdate(waiting, apply);
    expect(offered).toHaveBeenCalledTimes(1);
    await offerUpdate(container(true, true), apply);
    expect(offered).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('installing the app', () => {
  it('never happens on a shared view or inside another site’s page', () => {
    expect(installsApp({ pathname: '/' }, false)).toBe(true);
    expect(installsApp({ pathname: '/f/AbCdEfGhIjKlMnOpQrStUv' }, false)).toBe(true);
    expect(installsApp({ pathname: '/v/AbCdEfGhIjKlMnOpQrStUv' }, false)).toBe(false);
    expect(installsApp({ pathname: '/' }, true)).toBe(false);
  });
});

describe('updates after immediate takeover', () => {
  it('offers takeover only when the page had an older controller and never reloads by itself', async () => {
    const { offerUpdate, onUpdateReady } = await import('./pwa');
    const offered = vi.fn();
    const apply = vi.fn(async () => {});
    const stop = onUpdateReady(offered);
    offered.mockClear();
    const service = container(true, false);
    await offerUpdate(service, apply, null);
    await offerUpdate(service, apply, service.controller);
    expect(offered).not.toHaveBeenCalled();
    await offerUpdate(service, apply, {} as ServiceWorker);
    expect(offered).toHaveBeenCalledWith(apply);
    expect(apply).not.toHaveBeenCalled();
    await offered.mock.calls[0]![0]();
    expect(apply).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('checking the page against the new worker build', () => {
  let entry: HTMLScriptElement;
  let channels: Array<{
    port1: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn> };
    port2: { reply: (data: unknown) => void; close: ReturnType<typeof vi.fn> };
  }>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    entry = document.createElement('script');
    entry.type = 'module';
    entry.src = '/assets/entry-current.js';
    vi.spyOn(document, 'querySelector').mockReturnValue(entry);
    channels = [];
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined, close: vi.fn() };
        port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() };
        constructor() {
          channels.push(this);
        }
      },
    );
  });

  afterEach(() => {
    entry.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('offers only an older page, current build %s', async (current) => {
    const { offerUpdate, onUpdateReady } = await import('./pwa');
    const postMessage = vi.fn((_message, ports) => ports[0].reply({ current }));
    const service = { ...container(true, false), controller: { postMessage } as unknown as ServiceWorker };
    const offered = vi.fn();
    const apply = vi.fn(async () => {});
    const stop = onUpdateReady(offered);
    try {
      const previous = {} as ServiceWorker;
      await Promise.all([offerUpdate(service, apply, previous), offerUpdate(service, apply, previous)]);
      expect(postMessage).toHaveBeenCalledWith({ type: 'check-page-build', entry: entry.src }, [
        expect.anything(),
      ]);
      expect(offered).toHaveBeenCalledTimes(current ? 0 : 1);
      expect(apply).not.toHaveBeenCalled();
      expect(
        channels.every(
          (channel) =>
            channel.port1.close.mock.calls.length === 1 && channel.port2.close.mock.calls.length === 1,
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it('offers an update after a short wait when the worker does not answer', async () => {
    const { offerUpdate, onUpdateReady } = await import('./pwa');
    const service = {
      ...container(true, false),
      controller: { postMessage: vi.fn() } as unknown as ServiceWorker,
    };
    const offered = vi.fn();
    const apply = vi.fn(async () => {});
    const stop = onUpdateReady(offered);
    try {
      const check = offerUpdate(service, apply, {} as ServiceWorker);
      await vi.advanceTimersByTimeAsync(999);
      expect(offered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await check;
      expect(offered).toHaveBeenCalledExactlyOnceWith(apply);
      expect(channels[0]!.port1.close).toHaveBeenCalledTimes(1);
      expect(channels[0]!.port2.close).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('keeps a missing-file notice when the worker confirms the page entry is current', async () => {
    const { markPageOutdated, offerUpdate, onUpdateReady } = await import('./pwa');
    const service = {
      ...container(true, false),
      controller: {
        postMessage: (_message: unknown, ports: Array<{ reply: (data: unknown) => void }>) =>
          ports[0]!.reply({ current: true }),
      } as unknown as ServiceWorker,
    };
    const offered = vi.fn();
    const stop = onUpdateReady(offered);
    try {
      markPageOutdated();
      await offerUpdate(service, async () => {}, {} as ServiceWorker);
      expect(offered).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe('shared asset recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    vi.stubGlobal('caches', { delete: vi.fn(async () => true) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }))),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('updates, activates a waiting worker, and reloads once for concurrent failures', async () => {
    vi.useFakeTimers();
    const { recoverAssets } = await import('./asset-recovery');
    const next = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const service = Object.assign(new EventTarget(), {
      getRegistration: vi.fn(async () => ({ waiting: next, update: vi.fn(async () => {}) })),
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
    const reload = vi.fn();
    const spill = vi.fn();
    window.addEventListener('pagehide', spill, { once: true });
    const one = recoverAssets(reload);
    expect(spill).not.toHaveBeenCalled();
    const two = recoverAssets(reload);
    await vi.advanceTimersByTimeAsync(1);
    expect(next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    service.dispatchEvent(new Event('controllerchange'));
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/healthz', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(await recoverAssets(reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the guard across a page load and rejects a needed import when offline', async () => {
    const reload = vi.fn();
    sessionStorage.setItem('rio.stale-asset', String(Date.now()));
    let recovery = await import('./asset-recovery');
    expect(await recovery.recoverAssets(reload)).toBe(false);

    sessionStorage.clear();
    vi.resetModules();
    recovery = await import('./asset-recovery');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await recovery.recoverAssets(reload)).toBe(false);
    await expect(
      recovery.recoverImport(async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      }),
    ).rejects.toBeInstanceOf(recovery.AssetLoadError);
    expect(reload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['connection', 'server', 'captive', 'unhealthy'])(
    'reports a needed import without reloading when the health request fails with %s',
    async (failure) => {
      if (failure === 'connection')
        vi.mocked(fetch).mockRejectedValue(new TypeError('Connection unavailable'));
      else
        vi.mocked(fetch).mockResolvedValue(
          failure === 'server'
            ? new Response('', { status: 503 })
            : new Response(
                failure === 'captive' ? '<html>Sign in</html>' : JSON.stringify({ status: 'down' }),
              ),
        );
      const recovery = await import('./asset-recovery');
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      await expect(
        recovery.recoverImport(async () => {
          throw new TypeError('Failed to fetch dynamically imported module');
        }),
      ).rejects.toBeInstanceOf(recovery.AssetLoadError);
      expect(reload).not.toHaveBeenCalled();
      expect(caches.delete).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'rio:asset-load-failed' }));
    },
  );

  it('ends an unanswered health request after two seconds without reloading', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        }),
    );
    const { recoverAssets } = await import('./asset-recovery');
    const reload = vi.fn();
    const repair = recoverAssets(reload);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await repair).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
  });

  it('shows recovery for an offline preload failure without announcing a new version', async () => {
    const recovery = await import('./asset-recovery');
    const { onUpdateReady } = await import('./pwa');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const events = new Map<string, EventListener>();
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      events.set(type, listener as EventListener);
    });
    const service = Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => undefined) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const offered = vi.fn();
    const stop = onUpdateReady(offered);
    try {
      recovery.installAssetRecovery();
      events.get('vite:preloadError')!(new Event('vite:preloadError'));
      expect(offered).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'rio:asset-load-failed' })),
      );
      expect(service.getRegistration).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
    } finally {
      stop();
    }
  });

  it.each([false, true])(
    'does not announce an unconfirmed speculative failure with online status %s',
    async (online) => {
      const { preloadAssets } = await import('./asset-recovery');
      const { onUpdateReady } = await import('./pwa');
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
      const offered = vi.fn();
      const stop = onUpdateReady(offered);
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
      try {
        await preloadAssets(async () => {
          throw new TypeError('Failed to fetch dynamically imported module');
        });
        expect(offered).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
      } finally {
        stop();
      }
    },
  );

  it.each([true, false])(
    'leaves a tracked preload failure to its caller with reporting %s',
    async (reportBlocked) => {
      const recovery = await import('./asset-recovery');
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const events = new Map<string, EventListener>();
      vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
        events.set(type, listener as EventListener);
      });
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
      recovery.installAssetRecovery();
      await expect(
        recovery.recoverImport(async () => {
          events.get('vite:preloadError')!(new Event('vite:preloadError'));
          throw new TypeError('Failed to fetch dynamically imported module');
        }, reportBlocked),
      ).rejects.toBeInstanceOf(recovery.AssetLoadError);
      const messages = dispatch.mock.calls.filter(([event]) => event.type === 'rio:asset-load-failed');
      expect(messages).toHaveLength(reportBlocked ? 1 : 0);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('accepts a confirmed update without service workers and flushes drafts before reloading', async () => {
    const { beforeReload } = await import('./asset-recovery');
    const { markPageOutdated, onUpdateReady } = await import('./pwa');
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    const order: string[] = [];
    const flush = vi.fn(() => {
      order.push('flush');
    });
    const stopFlush = beforeReload(flush);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {
      order.push('reload');
    });
    const offered = vi.fn();
    const stop = onUpdateReady(offered);
    try {
      markPageOutdated();
      expect(offered).toHaveBeenCalledTimes(1);
      expect(flush).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      await offered.mock.calls[0]![0]();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['flush', 'reload']);
    } finally {
      stop();
      stopFlush();
    }
  });

  it.each([true, false])(
    'offers one notice when a removed asset and worker takeover confirm the same update, asset first %s',
    async (assetFirst) => {
      const { markPageOutdated, onUpdateReady, offerUpdate } = await import('./pwa');
      const { reloadPage } = await import('./asset-recovery');
      const previous = {} as ServiceWorker;
      const next = {} as ServiceWorker;
      let waiting: ServiceWorker | null = next;
      const service = Object.assign(new EventTarget(), {
        controller: previous,
        getRegistration: vi.fn(async () => ({ waiting }) as ServiceWorkerRegistration),
      });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
      const offered = vi.fn();
      const stop = onUpdateReady(offered);
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
      try {
        if (assetFirst) markPageOutdated();
        await offerUpdate(service, async () => reloadPage());
        if (!assetFirst) markPageOutdated();
        waiting = null;
        service.controller = next;
        await offerUpdate(service, async () => reloadPage(), previous);
        expect(offered).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
        await offered.mock.calls[0]![0]();
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    },
  );

  it('replaces import errors before the router can run its independent reload', async () => {
    const recovery = await import('./asset-recovery');
    sessionStorage.setItem('rio.stale-asset', String(Date.now()));
    await expect(
      recovery.recoverImport(async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      }),
    ).rejects.toBeInstanceOf(recovery.AssetLoadError);
    const ordinary = new Error('render failed');
    await expect(
      recovery.recoverImport(async () => {
        throw ordinary;
      }),
    ).rejects.toBe(ordinary);
  });

  it('flushes registered draft sessions only when a page will reload', async () => {
    const recovery = await import('./asset-recovery');
    const flush = vi.fn();
    const stop = recovery.beforeReload(flush);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    expect(await recovery.recoverAssets()).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    recovery.reloadPage();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
    recovery.reloadPage();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('keeps preload errors on the shared recovery guard and recovers unhandled imports', async () => {
    const recovery = await import('./asset-recovery');
    const events = new Map<string, EventListener>();
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      events.set(type, listener as EventListener);
    });
    recovery.installAssetRecovery();
    sessionStorage.setItem('rio.stale-asset', String(Date.now()));
    events.get('vite:preloadError')!(new Event('vite:preloadError'));
    expect(sessionStorage.getItem('rio.stale-asset')).toBeTruthy();
    const preventDefault = vi.fn();
    events.get('unhandledrejection')!({
      reason: new TypeError('Failed to fetch dynamically imported module'),
      preventDefault,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('handles a worker repair by updating, saving drafts, and reloading once', async () => {
    const recovery = await import('./asset-recovery');
    const events = new Map<string, EventListener>();
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      events.set(type, listener as EventListener);
    });
    const update = vi.fn(async () => {});
    const service = Object.assign(new EventTarget(), {
      getRegistration: vi.fn(async () => ({ update })),
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
    const flush = vi.fn();
    const stop = recovery.beforeReload(flush);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    recovery.installAssetRecovery();
    events.get('vite:preloadError')!(new Event('vite:preloadError'));
    const reply = vi.fn();
    service.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type: 'repair-stale-assets' },
        ports: [{ postMessage: reply }],
      }),
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith({ handled: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rio.stale-asset')).toBeTruthy();
    stop();
  });

  it('keeps a speculative failure deferred while unrelated required code is loading', async () => {
    const recovery = await import('./asset-recovery');
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    const service = Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => undefined) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    recovery.installAssetRecovery();
    let finish!: (value: string) => void;
    const needed = recovery.recoverImport(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await recovery.preloadAssets(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const reply = vi.fn();
    service.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type: 'repair-stale-assets' },
        ports: [{ postMessage: reply }],
      }),
    );
    finish('ready');
    expect(await needed).toBe('ready');
    expect(reply).toHaveBeenCalledWith({ deferred: true });
    expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('defers a delayed speculative repair and still repairs when that code becomes required', async () => {
    vi.useFakeTimers();
    const recovery = await import('./asset-recovery');
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    const service = Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => undefined) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    recovery.installAssetRecovery();
    const failed = async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    };
    await recovery.preloadAssets(failed);
    await vi.advanceTimersByTimeAsync(2_000);
    const reply = vi.fn();
    service.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type: 'repair-stale-assets' },
        ports: [{ postMessage: reply }],
      }),
    );
    expect(reply).toHaveBeenCalledWith({ deferred: true });
    expect(reload).not.toHaveBeenCalled();
    void recovery.recoverImport(failed);
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

it('offers the update for a stale preload without reloading or spilling drafts', async () => {
  vi.resetModules();
  sessionStorage.clear();
  const { installAssetRecovery, preloadAssets } = await import('./asset-recovery');
  const { onUpdateReady } = await import('./pwa');
  const offered = vi.fn();
  const stop = onUpdateReady(offered);
  const events = new Map<string, EventListener>();
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    events.set(type, listener as EventListener);
  });
  const service = Object.assign(new EventTarget(), { getRegistration: vi.fn() });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
  const spill = vi.fn();
  window.onpagehide = spill;
  installAssetRecovery();
  await preloadAssets(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  events.get('vite:preloadError')!(new Event('vite:preloadError'));
  expect(offered).not.toHaveBeenCalled();
  const reply = vi.fn();
  service.dispatchEvent(
    Object.assign(new Event('message'), {
      data: { type: 'repair-stale-assets' },
      ports: [{ postMessage: reply }],
    }),
  );
  expect(offered).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith({ deferred: true });
  expect(sessionStorage.getItem('rio.stale-asset')).toBeNull();
  expect(service.getRegistration).not.toHaveBeenCalled();
  expect(spill).not.toHaveBeenCalled();
  window.onpagehide = null;
  stop();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

it('leaves a needed import pending while its repair reload is under way', async () => {
  vi.resetModules();
  sessionStorage.clear();
  const health = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
  const { recoverImport } = await import('./asset-recovery');
  const service = {
    getRegistration: vi.fn(async () => {
      sessionStorage.setItem('repair-requested', 'yes');
      return undefined;
    }),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: service });
  let rejected = false;
  void recoverImport(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  }).catch(() => {
    rejected = true;
  });
  await vi.waitFor(() => expect(sessionStorage.getItem('repair-requested')).toBe('yes'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(rejected).toBe(false);
  Reflect.deleteProperty(navigator, 'serviceWorker');
  health.mockRestore();
});
